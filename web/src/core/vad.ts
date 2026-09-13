/**
 * 말한 구간 찾기 (VAD).
 *
 * 3시간 운행에서 사람이 말한 건 4분일 수 있다. 지금은 그 4분을 찾으려면
 * 3시간을 훑어야 한다. 이게 그걸 없앤다.
 *
 * 전사(글자로 옮기기)와 달리 **이건 원본 조건이 나빠도 된다.** 8kHz 모노
 * 차내 음성에서 "무슨 말인지"는 어렵지만 "말이 있었는지"는 가를 수 있다.
 *
 * 모델을 쓰지 않는다. 단일 HTML 파일 하나로 오프라인에서 동작해야 하는데,
 * ONNX 런타임만 3~20MB이고 실행 시점에 내려받아야 하기 때문이다.
 * 대신 차내 잡음의 성질을 이용한다.
 *
 *   노면·엔진·풍절음 = 넓은 대역에 퍼진 **거의 일정한** 소리
 *   사람 목소리      = 300~3400Hz에 몰린 **하모닉** 소리 + 음절마다 끊김(2~8Hz)
 *
 * 그래서 세 가지를 본다.
 *   ① 음성 대역이 잡음 바닥보다 얼마나 솟았는가 (적응형 바닥 추정)
 *   ② 하모닉 구조가 있는가 (자기상관 최대값)
 *   ③ 음절 속도(2~8Hz)로 출렁이는가 — 일정한 잡음에는 없는 성질
 */

/** 8kHz에서 32ms */
const FRAME = 256;
/** 16ms마다 한 프레임 */
const HOP = 128;
/** 사람 목소리 기본 주파수 범위 60~400Hz → 자기상관 지연 */
const LAG_MIN = 20;   // 8000/400
const LAG_MAX = 133;  // 8000/60
/** 음성 대역 300~3400Hz의 FFT 빈 (8000/256 = 31.25Hz/빈) */
const BIN_LO = 10;
const BIN_HI = 108;
/** 잡음 바닥을 훑는 창 (프레임 수). 약 3초 — 이보다 긴 말은 드물다 */
const FLOOR_WINDOW = 190;

export interface SpeechSpan {
  /** 구간 안에서의 시작·끝 (ms) */
  startMs: number;
  endMs: number;
  /** 0~1. 높을수록 말일 가능성이 크다 */
  score: number;
}

export interface VadOptions {
  sampleRate?: number;
  /** 음성 대역이 잡음 바닥보다 이만큼(dB) 솟아야 말로 본다 */
  snrDb?: number;
  /** 이보다 짧은 건 버린다 (ms) — 문 닫는 소리, 경적 */
  minSpeechMs?: number;
  /** 이보다 짧게 끊긴 건 이어 붙인다 (ms) — 숨 쉬는 사이 */
  maxGapMs?: number;
  /** 앞뒤로 이만큼 넉넉히 잡는다 (ms) — 첫 음절이 잘리지 않게 */
  padMs?: number;
}

const DEFAULTS: Required<VadOptions> = {
  sampleRate: 8000,
  snrDb: 6,
  minSpeechMs: 350,
  maxGapMs: 400,
  padMs: 200,
};

// ── 신호 처리 ────────────────────────────────────────

/** 제자리 radix-2 FFT. 256점이라 재귀 없이 반복으로 충분하다. */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

const HANN = (() => {
  const w = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));
  return w;
})();

/**
 * 하모닉 정도. 목소리는 성대가 주기적으로 여닫혀 파형이 되풀이된다.
 * 노면 잡음에는 그런 되풀이가 없다.
 */
function harmonicity(x: Float32Array, from: number): number {
  let energy = 0;
  for (let i = 0; i < FRAME; i++) energy += x[from + i] * x[from + i];
  if (energy < 1e-9) return 0;

  let best = 0;
  for (let lag = LAG_MIN; lag <= LAG_MAX; lag++) {
    let dot = 0;
    let tail = 0;
    const n = FRAME - lag;
    for (let i = 0; i < n; i++) {
      const a = x[from + i];
      const b = x[from + i + lag];
      dot += a * b;
      tail += b * b;
    }
    if (tail < 1e-9) continue;
    const r = dot / Math.sqrt(energy * tail);
    if (r > best) best = r;
  }
  return Math.max(0, best);
}

/** 프레임마다 뽑는 값 */
interface Frame {
  /** 음성 대역 에너지 (dB) */
  bandDb: number;
  harmonic: number;
}

function analyze(x: Float32Array): Frame[] {
  const out: Frame[] = [];
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);

  for (let at = 0; at + FRAME <= x.length; at += HOP) {
    for (let i = 0; i < FRAME; i++) {
      re[i] = x[at + i] * HANN[i];
      im[i] = 0;
    }
    fft(re, im);
    let band = 0;
    for (let b = BIN_LO; b <= BIN_HI; b++) band += re[b] * re[b] + im[b] * im[b];
    out.push({
      bandDb: 10 * Math.log10(band + 1e-12),
      harmonic: harmonicity(x, at),
    });
  }
  return out;
}

/**
 * 잡음 바닥을 추정한다 — 창 안의 **하위 20%** 값.
 *
 * 최솟값을 쓰면 한 프레임의 우연한 정적에 휘둘리고, 평균을 쓰면 말소리가
 * 바닥을 끌어올려 스스로를 숨긴다. 분위수가 둘 사이에서 안정적이다.
 * 차가 서고 달리며 잡음이 변하므로 창을 옮겨 가며 다시 잡는다.
 */
