/** GPS 경로 지도. Leaflet + OSM 타일 (API 키 불필요). */
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { GpsFix } from '../core/types';

export class GpsMap {
  private map: L.Map | null = null;
  private track: L.Polyline | null = null;
  private marker: L.CircleMarker | null = null;
  private fixes: GpsFix[] = [];

  constructor(private readonly el: HTMLElement) {}

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
    }
    const latlngs = valid.map((g) => [g.lat, g.lon] as [number, number]);
    this.track?.remove();
    this.track = L.polyline(latlngs, { color: '#2b6cb0', weight: 4, opacity: 0.85 }).addTo(this.map);
    this.marker?.remove();
    this.marker = L.circleMarker(latlngs[0], {
      radius: 7, color: '#fff', weight: 2, fillColor: '#e53e3e', fillOpacity: 1,
    }).addTo(this.map);
    this.map.fitBounds(this.track.getBounds(), { padding: [24, 24] });
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
    return best;
  }

  /** 탭이 숨겨진 상태에서 만들어지면 크기가 0이라 다시 계산해야 한다. */
  invalidate(): void {
    this.map?.invalidateSize();
  }
}
