/**
 * 카카오 지도 백엔드 (선택적).
 *
 * 왜 "선택적"인가 — 카카오 JS SDK 는 **개발자센터에 등록한 도메인에서만** 뜬다
 * (제공된 KAKAO_API_GUIDE §2). 이 앱의 실제 배포는 안드로이드 다운로드 폴더에서
 * `file://` 로 여는 단일 HTML 이라 등록할 도메인 자체가 없고 출처(origin)가 null 이라
 * SDK 인증이 막힌다. 그래서:
 *
 *   - http/https 로 **등록된 도메인**에서 열면 → 카카오 지도(국내 지도, 감사에 유리)
 *   - `file://` 나 미등록 도메인 → SDK 를 아예 부르지 않고 **OSM(Leaflet)로 대체**
 *
 * 카카오는 국내 타일만 준다(§3). 대체가 필요한 해외/오프라인은 어차피 OSM 이 맞다.
 * 이 파일은 SDK 로더와, 지도 백엔드 인터페이스를 만족하는 KakaoBackend 를 담는다.
 * 실 기기(file://)에서는 한 줄도 실행되지 않으므로, 여기 버그가 앱을 깨지 못한다.
 */
import type { GpsFix } from '../core/types';
import type { Stay } from '../core/stays';
import { EMPTY_GEO, type GeoInfo } from '../core/geocode';
import type { MapBackend } from './map-backend';

// ── SDK 로더 ────────────────────────────────────────
// JS 키. 브라우저에 노출되는 값이라 도메인 제한이 유일한 보호막이다(§0).
const KAKAO_JS_KEY = '5c05414abebe433a71e0d03e3ca7a7f9';
// libraries=services 로 좌표→주소(coord2Address)까지 같은 SDK 로 쓴다
const SDK_URL = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_JS_KEY}&autoload=false&libraries=services`;
const LOAD_TIMEOUT_MS = 9000;

type LoadState = 'idle' | 'loading' | 'ready' | 'failed';
let state: LoadState = 'idle';
let loadPromise: Promise<boolean> | null = null;
let failReason = '';

/** 진단용 — 지금 지도 상태와 카카오 실패 사유(있으면) */
export function kakaoDiag(): { state: string; reason: string } {
  return { state, reason: failReason };
}

/** 지금 카카오 지도를 쓸 수 있나 (SDK 로드 완료 + maps 네임스페이스 존재) */
export function kakaoReady(): boolean {
  return state === 'ready' && typeof window !== 'undefined' &&
    !!window.kakao?.maps?.Map;
}

/**
 * file:// 나 미등록 도메인에선 카카오가 어차피 안 뜨므로 시도조차 않는다.
 * http/https 에서만 SDK 를 부른다 — 그래야 헤드리스 e2e(로컬 http)도 네트워크가
 * 막히면 실패로 떨어져 OSM 으로 안전하게 대체된다.
 */
function mapOverride(): 'kakao' | 'osm' | null {
  try {
    const v = new URLSearchParams(window.location.search).get('map');
    return v === 'kakao' || v === 'osm' ? v : null;
  } catch { return null; }
}

/**
 * 카카오를 시도할 자격 판정.
 *
 * 호스팅(http/https · 등록 도메인)에서 카카오 지도·주소를 쓴다. 실측(카카오
 * 데브톡/가이드)상 `file://` 로 직접 연 HTML 은 도메인 인증이 막혀 안 되고,
 * localhost 는 기본 미등록이라 어차피 안 뜬다.
 *
 *   - `?map=osm`  → 무조건 OSM
 *   - `?map=kakao`→ http/https 면 localhost 라도 카카오 시도(로컬 등록 시)
 *   - 기본       → http/https + 비-localhost 면 카카오 시도(등록 호스팅), 그 외 OSM
 * file://·localhost·오프라인·미등록은 SDK 로드 실패로 OSM 에 안전하게 떨어진다.
 */
