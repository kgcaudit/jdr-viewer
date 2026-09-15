import { describe, expect, it } from 'vitest';
import { deriveStays, staysSummary, type StayInput } from '../src/core/stays';

const T0 = Date.UTC(2026, 8, 12, 8, 0, 0);
const M = 1 / 111_320; // 대략 1 m에 해당하는 위도 증분

/** min분 동안 같은 자리(살짝 흔들리며)에 머문 점들 */
function stayPoints(startMin: number, durMin: number, lat: number, lon: number, stepSec = 60): StayInput[] {
  const out: StayInput[] = [];
  for (let s = 0; s <= durMin * 60; s += stepSec) {
    out.push({
      t: T0 + (startMin * 60 + s) * 1000,
      lat: lat + (Math.sin(s) * 10) * M, // ±10 m 지터
      lon: lon + (Math.cos(s) * 10) * M,
    });
  }
  return out;
}

describe('체류 도출', () => {
  it('한 자리에 오래 머물면 체류 하나 (시작~끝, 머문 시간)', () => {
    const pts = stayPoints(0, 20, 37.5, 127.0); // 20분 체류
    const stays = deriveStays(pts);
    expect(stays).toHaveLength(1);
    expect(stays[0].fromMs).toBe(T0);
    expect(stays[0].durationMs).toBe(20 * 60_000);
  });

  it('짧게 스친 곳은 체류가 아니다 (최소 시간 미만)', () => {
    const pts = stayPoints(0, 2, 37.5, 127.0); // 2분 < 기본 5분
    expect(deriveStays(pts)).toHaveLength(0);
  });

  it('멀리 이동하는 구간은 체류가 없다', () => {
    const pts: StayInput[] = [];
    for (let i = 0; i < 20; i++) pts.push({ t: T0 + i * 60_000, lat: 37.5 + i * 300 * M, lon: 127.0 }); // 매분 300 m
    expect(deriveStays(pts)).toHaveLength(0);
  });

  it('머물다 이동하다 다시 머물면 체류 둘', () => {
    const a = stayPoints(0, 10, 37.50, 127.00);
    const move: StayInput[] = [
      { t: T0 + 11 * 60_000, lat: 37.55, lon: 127.05 },
      { t: T0 + 12 * 60_000, lat: 37.60, lon: 127.10 },
    ];
    const b = stayPoints(20, 10, 37.65, 127.15);
    const stays = deriveStays([...a, ...move, ...b]);
    expect(stays).toHaveLength(2);
    expect(stays[0].lat).toBeCloseTo(37.50, 2);
    expect(stays[1].lat).toBeCloseTo(37.65, 2);
  });

  it('반경·최소시간을 조절할 수 있다', () => {
    const pts = stayPoints(0, 3, 37.5, 127.0);
    expect(deriveStays(pts, { minStayMs: 2 * 60_000 })).toHaveLength(1); // 2분 기준이면 잡힌다
  });

  it('주소가 있으면 대표 주소를 담는다', () => {
    const pts = stayPoints(0, 10, 37.5, 127.0).map((p, i) => ({ ...p, addr: i === 0 ? '집' : '집 근처' }));
    expect(deriveStays(pts)[0].addr).toBe('집');
  });

  it('합계가 곳 수와 총 머문 시간을 낸다', () => {
    const a = stayPoints(0, 10, 37.50, 127.00);
    const b = stayPoints(20, 15, 37.65, 127.15);
    const sum = staysSummary(deriveStays([...a, ...b]));
    expect(sum.places).toBe(2);
    expect(sum.totalMs).toBe(25 * 60_000);
  });
});
