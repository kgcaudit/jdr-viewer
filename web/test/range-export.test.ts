/**
 * 시간 구간 내보내기.
 *
 * 파일 하나가 50초라 파일 단위 내보내기는 쓸모가 없다.
 * "07:57:13부터 08:02:13까지"를 파일 여섯 개에서 이어 붙이는 것이 목표다.
 */
import { describe, expect, it } from 'vitest';
import { BufferByteSource } from '../src/core/byte-source';
import { parseJdr } from '../src/core/parser';
import {
  buildRange, estimateRangeBytes, rangeFileName, segmentsInRange,
} from '../src/core/range-export';
import type { SegmentInfo } from '../src/core/segment';
import { buildJdrBlock, pcmTone, type SynthPacket } from './synth';

const T = (h: number, m: number, s = 0) => Date.UTC(2026, 8, 9, h, m, s);

/** 30fps · 3초마다 키프레임 · 채널 2개 · 오디오 */
function makeFile(startMs: number, seconds: number) {
  const packets: SynthPacket[] = [];
  const frames = seconds * 30;
  for (let f = 0; f < frames; f++) {
    const t = startMs + Math.round((f * 1000) / 30);
    const key = f % 90 === 0;
    for (const ch of ['00', '01']) {
      packets.push({
        tag: `${ch}V${key ? 'I' : 'P'}`,
        payload: new Uint8Array(ch === '00' ? 300 : 200).fill(f & 0xff),
        timeMs: t, aux: f,
      });
    }
    if (f % 6 === 0) packets.push({ tag: '00AD', payload: pcmTone(1600, f * 1600), timeMs: t });
  }
  return new BufferByteSource(buildJdrBlock(packets), 'x.jdr');
}

function segOf(startMs: number, seconds: number, name: string): SegmentInfo {
  return {
    id: name, name, path: `data/${name}`, folder: 'data', size: 7_000_000,
    startMs, endMs: startMs + seconds * 1000, durationMs: seconds * 1000,
    packetCount: seconds * 30 * 2, ch0Count: seconds * 30, ch1Count: seconds * 30,
    gpsCount: 0, sensorCount: 0, blockOffsets: [0], timeSource: 'header', endEstimated: false,
  };
}

/** 10초짜리 파일 4개 = 07:00:00 ~ 07:00:40 */
function library() {
  const segments: SegmentInfo[] = [];
  const sources = new Map<string, BufferByteSource>();
  for (let i = 0; i < 4; i++) {
    const start = T(7, 0, i * 10);
    const name = `0000044${i}.jdr`;
    segments.push(segOf(start, 10, name));
    sources.set(name, makeFile(start, 10));
  }
  const loader = {
    async load(seg: SegmentInfo) {
      const src = sources.get(seg.name)!;
      return { doc: await parseJdr(src), src };
    },
  };
  return { segments, loader };
}

describe('파일명 규칙', () => {
  it('언제 찍힌 건지 이름만 보고 알 수 있다', () => {
    const r = { fromMs: T(7, 57, 13), toMs: T(8, 2, 13) };
    expect(rangeFileName(r, 'front')).toBe('260909_075713-080213_Front.h264');
    expect(rangeFileName(r, 'rear')).toBe('260909_075713-080213_Rear.h264');
    expect(rangeFileName(r, 'audio')).toBe('260909_075713-080213_Audio.wav');
    expect(rangeFileName(r, 'gps')).toBe('260909_075713-080213_GPS.csv');
    expect(rangeFileName(r, 'sensor')).toBe('260909_075713-080213_Sensor.csv');
  });

  it('자정을 넘으면 끝에도 날짜를 붙인다', () => {
    const r = { fromMs: T(23, 50, 0), toMs: Date.UTC(2026, 8, 10, 0, 12, 0) };
    expect(rangeFileName(r, 'front')).toBe('260909_235000-260910_001200_Front.h264');
  });
});

describe('구간에 걸친 파일 고르기', () => {
  const { segments } = library();

  it('겹치는 것만 고른다', () => {
    const hit = segmentsInRange(segments, { fromMs: T(7, 0, 12), toMs: T(7, 0, 25) });
    expect(hit.map((s) => s.name)).toEqual(['00000441.jdr', '00000442.jdr']);
  });

  it('경계에 딱 걸친 것은 넣지 않는다', () => {
    const hit = segmentsInRange(segments, { fromMs: T(7, 0, 10), toMs: T(7, 0, 20) });
    expect(hit.map((s) => s.name)).toEqual(['00000441.jdr']);
  });

  it('아무것도 안 걸치면 빈 배열', () => {
    expect(segmentsInRange(segments, { fromMs: T(9, 0), toMs: T(9, 5) })).toEqual([]);
  });
});

