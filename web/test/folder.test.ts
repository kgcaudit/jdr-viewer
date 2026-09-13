import { describe, expect, it } from 'vitest';
import { BufferByteSource } from '../src/core/byte-source';
import { probeSegment, timeFromFileName, type SegmentInfo } from '../src/core/segment';
import { buildLibrary, resolvePlayPosition, segmentIndexAt, gapAt } from '../src/core/library';
import { scanRecords } from '../src/core/records';
import { formatRecordedTime } from '../src/core/time';
import { buildJdrBlock, concatBlocks, gpsPayload, gsensorPayload, pcmTone, type SynthPacket } from './synth';

const FPS = 30;

/**
 * 지정한 시각에서 시작하는 합성 JDR 한 개.
 * videoBytes를 키우면 실제 기기처럼 레코드 사이가 멀어져, 인덱스 스캔의 이점이 드러난다.
 */
function makeFile(startMs: number, seconds: number, baseOffset = 0, videoBytes = 6): Uint8Array<ArrayBuffer> {
  const packets: SynthPacket[] = [];
  const frames = seconds * FPS;
  for (let f = 0; f < frames; f++) {
    const t = startMs + Math.round((f * 1000) / FPS);
    const isKey = f % 15 === 0;
    for (const ch of ['00', '01']) {
      const payload = new Uint8Array(videoBytes);
      payload.set([0, 0, 0, 1, isKey ? 0x65 : 0x41, f & 0xff]);
      packets.push({ tag: `${ch}V${isKey ? 'I' : 'P'}`, payload, timeMs: t, aux: f });
    }
    if (f % 6 === 0) packets.push({ tag: '00AD', payload: pcmTone(1600, f * 1600), timeMs: t });
    if (f % 30 === 0) {
      packets.push({
        tag: '00GP', timeMs: t,
        payload: gpsPayload({
          year: 2026, month: 9, day: 9, hour: 8, minute: 0, second: f / 30,
          latNmea: 3733.5678 + f * 0.0001, lonNmea: 12658.1234 + f * 0.0001,
          altitude: 40, speed: 60,
        }),
      });
    }
    if (f % 3 === 0) packets.push({ tag: '00SE', payload: gsensorPayload(f, -f, 1024), timeMs: t });
  }
  return buildJdrBlock(packets, baseOffset);
}

const T = (h: number, m: number, s: number) => Date.UTC(2026, 8, 9, h, m, s, 0);

async function probe(bytes: Uint8Array<ArrayBuffer>, name: string, path = name): Promise<SegmentInfo> {
  return probeSegment({ src: new BufferByteSource(bytes, name), name, path, size: bytes.length });
}

describe('세그먼트 프로브', () => {
  it('헤더 512바이트만으로 시간 범위와 구성을 읽는다', async () => {
    const bytes = makeFile(T(8, 16, 0), 4);
    const src = new BufferByteSource(bytes, '00000465.jdr');
    let reads = 0;
    let readBytes = 0;
    const counting = {
      size: src.size, name: src.name,
      async read(o: number, l: number) { reads++; const b = await src.read(o, l); readBytes += b.length; return b; },
    };
    const seg = await probeSegment({ src: counting, name: '00000465.jdr', path: 'data/00000465.jdr', size: bytes.length });

    expect(seg.error).toBeUndefined();
    expect(seg.folder).toBe('data');
    expect(seg.timeSource).toBe('header');
    expect(formatRecordedTime(seg.startMs, false)).toBe('2026-09-09 08:16:00');
    expect(seg.durationMs).toBeGreaterThan(3800);
    expect(seg.ch0Count).toBe(120);
    expect(seg.ch1Count).toBe(120);
    expect(seg.blockOffsets).toEqual([0]);
    // 파일 전체(수백 KB)가 아니라 헤더 몇 개만 읽어야 한다
    expect(readBytes).toBeLessThan(4096);
    expect(reads).toBeLessThanOrEqual(3);
  });

  it('블록이 여러 개면 체인을 따라가 전부 센다', async () => {
    const a = makeFile(T(8, 16, 0), 2);
    const b = makeFile(T(8, 16, 2), 2, a.length);
    const seg = await probe(concatBlocks([a, b]), 'multi.jdr');
    expect(seg.blockOffsets).toEqual([0, a.length]);
    expect(seg.ch0Count).toBe(120);
    expect(formatRecordedTime(seg.startMs, false)).toBe('2026-09-09 08:16:00');
    expect(seg.endMs).toBeGreaterThan(T(8, 16, 3));
  });

  it('JDR이 아니면 사유를 남긴다 (조용히 버리지 않는다)', async () => {
    const junk = new Uint8Array(8192).fill(0xab);
    const seg = await probe(junk, 'broken.jdr');
    expect(seg.error).toContain('JEB1');
  });
});

