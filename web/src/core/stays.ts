/**
 * 체류(머문 곳) 도출.
 *
 * 휴대폰 위치 점들 중 **연속으로 같은 자리에 머문** 구간을 묶어 하나의 체류로
 * 만든다. "각 좌표에서 얼마나 머물렀나" — 시각 범위(시작~끝)와 머문 시간을 낸다.
 *
 * 왜 점의 staytime 필드가 아니라 궤적에서 도출하나: staytime은 점 하나에 붙은
 * 값이라 "언제부터 언제까지"가 안 나온다. 연속 점을 묶으면 시작~끝이 명확하다.
 */
import { haversineM } from './phone-track';

/** 체류 도출에 필요한 최소 점 모양 */
export interface StayInput {
  t: number;
  lat: number;
  lon: number;
  addr?: string;
}

export interface Stay {
  fromMs: number;
  toMs: number;
  durationMs: number;
  /** 대표 좌표 (묶음의 첫 점) */
  lat: number;
  lon: number;
  /** 주소 라벨 (있으면) */
  addr: string;
  /** 묶인 점 개수 */
  count: number;
}

export interface StayOptions {
  /** 이 반경(m) 안에 머물면 같은 자리로 본다 */
  radiusM: number;
  /** 이 시간(ms) 이상 머물러야 체류로 친다 */
  minStayMs: number;
}

export const DEFAULT_STAY: StayOptions = {
  radiusM: 60,
  minStayMs: 5 * 60_000,
};

/**
 * 시각 순 점들에서 체류를 도출한다.
 *
 * 첫 점을 기준(anchor)으로, 반경 안에 있는 연속 점을 계속 묶는다. 벗어나면
 * 그 묶음을 마감하고 다음 점에서 새로 시작한다. 묶음의 시간 폭이 최소 체류
 * 시간을 넘으면 체류로 남긴다(움직이는 구간은 묶음이 1점이라 걸러진다).
 */
export function deriveStays(points: StayInput[], options: Partial<StayOptions> = {}): Stay[] {
  const opt = { ...DEFAULT_STAY, ...options };
  const stays: Stay[] = [];
  let i = 0;
  while (i < points.length) {
    const anchor = points[i];
    let j = i + 1;
    while (j < points.length && haversineM(anchor.lat, anchor.lon, points[j].lat, points[j].lon) <= opt.radiusM) {
      j++;
    }
    const last = points[j - 1];
    const durationMs = last.t - anchor.t;
    if (j - i >= 2 && durationMs >= opt.minStayMs) {
      stays.push({
        fromMs: anchor.t, toMs: last.t, durationMs,
        lat: anchor.lat, lon: anchor.lon,
        addr: anchor.addr ?? '', count: j - i,
      });
      i = j;
    } else {
      // 체류가 아니면 한 점만 넘어가 다음 자리를 본다 (이동 구간)
      i = i + 1 < j ? j : i + 1;
    }
  }
  return stays;
}

/** 체류 합계 (총 몇 곳, 총 머문 시간) */
export function staysSummary(stays: Stay[]): { places: number; totalMs: number } {
  return {
    places: stays.length,
    totalMs: stays.reduce((s, x) => s + x.durationMs, 0),
  };
}
