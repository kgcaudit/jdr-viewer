/**
 * 리버스 지오코딩(좌표 → 주소) — OpenStreetMap Nominatim.
 *
 * 왜 OSM 인가: 카카오/네이버 REST 는 브라우저 CORS·도메인 인증에 막혀 `file://`
 * (다운로드 폴더에서 파일 열기)에선 못 쓴다. Nominatim 은 CORS 가 열려 있어 파일
 * 열기에서도 부를 수 있다. 대신 한글 주소 품질은 카카오보다 낮고, 사용 정책상
 * **초당 1회**를 넘기면 안 된다.
 *
 * 그래서:
 *   - 좌표를 반올림해 **키로 캐시**(IndexedDB) — 같은 자리는 딱 한 번만 부른다.
 *   - 네트워크 호출은 **직렬 큐 + 1.1초 간격**으로 정책을 지킨다.
 *   - 실패하면 빈 문자열 — 주소가 없을 뿐 앱은 멀쩡하다.
 *
 * 개인정보: 리버스 지오코딩은 **체류 좌표를 외부(OSM)로 보낸다.** 화면에만 쓰고,
 * 좌표·주소를 로그나 다른 서비스로 보내지 않는다.
 */

/** 좌표를 캐시 키로 — 소수 4자리(≈11 m)면 같은 지점을 하나로 묶기에 충분하다 */
export function geoKey(lat: number, lon: number): string {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

/**
 * 우선 제공자(카카오 등)를 주입한다. 호스팅(등록 도메인)에서 카카오 services 가
 * 준비되면 main 이 여기에 넣어 준다. 있으면 이걸 먼저 쓰고, 빈 결과면 OSM 으로.
 * (core 가 ui/kakao 를 직접 import 하지 않도록 주입으로 계층을 지킨다)
 */
/** 좌표에서 얻은 정보 — 주소 + 대표 상호명/건물명(있을 때) */
export interface GeoInfo { addr: string; place: string }
export const EMPTY_GEO: GeoInfo = { addr: '', place: '' };

type Provider = (lat: number, lon: number) => Promise<GeoInfo>;
let preferred: Provider | null = null;
export function setPreferredProvider(fn: Provider | null): void { preferred = fn; }

/** Nominatim 응답에서 한글 주소를 큰 단위→작은 단위로 조립한다 */
export function formatNominatim(json: unknown): string {
  const j = json as { address?: Record<string, string>; display_name?: string };
  const a = j.address ?? {};
  // 대한민국 행정구역 순서(도/광역시 → 시군구 → 읍면동 → 리/동 → 도로 → 번지)
  const order = [
    'province', 'state', 'city', 'county', 'municipality',
    'town', 'township', 'borough', 'city_district', 'district',
    'suburb', 'village', 'neighbourhood', 'quarter',
    'road', 'house_number',
  ];
  const parts: string[] = [];
  for (const k of order) {
    const v = a[k];
    if (v && !parts.includes(v)) parts.push(v);
  }
  const s = parts.join(' ').trim();
  if (s) return s;
  // 조립 실패 시 display_name(작은→큰 순, 쉼표)을 뒤집어 큰→작은으로
  const dn = String(j.display_name ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const noCountry = dn.filter((x) => x !== '대한민국' && x !== 'South Korea');
  return noCountry.reverse().join(' ');
}

/** Nominatim 응답에서 대표 상호명/건물명(POI 이름)을 뽑는다. 없으면 빈 문자열. */
export function placeNominatim(json: unknown): string {
  const j = json as { name?: string; address?: Record<string, string> };
  if (j.name && j.name.trim()) return j.name.trim();
  const a = j.address ?? {};
  // 이름 후보(상점·시설·건물명 등). 도로/번지 같은 주소요소는 제외.
  for (const k of ['amenity', 'shop', 'tourism', 'office', 'building', 'leisure', 'aeroway', 'craft']) {
    const v = a[k];
    if (v && !/^\d/.test(v)) return v; // 숫자로 시작하면 번지 등 → 상호명 아님
  }
  return '';
}

// ── 캐시(IndexedDB) ─────────────────────────────────
const DB_NAME = 'jdr-viewer-geocode';
const STORE = 'addr';
let dbP: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbP) return dbP;
  dbP = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbP;
}

async function cacheGet(key: string): Promise<GeoInfo | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => {
        const v = req.result;
        if (typeof v !== 'string') { resolve(null); return; }
        try {
          const o = JSON.parse(v) as Partial<GeoInfo>;
          if (o && typeof o.addr === 'string') { resolve({ addr: o.addr, place: o.place ?? '' }); return; }
        } catch { /* 옛 저장분: 순수 주소 문자열 */ }
        resolve({ addr: v, place: '' }); // 하위호환
      };
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function cachePut(key: string, info: GeoInfo): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(JSON.stringify(info), key);
  } catch { /* 다음에 다시 부른다 */ }
}

// ── 직렬 큐 (초당 1회 정책) ──────────────────────────
const GAP_MS = 1100;
let chain: Promise<unknown> = Promise.resolve();
let lastAt = 0;
const inflight = new Map<string, Promise<GeoInfo>>();

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchNominatim(lat: number, lon: number): Promise<GeoInfo> {
  const wait = GAP_MS - (Date.now() - lastAt);
  if (wait > 0) await delay(wait);
  lastAt = Date.now();
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&accept-language=ko&zoom=18&namedetails=0`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return EMPTY_GEO;
    const j = await res.json();
    return { addr: formatNominatim(j), place: placeNominatim(j) };
  } catch {
    return EMPTY_GEO;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 좌표의 주소·상호명을 돌려준다. 캐시에 있으면 즉시, 없으면 큐에 넣어 부른다.
 * 실패하면 빈 값. 같은 좌표를 연달아 물으면 한 번만 부른다.
 */
export async function reverseGeocode(lat: number, lon: number): Promise<GeoInfo> {
  const key = geoKey(lat, lon);
  const cached = await cacheGet(key);
  if (cached !== null) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;

  const p = (async () => {
    let info = EMPTY_GEO;
    // 우선 제공자(카카오 등)가 있으면 먼저 — CORS·간격 제약 없이 도로명 주소+건물명
    if (preferred) {
      try { info = await preferred(lat, lon); } catch { info = EMPTY_GEO; }
    }
    // 주소를 못 얻었으면 OSM 로 전체를, 주소는 있는데 **상호명만 비면** OSM 상호명만
    // 보충한다(카카오 장소검색도 못 찾은 시골·건물 안 등). 주소는 카카오 것을 지킨다.
    // 두 경우 모두 직렬 체인에 매달아 호출 간격(초당 1회)을 지킨다.
    if (!info.addr || !info.place) {
      const run = chain.then(() => fetchNominatim(lat, lon));
      chain = run.catch(() => EMPTY_GEO);
      const osm = await run;
      info = {
        addr: info.addr || osm.addr,
        place: info.place || osm.place,
      };
    }
    if (info.addr || info.place) await cachePut(key, info);
    inflight.delete(key);
    return info;
  })();
  inflight.set(key, p);
  return p;
}
