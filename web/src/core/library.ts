/**
 * 세그먼트 모음 = 하나의 벽시계 타임라인.
 *
 * 병합은 "이어 붙이기"이지 원본을 바꾸는 게 아니다.
 * 어느 시각이 어느 파일에서 왔는지 항상 되짚을 수 있어야 한다.
 */
import type { SegmentInfo } from './segment';

export interface Gap {
  fromMs: number;
  toMs: number;
  durationMs: number;
  /** 빈 구간 앞뒤 파일 — 원인을 되짚으려면 이게 있어야 한다 */
  beforeName: string;
  afterName: string;
  /**
   * 파일 번호가 몇 개 건너뛰었는가. `00000087` → `00000089`면 1.
   * 번호를 못 읽으면 -1.
   *
   * 이게 이 빈 구간의 성격을 가른다.
   *   번호가 건너뜀  → 파일이 실제로 없다 (덮어썼거나 지워졌다)
   *   번호가 이어짐  → 파일은 다 있는데 기록이 끊겼거나 시각이 어긋난 것
   */
  numberSkip: number;
}

export interface Overlap {
  /** 겹치는 두 세그먼트의 인덱스 */
  a: number;
  b: number;
  fromMs: number;
  toMs: number;
}

export interface Library {
  /** 시작 시각 순으로 정렬된 유효 세그먼트 */
  segments: SegmentInfo[];
  /** 읽지 못한 파일 (조용히 버리지 않고 사유와 함께 보여준다) */
  invalid: SegmentInfo[];
  startMs: number;
  endMs: number;
  /** 벽시계 기준 전체 길이 (갭 포함) */
  spanMs: number;
  /** 실제 영상이 있는 시간 합계 (갭 제외) */
  coveredMs: number;
  gaps: Gap[];
  overlaps: Overlap[];
  totalBytes: number;
}

/** 이보다 짧은 틈은 파일 경계의 오차로 보고 갭으로 세지 않는다. */
export const GAP_THRESHOLD_MS = 1500;

/** 파일명 끝의 순번 (`data/00000087.jdr` → 87). 못 읽으면 NaN. */
export function fileNumberOf(name: string): number {
  const m = /(\d+)(?:\.[^.]*)?$/.exec(name);
  return m ? Number(m[1]) : NaN;
}
/**
 * 겹침은 갭보다 민감하게 본다.
 * 같은 시각을 담은 파일이 있다는 사실 자체가 알려야 할 정보이기 때문이다
 * (예: event 폴더가 data와 겹침).
 */
export const OVERLAP_THRESHOLD_MS = 250;

export function buildLibrary(all: SegmentInfo[]): Library {
  const invalid = all.filter((s) => s.error);
  const segments = all
    .filter((s) => !s.error && Number.isFinite(s.startMs))
    .sort((a, b) => a.startMs - b.startMs || a.name.localeCompare(b.name));

  if (segments.length === 0) {
    return {
      segments: [], invalid, startMs: NaN, endMs: NaN, spanMs: 0, coveredMs: 0,
      gaps: [], overlaps: [], totalBytes: all.reduce((s, x) => s + x.size, 0),
    };
  }

  const startMs = segments[0].startMs;
  let endMs = segments[0].endMs;
  const gaps: Gap[] = [];
  const overlaps: Overlap[] = [];

  for (let i = 1; i < segments.length; i++) {
    const prevEnd = endMs;
    const cur = segments[i];
    if (cur.startMs - prevEnd > GAP_THRESHOLD_MS) {
      const before = segments[i - 1];
      const a = fileNumberOf(before.name);
      const b = fileNumberOf(cur.name);
      gaps.push({
        fromMs: prevEnd, toMs: cur.startMs, durationMs: cur.startMs - prevEnd,
        beforeName: before.name, afterName: cur.name,
        numberSkip: Number.isFinite(a) && Number.isFinite(b) && b > a ? b - a - 1 : -1,
      });
    } else if (cur.startMs < prevEnd - OVERLAP_THRESHOLD_MS) {
      overlaps.push({ a: i - 1, b: i, fromMs: cur.startMs, toMs: Math.min(prevEnd, cur.endMs) });
    }
    endMs = Math.max(endMs, cur.endMs);
  }

  // 겹침을 빼고 실제로 덮인 시간을 구한다
  let coveredMs = 0;
  let cursor = -Infinity;
  for (const s of segments) {
    const from = Math.max(s.startMs, cursor);
    if (s.endMs > from) {
      coveredMs += s.endMs - from;
      cursor = s.endMs;
    }
  }

  return {
    segments, invalid, startMs, endMs,
    spanMs: endMs - startMs,
    coveredMs,
    gaps, overlaps,
    totalBytes: all.reduce((s, x) => s + x.size, 0),
  };
}

/** 절대 시각이 속한 세그먼트 인덱스. 없으면 -1. */
export function segmentIndexAt(lib: Library, absMs: number): number {
  const segs = lib.segments;
  let lo = 0;
  let hi = segs.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].startMs <= absMs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // 겹치는 구간에서는 먼저 시작한 쪽을 쓴다 (D1: 연속 병합)
  if (best >= 0 && absMs <= segs[best].endMs) return best;
  return -1;
}

/**
 * 절대 시각에서 재생을 이어갈 위치를 찾는다.
 * 빈 구간이면 다음 세그먼트 시작으로 건너뛴다 (D2: 갭 건너뛰기).
 */
export function resolvePlayPosition(lib: Library, absMs: number): { index: number; absMs: number } | null {
  if (lib.segments.length === 0) return null;
  const direct = segmentIndexAt(lib, absMs);
  if (direct >= 0) return { index: direct, absMs };
  for (let i = 0; i < lib.segments.length; i++) {
    if (lib.segments[i].startMs > absMs) return { index: i, absMs: lib.segments[i].startMs };
  }
  const last = lib.segments.length - 1;
  return { index: last, absMs: lib.segments[last].endMs };
}

export function gapAt(lib: Library, absMs: number): Gap | null {
  for (const g of lib.gaps) {
    if (absMs >= g.fromMs && absMs < g.toMs) return g;
  }
  return null;
}
