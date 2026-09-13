import { describe, expect, it } from 'vitest';
import { buildLibrary } from '../src/core/library';
import { StripLayout } from '../src/core/strip-layout';
import type { SegmentInfo } from '../src/core/segment';

const T = (h: number, m: number, s = 0) => Date.UTC(2026, 8, 12, h, m, s);
const seg = (name: string, start: number, durSec: number): SegmentInfo => ({
  id: name, name, path: `data/${name}`, folder: 'data', size: 70 << 20,
  startMs: start, endMs: start + durSec * 1000, durationMs: durSec * 1000,
  packetCount: 5000, ch0Count: 2000, ch1Count: 2000, gpsCount: 70, sensorCount: 700,
  blockOffsets: [0], timeSource: 'header', endEstimated: false,
});

describe('스트립 축', () => {
  /** 실제 모양: 오전 운행 → 13시간 공백 → 오후 운행 */
  function dayLibrary() {
    const segs: SegmentInfo[] = [];
    for (let i = 0; i < 40; i++) segs.push(seg(`m${i}.jdr`, T(8, 9) + i * 70_000, 69));
    for (let i = 0; i < 39; i++) segs.push(seg(`e${i}.jdr`, T(22, 24) + i * 70_000, 69));
    return buildLibrary(segs);
  }

  it('벽시계 비율을 그대로 쓰면 구간이 실이 되지만, 눌러 담으면 보인다', () => {
    const lib = dayLibrary();
    // 벽시계 그대로였다면
    const rawRatio = (69_000 / lib.spanMs) * 100;
    expect(rawRatio).toBeLessThan(0.15);

    const layout = new StripLayout(lib);
    const segItems = layout.items.filter((i) => i.kind === 'segment');
    expect(segItems).toHaveLength(79);
    const width = (segItems[0].to - segItems[0].from) * 100;
    // 최소 5배는 넓어져야 실제로 클릭할 수 있다
    expect(width).toBeGreaterThan(rawRatio * 5);
  });

  it('빈 구간을 없애지 않는다 — 축에 남아 있다', () => {
    const lib = dayLibrary();
    const layout = new StripLayout(lib);
    const gaps = layout.items.filter((i) => i.kind === 'gap');
    expect(gaps).toHaveLength(lib.gaps.length);
    expect(gaps[0].to - gaps[0].from).toBeGreaterThan(0);
  });

  it('시간 순서가 유지되고 축을 빈틈없이 채운다', () => {
    const layout = new StripLayout(dayLibrary());
    let prev = -1;
    for (const it of layout.items) {
      expect(it.from).toBeCloseTo(prev < 0 ? 0 : prev, 6);
      expect(it.to).toBeGreaterThan(it.from);
      prev = it.to;
    }
    expect(prev).toBeCloseTo(1, 6);
  });

  it('시각 ↔ 축 위치가 왕복한다', () => {
    const lib = dayLibrary();
    const layout = new StripLayout(lib);
    for (const s of [lib.segments[0], lib.segments[20], lib.segments[78]]) {
      const mid = s.startMs + s.durationMs / 2;
      expect(layout.timeAt(layout.ratioAt(mid))).toBeCloseTo(mid, -1);
    }
    expect(layout.ratioAt(lib.startMs)).toBeCloseTo(0, 6);
    expect(layout.ratioAt(lib.endMs)).toBeCloseTo(1, 6);
  });

  it('빈 구간 안의 시각도 그 구간 안으로 매핑된다', () => {
    const lib = dayLibrary();
    const layout = new StripLayout(lib);
    const g = lib.gaps[0];
    const mid = (g.fromMs + g.toMs) / 2;
    const r = layout.ratioAt(mid);
    const gapItem = layout.items.find((i) => i.kind === 'gap')!;
    expect(r).toBeGreaterThanOrEqual(gapItem.from);
    expect(r).toBeLessThanOrEqual(gapItem.to);
  });

  it('구간이 하나뿐이면 축 전체를 차지한다', () => {
    const layout = new StripLayout(buildLibrary([seg('only.jdr', T(8, 0), 69)]));
    expect(layout.items).toHaveLength(1);
    expect(layout.items[0].from).toBe(0);
    expect(layout.items[0].to).toBe(1);
  });
});