describe('파일명 시각 추출', () => {
  it('구분자가 있어도 찾는다', () => {
    expect(formatRecordedTime(timeFromFileName('20260115_090000_NF.jdr'), false)).toBe('2026-01-15 09:00:00');
    expect(formatRecordedTime(timeFromFileName('2026-01-15 09-30-45.jdr'), false)).toBe('2026-01-15 09:30:45');
  });
  it('순번만 있는 실제 기기 파일명에서는 못 찾는다', () => {
    // 실제 IROAD는 00000465.jdr 처럼 순번만 쓴다 → 헤더 시각이 유일한 근거
    expect(Number.isNaN(timeFromFileName('00000465.jdr'))).toBe(true);
    expect(Number.isNaN(timeFromFileName('00000000.jdr'))).toBe(true);
  });
});

describe('라이브러리 타임라인', () => {
  const seg = (name: string, start: number, durSec: number, folder = 'data'): SegmentInfo => ({
    id: `${folder}/${name}`, name, path: `${folder}/${name}`, folder, size: 70 << 20,
    startMs: start, endMs: start + durSec * 1000, durationMs: durSec * 1000,
    packetCount: 100, ch0Count: 50, ch1Count: 50, gpsCount: 5, sensorCount: 20,
    blockOffsets: [0], timeSource: 'header', endEstimated: false,
  });

  it('순번이 순환해도 기록 시각 순으로 정렬한다', () => {
    // 루프 녹화는 오래된 파일을 덮어쓰므로 번호 순서 ≠ 시간 순서다
    const lib = buildLibrary([
      seg('00000465.jdr', T(8, 16, 0), 44),
      seg('00000001.jdr', T(8, 10, 0), 44),   // 번호는 작지만 더 이른 시각
      seg('00000466.jdr', T(8, 16, 44), 44),
    ]);
    expect(lib.segments.map((s) => s.name)).toEqual([
      '00000001.jdr', '00000465.jdr', '00000466.jdr',
    ]);
    expect(formatRecordedTime(lib.startMs, false)).toBe('2026-09-09 08:10:00');
  });

  it('빈 구간을 찾아낸다', () => {
    const lib = buildLibrary([
      seg('a.jdr', T(8, 0, 0), 44),
      seg('b.jdr', T(8, 0, 44), 44),
      seg('c.jdr', T(9, 0, 0), 44),   // 큰 공백
    ]);
    expect(lib.gaps).toHaveLength(1);
    expect(lib.gaps[0].durationMs).toBe(T(9, 0, 0) - T(8, 1, 28));
    expect(lib.coveredMs).toBe(3 * 44_000);
    expect(lib.spanMs).toBe(T(9, 0, 44) - T(8, 0, 0));
  });

  it('짧은 겹침도 놓치지 않는다', () => {
    // 겹침은 갭보다 민감하게 본다 — 같은 시각 파일이 있다는 사실 자체가 알릴 정보다
    const lib = buildLibrary([
      seg('a.jdr', T(8, 0, 0), 2),
      { ...seg('b.jdr', T(8, 0, 0) + 1200, 2), name: 'b.jdr' },
    ]);
    expect(lib.overlaps).toHaveLength(1);
  });

  it('파일 경계의 미세한 어긋남은 갭으로도 겹침으로도 세지 않는다', () => {
    const lib = buildLibrary([
      seg('a.jdr', T(8, 0, 0), 44),
      seg('b.jdr', T(8, 0, 44) + 100, 44),   // 100ms 틈
    ]);
    expect(lib.gaps).toHaveLength(0);
    expect(lib.overlaps).toHaveLength(0);
  });

  it('겹치는 구간을 찾아낸다 (event가 data와 겹치는 경우)', () => {
    const lib = buildLibrary([
      seg('data.jdr', T(8, 0, 0), 60, 'data'),
      seg('event.jdr', T(8, 0, 20), 20, 'event'),
    ]);
    expect(lib.overlaps).toHaveLength(1);
    // 겹쳐도 실제로 덮인 시간은 60초다
    expect(lib.coveredMs).toBe(60_000);
  });

  it('빈 구간으로 이동하면 다음 구간 시작으로 건너뛴다', () => {
    const lib = buildLibrary([
      seg('a.jdr', T(8, 0, 0), 44),
      seg('c.jdr', T(9, 0, 0), 44),
    ]);
    expect(gapAt(lib, T(8, 30, 0))).not.toBeNull();
    expect(segmentIndexAt(lib, T(8, 30, 0))).toBe(-1);

    const jumped = resolvePlayPosition(lib, T(8, 30, 0));
    expect(jumped).toEqual({ index: 1, absMs: T(9, 0, 0) });

    const inside = resolvePlayPosition(lib, T(8, 0, 10));
    expect(inside).toEqual({ index: 0, absMs: T(8, 0, 10) });
  });

  it('읽지 못한 파일은 따로 모아둔다', () => {
    const bad = { ...seg('broken.jdr', NaN, 0), error: 'JEB1 블록을 찾지 못했습니다' };
    const lib = buildLibrary([seg('a.jdr', T(8, 0, 0), 44), bad]);
    expect(lib.segments).toHaveLength(1);
    expect(lib.invalid).toHaveLength(1);
    expect(lib.invalid[0].error).toContain('JEB1');
  });
});

