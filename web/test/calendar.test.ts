import { describe, expect, it } from 'vitest';
import { formatDurationKo } from '../src/core/time';
import { buildCalendar, dayKeyOf, monthGrid, SESSION_GAP_MS } from '../src/core/calendar';
import type { SegmentInfo } from '../src/core/segment';

const T = (day: number, h: number, m: number, s = 0) => Date.UTC(2026, 8, day, h, m, s);

const seg = (name: string, start: number, durSec: number, folder = 'data'): SegmentInfo => ({
  id: `${folder}/${name}`, name, path: `${folder}/${name}`, folder, size: 70 << 20,
  startMs: start, endMs: start + durSec * 1000, durationMs: durSec * 1000,
  packetCount: 5000, ch0Count: 2000, ch1Count: 2000, gpsCount: 70, sensorCount: 700,
  blockOffsets: [0], timeSource: 'header', endEstimated: false, headerShiftMs: 0,
});

describe('날짜 키', () => {
  it('기록된 벽시계 기준으로 만든다 (브라우저 타임존 무관)', () => {
    expect(dayKeyOf(Date.UTC(2026, 8, 9, 23, 59, 59))).toBe('2026-09-09');
    expect(dayKeyOf(Date.UTC(2026, 8, 10, 0, 0, 1))).toBe('2026-09-10');
    expect(dayKeyOf(Date.UTC(2026, 0, 5, 8, 0, 0))).toBe('2026-01-05');
  });
});

describe('캘린더 인덱스', () => {
  it('날짜별로 묶고 녹화량을 센다', () => {
    const cal = buildCalendar([
      seg('a.jdr', T(8, 22, 24), 69),
      seg('b.jdr', T(8, 22, 26), 69),
      seg('c.jdr', T(9, 8, 9), 69),
    ]);
    expect(cal.days.map((d) => d.key)).toEqual(['2026-09-08', '2026-09-09']);
    expect(cal.byKey.get('2026-09-08')!.segments).toHaveLength(2);
    expect(cal.months).toEqual([{ year: 2026, month: 9 }]);
    expect(cal.totalSegments).toBe(3);
  });

  it('실제 기기처럼 순번이 뒤섞여 있어도 날짜별로 정리한다', () => {
    const cal = buildCalendar([
      seg('00000465.jdr', T(9, 8, 30), 69),
      seg('00000001.jdr', T(3, 8, 9), 69),   // 번호는 작지만 더 이른 날
      seg('00000466.jdr', T(9, 8, 32), 69),
    ]);
    expect(cal.days.map((d) => d.key)).toEqual(['2026-09-03', '2026-09-09']);
    expect(cal.days[1].segments.map((s) => s.name)).toEqual(['00000465.jdr', '00000466.jdr']);
  });

  it('하루 안에서 공백이 크면 운행(세션)으로 나눈다', () => {
    // 실제 데이터 모양: 오전 출근 / 오후 퇴근
    const segs = [
      seg('m1.jdr', T(8, 8, 9), 69),
      seg('m2.jdr', T(8, 8, 10, 10), 69),
      seg('e1.jdr', T(8, 22, 9), 69),
      seg('e2.jdr', T(8, 22, 10, 10), 69),
    ];
    const day = buildCalendar(segs).byKey.get('2026-09-08')!;
    expect(day.sessions).toHaveLength(2);
    expect(day.sessions[0].segments.map((s) => s.name)).toEqual(['m1.jdr', 'm2.jdr']);
    expect(day.sessions[1].segments.map((s) => s.name)).toEqual(['e1.jdr', 'e2.jdr']);
    expect(day.sessions[0].coveredMs).toBe(2 * 69_000);
  });

  it('공백이 기준보다 짧으면 같은 운행으로 본다', () => {
    const gap = SESSION_GAP_MS - 60_000;
    const day = buildCalendar([
      seg('a.jdr', T(8, 8, 0), 69),
      seg('b.jdr', T(8, 8, 0) + 69_000 + gap, 69),
    ]).byKey.get('2026-09-08')!;
    expect(day.sessions).toHaveLength(1);
  });

  it('자정을 넘는 파일은 시작 날짜에 넣고 표시한다', () => {
    const cal = buildCalendar([seg('night.jdr', T(8, 23, 59, 30), 69)]);
    expect(cal.days.map((d) => d.key)).toEqual(['2026-09-08']);
    expect(cal.byKey.get('2026-09-08')!.crossesMidnight).toBe(true);
  });

  it('겹치는 구간은 녹화량을 한 번만 센다', () => {
    const day = buildCalendar([
      seg('data.jdr', T(8, 8, 0), 60, 'data'),
      seg('event.jdr', T(8, 8, 0, 20), 20, 'event'),
    ]).byKey.get('2026-09-08')!;
    expect(day.coveredMs).toBe(60_000);
  });

  it('히트맵 정규화 기준은 가장 많이 찍힌 날이다', () => {
    const cal = buildCalendar([
      seg('a.jdr', T(3, 8, 0), 69),
      seg('b.jdr', T(9, 8, 0), 69),
      seg('c.jdr', T(9, 8, 2), 69),
    ]);
    expect(cal.maxCoveredMs).toBe(2 * 69_000);
  });

  it('여러 달에 걸치면 달 목록을 만든다', () => {
    const cal = buildCalendar([
      seg('a.jdr', Date.UTC(2026, 7, 30, 8, 0), 69),
      seg('b.jdr', Date.UTC(2026, 8, 2, 8, 0), 69),
    ]);
    expect(cal.months).toEqual([{ year: 2026, month: 8 }, { year: 2026, month: 9 }]);
  });
});

