import { describe, expect, it } from 'vitest';
import {
  splitByDay, mergePoints, dayKeyOf, toMovePoint, movePointToFix,
  serializeMoveDays, parseMoveFile, MoveFileError, type MovePoint,
} from '../src/core/move-store';
import type { PhoneFix } from '../src/core/phone-track';

function fix(t: number, lat = 37.5, lon = 127): PhoneFix {
  return { timeMs: t, lat, lon, rawSpeed: 0, accuracyM: 10, activity: 'STILL', stayMs: 0, provider: 'gps', battery: 80, address: '' };
}
function pt(t: number, lat = 37.5, lon = 127): MovePoint {
  return { t, lat, lon, speed: 0, acc: 10, act: 'STILL' };
}

describe('이동기록 날짜 나누기', () => {
  it('벽시계 기준으로 날짜를 자른다 (KST 오프셋을 더하지 않는다)', () => {
    expect(dayKeyOf(Date.UTC(2026, 8, 12, 23, 59, 59))).toBe('2026-09-12');
    expect(dayKeyOf(Date.UTC(2026, 8, 13, 0, 0, 1))).toBe('2026-09-13');
  });

  it('여러 날에 걸친 점을 날짜별로 가른다', () => {
    const fixes = [
      fix(Date.UTC(2026, 8, 12, 8, 0, 0)),
      fix(Date.UTC(2026, 8, 12, 22, 0, 0)),
      fix(Date.UTC(2026, 8, 13, 7, 0, 0)),
    ];
    const m = splitByDay(fixes);
    expect(m.get('2026-09-12')).toHaveLength(2);
    expect(m.get('2026-09-13')).toHaveLength(1);
  });

  it('좌표가 0이면 버린다', () => {
    const m = splitByDay([fix(Date.UTC(2026, 8, 12, 8, 0, 0), 0, 0)]);
    expect(m.size).toBe(0);
  });
});

describe('이동기록 병합 (2,000건 상한으로 잘린 하루 채우기)', () => {
  it('같은 시각은 하나로, 새 시각만 더한다', () => {
    const existing = [pt(1000), pt(2000)];
    const incoming = [pt(2000), pt(3000)]; // 2000은 겹침
    const { points, added } = mergePoints(existing, incoming);
    expect(added).toBe(1);
    expect(points.map((p) => p.t)).toEqual([1000, 2000, 3000]);
  });

  it('먼저 있던 점을 지킨다 (안정적)', () => {
    const existing = [{ ...pt(1000), act: '먼저' }];
    const incoming = [{ ...pt(1000), act: '나중' }];
    const { points, added } = mergePoints(existing, incoming);
    expect(added).toBe(0);
    expect(points[0].act).toBe('먼저');
  });

  it('두 번째 업로드가 하루의 빈 뒷부분을 채운다', () => {
    // 1차: 0~2000건 상한으로 오전만, 2차: 오후 — 합치면 하루 전체
    const morning = Array.from({ length: 3 }, (_, i) => pt(i * 1000));
    const afternoon = Array.from({ length: 3 }, (_, i) => pt(10_000 + i * 1000));
    const step1 = mergePoints([], morning);
    const step2 = mergePoints(step1.points, afternoon);
    expect(step2.points).toHaveLength(6);
    expect(step2.added).toBe(3);
  });

  it('시각 순으로 세운다', () => {
    const { points } = mergePoints([pt(3000)], [pt(1000), pt(2000)]);
    expect(points.map((p) => p.t)).toEqual([1000, 2000, 3000]);
  });
});

describe('MovePoint ↔ PhoneFix 왕복', () => {
  it('필드가 보존된다', () => {
    const f = fix(1000, 37.51, 127.01);
    f.rawSpeed = 42; f.accuracyM = 13; f.activity = 'WALKING';
    const back = movePointToFix(toMovePoint(f));
    expect(back.timeMs).toBe(1000);
    expect(back.lat).toBe(37.51);
    expect(back.rawSpeed).toBe(42);
    expect(back.accuracyM).toBe(13);
    expect(back.activity).toBe('WALKING');
  });
});

describe('이동기록 파일 내보내기/불러오기', () => {
  it('직렬화·역직렬화가 왕복한다', () => {
    const days = [{ dayKey: '2026-09-12', points: [pt(1000), pt(2000)], updatedAt: 1, sources: ['a.txt'] }];
    const text = serializeMoveDays(days);
    const back = parseMoveFile(text);
    expect(back).toHaveLength(1);
    expect(back[0].points).toHaveLength(2);
    expect(back[0].sources).toEqual(['a.txt']);
  });

  it('JDR 이동기록 파일이 아니면 실패한다', () => {
    expect(() => parseMoveFile('{"format":"other"}')).toThrow(MoveFileError);
    expect(() => parseMoveFile('not json')).toThrow(MoveFileError);
  });
});
