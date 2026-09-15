/** GPS 경로 지도. Leaflet + OSM 타일 (API 키 불필요). */
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { GpsFix } from '../core/types';
import type { Stay } from '../core/stays';
import type { MapBackend } from './map-backend';
import { KakaoBackend, kakaoReady } from './kakao';

/** '현재 주행 위치'로 옮길 때 최소한 이만큼은 당긴다 (거리 이름이 보이는 배율) */
const FOCUS_ZOOM = 17;

/** OSM(Leaflet) 백엔드. file:// 실기기와 테스트가 늘 타는 확실한 길. */
export class LeafletBackend implements MapBackend {
  private map: L.Map | null = null;
  private track: L.Polyline | null = null;
  private marker: L.CircleMarker | null = null;
  /** 체류(머문 곳) 표식 묶음 — 다시 그릴 때 통째로 지운다 */
  private stayLayer: L.LayerGroup | null = null;
  private fixes: GpsFix[] = [];
  /** 표식이 지금 놓인 지점 — '현재 주행 위치'가 돌려준다 */
  private current: GpsFix | null = null;
  /**
   * 처음 한 번만 경로에 맞춰 화면을 잡는다.
   * 구간이 바뀔 때마다 다시 맞추면 사용자가 확대해 둔 위치가 리셋된다.
   */
  private fitted = false;

  private ro: ResizeObserver | null = null;

  constructor(private readonly el: HTMLElement) {}

