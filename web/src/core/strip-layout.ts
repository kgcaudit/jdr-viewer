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
 *
 * 그것만으로는 부족하다. 한 운행에 파일 60개면 구간 하나가 1.5%인데,
 * 폰 390px에서는 5.9px다. 그래서 **구간마다 최소 폭을 보장**한다
 * (`minSegmentFraction`). 그만큼 긴 구간에서 덜어 오므로 길이 비율은
 * 약간 왜곡되지만, 누를 수 없는 구간보다는 낫다.
 *
 * 빈 구간의 폭은 **실제 길이에 비례**해야 한다. 예전에는 길이와 무관하게
 * 하나당 2%를 줬는데, 파일 사이가 몇 초씩 벌어진 운행에서는 빗금이 화면의
 * 30%를 덮어 "영상이 다 끊긴" 것처럼 보였다. 실제로는 3%도 안 비었는데도.
 */
import type { Library } from './library';

/**
 * 빈 구간이 다 합쳐서 차지할 수 있는 최대 비율.
 *
 * 13시간짜리 공백이 축을 통째로 먹으면 정작 영상이 안 보인다.
 */
const GAP_TOTAL_MAX = 0.3;
/** 빈 구간 하나의 최대 비율 (하나가 다 먹지 않도록) */
const GAP_UNIT_MAX = 0.06;
/** 폭을 몰라 픽셀 하한을 못 받을 때 쓰는 최소 비율 */
const GAP_MIN_FALLBACK = 0.004;
/** 최소 폭 보정이 수렴할 때까지 도는 횟수 (보통 2회면 끝난다) */
const FIT_PASSES = 6;

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

/**
 * 구간별 폭(합 = share)을 구한다.
 * 길이에 비례하되, 어느 것도 min보다 좁아지지 않게 한다.
 */
function fitWidths(durations: number[], share: number, min: number): number[] {
  const n = durations.length;
  if (n === 0) return [];
  // 최소 폭만으로 이미 꽉 차면 길이를 포기하고 똑같이 나눈다
  if (min * n >= share) return durations.map(() => share / n);

  const widths = new Array<number>(n);
  const pinned = new Array<boolean>(n).fill(false);
  for (let pass = 0; pass < FIT_PASSES; pass++) {
    let freeShare = share;
    let freeTotal = 0;
    for (let i = 0; i < n; i++) {
      if (pinned[i]) freeShare -= min;
      else freeTotal += durations[i];
    }
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (pinned[i]) { widths[i] = min; continue; }
      const w = freeTotal > 0 ? (durations[i] / freeTotal) * freeShare : freeShare / n;
      if (w < min) { pinned[i] = true; changed = true; }
      widths[i] = Math.max(w, min);
    }
    if (!changed) break;
  }
  return widths;
}

export class StripLayout {
  readonly items: StripItem[] = [];