function eligible(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  const ov = mapOverride();
  if (ov === 'osm') return false;
  const p = window.location.protocol;
  if (p !== 'http:' && p !== 'https:') return false;
  if (ov === 'kakao') return true;
  const h = window.location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h === '') return false;
  return true;
}

/** SDK 를 한 번만 부른다. 성공하면 kakaoReady()가 참이 된다. 실패해도 조용히 대체된다. */
export function preloadKakao(): Promise<boolean> {
  if (loadPromise) return loadPromise;
  if (!eligible()) {
    state = 'failed';
    failReason = mapOverride() === 'osm' ? 'OSM 강제(?map=osm)'
      : (typeof window !== 'undefined' && window.location.protocol === 'file:') ? 'file:// (호스팅 아님)'
      : '대상 아님(localhost/미지원)';
    return Promise.resolve(false);
  }
  state = 'loading';
  loadPromise = new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean, reason = ''): void => {
      if (done) return;
      done = true;
      state = ok ? 'ready' : 'failed';
      if (!ok) failReason = reason || failReason || '알 수 없음';
      resolve(ok);
    };
    const timer = window.setTimeout(
      () => finish(false, '로드 시간초과(도메인 미등록/네트워크 의심)'), LOAD_TIMEOUT_MS);
    try {
      const s = document.createElement('script');
      s.src = SDK_URL;
      s.async = true;
      s.onload = () => {
        // 도메인 미등록/키 오류면 정상 sdk.js 가 안 와서 maps.load 가 함수가 아니다
        const load = window.kakao?.maps?.load;
        if (typeof load !== 'function') {
          window.clearTimeout(timer);
          finish(false, '도메인 미등록/키 오류(maps 미정의)');
          return;
        }
        try { load(() => { window.clearTimeout(timer); finish(true); }); }
        catch { window.clearTimeout(timer); finish(false, 'maps.load 예외'); }
      };
      s.onerror = () => { window.clearTimeout(timer); finish(false, '스크립트 로드 실패(차단/네트워크)'); };
      document.head.appendChild(s);
    } catch { window.clearTimeout(timer); finish(false, '스크립트 삽입 예외'); }
  });
  return loadPromise;
}

// ── 카카오 지도 최소 타입 (@types 없음) ───────────────
// 쓰는 것만 좁게 선언한다. any 남발 대신 필요한 표면만.
interface KLatLng { getLat(): number; getLng(): number; }
interface KBounds { extend(ll: KLatLng): void; }
interface KMouseEvent { latLng: KLatLng; }
interface KOverlayShape { setMap(m: KMap | null): void; }
interface KMap {
  setBounds(b: KBounds): void;
  setLevel(n: number): void;
  getLevel(): number;
  setCenter(ll: KLatLng): void;
  relayout(): void;
}
interface KakaoMaps {
  Map: new (el: HTMLElement, opt: { center: KLatLng; level: number }) => KMap;
  LatLng: new (lat: number, lng: number) => KLatLng;
  LatLngBounds: new () => KBounds;
  Polyline: new (opt: {
    path: KLatLng[]; strokeWeight: number; strokeColor: string; strokeOpacity: number;
  }) => KOverlayShape & { setPath(p: KLatLng[]): void };
  CustomOverlay: new (opt: {
    position: KLatLng; content: string | HTMLElement; yAnchor?: number; xAnchor?: number; clickable?: boolean; zIndex?: number;
  }) => KOverlayShape & { setPosition(ll: KLatLng): void };
  load(cb: () => void): void;
  event: { addListener(target: unknown, type: string, cb: (e: KMouseEvent) => void): void };
  services?: {
    Geocoder: new () => {
      coord2Address(lng: number, lat: number, cb: (result: KAddr[], status: string) => void): void;
    };
    Status: { OK: string };
  };
}
interface KAddr {
  road_address?: { address_name?: string; building_name?: string } | null;
  address?: { address_name?: string } | null;
}
declare global {
  interface Window { kakao?: { maps?: KakaoMaps } }
}

