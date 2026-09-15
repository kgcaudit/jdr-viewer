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
import type { MapBackend } from './map-backend';

// ── SDK 로더 ────────────────────────────────────────
// JS 키. 브라우저에 노출되는 값이라 도메인 제한이 유일한 보호막이다(§0).
const KAKAO_JS_KEY = 'e1c60a373716a5f2e90363a1bf1a01d5';
const SDK_URL = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_JS_KEY}&autoload=false`;
const LOAD_TIMEOUT_MS = 6000;

type LoadState = 'idle' | 'loading' | 'ready' | 'failed';
let state: LoadState = 'idle';
let loadPromise: Promise<boolean> | null = null;

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
function eligible(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  const p = window.location.protocol;
  if (p !== 'http:' && p !== 'https:') return false;
  // localhost/루프백은 카카오에 기본 미등록이라 어차피 안 뜬다(가이드 §2). 시도하지
  // 않아 로컬 개발·헤드리스 e2e 는 늘 OSM 으로 결정론적으로 떨어진다.
  const h = window.location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h === '') return false;
  return true;
}

/** SDK 를 한 번만 부른다. 성공하면 kakaoReady()가 참이 된다. 실패해도 조용히 대체된다. */
export function preloadKakao(): Promise<boolean> {
  if (loadPromise) return loadPromise;
  if (!eligible()) { state = 'failed'; return Promise.resolve(false); }
  state = 'loading';
  loadPromise = new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      state = ok ? 'ready' : 'failed';
      resolve(ok);
    };
    const timer = window.setTimeout(() => finish(false), LOAD_TIMEOUT_MS);
    try {
      const s = document.createElement('script');
      s.src = SDK_URL;
      s.async = true;
      s.onload = () => {
        try {
          window.kakao?.maps?.load(() => { window.clearTimeout(timer); finish(true); });
        } catch { window.clearTimeout(timer); finish(false); }
      };
      s.onerror = () => { window.clearTimeout(timer); finish(false); };
      document.head.appendChild(s);
    } catch { window.clearTimeout(timer); finish(false); }
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
}
declare global {
  interface Window { kakao?: { maps?: KakaoMaps } }
}

const km = (): KakaoMaps => window.kakao!.maps!;

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
    for (const s of stays) {
      const cap = `${fmtClock(s.fromMs)} · ${fmtDur(s.durationMs)}`;
      const html = `<div class="kk-stay-dot"></div><div class="kk-stay-cap">${esc(cap)}</div>`;
      this.extras.push(this.overlay({ lat: s.lat, lon: s.lon }, html, 'kk-stay', true));
    }
  }
}
