/** 속도 / G센서 시계열 차트. uPlot은 수만 포인트도 가볍게 그린다. */
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { JdrDocument } from '../core/types';
import { GSENSOR_SCALE } from '../core/parser';
import { GpsMap } from './map';

const COLORS = { speed: '#2b6cb0', x: '#c2410c', y: '#15803d', z: '#6d28d9', cursor: '#e53e3e' };

function axisStyle(): uPlot.Axis {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const stroke = dark ? '#9aa2b1' : '#626977';
  const grid = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.07)';
  return { stroke, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid } };
}

/** 화면 픽셀 수 수준으로 줄인다 — 수만 포인트를 그대로 그리면 버벅인다. */
function downsample(xs: Float64Array | number[], ys: number[][], maxPoints: number): [number[], number[][]] {
  const n = xs.length;
  if (n <= maxPoints) return [Array.from(xs), ys.map((y) => Array.from(y))];
  const step = Math.ceil(n / maxPoints);
  const ox: number[] = [];
  const oys: number[][] = ys.map(() => []);
  for (let i = 0; i < n; i += step) {
    ox.push(xs[i]);
    for (let s = 0; s < ys.length; s++) {
      // 구간 내 절댓값이 가장 큰 값을 대표로 — 충격 피크가 사라지면 안 된다
      let peak = ys[s][i];
      for (let j = i; j < Math.min(i + step, n); j++) {
        if (Math.abs(ys[s][j]) > Math.abs(peak)) peak = ys[s][j];
      }
      oys[s].push(peak);
    }
  }
  return [ox, oys];
}

export class TimeCharts {
  private speedPlot: uPlot | null = null;
  private gPlot: uPlot | null = null;

  constructor(
    private readonly speedEl: HTMLElement,
    private readonly gEl: HTMLElement,
  ) {}

  render(doc: JdrDocument): void {
    this.destroy();
    const t0 = doc.firstTimeMs;

    // ── 속도 ──
    const fixes = GpsMap.validFixes(doc.gps);
    if (fixes.length > 1) {
      const xs = fixes.map((g) => (g.timeMs - t0) / 1000);
      const ys = fixes.map((g) => g.speed);
      this.speedPlot = new uPlot(
        {
          width: this.speedEl.clientWidth || 320,
          height: 170,
          title: '속도 (km/h · 추정)',
          cursor: { y: false },
          scales: { x: { time: false } },
          axes: [{ ...axisStyle(), label: '초' }, axisStyle()],
          series: [
            { label: '초' },
            { label: 'km/h', stroke: COLORS.speed, width: 2, fill: 'rgba(43,108,176,.12)' },
          ],
        },
        [xs, ys],
        this.speedEl,
      );
    } else {
      this.speedEl.innerHTML = '<p class="muted small">표시할 GPS 속도 데이터가 없습니다.</p>';
    }

    // ── G센서 ──
    const s = doc.gsensor;
    if (s.count > 1) {
      const xsAll = new Float64Array(s.count);
      for (let i = 0; i < s.count; i++) xsAll[i] = (s.timeMs[i] - t0) / 1000;
      const [xs, [gx, gy, gz]] = downsample(
        xsAll,
        [
          Array.from(s.x, (v) => v / GSENSOR_SCALE),
          Array.from(s.y, (v) => v / GSENSOR_SCALE),
          Array.from(s.z, (v) => v / GSENSOR_SCALE),
        ],
        2000,
      );
      this.gPlot = new uPlot(
        {
          width: this.gEl.clientWidth || 320,
          height: 170,
          title: 'G센서 (raw ÷ 1024 ≈ g · 추정)',
          cursor: { y: false },
          scales: { x: { time: false } },
          axes: [{ ...axisStyle(), label: '초' }, axisStyle()],
          series: [
            { label: '초' },
            { label: 'X', stroke: COLORS.x, width: 1.5 },
            { label: 'Y', stroke: COLORS.y, width: 1.5 },
            { label: 'Z', stroke: COLORS.z, width: 1.5 },
          ],
        },
        [xs, gx, gy, gz],
        this.gEl,
      );
    } else {
      this.gEl.innerHTML = '<p class="muted small">표시할 G센서 데이터가 없습니다.</p>';
    }
  }

  /** 재생 위치를 차트 커서로 표시 */
  syncTo(relSec: number): void {
    for (const plot of [this.speedPlot, this.gPlot]) {
      if (!plot) continue;
      const left = plot.valToPos(relSec, 'x');
      plot.setCursor({ left, top: 0 });
    }
  }

  resize(): void {
    for (const [plot, el] of [[this.speedPlot, this.speedEl], [this.gPlot, this.gEl]] as const) {
      if (plot && el.clientWidth > 0) plot.setSize({ width: el.clientWidth, height: 170 });
    }
  }

  destroy(): void {
    this.speedPlot?.destroy();
    this.gPlot?.destroy();
    this.speedPlot = null;
    this.gPlot = null;
    this.speedEl.innerHTML = '';
    this.gEl.innerHTML = '';
  }
}
