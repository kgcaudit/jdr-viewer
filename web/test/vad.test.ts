/**
 * 말한 구간 찾기.
 *
 * 실제 블랙박스 녹음이 없으므로 **차내 소리를 흉내내 만든 신호**로 잰다.
 *  - 노면·엔진: 저역이 강한 광대역 잡음 (거의 일정)
 *  - 목소리: 기본 주파수 110~220Hz의 하모닉 + 초당 4음절로 끊기는 포락선
 *
 * 흉내는 흉내일 뿐이라, 여기 통과했다고 실기기에서 잘 된다는 뜻은 아니다.
 * 다만 "일정한 잡음은 말로 세지 않는다"는 건 확실히 확인할 수 있다.
 */
import { describe, expect, it } from 'vitest';
import { detectSpeech, pcmFromBytes, speechTotalMs, type SpeechSpan } from '../src/core/vad';

const SR = 8000;

/** 저역이 강한 광대역 잡음 = 노면·엔진 */
function roadNoise(seconds: number, level: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  let lp = 0;
  let seed = 12345;
  for (let i = 0; i < out.length; i++) {
    // 되풀이 가능한 난수 (테스트가 흔들리면 안 된다)
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const white = (seed / 0x3fffffff) - 1;
    lp = lp * 0.92 + white * 0.08;          // 저역 성분
    out[i] = (lp * 3 + white * 0.25) * level;
  }
  return out;
}

/** 하모닉 + 음절 포락선 = 목소리 */
function voice(seconds: number, f0: number, level: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    let v = 0;
    // 배음 8개까지 (8kHz니까 4kHz 아래만 의미가 있다)
    for (let h = 1; h <= 8; h++) {
      const f = f0 * h;
      if (f > 3600) break;
      v += Math.sin(2 * Math.PI * f * t) / h;
    }
    // 초당 4음절로 끊기는 포락선 — 말의 결정적 특징
    const syl = Math.max(0, Math.sin(2 * Math.PI * 4 * t));
    out[i] = v * syl * level;
  }
  return out;
}

/** [from, to) 초 구간에 목소리를 얹는다 */
function mix(base: Float32Array, from: number, to: number, v: Float32Array): void {
  const at = Math.round(from * SR);
  const n = Math.min(Math.round((to - from) * SR), v.length, base.length - at);
  for (let i = 0; i < n; i++) base[at + i] += v[i];
}

/** 구간이 [from, to] 초를 덮는가 */
function covers(spans: SpeechSpan[], from: number, to: number): boolean {
  return spans.some((s) => s.startMs <= from * 1000 + 400 && s.endMs >= to * 1000 - 400);
}