describe('구간 내보내기', () => {
  it('여러 파일에 걸친 영상을 하나로 이어 붙인다', async () => {
    const { segments, loader } = library();
    const one = await buildRange('front', segments, loader, { fromMs: T(7, 0, 2), toMs: T(7, 0, 8) });
    const three = await buildRange('front', segments, loader, { fromMs: T(7, 0, 2), toMs: T(7, 0, 28) });
    expect(one.segmentCount).toBe(1);
    expect(three.segmentCount).toBe(3);
    expect(three.blob.size).toBeGreaterThan(one.blob.size * 3);
  });

  it('영상은 반드시 키프레임에서 시작한다', async () => {
    const { segments, loader } = library();
    // 3초마다 키프레임이므로 5초 지점을 요청하면 3초로 거슬러 올라가야 한다
    const r = await buildRange('front', segments, loader, { fromMs: T(7, 0, 5), toMs: T(7, 0, 9) });
    expect(r.actualFromMs).toBeLessThan(T(7, 0, 5));
    expect(r.actualFromMs).toBe(T(7, 0, 3));
  });

  it('전방과 후방이 따로 나온다', async () => {
    const { segments, loader } = library();
    const range = { fromMs: T(7, 0, 0), toMs: T(7, 0, 9) };
    const front = await buildRange('front', segments, loader, range);
    const rear = await buildRange('rear', segments, loader, range);
    // 픽스처에서 전방이 300바이트, 후방이 200바이트짜리 프레임이다
    expect(front.blob.size).toBeGreaterThan(rear.blob.size);
  });

  it('음성은 WAV 머리글이 붙고 길이가 구간에 맞는다', async () => {
    const { segments, loader } = library();
    const r = await buildRange('audio', segments, loader, { fromMs: T(7, 0, 0), toMs: T(7, 0, 20) });
    const head = new Uint8Array(await r.blob.slice(0, 44).arrayBuffer());
    expect(String.fromCharCode(...head.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...head.subarray(8, 12))).toBe('WAVE');
    // 20초 × 8000Hz × 2바이트 언저리
    const seconds = (r.blob.size - 44) / 2 / 8000;
    expect(seconds).toBeGreaterThan(15);
    expect(seconds).toBeLessThan(22);
  });

  it('범위가 좁으면 결과도 작다', async () => {
    const { segments, loader } = library();
    const wide = await buildRange('front', segments, loader, { fromMs: T(7, 0, 0), toMs: T(7, 0, 40) });
    const narrow = await buildRange('front', segments, loader, { fromMs: T(7, 0, 30), toMs: T(7, 0, 33) });
    expect(narrow.blob.size).toBeLessThan(wide.blob.size / 4);
  });

  it('해당하는 영상이 없으면 사유를 알린다', async () => {
    const { segments, loader } = library();
    await expect(buildRange('front', segments, loader, { fromMs: T(9, 0), toMs: T(9, 5) }))
      .rejects.toThrow('해당하는 영상이 없습니다');
  });

  it('진행률이 0에서 1까지 올라가고 파일 이름을 알려 준다', async () => {
    const { segments, loader } = library();
    const seen: number[] = [];
    const names = new Set<string>();
    await buildRange('front', segments, loader, { fromMs: T(7, 0, 0), toMs: T(7, 0, 40) }, (p) => {
      seen.push(p.ratio);
      if (p.name) names.add(p.name);
    });
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(1);
    expect(names.size).toBe(4);
  });
});

describe('크기 어림', () => {
  const { segments } = library();

  it('범위가 두 배면 어림값도 대략 두 배', () => {
    const a = estimateRangeBytes(segments, { fromMs: T(7, 0, 0), toMs: T(7, 0, 10) }, 'front');
    const b = estimateRangeBytes(segments, { fromMs: T(7, 0, 0), toMs: T(7, 0, 20) }, 'front');
    expect(b / a).toBeCloseTo(2, 1);
  });

  it('음성은 초당 16KB로 정확히 셈한다', () => {
    const v = estimateRangeBytes(segments, { fromMs: T(7, 0, 0), toMs: T(7, 0, 10) }, 'audio');
    expect(v).toBe(10 * 8000 * 2);
  });

  it('범위 밖이면 0', () => {
    expect(estimateRangeBytes(segments, { fromMs: T(9, 0), toMs: T(9, 5) }, 'front')).toBe(0);
  });
});
