/**
 * 세그먼트 모음 = 하나의 벽시계 타임라인.
 *
 * 병합은 "이어 붙이기"이지 원본을 바꾸는 게 아니다.
 * 어느 시각이 어느 파일에서 왔는지 항상 되짚을 수 있어야 한다.
 *
 * 기기는 한 번의 주행을 **두 폴더에 나눠 쓴다.**
 *   data  — 평상시 순환 녹화
 *   event — 충격 등으로 이벤트가 걸린 구간
 *
 * 그러므로 둘을 함께 놓아야 주행 하나가 온전해진다.
 * 다만 기종에 따라 event가 data의 **사본**이기도 하고 **대체**이기도 하다.
 *   사본이면 → 같은 시각이 두 번 들어와 재생이 되풀이된다
 *   대체면  → data만 보면 그 자리에 없는 빈 구간이 생긴다
 *
 * 그래서 **data를 기본 줄기로 삼고, event는 비어 있는 자리만 채운다.**
 * 채우지 않은 event 파일도 버리지 않는다 — "여기서 이벤트가 걸렸다"는
 * 사실 자체가 감사에서 가장 중요한 정보이므로 표시로 남긴다.
 */
import type { SegmentInfo } from './segment';

/** 이벤트(충격) 폴더인가. 기기마다 Event/event/EVENT로 제각각이다. */
export function isEventFolder(folder: string): boolean {
  return /event/i.test(folder);
}

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

/** 이벤트가 걸린 구간 — 재생 줄기에 들어갔든 아니든 표시로 남긴다 */
export interface EventMark {
  fromMs: number;
  toMs: number;
  name: string;
  path: string;
  /** 재생 줄기에 들어갔는가 (data에 없던 자리를 채운 경우) */
  inChain: boolean;
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
  /** 이벤트 구간 (event 폴더) */
  events: EventMark[];
  /** 이미 덮인 시각이라 재생 줄기에서 뺀 파일 — 목록에는 남긴다 */
  duplicates: SegmentInfo[];
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

/** 이벤트 파일이 이만큼은 새로 채워야 재생 줄기에 넣는다 */
const EVENT_FILL_MIN_MS = 2000;

/**
 * data를 줄기로 삼고 event는 빈 자리만 채운다.
 *
 * event가 data의 사본이면 같은 시각이 두 번 재생되므로 줄기에서 빼고,
 * data를 대체한 것이면 그 자리를 채워 주행이 끊기지 않게 한다.
 * 어느 쪽이든 이벤트가 걸린 시각은 `events`에 남는다.
 */
function buildChain(valid: SegmentInfo[]): {
  chain: SegmentInfo[]; duplicates: SegmentInfo[]; events: EventMark[];
} {
  const byTime = (a: SegmentInfo, b: SegmentInfo) =>
    a.startMs - b.startMs || a.name.localeCompare(b.name);
  const base = valid.filter((s) => !isEventFolder(s.folder)).sort(byTime);
  const evt = valid.filter((s) => isEventFolder(s.folder)).sort(byTime);
  // event 폴더뿐이면 그게 곧 줄기다
  if (base.length === 0) {
    return {
      chain: evt,
      duplicates: [],
      events: evt.map((s) => ({ fromMs: s.startMs, toMs: s.endMs, name: s.name, path: s.path, inChain: true })),
    };
  }

  /** 이미 덮인 구간들 (시각 순, 겹치지 않음) */
  const covered: { from: number; to: number }[] = [];
  const addCover = (from: number, to: number): void => {
    covered.push({ from, to });
    covered.sort((a, b) => a.from - b.from);
    for (let i = 1; i < covered.length; i++) {
      if (covered[i].from <= covered[i - 1].to) {
        covered[i - 1].to = Math.max(covered[i - 1].to, covered[i].to);
        covered.splice(i--, 1);
      }
    }
  };
  const uncoveredMs = (from: number, to: number): number => {
    let left = to - from;
    for (const c of covered) {
      const lo = Math.max(from, c.from);
      const hi = Math.min(to, c.to);
      if (hi > lo) left -= hi - lo;
    }
    return Math.max(0, left);
  };

  for (const s of base) addCover(s.startMs, s.endMs);

  const chain = [...base];
  const duplicates: SegmentInfo[] = [];
  const events: EventMark[] = [];
  for (const s of evt) {
    const fills = uncoveredMs(s.startMs, s.endMs) >= EVENT_FILL_MIN_MS;
    if (fills) {
      chain.push(s);
      addCover(s.startMs, s.endMs);
    } else {
      duplicates.push(s);
    }
    events.push({ fromMs: s.startMs, toMs: s.endMs, name: s.name, path: s.path, inChain: fills });
  }
  chain.sort(byTime);
  return { chain, duplicates, events };
}

export function buildLibrary(all: SegmentInfo[]): Library {
  const invalid = all.filter((s) => s.error);
  const valid = all.filter((s) => !s.error && Number.isFinite(s.startMs));
  const { chain: segments, duplicates, events } = buildChain(valid);

  const lib: Library = {
    segments, invalid, startMs: NaN, endMs: NaN, spanMs: 0, coveredMs: 0,
    gaps: [], overlaps: [], events, duplicates,
    totalBytes: all.reduce((s, x) => s + x.size, 0),
  };
  recomputeLibrary(lib);
  return lib;
}

/**
 * 시각이 바뀐 뒤 파생값을 다시 계산한다.
 *
 * 프로브는 헤더만 읽으므로 종료 시각이 실제보다 이를 수 있다. 그 파일을
 * 실제로 열어 보면 진짜 시각을 알게 되는데, 그때 **빈 구간과 겹침을 다시
 * 계산해야** 화면이 사실과 맞는다. 그대로 두면 없는 빈 구간이 계속 남는다.
 */
export function recomputeLibrary(lib: Library): void {
  const segments = lib.segments;
  segments.sort((a, b) => a.startMs - b.startMs || a.name.localeCompare(b.name));
  lib.gaps = [];
  lib.overlaps = [];
  if (segments.length === 0) {
    lib.startMs = NaN;
    lib.endMs = NaN;
    lib.spanMs = 0;
    lib.coveredMs = 0;
    return;
  }

  lib.startMs = segments[0].startMs;
  let endMs = segments[0].endMs;
  for (let i = 1; i < segments.length; i++) {
    const prevEnd = endMs;
    const cur = segments[i];
    if (cur.startMs - prevEnd > GAP_THRESHOLD_MS) {
      const before = segments[i - 1];
      const a = fileNumberOf(before.name);
      const b = fileNumberOf(cur.name);
      lib.gaps.push({
        fromMs: prevEnd, toMs: cur.startMs, durationMs: cur.startMs - prevEnd,
        beforeName: before.name, afterName: cur.name,
        numberSkip: Number.isFinite(a) && Number.isFinite(b) && b > a ? b - a - 1 : -1,
      });
    } else if (cur.startMs < prevEnd - OVERLAP_THRESHOLD_MS) {
      lib.overlaps.push({ a: i - 1, b: i, fromMs: cur.startMs, toMs: Math.min(prevEnd, cur.endMs) });
    }
    endMs = Math.max(endMs, cur.endMs);
  }
  lib.endMs = endMs;
  lib.spanMs = endMs - lib.startMs;

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
  lib.coveredMs = coveredMs;
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
