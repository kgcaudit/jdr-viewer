/**
 * 체류(머문 곳) 도출.
 *
 * **원본 staytime 이 근거다.** 도와줘 각 점에는 그 지점에 머문 시간(staytime, 초)이
 * 붙어 온다 — 우리가 위치 군집이나 속도로 "머문 것 같다"를 추정할 필요가 없다.
 * staytime 은 머무는 동안 계속 누적되므로, 한 지점의 마지막(=최대) staytime 이 그
 * 체류의 전체 시간이고, 도착 시각 = 그 점의 timestamp - staytime 이다.
 *
 * 그래서:
 *   - staytime 이 최소 기준(기본 5분) 이상인 점만 체류 후보로 본다.
 *   - 반경 안에서 이어지는 후보들은 같은 체류로 묶고, 그중 staytime 이 가장 큰 점을
 *     대표로 삼는다(누적 최댓값 = 전체 머문 시간).
 * 이동 중인 점은 staytime 이 몇 초라 자동으로 걸러진다.
 */
import { haversineM } from './phone-track';

/** 체류 도출에 필요한 최소 점 모양 */
export interface StayInput {
  t: number;
  lat: number;
  lon: number;
  addr?: string;
  /** 원본 staytime(ms) — 이 지점에 머문 시간. 체류 판단의 근거. */
  stayMs: number;
}

export interface Stay {
  fromMs: number;
  toMs: number;
  durationMs: number;
  /** 대표 좌표 (staytime 최대 점) */
  lat: number;
  lon: number;
  /** 주소 라벨 (있으면) */
  addr: string;
  /** 묶인 점 개수 */
  count: number;
}

export interface StayOptions {
  /** 이 반경(m) 안에서 이어지는 체류 후보는 같은 자리로 본다 */
  radiusM: number;
  /** staytime 이 이 시간(ms) 이상이어야 체류로 친다 */
  minStayMs: number;
}

export const DEFAULT_STAY: StayOptions = {
  radiusM: 60,
  minStayMs: 5 * 60_000,
};

/**
 * 시각 순 점들에서 체류를 도출한다 (원본 staytime 기준).
 *
 * staytime 이 기준 이상인 점만 후보로 두고, 반경 안에서 이어지는 후보를 한 체류로
 * 묶어 그중 staytime 최대 점을 대표로 삼는다. 대표의 도착 시각은 timestamp에서
 * staytime 을 뺀 값이다.
 */
export function deriveStays(points: StayInput[], options: Partial<StayOptions> = {}): Stay[] {
  const opt = { ...DEFAULT_STAY, ...options };
  const stays: Stay[] = [];
  let group: StayInput[] = [];
  let prev: StayInput | null = null;

  const flush = (): void => {
    if (group.length === 0) return;
    // 누적 staytime 이 최대인 점이 그 체류의 전체 머문 시간을 담는다
    let rep = group[0];
    for (const p of group) if (p.stayMs > rep.stayMs) rep = p;
    // 대표 주소: 대표 점 우선, 없으면 묶음 중 처음 나오는 주소
    let addr = rep.addr ?? '';
    if (!addr) for (const p of group) { if (p.addr) { addr = p.addr; break; } }
    stays.push({
      fromMs: rep.t - rep.stayMs,
      toMs: rep.t,
      durationMs: rep.stayMs,
      lat: rep.lat, lon: rep.lon,
      addr, count: group.length,
    });
    group = [];
    prev = null;
  };

  for (const p of points) {
    if (!(p.stayMs >= opt.minStayMs)) { flush(); continue; } // 이동 중(짧은 staytime)은 끊는다
    if (prev && haversineM(prev.lat, prev.lon, p.lat, p.lon) <= opt.radiusM) {
      group.push(p);
    } else {
      flush();
      group = [p];
    }
    prev = p;
  }
  flush();
  return stays;
}

/** 체류 합계 (총 몇 곳, 총 머문 시간) */
export function staysSummary(stays: Stay[]): { places: number; totalMs: number } {
  return {
    places: stays.length,
    totalMs: stays.reduce((s, x) => s + x.durationMs, 0),
  };
}