  /**
   * 칸 크기가 바뀌면 스스로 다시 잰다.
   *
   * Leaflet은 만들어질 때 잰 크기만큼만 타일을 받는다. 그래서 칸이 커지면
   * 커진 만큼은 **빈 회색으로 남는다.** 지금까지는 탭을 누를 때와 창 크기가
   * 바뀔 때만 알려 주고 있었는데, 영상을 접거나 화면 배치가 바뀌는 것은
   * 그 둘 어디에도 걸리지 않는다. 칸 자체를 지켜보면 빠짐이 없다.
   */
  private watch(): void {
    if (this.ro || typeof ResizeObserver === 'undefined') return;
    let pending = 0;
    this.ro = new ResizeObserver(() => {
      // 한 번에 몰아서 — 크기가 연달아 바뀌는 동안 매번 다시 재지 않는다
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => this.map?.invalidateSize());
    });
    this.ro.observe(this.el);
  }

  /** 위/경도가 0인 행은 위성 미수신이므로 경로에서 뺀다 (안 그러면 기니만으로 선이 튄다). */
  static validFixes(fixes: GpsFix[]): GpsFix[] {
    return fixes.filter(
      (g) => Number.isFinite(g.lat) && Number.isFinite(g.lon) &&
        g.lat !== 0 && g.lon !== 0 && Math.abs(g.lat) <= 90 && Math.abs(g.lon) <= 180,
    );
  }

  render(fixes: GpsFix[]): { shown: number; dropped: number } {
    const valid = LeafletBackend.validFixes(fixes);
    this.fixes = valid;
    if (valid.length === 0) return { shown: 0, dropped: fixes.length };

    if (!this.map) {
      this.map = L.map(this.el, { attributionControl: true });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors',
      }).addTo(this.map);
      this.watch();
    }
    const latlngs = valid.map((g) => [g.lat, g.lon] as [number, number]);
    this.track?.remove();
    this.track = L.polyline(latlngs, { color: '#2b6cb0', weight: 4, opacity: 0.85 }).addTo(this.map);
    this.marker?.remove();
    this.current = valid[0];
    this.marker = L.circleMarker(latlngs[0], {
      radius: 7, color: '#fff', weight: 2, fillColor: '#e53e3e', fillOpacity: 1,
    }).addTo(this.map);
    if (!this.fitted) {
      this.map.fitBounds(this.track.getBounds(), { padding: [24, 24] });
      this.fitted = true;
    }
    return { shown: valid.length, dropped: fixes.length - valid.length };
  }

  /** 재생 위치에 맞춰 마커를 옮긴다. */
  syncTo(absTimeMs: number): GpsFix | null {
    if (!this.marker || this.fixes.length === 0) return null;
    let best = this.fixes[0];
    for (const g of this.fixes) {
      if (g.timeMs <= absTimeMs) best = g;
      else break;
    }
    this.marker.setLatLng([best.lat, best.lon]);
    this.current = best;
    return best;
  }

  /**
   * 지금 재생 중인 지점이 보이게 옮긴다.
   *
   * **누를 때만** 움직인다. 재생을 따라 계속 가운데로 끌어오면 지도를 손으로
   * 옮겨 살펴보던 것이 매번 튕겨 나간다.
   *
   * 배율은 사용자가 맞춰 둔 것을 지키되, '전체 경로 보기'처럼 멀리 물러나
   * 있을 때는 거리까지 보이게 당긴다 — 점만 찍히면 어디인지 알 수 없다.
   */
  showCurrent(): GpsFix | null {
    if (!this.map || !this.marker) return null;
    this.map.setView(this.marker.getLatLng(), Math.max(this.map.getZoom(), FOCUS_ZOOM));
    return this.current ?? this.fixes[0] ?? null;
  }

  /** 특정 좌표로 중심 이동 (머문 곳 번호 클릭). 배율은 거리 이름이 보이게 당긴다. */
  centerOn(lat: number, lon: number): void {
    if (!this.map) return;
    this.map.setView([lat, lon], Math.max(this.map.getZoom(), FOCUS_ZOOM));
  }

  /** 전체 경로가 다 보이도록 다시 맞춘다 (사용자가 눌렀을 때만) */
  fitAll(): boolean {
    if (!this.map || !this.track) return false;
    this.map.fitBounds(this.track.getBounds(), { padding: [24, 24] });
    return true;
  }

  /** 새 라이브러리를 그릴 때는 다시 한 번 맞춰야 한다 */
  resetFit(): void {
    this.fitted = false;
  }

  /** 탭이 숨겨진 상태에서 만들어지면 크기가 0이라 다시 계산해야 한다. */
  invalidate(): void {
    this.map?.invalidateSize();
  }

  /** 클릭한 좌표에서 가장 가까운 점 (2,000점이라도 한 번 훑으면 충분하다) */
  private nearest(lat: number, lon: number): GpsFix | null {
    let best: GpsFix | null = null;
    let bestD = Infinity;
    for (const g of this.fixes) {
      const d = (g.lat - lat) ** 2 + (g.lon - lon) ** 2;
      if (d < bestD) { bestD = d; best = g; }
    }
    return best;
  }

  /**
   * 경로에 시각을 붙인다.
   *
   * 2,000점에 다 찍으면 글자가 뒤덮이므로 **누르면** 그 점 시각을 말풍선으로
   * 보여주고, 시작·끝 지점에만 시각 라벨을 상시 표기한다.
   * @param fmt  시각(ms) → 보여줄 문자열
   * @param extra 점 하나에 덧붙일 설명(속도·활동 등) — 선택
   */
  enableTimeLabels(fmt: (ms: number) => string, extra?: (g: GpsFix) => string): void {
    if (!this.map || !this.track || this.fixes.length === 0) return;
    this.track.on('click', (e: L.LeafletMouseEvent) => {
      const g = this.nearest(e.latlng.lat, e.latlng.lng);
      if (!g || !this.map) return;
      const body = `<strong>${fmt(g.timeMs)}</strong>${extra ? `<br>${extra(g)}` : ''}`;
      L.popup({ closeButton: false }).setLatLng([g.lat, g.lon]).setContent(body).openOn(this.map);
    });
    const first = this.fixes[0];
    const last = this.fixes[this.fixes.length - 1];
    const label = (g: GpsFix, text: string): void => {
      if (!this.map) return;
      L.circleMarker([g.lat, g.lon], { radius: 5, color: '#fff', weight: 2, fillColor: '#2f855a', fillOpacity: 1 })
        .addTo(this.map)
        .bindTooltip(text, { permanent: true, direction: 'top', className: 'map-time-label' });
    };
    label(first, `출발 ${fmt(first.timeMs)}`);
    if (last !== first) label(last, `끝 ${fmt(last.timeMs)}`);
  }

  /**
   * 머문 곳을 지도에 표기한다.
   *
   * 체류마다 굵은 동그라미를 찍고, 상시 라벨로 머문 시간을 보여준다. 누르면
   * 시각 범위와 주소까지 말풍선으로 편다. 다시 그릴 때 이전 표식은 지운다.
   * @param stays  도출된 체류들
   * @param fmtClock 시각(ms) → 'HH:MM' 등
   * @param fmtDur   머문 시간(ms) → '2시간 5분' 등
   */
  showStays(stays: Stay[], fmtClock: (ms: number) => string, fmtDur: (ms: number) => string): void {
    if (!this.map) return;
    this.stayLayer?.remove();
    if (stays.length === 0) { this.stayLayer = null; return; }
    const layer = L.layerGroup();
    stays.forEach((s, i) => {
      const range = `${fmtClock(s.fromMs)}~${fmtClock(s.toMs)}`;
      const dur = fmtDur(s.durationMs);
      const popup = `<strong>머문 곳 ${i + 1}</strong><br>${range} · ${dur}` +
        (s.addr ? `<br>${escapeHtmlText(s.addr)}` : '');
      // 번호 배지 핀 — 회색 원 대신 시선을 끄는 주황 배지에 순번을 박는다
      const icon = L.divIcon({
        className: 'stay-marker',
        html: `<span class="stay-pin">${i + 1}</span>`,
        iconSize: [30, 30], iconAnchor: [15, 15],
      });
      L.marker([s.lat, s.lon], { icon, title: `머문 곳 ${i + 1} · ${dur}`, zIndexOffset: 1000 })
        .bindTooltip(dur, { permanent: true, direction: 'bottom', offset: [0, 12], className: 'map-stay-label' })
        .bindPopup(popup)
        .addTo(layer);
    });
    layer.addTo(this.map);
    this.stayLayer = layer;
  }
}

