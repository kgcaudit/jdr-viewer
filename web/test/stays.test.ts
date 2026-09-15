import { describe, expect, it } from 'vitest';
import { deriveStays, staysSummary, type StayInput } from '../src/core/stays';

const T0 = Date.UTC(2026, 8, 12, 8, 0, 0);
const min = (m: number): number => m * 60_000;

/** 한 지점 후보 점 하나 — 원본 staytime(ms)이 곧 머문 시간 */
function pt(atMin: number, lat: number, lon: number, stayMs: number, addr?: string): StayInput {
  return { t: T0 + min(atMin), lat, lon, stayMs, addr };
}

describe('체류 도출 (원본 staytime 기준)', () => {
  it('실제 예: staytime 13082초 한 점이 3시간 38분 체류가 된다', () => {
    // 도와줘 발췌: 17:46:33 에 staytime 13082 → 도착은 그만큼 앞
    const rec = Date.UTC(2026, 8, 12, 17, 46, 33);
    const stays = deriveStays([{ t: rec, lat: 36.8738267, lon: 127.4712511, stayMs: 13082 * 1000 }]);
    expect(stays).toHaveLength(1);
    expect(stays[0].durationMs).toBe(13082 * 1000);
    expect(stays[0].toMs).toBe(rec);
    expect(stays[0].fromMs).toBe(rec - 13082 * 1000); // 도착 = timestamp - staytime
  });

  it('staytime 이 기준 이상이면 점 하나로도 체류', () => {
    const stays = deriveStays([pt(20, 37.5, 127.0, min(20))]);
    expect(stays).toHaveLength(1);
    expect(stays[0].durationMs).toBe(min(20));
    expect(stays[0].fromMs).toBe(T0); // 08:20 - 20분 = 08:00
  });

  it('staytime 이 짧으면(기본 5분 미만) 체류가 아니다', () => {
    expect(deriveStays([pt(2, 37.5, 127.0, min(2))])).toHaveLength(0);
  });

  it('이동 점(staytime 몇 초)들은 체류가 없다', () => {
    // 21:24 전후 주행 발췌처럼 staytime 6~7초
    const pts: StayInput[] = [];
    for (let i = 0; i < 8; i++) pts.push(pt(i, 36.87 + i * 0.001, 127.46, 7000));
    expect(deriveStays(pts)).toHaveLength(0);
  });

  it('한 자리 여러 점이면 누적 최대 staytime 이 전체 머문 시간', () => {
    // 같은 곳에서 staytime 이 60→600→1200초로 누적
    const stays = deriveStays([
      pt(1, 37.5, 127.0, 60_000),
      pt(10, 37.5001, 127.0001, 600_000),
      pt(20, 37.5, 127.0, 1_200_000),
    ]);
    expect(stays).toHaveLength(1);
    expect(stays[0].durationMs).toBe(1_200_000); // 20분
  });

  it('머물다 이동하다 다시 머물면 체류 둘', () => {
    const stays = deriveStays([
      pt(0, 37.50, 127.00, min(10)),   // 체류 A
      pt(11, 37.55, 127.05, 7000),     // 이동(짧은 staytime) → 끊김
      pt(12, 37.60, 127.10, 6000),     // 이동
      pt(30, 37.65, 127.15, min(15)),  // 체류 B
    ]);
    expect(stays).toHaveLength(2);
    expect(stays[0].lat).toBeCloseTo(37.50, 2);
    expect(stays[1].lat).toBeCloseTo(37.65, 2);
    expect(stays[1].durationMs).toBe(min(15));
  });

  it('반경 밖 후보는 서로 다른 체류로 나뉜다', () => {
    const stays = deriveStays([
      pt(0, 37.50, 127.00, min(10)),
      pt(20, 37.65, 127.15, min(12)), // 멀리 떨어진 다른 체류
    ]);
    expect(stays).toHaveLength(2);
  });

  it('최소 시간을 조절할 수 있다', () => {
    const stays = deriveStays([pt(3, 37.5, 127.0, min(3))], { minStayMs: min(2) });
    expect(stays).toHaveLength(1);
  });

  it('주소가 있으면 대표 주소를 담는다', () => {
    const stays = deriveStays([
      pt(1, 37.5, 127.0, 60_000, ''),
      pt(20, 37.5, 127.0, min(20), '집'),
    ]);
    expect(stays[0].addr).toBe('집');
  });

  it('합계가 곳 수와 총 머문 시간을 낸다', () => {
    const sum = staysSummary(deriveStays([
      pt(0, 37.50, 127.00, min(10)),
      pt(20, 37.65, 127.15, min(15)),
    ]));
    expect(sum.places).toBe(2);
    expect(sum.totalMs).toBe(min(25));
  });
});
