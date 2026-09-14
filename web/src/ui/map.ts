/** GPS 경로 지도. Leaflet + OSM 타일 (API 키 불필요). */
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { GpsFix } from '../core/types';

/** '현재 주행 위치'로 옮길 때 최소한 이만큼은 당긴다 (거리 이름이 보이는 배율) */
const FOCUS_ZOOM = 17;

export class GpsMap {
  private map: L.Map | null = null;
  private track: L.Polyline | null = null;
  private marker: L.CircleMarker | null = null;
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
    const valid = GpsMap.validFixes(fixes);
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
}
