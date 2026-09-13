/**
 * 날짜별 인덱스.
 *
 * 전체를 하나의 축에 올리면 못 쓴다 — 실제 데이터는 230시간 범위에 파일 하나가 69초라
 * 타임라인 구간이 1.8px짜리 실이 된다. 날짜로 끊으면 축이 24시간으로 줄어든다.
 *
 * 하루 안에서도 운행 시간대가 나뉘므로(출근/퇴근) 공백이 크면 세션으로 더 쪼갠다.
 */
import type { SegmentInfo } from './segment';

/** 이보다 긴 공백이면 다른 운행으로 본다 */
export const SESSION_GAP_MS = 10 * 60 * 1000;

export interface DaySession {
  startMs: number;
  endMs: number;
  /** 이 세션에 속한 세그먼트 (날짜 안에서의 순서) */
  segments: SegmentInfo[];
  /** 실제 영상 길이 합계 */
  coveredMs: number;
}

export interface DayEntry {
  /** 'YYYY-MM-DD' — 기기가 기록한 벽시계 기준 */
  key: string;
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  startMs: number;
  endMs: number;
  segments: SegmentInfo[];
  bytes: number;
  /** 실제 영상 길이 합계 (겹침 제외) */
  coveredMs: number;
  sessions: DaySession[];
  /** 자정을 넘어 다음 날까지 이어지는 파일이 있는가 */
  crossesMidnight: boolean;
}

export interface MonthKey {
  year: number;
  /** 1-12 */
  month: number;
}

export interface CalendarIndex {
  days: DayEntry[];
  byKey: Map<string, DayEntry>;
  months: MonthKey[];
  /** 히트맵 정규화용 — 가장 많이 찍힌 날의 영상 길이 */
  maxCoveredMs: number;
  totalSegments: number;
  totalBytes: number;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** 기록된 벽시계 기준 날짜 키. UTC 게터를 쓰는 이유는 time.ts 주석 참조. */
export function dayKeyOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function monthKeyOf(day: DayEntry): string {
  return `${day.year}-${pad(day.month)}`;
}

/** 하루의 세그먼트를 공백 기준으로 운행 단위로 나눈다 */
function splitSessions(segments: SegmentInfo[]): DaySession[] {
  const sessions: DaySession[] = [];
  let cur: DaySession | null = null;
  for (const s of segments) {
    if (!cur || s.startMs - cur.endMs > SESSION_GAP_MS) {
      cur = { startMs: s.startMs, endMs: s.endMs, segments: [s], coveredMs: 0 };
      sessions.push(cur);
    } else {
      cur.segments.push(s);
      cur.endMs = Math.max(cur.endMs, s.endMs);
    }
  }
  for (const s of sessions) s.coveredMs = coveredDuration(s.segments);
  return sessions;
}

/** 겹치는 구간을 한 번만 세는 실제 영상 길이 */
function coveredDuration(segments: SegmentInfo[]): number {
  let total = 0;
  let cursor = -Infinity;
  for (const s of segments) {
    const from = Math.max(s.startMs, cursor);
    if (s.endMs > from) {
      total += s.endMs - from;
      cursor = s.endMs;
    }
  }
  return total;
}

export function buildCalendar(all: SegmentInfo[]): CalendarIndex {
  const valid = all
    .filter((s) => !s.error && Number.isFinite(s.startMs))
    .sort((a, b) => a.startMs - b.startMs || a.name.localeCompare(b.name));

  const byKey = new Map<string, DayEntry>();
  for (const s of valid) {
    // 자정을 넘는 파일은 시작 날짜에 넣는다 — 단순하고 예측 가능하다
    const key = dayKeyOf(s.startMs);
    let day = byKey.get(key);
    if (!day) {
      const d = new Date(s.startMs);
      day = {
        key,
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        startMs: s.startMs,
        endMs: s.endMs,
        segments: [],
        bytes: 0,
        coveredMs: 0,
        sessions: [],
        crossesMidnight: false,
      };
      byKey.set(key, day);
    }
    day.segments.push(s);
    day.bytes += s.size;
    day.startMs = Math.min(day.startMs, s.startMs);
    day.endMs = Math.max(day.endMs, s.endMs);
    if (dayKeyOf(s.endMs) !== key) day.crossesMidnight = true;
  }

  const days = [...byKey.values()].sort((a, b) => a.startMs - b.startMs);
  for (const d of days) {
    d.coveredMs = coveredDuration(d.segments);
    d.sessions = splitSessions(d.segments);
  }

  const monthSeen = new Set<string>();
  const months: MonthKey[] = [];
  for (const d of days) {
    const mk = monthKeyOf(d);
    if (!monthSeen.has(mk)) {
      monthSeen.add(mk);
      months.push({ year: d.year, month: d.month });
    }
  }

  return {
    days,
    byKey,
    months,
    maxCoveredMs: days.reduce((m, d) => Math.max(m, d.coveredMs), 0),
    totalSegments: valid.length,
    totalBytes: all.reduce((s, x) => s + x.size, 0),
  };
}

/** 달력 그리드에 필요한 칸 목록 (앞뒤 빈칸 포함, 일요일 시작) */
export function monthGrid(year: number, month: number): { key: string; day: number; inMonth: boolean }[] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstWeekday = first.getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: { key: string; day: number; inMonth: boolean }[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push({ key: '', day: 0, inMonth: false });
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ key: `${year}-${pad(month)}-${pad(d)}`, day: d, inMonth: true });
  }
  while (cells.length % 7 !== 0) cells.push({ key: '', day: 0, inMonth: false });
  return cells;
}
