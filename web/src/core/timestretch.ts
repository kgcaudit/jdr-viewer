/**
 * 음높이를 지키면서 속도만 바꾸는 시간 신축 (SOLA/WSOLA 계열).
 *
 * `AudioBufferSourceNode.playbackRate`를 쓰면 표본을 다시 뽑는 것이라
 * 2배속에서 목소리가 다람쥐가 된다. 블랙박스는 음성이 증거인 경우가 많아
 * 그건 못 쓴다.
 *
 * 원리는 단순하다. 파형을 겹치는 조각으로 자른 뒤, **조각을 꺼내 오는 간격만**
 * 배속에 맞춰 넓히거나 좁히고, 내보내는 간격은 그대로 둔다. 조각 하나의
 * 파형은 건드리지 않으므로 주파수(= 음높이)가 유지된다.
 *
 * 이어 붙이는 자리에서 위상이 어긋나면 "딱딱" 소리가 나므로, 이상적인 위치
 * ±`SEARCH`만큼을 훑어 **직전 꼬리와 가장 닮은 자리**를 골라 겹쳐 섞는다.
 * 이게 SOLA의 전부다.
 *
 * 8kHz 모노 음성은 이 방식이 가장 잘 맞는 신호다 (원래 전화 음성용으로 나왔다).
 */

/** 겹쳐 섞는 길이(표본). 8kHz에서 16ms — 음성 한 주기(최저 ~80Hz)보다 길다 */
const OVERLAP = 128;
/** 이상적인 위치에서 이만큼 앞뒤를 훑어 가장 닮은 자리를 찾는다 (8kHz에서 ±12ms) */
const SEARCH = 96;

/** 겹쳐 섞을 때 쓰는 창(0→1). 매번 만들지 않도록 한 번만 계산한다. */
const FADE = (() => {
  const w = new Float32Array(OVERLAP);
  for (let i = 0; i < OVERLAP; i++) w[i] = 0.5 - 0.5 * Math.cos((Math.PI * i) / (OVERLAP - 1));
  return w;
})();

/**
 * 이어지는 블록을 계속 밀어 넣으며 쓰는 신축기.
 *
 * 재생은 500ms짜리 조각을 잇달아 만들므로, 조각마다 따로 신축하면 경계에서
 * 위상이 끊긴다. 그래서 꼬리와 읽던 위치를 들고 다니며 **하나의 연속된 흐름**
 * 으로 처리한다.
 */
export class TimeStretcher {
  /** 아직 처리하지 못한 입력 (앞쪽은 소비되는 대로 버린다) */
  private buf = new Float32Array(0);
  /** buf[0]이 입력 전체에서 몇 번째 표본인지 */
  private bufStart = 0;
  /** 다음에 꺼내 올 이상적인 위치 (입력 전체 기준, 소수) */
  private anaPos = 0;
  /** 직전에 내보낸 조각의 꼬리 — 다음 조각을 고를 때의 본보기가 된다 */
  private tail: Float32Array | null = null;
  private speedValue = 1;

  /** 1보다 크면 빨라지고 작으면 느려진다. 음높이는 그대로다. */
  get speed(): number {
    return this.speedValue;
  }
  set speed(v: number) {
    const next = Math.max(0.25, Math.min(v, 8));
    if (next === this.speedValue) return;
    this.speedValue = next;
    this.reset();
  }

  reset(): void {
    this.buf = new Float32Array(0);
    this.bufStart = 0;
    this.anaPos = 0;
    this.tail = null;
  }

  /**
   * 입력 한 덩어리를 넣고, 지금까지 만들어진 출력을 받는다.
   * 배속이 1이면 손대지 않고 그대로 돌려준다 (완전 무손실).
   */
  push(input: Float32Array): Float32Array {
    if (this.speedValue === 1 && this.tail === null && this.buf.length === 0) return input;

    // 남은 입력 뒤에 새 입력을 붙인다
    const merged = new Float32Array(this.buf.length + input.length);
    merged.set(this.buf, 0);
    merged.set(input, this.buf.length);
    this.buf = merged;

    const anaHop = OVERLAP * this.speedValue;
    const out: Float32Array[] = [];

    for (;;) {
      const ideal = Math.round(this.anaPos) - this.bufStart;
      // 훑을 범위와 조각 하나(2×OVERLAP)를 다 담을 만큼 입력이 있어야 한다
      const lo = Math.max(0, ideal - SEARCH);
      const hi = ideal + SEARCH;
      if (lo < 0 || hi + 2 * OVERLAP > this.buf.length) break;

      const chosen = this.tail ? this.bestMatch(lo, hi, this.tail) : Math.max(0, ideal);

      const piece = new Float32Array(OVERLAP);
      if (this.tail) {
        for (let i = 0; i < OVERLAP; i++) {
          piece[i] = this.tail[i] * (1 - FADE[i]) + this.buf[chosen + i] * FADE[i];
        }
      } else {
        piece.set(this.buf.subarray(chosen, chosen + OVERLAP));
      }
      out.push(piece);

      // 고른 조각의 "자연스러운 다음"이 곧 다음번의 본보기가 된다
      this.tail = this.buf.slice(chosen + OVERLAP, chosen + 2 * OVERLAP);
      this.anaPos += anaHop;

      // 더 필요 없는 앞부분을 버린다 (훑을 여유는 남긴다)
      const keepFrom = Math.max(0, Math.round(this.anaPos) - this.bufStart - SEARCH - OVERLAP);
      if (keepFrom > 4096) {
        this.buf = this.buf.slice(keepFrom);
        this.bufStart += keepFrom;
      }
    }

    let total = 0;
    for (const p of out) total += p.length;
    const result = new Float32Array(total);
    let at = 0;
    for (const p of out) { result.set(p, at); at += p.length; }
    return result;
  }

  /** 본보기(tail)와 가장 닮은 자리를 찾는다 — 정규화 상호상관 */
  private bestMatch(lo: number, hi: number, tail: Float32Array): number {
    let best = lo;
    let bestScore = -Infinity;
    for (let c = lo; c <= hi; c++) {
      let dot = 0;
      let energy = 0;
      // 표본 두 개씩 건너뛴다 — 8kHz에서 품질 차이 없이 두 배 빠르다
      for (let i = 0; i < OVERLAP; i += 2) {
        const x = this.buf[c + i];
        dot += tail[i] * x;
        energy += x * x;
      }
      const score = energy > 1e-9 ? dot / Math.sqrt(energy) : 0;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }
}

/**
 * 한 덩어리를 통째로 신축한다 (테스트·일회성 용도).
 * 재생 경로는 `TimeStretcher`를 쓴다.
 */
export function stretch(input: Float32Array, speed: number): Float32Array {
  const s = new TimeStretcher();
  s.speed = speed;
  return s.push(input);
}