describe('말한 구간 찾기', () => {
  it('노면 잡음만 있으면 아무것도 찾지 않는다', () => {
    const spans = detectSpeech(roadNoise(20, 0.15));
    expect(speechTotalMs(spans), `잘못 잡은 구간: ${JSON.stringify(spans)}`).toBe(0);
  });

  it('조용한 주차 구간(거의 무음)에서도 찾지 않는다', () => {
    expect(detectSpeech(roadNoise(20, 0.002))).toEqual([]);
  });

  it('완전 무음에서도 터지지 않는다', () => {
    expect(detectSpeech(new Float32Array(SR * 10))).toEqual([]);
  });

  it('잡음 속의 말 한 마디를 찾는다', () => {
    const x = roadNoise(20, 0.1);
    mix(x, 6, 9, voice(3, 140, 0.5));
    const spans = detectSpeech(x);
    expect(spans.length).toBeGreaterThan(0);
    expect(covers(spans, 6, 9), `찾은 구간: ${JSON.stringify(spans)}`).toBe(true);
  });

  it('떨어져 있는 두 마디를 따로 찾는다', () => {
    const x = roadNoise(30, 0.1);
    mix(x, 4, 7, voice(3, 130, 0.5));
    mix(x, 18, 21, voice(3, 200, 0.5));
    const spans = detectSpeech(x);
    expect(spans).toHaveLength(2);
    expect(covers(spans, 4, 7)).toBe(true);
    expect(covers(spans, 18, 21)).toBe(true);
  });

  it('숨 쉬는 사이로 끊긴 말은 한 구간으로 잇는다', () => {
    const x = roadNoise(20, 0.1);
    mix(x, 5, 7, voice(2, 150, 0.5));
    mix(x, 7.2, 9, voice(1.8, 150, 0.5));
    const spans = detectSpeech(x);
    expect(spans, JSON.stringify(spans)).toHaveLength(1);
  });

  it('한참 끊기면 다른 구간으로 본다', () => {
    const x = roadNoise(20, 0.1);
    mix(x, 4, 6, voice(2, 150, 0.5));
    mix(x, 11, 13, voice(2, 150, 0.5));   // 5초 사이
    expect(detectSpeech(x)).toHaveLength(2);
  });

  it('짧은 충격음(문 닫힘·경적)은 말로 세지 않는다', () => {
    const x = roadNoise(20, 0.1);
    const bang = new Float32Array(Math.round(0.15 * SR));
    for (let i = 0; i < bang.length; i++) {
      bang[i] = Math.sin(2 * Math.PI * 400 * (i / SR)) * Math.exp(-i / (SR * 0.03));
    }
    mix(x, 8, 8.15, bang);
    expect(detectSpeech(x)).toEqual([]);
  });

  it('앞뒤로 여유를 둬 첫 음절이 잘리지 않는다', () => {
    const x = roadNoise(20, 0.08);
    mix(x, 8, 11, voice(3, 150, 0.6));
    const s = detectSpeech(x)[0];
    expect(s.startMs).toBeLessThanOrEqual(8000);
    expect(s.endMs).toBeGreaterThanOrEqual(11000);
  });

  it('점수는 0~1이고, 또렷한 말이 더 높다', () => {
    const loud = roadNoise(20, 0.08);
    mix(loud, 6, 10, voice(4, 150, 0.8));
    const faint = roadNoise(20, 0.08);
    mix(faint, 6, 10, voice(4, 150, 0.18));

    const a = detectSpeech(loud)[0];
    const b = detectSpeech(faint)[0];
    expect(a.score).toBeGreaterThan(0);
    expect(a.score).toBeLessThanOrEqual(1);
    if (b) expect(a.score).toBeGreaterThan(b.score);
  });

  it('구간은 시각 순이고 겹치지 않는다', () => {
    const x = roadNoise(40, 0.1);
    for (const at of [3, 9, 16, 24, 33]) mix(x, at, at + 2.5, voice(2.5, 120 + at * 3, 0.5));
    const spans = detectSpeech(x);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].startMs).toBeGreaterThan(spans[i - 1].startMs);
      expect(spans[i].startMs).toBeGreaterThanOrEqual(spans[i - 1].endMs);
    }
  });

  it('잡음이 커지면 놓치기 시작한다 — 한계를 기록해 둔다', () => {
    const found: Record<string, boolean> = {};
    for (const noise of [0.05, 0.1, 0.2, 0.4]) {
      const x = roadNoise(20, noise);
      mix(x, 6, 10, voice(4, 150, 0.5));
      found[`잡음 ${noise}`] = covers(detectSpeech(x), 6, 10);
    }
    // 낮은 잡음에서는 반드시 찾아야 한다
    expect(found['잡음 0.05']).toBe(true);
    expect(found['잡음 0.1']).toBe(true);
    // 나머지는 기록만 — 실기기 값으로 문턱을 다시 잡을 때 기준이 된다
    console.log('VAD 잡음 한계:', found);
  });

  it('입력이 아주 짧으면 빈 배열이다', () => {
    expect(detectSpeech(new Float32Array(100))).toEqual([]);
  });
});

describe('PCM 변환', () => {
  it('s16le를 -1~1로 편다', () => {
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setInt16(0, 0, true);
    dv.setInt16(2, 32767, true);
    dv.setInt16(4, -32768, true);
    dv.setInt16(6, 16384, true);
    const pcm = pcmFromBytes(new Uint8Array(buf));
    expect(pcm[0]).toBe(0);
    expect(pcm[1]).toBeCloseTo(1, 3);
    expect(pcm[2]).toBe(-1);
    expect(pcm[3]).toBe(0.5);
  });

  it('홀수 바이트는 마지막 반 토막을 버린다', () => {
    expect(pcmFromBytes(new Uint8Array(5))).toHaveLength(2);
  });
});
