/**
 * 휴대폰 위치기록(도와줘 위치추적) 파싱.
 *
 * 차량 블랙박스(JDR)의 GPS는 **그 차에 탔을 때만** 찍힌다. 휴대폰 GPS는
 * 사람이 어디 있든 찍히므로, 둘을 같은 시간축에 겹쳐 보면 각 시간대가
 * "이 차 주행 / 보행 / 다른 이동 / 체류" 중 무엇인지 가려낼 수 있다.
 * 이 파일은 그 첫 단계 — 휴대폰 쪽 원본을 우리 좌표계로 옮긴다.
 *
 * 원본은 위치기록 조회 응답(JSON)이다:
 *   { success, message, data: [[ {레코드}, … ]], errors }
 * 레코드 필드: timestamp, staytime, latitude, longitude, accuracy, speed,
 *              battery, address, updated_at, provider, activity_type
 *
 * **개인정보 주의**: 이 값들은 실제 사람의 정밀 위치다. 파싱은 브라우저
 * 안에서만 이뤄지고 원본은 기기 밖으로 나가지 않는다.
 */

/** 휴대폰 위치 한 점 — 우리 좌표계로 정규화한 값 */
export interface PhoneFix {
  /**
   * 벽시계 시각(ms). **차량 GPS와 같은 기준**으로 맞춘다 —
   * 기기가 적은 시각 숫자를 Date.UTC로 담는다(6장 규약). 그래야 KST끼리
   * 같은 순간이 같은 값이 되어 차량 트랙과 초 단위로 겹칠 수 있다.
   */
  timeMs: number;
  lat: number;
  lon: number;
  /** 원본이 준 속도(단위 불명 — 표시용). 분류에는 이웃 점으로 다시 계산한 값을 쓴다. */
  rawSpeed: number;
  /** 위치 정확도(m). 클수록 실내 등으로 못 믿는다. */
  accuracyM: number;
  /** OS가 매긴 활동유형(still / walking / in_vehicle 등) — 분류의 1차 단서 */
  activity: string;
  /** 그 지점의 체류시간(ms). 원본 staytime(초)을 ms로 — 체류 판단의 근거값. */
  stayMs: number;
  provider: string;
  battery: number;
  /** 사람이 읽는 주소 라벨 (개인정보 — 화면에만, 로그·외부 전송 금지) */
  address: string;
}

export class PhoneTrackError extends Error {}

/** 'YYYY-MM-DD HH:MM:SS' → 벽시계 ms. 실패하면 NaN. */
export function parsePhoneTime(s: unknown): number {
  if (typeof s !== 'string') return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s.trim());
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

/** 위/경도가 유효한가 (0,0이나 범위 밖은 위성 미수신 등으로 버린다) */
export function isValidLatLon(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat !== 0 && lon !== 0 && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/**
 * 도와줘 위치기록 응답(JSON 문자열)을 PhoneFix[]로.
 *
 * data는 배열의 배열이라(하루가 여러 토막일 수 있다) 전부 펼친다.
 * 좌표가 없는 점은 버리고, 시각 순으로 세운다.
 */
export function parsePhoneTrack(text: string): PhoneFix[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PhoneTrackError('위치기록 파일이 올바른 JSON이 아닙니다');
  }

  // { data: [[...]] } 형태가 정식이지만, 배열만 든 파일도 받아 준다.
  let groups: unknown[];
  if (Array.isArray(raw)) {
    groups = raw;
  } else if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)) {
    groups = (raw as { data: unknown[] }).data;
  } else {
    throw new PhoneTrackError('위치기록 형식이 아닙니다 (data 배열이 없습니다)');
  }

  const rows: unknown[] = [];
  for (const g of groups) {
    if (Array.isArray(g)) rows.push(...g);
    else if (g && typeof g === 'object') rows.push(g); // data:[{...}] 형태도 허용
  }

  const out: PhoneFix[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const timeMs = parsePhoneTime(o.timestamp);
    const lat = num(o.latitude);
    const lon = num(o.longitude);
    if (!Number.isFinite(timeMs) || !isValidLatLon(lat, lon)) continue;
    out.push({
      timeMs, lat, lon,
      rawSpeed: num(o.speed) || 0,
      accuracyM: num(o.accuracy) || 0,
      activity: typeof o.activity_type === 'string' ? o.activity_type : '',
      stayMs: (num(o.staytime) || 0) * 1000, // 원본 staytime 은 항상 초 단위

      provider: typeof o.provider === 'string' ? o.provider : '',
      battery: num(o.battery) || 0,
      address: typeof o.address === 'string' ? o.address : '',
    });
  }
  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}

const R_EARTH_M = 6_371_000;

/** 두 좌표 사이 거리(m) — 하버사인 */
export function haversineM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}