  /**
   * @param minSegmentFraction 구간 하나가 가질 최소 폭(0~1). 화면 폭을 아는
   *   쪽에서 `6px / 트랙폭`처럼 넘긴다. 0이면 예전처럼 길이에만 비례한다.
   */
  constructor(lib: Library, minSegmentFraction = 0, minGapFraction = 0) {
    const segs = lib.segments;
    if (segs.length === 0) return;

    const gapWidths = this.fitGaps(lib, minGapFraction);
    const gapShare = gapWidths.reduce((a, b) => a + b, 0);
    const segShare = 1 - gapShare;

    const min = Math.max(0, Math.min(minSegmentFraction, segShare / segs.length));
    const widths = fitWidths(segs.map((s) => Math.max(1, s.durationMs)), segShare, min);

    // 세그먼트와 빈 구간을 시각 순으로 번갈아 배치한다
    let cursor = 0;
    let gapIdx = 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (gapIdx < lib.gaps.length && lib.gaps[gapIdx].toMs <= s.startMs) {
        const g = lib.gaps[gapIdx];
        this.items.push({ kind: 'gap', index: gapIdx, from: cursor, to: cursor + gapWidths[gapIdx], startMs: g.fromMs, endMs: g.toMs });
        cursor += gapWidths[gapIdx];
        gapIdx++;
      }
      this.items.push({ kind: 'segment', index: i, from: cursor, to: cursor + widths[i], startMs: s.startMs, endMs: s.endMs });
      cursor += widths[i];
    }
    // 반올림 오차로 끝이 1에 못 미치는 것을 맞춰 준다
    const last = this.items[this.items.length - 1];
    if (last) last.to = 1;
  }

  /**
   * 빈 구간들의 폭.
   *
   * 원칙은 "실제 비어 있는 만큼만 차지한다"이다. 다만 두 가지를 손본다.
   *   - 너무 얇아 안 보이면 최소 폭을 준다 (있다는 사실은 보여야 한다)
   *   - 13시간짜리 공백이 축을 다 먹지 않게 하나·합계에 상한을 둔다
   */
  private fitGaps(lib: Library, minGapFraction: number): number[] {
    const n = lib.gaps.length;
    if (n === 0) return [];

    const gapTotal = lib.gaps.reduce((a, g) => a + Math.max(1, g.durationMs), 0);
    const timeTotal = gapTotal + lib.coveredMs;
    // 실제로 비어 있는 비율. 3%만 비었으면 빗금도 3%여야 한다.
    const natural = timeTotal > 0 ? gapTotal / timeTotal : 0;

    const min = minGapFraction > 0 ? minGapFraction : GAP_MIN_FALLBACK;
    const budget = Math.min(Math.max(natural, min * n), GAP_TOTAL_MAX);

    const widths = lib.gaps.map((g) => (Math.max(1, g.durationMs) / gapTotal) * budget);
    // 하나가 다 먹지 않게, 또 안 보일 만큼 얇지 않게
    let fixed = widths.map((w) => Math.max(min, Math.min(w, GAP_UNIT_MAX)));
    const sum = fixed.reduce((a, b) => a + b, 0);
    if (sum > GAP_TOTAL_MAX) fixed = fixed.map((w) => (w / sum) * GAP_TOTAL_MAX);
    return fixed;
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

  /** 축 위치가 걸린 항목 */
  itemAt(ratio: number): StripItem | null {
    if (this.items.length === 0) return null;
    const r = Math.max(0, Math.min(1, ratio));
    for (const it of this.items) if (r <= it.to) return it;
    return this.items[this.items.length - 1];
  }

  /**
   * 축 위치 → "실제로 갈 수 있는" 절대 시각.
   *
   * 빈 구간을 누르면 녹화가 없는 시각이 나와 재생이 엉뚱한 곳으로 간다.
   * 그래서 빈 구간에 걸리면 **가까운 쪽 구간의 시작/끝**으로 붙인다.
   */
  snapTime(ratio: number): number {
    const it = this.itemAt(ratio);
    if (!it) return 0;
    if (it.kind === 'segment') return this.timeAt(ratio);

    const i = this.items.indexOf(it);
    const prev = this.items[i - 1];
    const next = this.items[i + 1];
    const width = it.to - it.from;
    const t = width > 0 ? (Math.max(0, Math.min(1, ratio)) - it.from) / width : 0;
    if (t < 0.5 && prev) return prev.endMs;
    if (next) return next.startMs;
    return prev ? prev.endMs : it.startMs;
  }

  /** 축 위치가 가리키는 구간 번호. 빈 구간이면 붙게 될 구간을 준다. */
  segmentAt(ratio: number): number {
    const it = this.itemAt(ratio);
    if (!it) return -1;
    if (it.kind === 'segment') return it.index;
    const i = this.items.indexOf(it);
    const width = it.to - it.from;
    const t = width > 0 ? (Math.max(0, Math.min(1, ratio)) - it.from) / width : 0;
    const pick = t < 0.5 ? this.items[i - 1] : this.items[i + 1];
    return pick && pick.kind === 'segment' ? pick.index : -1;
  }
}