function noiseFloor(frames: Frame[]): Float32Array {
  const n = frames.length;
  const floor = new Float32Array(n);
  const half = Math.floor(FLOOR_WINDOW / 2);
  const scratch: number[] = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half);
    scratch.length = 0;
    for (let j = lo; j < hi; j++) scratch.push(frames[j].bandDb);
    scratch.sort((a, b) => a - b);
    floor[i] = scratch[Math.floor(scratch.length * 0.2)];
  }
  return floor;
}

/**
 * 음절 속도(2~8Hz)로 출렁이는 정도.
 *
 * 사람 말은 초당 서너 음절로 끊어지며 에너지가 오르내린다.
 * 일정한 노면 잡음에는 이 출렁임이 없어서, 에너지만으로는 못 가르는
 * 경우를 이게 갈라 준다.
 */
function modulation(frames: Frame[], frameRate: number): Float32Array {
  const n = frames.length;
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) env[i] = frames[i].bandDb;

  // 2~8Hz만 남기려면 8Hz 위(빠른 떨림)와 2Hz 아래(느린 추세)를 걷어낸다
  const fast = smooth(env, Math.max(1, Math.round(frameRate / 16)));
  const slow = smooth(env, Math.max(3, Math.round(frameRate / 2)));

  const out = new Float32Array(n);
  const half = Math.max(2, Math.round(frameRate / 4)); // 0.25초 안의 출렁임 폭
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    let sum = 0;
    for (let j = lo; j < hi; j++) {
      const d = fast[j] - slow[j];
      sum += d * d;
    }
    out[i] = Math.sqrt(sum / (hi - lo));
  }
  return out;
}

function smooth(x: Float32Array, half: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    let sum = 0;
    for (let j = lo; j < hi; j++) sum += x[j];
    out[i] = sum / (hi - lo);
  }
  return out;
}

// ── 판정 ────────────────────────────────────────────

/**
 * PCM(모노)에서 말한 구간을 찾는다.
 *
 * 반환은 시각 순이며 겹치지 않는다. 입력이 짧으면 빈 배열이다.
 */
export function detectSpeech(pcm: Float32Array, options: VadOptions = {}): SpeechSpan[] {
  const o = { ...DEFAULTS, ...options };
  if (pcm.length < FRAME * 4) return [];

  const frames = analyze(pcm);
  if (frames.length === 0) return [];
  const frameRate = o.sampleRate / HOP;
  const floor = noiseFloor(frames);
  const mod = modulation(frames, frameRate);

  // 점수: 잡음 위로 솟은 정도 · 하모닉 · 출렁임을 각각 0~1로 눌러 곱한다.
  // 하나라도 아니면 0에 가까워야 하므로 더하기가 아니라 곱하기다.
  const score = new Float32Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    const snr = frames[i].bandDb - floor[i];
    const a = clamp01((snr - o.snrDb) / 6);
    const b = clamp01((frames[i].harmonic - 0.3) / 0.35);
    const c = clamp01((mod[i] - 0.8) / 2.0);
    score[i] = a * b * c;
  }
  // 한 음절이 잠깐 약해져도 끊기지 않도록 살짝 눌러 편다
  const smoothed = smooth(score, 2);

  // 들어갈 때는 엄하게, 나올 때는 느슨하게 (한 번 말이 시작되면 잘 안 끊기게)
  const spans: { from: number; to: number }[] = [];
  let inSpeech = false;
  let start = 0;
  for (let i = 0; i < smoothed.length; i++) {
    if (!inSpeech && smoothed[i] > 0.35) { inSpeech = true; start = i; }
    else if (inSpeech && smoothed[i] < 0.12) { inSpeech = false; spans.push({ from: start, to: i }); }
  }
  if (inSpeech) spans.push({ from: start, to: smoothed.length });

  const toMs = (frame: number) => (frame * HOP * 1000) / o.sampleRate;
  const totalMs = (pcm.length * 1000) / o.sampleRate;

  // 숨 쉬는 사이로 끊긴 것들을 먼저 잇는다
  const merged: { from: number; to: number }[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && toMs(s.from) - toMs(last.to) <= o.maxGapMs) last.to = s.to;
    else merged.push({ ...s });
  }

  const out: SpeechSpan[] = [];
  for (const s of merged) {
    if (toMs(s.to) - toMs(s.from) < o.minSpeechMs) continue;
    let sum = 0;
    for (let i = s.from; i < s.to; i++) sum += smoothed[i];
    out.push({
      startMs: Math.max(0, toMs(s.from) - o.padMs),
      endMs: Math.min(totalMs, toMs(s.to) + o.padMs),
      score: clamp01(sum / Math.max(1, s.to - s.from)),
    });
  }
  // 여유를 붙이다 겹친 것들을 정리한다
  return mergeOverlaps(out);
}

function mergeOverlaps(list: SpeechSpan[]): SpeechSpan[] {
  const out: SpeechSpan[] = [];
  for (const s of list) {
    const last = out[out.length - 1];
    if (last && s.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, s.endMs);
      last.score = Math.max(last.score, s.score);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** s16le 바이트를 -1~1 실수로 편다 */
export function pcmFromBytes(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const n = Math.floor(bytes.byteLength / 2);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true) / 32768;
  return out;
}

/** 말한 구간의 총 길이(ms) */
export function speechTotalMs(spans: SpeechSpan[]): number {
  return spans.reduce((a, s) => a + (s.endMs - s.startMs), 0);
}