describe('인덱스 기반 레코드 스캔', () => {
  it('파일 전체를 읽지 않고 GPS·센서만 뽑는다', async () => {
    // 실제 기기처럼 프레임이 커서 레코드 사이가 먼 파일
    const bytes = makeFile(T(8, 16, 0), 10, 0, 16 * 1024);
    const seg = await probe(bytes, '00000465.jdr');
    const src = new BufferByteSource(bytes, '00000465.jdr');
    const result = await scanRecords(src, seg, 0);

    expect(result.indexUnavailable).toBe(false);
    expect(result.gps).toHaveLength(10);
    expect(result.gsensor.count).toBe(100);
    expect(result.gps[0].lat).toBeCloseTo(37 + 33.5678 / 60, 5);
    expect(result.gps[0].speed).toBeCloseTo(60, 6);
    expect(result.gsensor.z[0]).toBe(1024);
    // 핵심: 전체 파일보다 훨씬 적게 읽어야 한다 (실측 70MB 파일에서는 0.1MB만 읽었다)
    expect(result.bytesRead).toBeLessThan(bytes.length / 10);
  });

  it('센서 샘플 수를 제한하면 솎아낸다', async () => {
    const bytes = makeFile(T(8, 16, 0), 10);
    const seg = await probe(bytes, 'x.jdr');
    const result = await scanRecords(new BufferByteSource(bytes, 'x.jdr'), seg, 20);
    expect(result.gps).toHaveLength(10);         // GPS는 전부
    expect(result.gsensor.count).toBeLessThanOrEqual(20);
    expect(result.gsensor.count).toBeGreaterThan(0);
  });

  it('시각이 함께 나온다', async () => {
    const bytes = makeFile(T(8, 16, 0), 4);
    const seg = await probe(bytes, 'x.jdr');
    const result = await scanRecords(new BufferByteSource(bytes, 'x.jdr'), seg, 0);
    expect(formatRecordedTime(result.gps[0].timeMs, false)).toBe('2026-09-09 08:16:00');
    expect(result.gsensor.timeMs[0]).toBe(T(8, 16, 0));
  });
});