/** 말풍선에 넣는 짧은 텍스트만 살짝 막는다 (전체 escapeHtml은 format 모듈에 있다) */
function escapeHtmlText(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c
  ));
}

/**
 * 지도 파사드.
 *
 * 실행 환경에 맞는 백엔드를 골라 뒤로 감춘다 — 등록 도메인의 http/https 면 카카오,
 * 아니면(파일 열기·미등록·오프라인) OSM. 호출부는 늘 GpsMap 하나만 쓴다.
 *
 * 안전제일: 카카오 생성이 조금이라도 어긋나면 즉시 OSM 으로 내려앉는다. 그래서
 * 검증 못 한 카카오 코드가 실기기(항상 OSM)나 테스트를 깨지 못한다.
 */
export class GpsMap implements MapBackend {
  /** 위/경도 유효행만 (charts 등에서도 쓴다) */
  static validFixes = LeafletBackend.validFixes;

  private backend: MapBackend;

  constructor(el: HTMLElement) {
    this.backend = GpsMap.makeBackend(el);
  }

  private static makeBackend(el: HTMLElement): MapBackend {
    if (kakaoReady()) {
      try { return new KakaoBackend(el); } catch { /* OSM 으로 */ }
    }
    return new LeafletBackend(el);
  }

  render(fixes: GpsFix[]): { shown: number; dropped: number } { return this.backend.render(fixes); }
  syncTo(absTimeMs: number): GpsFix | null { return this.backend.syncTo(absTimeMs); }
  showCurrent(): GpsFix | null { return this.backend.showCurrent(); }
  centerOn(lat: number, lon: number): void { this.backend.centerOn(lat, lon); }
  fitAll(): boolean { return this.backend.fitAll(); }
  resetFit(): void { this.backend.resetFit(); }
  invalidate(): void { this.backend.invalidate(); }
  enableTimeLabels(fmt: (ms: number) => string, extra?: (g: GpsFix) => string): void {
    this.backend.enableTimeLabels(fmt, extra);
  }
  showStays(stays: Stay[], fmtClock: (ms: number) => string, fmtDur: (ms: number) => string): void {
    this.backend.showStays(stays, fmtClock, fmtDur);
  }
}