describe('달력 그리드', () => {
  it('일요일 시작으로 앞뒤 빈칸을 채운다', () => {
    // 2026년 9월 1일은 화요일 → 앞에 빈칸 2개
    const cells = monthGrid(2026, 9);
    expect(cells.length % 7).toBe(0);
    expect(cells[0].inMonth).toBe(false);
    expect(cells[1].inMonth).toBe(false);
    expect(cells[2]).toEqual({ key: '2026-09-01', day: 1, inMonth: true });
    expect(cells.filter((c) => c.inMonth)).toHaveLength(30);
  });

  it('윤년 2월도 맞게 센다', () => {
    expect(monthGrid(2024, 2).filter((c) => c.inMonth)).toHaveLength(29);
    expect(monthGrid(2026, 2).filter((c) => c.inMonth)).toHaveLength(28);
  });
});

describe('길이 표기', () => {
  it('1시간 미만은 시간으로 읽히면 안 된다 — 49분을 49시간으로 보이던 문제', () => {
    expect(formatDurationKo(49 * 60 + 38.9)).toBe('49분 39초');
    expect(formatDurationKo(28 * 60 + 33.5)).toBe('28분 34초');
  });

  it('1시간 이상은 시간과 분으로', () => {
    expect(formatDurationKo(3600 + 13 * 60 + 26)).toBe('1시간 13분');
    expect(formatDurationKo(49 * 3600 + 38 * 60)).toBe('49시간 38분');
  });

  it('딱 떨어지면 뒷단위를 붙이지 않는다', () => {
    expect(formatDurationKo(3600)).toBe('1시간');
    expect(formatDurationKo(120)).toBe('2분');
  });

  it('1분 미만은 초로', () => {
    expect(formatDurationKo(38.9)).toBe('39초');
    expect(formatDurationKo(0)).toBe('0초');
  });

  it('말이 안 되는 값은 —', () => {
    expect(formatDurationKo(NaN)).toBe('—');
    expect(formatDurationKo(-1)).toBe('—');
  });

  it('시·분·초 어느 것인지 글자만 보고 알 수 있다', () => {
    // 콜론 표기는 단위를 알 수 없다. 그게 이번 문제의 원인이었다.
    for (const sec of [59, 60, 3599, 3600, 3661, 90_000]) {
      const out = formatDurationKo(sec);
      expect(out, `${sec}초`).toMatch(/시간|분|초/);
      expect(out, `${sec}초`).not.toContain(':');
    }
  });
});
