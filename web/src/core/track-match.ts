/**
 * 휴대폰 동선 × 차량(JDR) GPS 대사.
 *
 * 목적: 휴대폰 위치 한 점 한 점이 그 시각에 **무엇을 하던 중**이었는지 가른다.
 *   - 이 차량 주행 : 같은 시각 차량 GPS가 곁에 있다(시간·거리 모두 가까움)
 *   - 보행         : 스스로 느리게 움직인다 + 차량 트랙 없음
 *   - 다른 이동    : 빠르게 움직이는데 이 차량 트랙은 없음(버스·타 차량)
 *   - 체류         : 사실상 정지
 *
 * 차량 GPS는 뷰어가 이미 가진 값(원본 불변)이라 진실의 기준으로 삼고,
 * 판정은 그 위에 휴대폰 점을 얹어 내린다.
 */
import { haversineM, isValidLatLon, type PhoneFix } from './phone-track';

/** 차량 GPS 한 점 — GpsFix가 그대로 만족한다 (필요한 것만 받는다) */
export interface CarFix {
  timeMs: number;
  lat: number;
  lon: number;
  speed?: number;
}

export type TrackClass =
  | 'in_vehicle_this' // 이 차량 주행
  | 'walking'         // 보행
  | 'moving_other'    // 다른 이동(버스·타 차량)
  | 'stationary'      // 체류
  | 'unknown';        // 판단 근거 부족

export interface MatchOptions {
  /** 차량과 이 거리(m) 안이면 "같은 위치" */
  overlapM: number;
  /** 이 속도(km/h) 이하면 보행 */
  walkKmh: number;
  /** 이 속도(km/h) 이하면 정지로 본다 */
  stillKmh: number;
  /** 차량 점과 이 시간(ms) 안이라야 "같은 시각"으로 견준다 */
  timeTolMs: number;
  /** 원본 staytime 이 이 시간(ms) 이상이면 속도와 무관하게 체류로 본다 */
  stillStayMs: number;
}

export const DEFAULT_MATCH: MatchOptions = {
  overlapM: 50,
  walkKmh: 7,
  stillKmh: 1.5,
  timeTolMs: 30_000,
  stillStayMs: 2 * 60_000,
};

/** 이웃 점으로 속도를 낼 때, 이보다 시간이 벌어지면 추정을 포기한다(초) */
const MAX_NEIGHBOR_S = 300;
/** 한 점에 몰아줄 수 있는 최대 시간(ms) — 큰 공백이 한 칸에 시간을 쏟지 않게 */
const MAX_SPAN_MS = 10 * 60_000;

export interface MatchedPoint {
  timeMs: number;
  lat: number;
  lon: number;
  activity: string;
  accuracyM: number;
  /** 이웃 점으로 다시 계산한 이동 속도(km/h). 못 내면 NaN. */
  moveKmh: number;
  /** 가장 가까운 시각 차량 점까지의 거리(m). 시간 창 밖이면 Infinity. */
  carDistM: number;
  /** 그 차량 점과의 시간차(ms). 없으면 Infinity. */
  carDtMs: number;
  klass: TrackClass;
  /** 원본 staytime(ms) — 그 지점 머문 시간. 체류 판단의 근거. */
  stayMs: number;
  /** 이 점이 대표하는 시간(ms) — 요약에서 "몇 분"을 셀 때 쓴다 */
  spanMs: number;
}

export interface ClassStat {
  points: number;
  spanMs: number;
  distM: number;
}

export interface DaySummary {
  points: number;
  timeStartMs: number;
  timeEndMs: number;
  spanTotalMs: number;
  distTotalM: number;
  byClass: Record<TrackClass, ClassStat>;
}

export interface MatchResult {
  points: MatchedPoint[];
  summary: DaySummary;
}

const CLASSES: TrackClass[] = ['in_vehicle_this', 'walking', 'moving_other', 'stationary', 'unknown'];

function emptyStat(): ClassStat {
  return { points: 0, spanMs: 0, distM: 0 };
}

function activityClass(activity: string): TrackClass | null {
  const a = activity.toLowerCase();
  if (!a) return null;
  if (a.includes('vehicle') || a.includes('car') || a.includes('driv') || a.includes('automotive')) return 'moving_other';
  if (a.includes('walk') || a.includes('foot') || a.includes('run') || a.includes('bicycle') || a.includes('bike')) return 'walking';
  if (a.includes('still') || a.includes('stationary') || a.includes('tilting')) return 'stationary';
  return null;
}

/** 이웃 점으로 이동 속도(km/h)를 낸다. 시간이 너무 벌어지면 NaN. */
function moveSpeedKmh(fixes: PhoneFix[], i: number): number {
  const cur = fixes[i];
  const parts: number[] = [];
  for (const j of [i - 1, i + 1]) {
    const nb = fixes[j];
    if (!nb) continue;
    const dtS = Math.abs(cur.timeMs - nb.timeMs) / 1000;
    if (dtS <= 0 || dtS > MAX_NEIGHBOR_S) continue;
    const d = haversineM(cur.lat, cur.lon, nb.lat, nb.lon);
    parts.push((d / dtS) * 3.6);
  }
  if (parts.length === 0) return NaN;
  return parts.reduce((s, x) => s + x, 0) / parts.length;
}

/** cars에서 t에 가장 가까운 점의 인덱스 (cars는 시각 오름차순) */
function nearestCar(carTimes: number[], t: number): number {
  if (carTimes.length === 0) return -1;
  let lo = 0;
  let hi = carTimes.length - 1;
  if (t <= carTimes[lo]) return lo;
  if (t >= carTimes[hi]) return hi;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (carTimes[mid] === t) return mid;
    if (carTimes[mid] < t) lo = mid + 1;
    else hi = mid - 1;
  }
  // lo = 첫 번째로 t보다 큰 것, hi = 그 앞. 둘 중 가까운 쪽.
  return Math.abs(carTimes[lo] - t) < Math.abs(carTimes[hi] - t) ? lo : hi;
}

