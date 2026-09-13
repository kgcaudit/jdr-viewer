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

describe('최소 구간 폭', () => {
  /** 운행 하나 = 파일 60개, 중간에 짧은 공백 5개 */
  function sessionLibrary() {
    const segs: SegmentInfo[] = [];
    let t = T(8, 0);
    for (let i = 0; i < 60; i++) {
      // 12개마다 5분 공백
      if (i > 0 && i % 12 === 0) t += 5 * 60_000;
      segs.push(seg(`s${i}.jdr`, t, i === 30 ? 4 : 69)); // 하나는 4초짜리 짧은 파일
      t += 70_000;
    }
    return buildLibrary(segs);
  }

  it('보정이 없으면 짧은 파일이 사실상 0폭이 된다', () => {
    const layout = new StripLayout(sessionLibrary());
    const short = layout.items.filter((i) => i.kind === 'segment')[30];
    // 390px 화면 기준 폭
    expect((short.to - short.from) * 390).toBeLessThan(1);
  });

  it('최소 폭을 주면 짧은 파일도 긴 파일과 같은 폭을 받는다', () => {
    const trackPx = 390;
    const layout = new StripLayout(sessionLibrary(), 7 / trackPx);
    const segs = layout.items.filter((i) => i.kind === 'segment');
    expect(segs).toHaveLength(60);

    // 60개 × 7px = 420px > 390px이라 7px를 다 줄 수는 없다.
    // 그때는 구간 몫을 똑같이 나눈다 (빈 구간 표시는 그대로 둔다).
    const each = (segs[0].to - segs[0].from) * trackPx;
    expect(each).toBeGreaterThan(5.5);
    for (const it of segs) expect((it.to - it.from) * trackPx).toBeCloseTo(each, 6);
    // 보정 전 4초짜리는 1px도 안 됐다
    expect(each).toBeGreaterThan(5);
  });

  it('여유가 있으면 요청한 최소 폭을 지킨다', () => {
    const trackPx = 1280;
    const segs20: SegmentInfo[] = [];
    let t = T(8, 0);
    for (let i = 0; i < 20; i++) {
      segs20.push(seg(`x${i}.jdr`, t, i === 5 ? 2 : 69));
      t += 70_000;
    }
    const layout = new StripLayout(buildLibrary(segs20), 7 / trackPx);
    const segs = layout.items.filter((i) => i.kind === 'segment');
    for (const it of segs) {
      expect((it.to - it.from) * trackPx).toBeGreaterThanOrEqual(7 - 1e-6);
    }
    // 2초짜리는 최소 폭에 붙고, 69초짜리는 그보다 훨씬 넓다
    expect((segs[5].to - segs[5].from) * trackPx).toBeCloseTo(7, 3);
    expect((segs[0].to - segs[0].from) * trackPx).toBeGreaterThan(20);
  });

  it('축은 여전히 0에서 1까지 빈틈없이 이어진다', () => {
    const layout = new StripLayout(sessionLibrary(), 7 / 390);
    expect(layout.items[0].from).toBeCloseTo(0, 6);
    expect(layout.items[layout.items.length - 1].to).toBeCloseTo(1, 6);
    for (let i = 1; i < layout.items.length; i++) {
      expect(layout.items[i].from).toBeCloseTo(layout.items[i - 1].to, 6);
    }
  });

  it('여유가 있으면 길이 비율이 지켜진다 — 긴 구간이 더 넓다', () => {
    const layout = new StripLayout(sessionLibrary(), 7 / 1280);
    const segs = layout.items.filter((i) => i.kind === 'segment');
    const short = segs[30].to - segs[30].from;   // 4초
    const long = segs[0].to - segs[0].from;      // 69초
    expect(long).toBeGreaterThan(short);
    expect(short * 1280).toBeGreaterThanOrEqual(7 - 1e-6);
  });

  it('최소 폭이 감당 못 할 만큼 크면 똑같이 나눈다 (넘치지 않는다)', () => {
    const layout = new StripLayout(sessionLibrary(), 0.5); // 말이 안 되는 요구
    const segs = layout.items.filter((i) => i.kind === 'segment');
    const first = segs[0].to - segs[0].from;
    for (const it of segs) expect(it.to - it.from).toBeCloseTo(first, 6);
    expect(layout.items[layout.items.length - 1].to).toBeCloseTo(1, 6);
  });
});

describe('빈 구간 스냅', () => {
  function gappyLibrary() {
    return buildLibrary([
      seg('a.jdr', T(8, 0), 69),
      seg('b.jdr', T(9, 0), 69),  // 앞과 약 59분 공백
    ]);
  }

  it('구간 위를 누르면 그 시각 그대로다', () => {
    const layout = new StripLayout(gappyLibrary());
    const mid = layout.items.find((i) => i.kind === 'segment')!;
    const r = (mid.from + mid.to) / 2;
    expect(layout.snapTime(r)).toBeCloseTo(layout.timeAt(r), 3);
  });

  it('빈 구간 앞쪽을 누르면 앞 구간의 끝으로 붙는다', () => {
    const lib = gappyLibrary();
    const layout = new StripLayout(lib);
    const gap = layout.items.find((i) => i.kind === 'gap')!;
    const r = gap.from + (gap.to - gap.from) * 0.2;
    expect(layout.snapTime(r)).toBe(lib.segments[0].endMs);
    expect(layout.segmentAt(r)).toBe(0);
  });

  it('빈 구간 뒤쪽을 누르면 다음 구간의 시작으로 붙는다', () => {
    const lib = gappyLibrary();
    const layout = new StripLayout(lib);
    const gap = layout.items.find((i) => i.kind === 'gap')!;
    const r = gap.from + (gap.to - gap.from) * 0.8;
    expect(layout.snapTime(r)).toBe(lib.segments[1].startMs);
    expect(layout.segmentAt(r)).toBe(1);
  });

  it('빈 구간 한가운데로는 절대 가지 않는다', () => {
    const lib = gappyLibrary();
    const layout = new StripLayout(lib);
    const gap = layout.items.find((i) => i.kind === 'gap')!;
    for (const t of [0.1, 0.3, 0.49, 0.51, 0.7, 0.9]) {
      const ms = layout.snapTime(gap.from + (gap.to - gap.from) * t);
      const inGap = ms > lib.segments[0].endMs && ms < lib.segments[1].startMs;
      expect(inGap).toBe(false);
    }
  });
});
