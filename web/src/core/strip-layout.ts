/**
 * 타임라인 스트립의 축 계산.
 *
 * 벽시계 비율을 그대로 쓰면 못 쓴다. 하루 범위가 15.6시간인데 파일 하나가 69초면
 * 구간 폭이 0.12%(화면에서 1.8px)가 되어 클릭조차 안 된다.
 * 실제 데이터의 대부분은 주차·정차 공백이기 때문이다.
 *
 * 그래서 **빈 구간만 눌러서** 그린다. 숨기지는 않는다 —
 * 빗금과 툴팁으로 공백의 실제 길이를 계속 보여준다(D2의 취지).
 * 시간 순서도 그대로다.
 */
import type { Library } from './library';

/** 빈 구간 하나가 축에서 차지할 비율 */
const GAP_UNIT = 0.02;
/** 빈 구간이 다 합쳐서 차지할 수 있는 최대 비율 */
const GAP_TOTAL_MAX = 0.3;

export interface StripItem {
  kind: 'segment' | 'gap';
  /** segment면 lib.segments의 인덱스, gap이면 lib.gaps의 인덱스 */
  index: number;
  /** 축에서의 위치 (0~1) */
  from: number;
  to: number;
  startMs: number;
  endMs: number;
}

export class StripLayout {
  readonly items: StripItem[] = [];

  constructor(lib: Library) {
    const segs = lib.segments;
    if (segs.length === 0) return;

    const covered = segs.reduce((a, s) => a + Math.max(1, s.durationMs), 0);
    const gapCount = lib.gaps.length;
    const gapShare = Math.min(gapCount * GAP_UNIT, GAP_TOTAL_MAX);
    const segShare = 1 - gapShare;
    const gapWidth = gapCount > 0 ? gapShare / gapCount : 0;

    // 세그먼트와 빈 구간을 시각 순으로 번갈아 배치한다
    let cursor = 0;
    let gapIdx = 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (gapIdx < gapCount && lib.gaps[gapIdx].toMs <= s.startMs) {
        const g = lib.gaps[gapIdx];
        this.items.push({ kind: 'gap', index: gapIdx, from: cursor, to: cursor + gapWidth, startMs: g.fromMs, endMs: g.toMs });
        cursor += gapWidth;
        gapIdx++;
      }
      const w = (Math.max(1, s.durationMs) / covered) * segShare;
      this.items.push({ kind: 'segment', index: i, from: cursor, to: cursor + w, startMs: s.startMs, endMs: s.endMs });
      cursor += w;
    }
    // 반올림 오차로 끝이 1에 못 미치는 것을 맞춰 준다
    const last = this.items[this.items.length - 1];
    if (last) last.to = 1;
  }

  /** 절대 시각 → 축 위치(0~1) */
  ratioAt(absMs: number): number {
    if (this.items.length === 0) return 0;
    for (const it of this.items) {
      if (absMs < it.startMs) return it.from;
      if (absMs <= it.endMs) {
        const span = it.endMs - it.startMs;
        const t = span > 0 ? (absMs - it.startMs) / span : 0;
        return it.from + t * (it.to - it.from);
      }
    }
    return 1;
  }

  /** 축 위치(0~1) → 절대 시각 */
  timeAt(ratio: number): number {
    if (this.items.length === 0) return 0;
    const r = Math.max(0, Math.min(1, ratio));
    for (const it of this.items) {
      if (r <= it.to) {
        const width = it.to - it.from;
        const t = width > 0 ? (r - it.from) / width : 0;
        return it.startMs + t * (it.endMs - it.startMs);
      }
    }
    return this.items[this.items.length - 1].endMs;
  }
}