const km = (): KakaoMaps => window.kakao!.maps!;

/** 카카오 주소검색(services)까지 준비됐나 — 좌표→주소에 필요 */
export function kakaoServicesReady(): boolean {
  return kakaoReady() && !!window.kakao?.maps?.services?.Geocoder;
}

/**
 * 카카오로 좌표 → {주소(도로명 우선, 없으면 지번), 상호명/건물명}. 등록 도메인에서만
 * 동작. 실패하면 빈 값. SDK services 가 브라우저 CORS 없이 처리한다.
 */
export function kakaoReverseGeocode(lat: number, lon: number): Promise<GeoInfo> {
  return new Promise((resolve) => {
    try {
      const M = km();
      if (!M.services) { resolve(EMPTY_GEO); return; }
      const geocoder = new M.services.Geocoder();
      const ok = M.services.Status?.OK ?? 'OK';
      const timer = setTimeout(() => resolve(EMPTY_GEO), 8000);
      geocoder.coord2Address(lon, lat, (result, status) => {
        clearTimeout(timer);
        if (status !== ok || !result || result.length === 0) { resolve(EMPTY_GEO); return; }
        const r = result[0];
        resolve({
          addr: r.road_address?.address_name || r.address?.address_name || '',
          place: r.road_address?.building_name || '',
        });
      });
    } catch { resolve(EMPTY_GEO); }
  });
}

/** 위/경도 유효행만 (0,0 미수신 제외) — Leaflet 백엔드와 같은 기준 */
function validFixes(fixes: GpsFix[]): GpsFix[] {
  return fixes.filter(
    (g) => Number.isFinite(g.lat) && Number.isFinite(g.lon) &&
      g.lat !== 0 && g.lon !== 0 && Math.abs(g.lat) <= 90 && Math.abs(g.lon) <= 180,
  );
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
}

const FOCUS_LEVEL = 3; // 작을수록 확대 (§2). 거리 이름이 보이는 정도.

/**
 * 카카오 지도 백엔드. MapBackend 를 만족한다. Leaflet 백엔드와 같은 표면.
 * 팝업/라벨은 CustomOverlay 로 만든다(카카오엔 Leaflet 의 tooltip/popup 이 없다).
 */
export class KakaoBackend implements MapBackend {
  private map: KMap | null = null;
  private line: (KOverlayShape & { setPath(p: KLatLng[]): void }) | null = null;
  private cursor: (KOverlayShape & { setPosition(ll: KLatLng): void }) | null = null;
  private extras: KOverlayShape[] = []; // 라벨·체류·팝업 표식
  private popup: KOverlayShape | null = null;
  private fixes: GpsFix[] = [];
  private current: GpsFix | null = null;
  private fitted = false;

  constructor(private readonly el: HTMLElement) {}

  private clearExtras(): void {
    for (const o of this.extras) o.setMap(null);
    this.extras = [];
  }

  render(fixes: GpsFix[]): { shown: number; dropped: number } {
    const valid = validFixes(fixes);
    this.fixes = valid;
    if (valid.length === 0) return { shown: 0, dropped: fixes.length };
    // 다시 그릴 때 이전 라벨·체류·팝업은 지운다 (재생 중 GPS 재렌더 대비)
    this.clearExtras();
    this.popup?.setMap(null);
    this.popup = null;
    const M = km();
    if (!this.map) {
      this.map = new M.Map(this.el, { center: new M.LatLng(valid[0].lat, valid[0].lon), level: 6 });
    }
    const path = valid.map((g) => new M.LatLng(g.lat, g.lon));
    if (this.line) this.line.setPath(path);
    else {
      this.line = new M.Polyline({ path, strokeWeight: 4, strokeColor: '#2b6cb0', strokeOpacity: 0.85 });
      this.line.setMap(this.map);
    }
    this.current = valid[0];
    const pos = new M.LatLng(valid[0].lat, valid[0].lon);
    if (this.cursor) this.cursor.setPosition(pos);
    else {
      this.cursor = new M.CustomOverlay({
        position: pos, zIndex: 5,
        content: '<div class="kk-cursor"></div>',
      });
      this.cursor.setMap(this.map);
    }
    if (!this.fitted) { this.fitAll(); this.fitted = true; }
    return { shown: valid.length, dropped: fixes.length - valid.length };
  }