function classify(p: MatchedPoint, activity: string, opt: MatchOptions): TrackClass {
  // 0) 원본 staytime 이 근거: 그 지점에 오래 머물렀다면 속도와 무관하게 체류.
  //    (원본 speed 가 3.6이어도 staytime 이 크면 실제로는 정지 상태다)
  if (p.stayMs >= opt.stillStayMs) return 'stationary';

  // 1) 기하학적 사실: 그 시각 차량이 곁에 있으면 이 차량 주행
  if (Number.isFinite(p.carDistM) && p.carDistM <= opt.overlapM) return 'in_vehicle_this';

  // 2) 다시 계산한 속도가 있으면 그걸 주로 쓴다
  if (Number.isFinite(p.moveKmh)) {
    if (p.moveKmh <= opt.stillKmh) {
      // 느려도 활동유형이 '차량'이면 정체 주행일 수 있으나, 이 차량 트랙이
      // 없으므로 '다른 이동'으로 두지 않고 정지로 둔다(보수적).
      return 'stationary';
    }
    if (p.moveKmh <= opt.walkKmh) return 'walking';
    return 'moving_other';
  }

  // 3) 속도를 못 내면 OS 활동유형에 기댄다
  const byAct = activityClass(activity);
  if (byAct === 'moving_other') return 'moving_other'; // 다른 차량(이 차량 아님)
  if (byAct) return byAct;
  return 'unknown';
}

/**
 * 하루치 대사.
 *
 * @param carFixesRaw 차량 GPS (뷰어가 가진 GpsFix[] 등)
 * @param phoneFixes  휴대폰 위치 (parsePhoneTrack 결과, 시각 오름차순)
 */
export function matchTracks(
  carFixesRaw: CarFix[],
  phoneFixes: PhoneFix[],
  options: Partial<MatchOptions> = {},
): MatchResult {
  const opt = { ...DEFAULT_MATCH, ...options };

  const cars = carFixesRaw
    .filter((c) => Number.isFinite(c.timeMs) && isValidLatLon(c.lat, c.lon))
    .sort((a, b) => a.timeMs - b.timeMs);
  const carTimes = cars.map((c) => c.timeMs);

  const points: MatchedPoint[] = [];
  for (let i = 0; i < phoneFixes.length; i++) {
    const f = phoneFixes[i];
    const ci = nearestCar(carTimes, f.timeMs);
    let carDistM = Infinity;
    let carDtMs = Infinity;
    if (ci >= 0) {
      const dt = Math.abs(cars[ci].timeMs - f.timeMs);
      if (dt <= opt.timeTolMs) {
        carDtMs = dt;
        carDistM = haversineM(f.lat, f.lon, cars[ci].lat, cars[ci].lon);
      }
    }
    const mp: MatchedPoint = {
      timeMs: f.timeMs, lat: f.lat, lon: f.lon,
      activity: f.activity, accuracyM: f.accuracyM,
      moveKmh: moveSpeedKmh(phoneFixes, i),
      carDistM, carDtMs,
      klass: 'unknown', stayMs: f.stayMs, spanMs: 0,
    };
    mp.klass = classify(mp, f.activity, opt);
    points.push(mp);
  }

  // 각 점이 대표하는 시간 = 앞뒤 이웃까지 절반씩 (양 끝은 한쪽만), 상한 적용
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    // 원본 staytime 으로 잡힌 체류 점은 그 자체가 오래 머문 구간이다. 이웃 간격
    // 상한(10분)에 눌리면 3시간 체류가 10분으로 과소집계되므로 staytime 을 그대로 쓴다.
    if (p.klass === 'stationary' && p.stayMs > 0) { p.spanMs = p.stayMs; continue; }
    const prev = points[i - 1];
    const next = points[i + 1];
    let span = 0;
    if (prev) span += Math.min((p.timeMs - prev.timeMs) / 2, MAX_SPAN_MS / 2);
    if (next) span += Math.min((next.timeMs - p.timeMs) / 2, MAX_SPAN_MS / 2);
    if (!prev && next) span = Math.min(next.timeMs - p.timeMs, MAX_SPAN_MS);
    if (prev && !next) span = Math.min(p.timeMs - prev.timeMs, MAX_SPAN_MS);
    p.spanMs = Math.max(0, span);
  }

  const byClass = {} as Record<TrackClass, ClassStat>;
  for (const c of CLASSES) byClass[c] = emptyStat();
  let distTotalM = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const st = byClass[p.klass];
    st.points++;
    st.spanMs += p.spanMs;
    if (i > 0) {
      const d = haversineM(points[i - 1].lat, points[i - 1].lon, p.lat, p.lon);
      st.distM += d;
      distTotalM += d;
    }
  }

  return {
    points,
    summary: {
      points: points.length,
      timeStartMs: points.length ? points[0].timeMs : NaN,
      timeEndMs: points.length ? points[points.length - 1].timeMs : NaN,
      spanTotalMs: points.reduce((s, p) => s + p.spanMs, 0),
      distTotalM,
      byClass,
    },
  };
}

/** 화면 라벨 */
export const CLASS_LABEL: Record<TrackClass, string> = {
  in_vehicle_this: '이 차량 주행',
  walking: '보행',
  moving_other: '다른 이동',
  stationary: '체류',
  unknown: '미상',
};