  syncTo(absTimeMs: number): GpsFix | null {
    if (!this.cursor || this.fixes.length === 0) return null;
    let best = this.fixes[0];
    for (const g of this.fixes) { if (g.timeMs <= absTimeMs) best = g; else break; }
    this.cursor.setPosition(new (km().LatLng)(best.lat, best.lon));
    this.current = best;
    return best;
  }

  showCurrent(): GpsFix | null {
    if (!this.map) return null;
    const g = this.current ?? this.fixes[0];
    if (!g) return null;
    this.map.setCenter(new (km().LatLng)(g.lat, g.lon));
    if (this.map.getLevel() > FOCUS_LEVEL) this.map.setLevel(FOCUS_LEVEL);
    return g;
  }

  centerOn(lat: number, lon: number): void {
    if (!this.map) return;
    this.map.setCenter(new (km().LatLng)(lat, lon));
    if (this.map.getLevel() > FOCUS_LEVEL) this.map.setLevel(FOCUS_LEVEL);
  }

  fitAll(): boolean {
    if (!this.map || this.fixes.length === 0) return false;
    const M = km();
    const b = new M.LatLngBounds();
    for (const g of this.fixes) b.extend(new M.LatLng(g.lat, g.lon));
    this.map.setBounds(b);
    return true;
  }

  resetFit(): void { this.fitted = false; }

  invalidate(): void { this.map?.relayout(); }

  private nearest(lat: number, lon: number): GpsFix | null {
    let best: GpsFix | null = null;
    let bestD = Infinity;
    for (const g of this.fixes) {
      const d = (g.lat - lat) ** 2 + (g.lon - lon) ** 2;
      if (d < bestD) { bestD = d; best = g; }
    }
    return best;
  }

  private overlay(g: { lat: number; lon: number }, html: string, cls: string, clickable = false): KOverlayShape {
    const M = km();
    const o = new M.CustomOverlay({
      position: new M.LatLng(g.lat, g.lon),
      content: `<div class="${cls}">${html}</div>`,
      yAnchor: 1.2, clickable,
    });
    o.setMap(this.map);
    return o;
  }

  enableTimeLabels(fmt: (ms: number) => string, extra?: (g: GpsFix) => string): void {
    if (!this.map || !this.line || this.fixes.length === 0) return;
    km().event.addListener(this.line, 'click', (e: KMouseEvent) => {
      const g = this.nearest(e.latLng.getLat(), e.latLng.getLng());
      if (!g) return;
      this.popup?.setMap(null);
      const body = `<strong>${esc(fmt(g.timeMs))}</strong>${extra ? `<br>${esc(extra(g))}` : ''}`;
      this.popup = this.overlay(g, body, 'kk-popup');
    });
    const first = this.fixes[0];
    const last = this.fixes[this.fixes.length - 1];
    this.extras.push(this.overlay(first, `출발 ${esc(fmt(first.timeMs))}`, 'kk-label'));
    if (last !== first) this.extras.push(this.overlay(last, `끝 ${esc(fmt(last.timeMs))}`, 'kk-label'));
  }

  showStays(stays: Stay[], fmtClock: (ms: number) => string, fmtDur: (ms: number) => string): void {
    if (!this.map) return;
    stays.forEach((s, i) => {
      const cap = `${fmtClock(s.fromMs)} · ${fmtDur(s.durationMs)}`;
      const html = `<div class="kk-stay-dot">${i + 1}</div><div class="kk-stay-cap">${esc(cap)}</div>`;
      this.extras.push(this.overlay({ lat: s.lat, lon: s.lon }, html, 'kk-stay', true));
    });
  }
}
