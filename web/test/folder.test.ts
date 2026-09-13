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
    // 파일 전체(수백 KB)가 아니라 헤더 몇 조각만 읽어야 한다
    // (JEB 헤더 + 첫 패킷 + 인덱스 마지막 항목 + 마지막 패킷)
    expect(readBytes).toBeLessThan(4096);
    expect(reads).toBeLessThanOrEqual(6);
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

  it('헤더의 종료 시각이 실제 마지막 패킷보다 이르면 바로잡는다', async () => {
    // 실기기에서 헤더 +0xA4가 실제보다 1.8초 이른 경우가 있었다.
    // 그대로 두면 재생 길이 표시가 어긋나고 파일 사이에 없는 빈 구간이 생긴다.
    const bytes = makeFile(T(8, 16, 0), 4);
    const dv = new DataView(bytes.buffer);
    // 블록 헤더의 종료 시각을 일부러 2초 이르게 바꾼다
    const early = new Date(T(8, 16, 1));
    dv.setUint16(0xa4, early.getUTCFullYear(), true);
    dv.setUint16(0xa4 + 2, early.getUTCMonth() + 1, true);
    dv.setUint16(0xa4 + 6, early.getUTCDate(), true);
    dv.setUint16(0xa4 + 8, early.getUTCHours(), true);
    dv.setUint16(0xa4 + 10, early.getUTCMinutes(), true);
    dv.setUint16(0xa4 + 12, early.getUTCSeconds(), true);
    dv.setUint16(0xa4 + 14, 0, true);

    const seg = await probe(bytes, 'x.jdr');
    // 헤더대로면 1초, 실제 패킷대로면 약 4초
    expect(seg.durationMs).toBeGreaterThan(3500);
    expect(seg.timeSource).toBe('packets');
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
    blockOffsets: [0], timeSource: 'header', endEstimated: false, headerShiftMs: 0,
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

  it('event가 data의 사본이면 되풀이 재생되지 않게 줄기에서 뺀다', () => {
    const lib = buildLibrary([
      seg('data.jdr', T(8, 0, 0), 60, 'data'),
      seg('event.jdr', T(8, 0, 20), 20, 'event'),
    ]);
    // 같은 20초를 두 번 재생하면 안 된다
    expect(lib.segments.map((s) => s.name)).toEqual(['data.jdr']);
    expect(lib.duplicates.map((s) => s.name)).toEqual(['event.jdr']);
    expect(lib.overlaps).toHaveLength(0);
    expect(lib.coveredMs).toBe(60_000);
    // 뺐어도 "여기서 이벤트가 걸렸다"는 사실은 남는다
    expect(lib.events).toHaveLength(1);
    expect(lib.events[0].inChain).toBe(false);
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

describe('빈 구간의 원인 가르기', () => {
  /** 번호가 이어지는 파일들 */
  const f = (no: number, startMs: number, durSec = 60): SegmentInfo => ({
    id: `data/${String(no).padStart(8, '0')}.jdr`,
    name: `${String(no).padStart(8, '0')}.jdr`,
    path: `data/${String(no).padStart(8, '0')}.jdr`,
    folder: 'data', size: 70 << 20,
    startMs, endMs: startMs + durSec * 1000, durationMs: durSec * 1000,
    packetCount: 4000, ch0Count: 1800, ch1Count: 1800, gpsCount: 60, sensorCount: 600,
    blockOffsets: [0], timeSource: 'header', endEstimated: false, headerShiftMs: 0,
  });

  const T0 = Date.UTC(2026, 8, 12, 23, 16, 43);

  it('파일 번호가 건너뛰면 파일이 없는 것으로 본다', () => {
    // 87 다음이 89 — 88이 없다
    const lib = buildLibrary([f(87, T0), f(89, T0 + 120_000)]);
    expect(lib.gaps).toHaveLength(1);
    expect(lib.gaps[0].numberSkip).toBe(1);
    expect(lib.gaps[0].beforeName).toBe('00000087.jdr');
    expect(lib.gaps[0].afterName).toBe('00000089.jdr');
  });

  it('여러 개가 빠지면 그 수를 센다', () => {
    const lib = buildLibrary([f(87, T0), f(92, T0 + 300_000)]);
    expect(lib.gaps[0].numberSkip).toBe(4);
  });

  it('번호가 이어지는데 비면 기록이 끊긴 것이다', () => {
    // 87 다음이 88인데 시간이 17초 빈다
    const lib = buildLibrary([f(87, T0), f(88, T0 + 77_000)]);
    expect(lib.gaps).toHaveLength(1);
    expect(lib.gaps[0].numberSkip).toBe(0);
    expect(lib.gaps[0].durationMs).toBe(17_000);
  });

  it('파일 번호를 못 읽으면 -1로 둔다 (넘겨짚지 않는다)', () => {
    const a = { ...f(1, T0), name: 'front.jdr', path: 'data/front.jdr' };
    const b = { ...f(2, T0 + 120_000), name: 'rear.jdr', path: 'data/rear.jdr' };
    const lib = buildLibrary([a, b]);
    expect(lib.gaps[0].numberSkip).toBe(-1);
  });

  it('번호가 거꾸로 가면 (덮어쓰기로 순번이 돌면) 넘겨짚지 않는다', () => {
    const lib = buildLibrary([f(900, T0), f(3, T0 + 120_000)]);
    expect(lib.gaps[0].numberSkip).toBe(-1);
  });

  it('붙어 있는 파일에는 빈 구간이 없다', () => {
    const lib = buildLibrary([f(87, T0), f(88, T0 + 60_000), f(89, T0 + 120_000)]);
    expect(lib.gaps).toEqual([]);
  });
});

describe('헤더 시각과 실제 패킷이 어긋날 때', () => {
  const T0 = Date.UTC(2026, 8, 12, 23, 16, 43);

  function build(headerStartMs: number, headerEndMs: number) {
    const packets: SynthPacket[] = [];
    for (let f = 0; f < 60; f++) {
      const t = T0 + Math.round((f * 1000) / 30);
      packets.push({ tag: f % 30 === 0 ? '00VI' : '00VP', payload: new Uint8Array(100), timeMs: t, aux: f });
    }
    return new BufferByteSource(
      buildJdrBlock(packets, 0, { startMs: headerStartMs, endMs: headerEndMs }),
      'x.jdr',
    );
  }

  const lastPacketMs = T0 + Math.round((59 * 1000) / 30);

  it('헤더가 늦으면 첫 패킷을 쓴다 — 안 그러면 없는 빈 구간이 생긴다', async () => {
    const src = build(T0 + 7_000, lastPacketMs);
    const seg = await probeSegment({ src, name: 'x.jdr', path: 'data/x.jdr', size: src.size });
    expect(seg.startMs).toBe(T0);
    expect(seg.headerShiftMs).toBe(7_000);
    expect(seg.timeSource).toBe('packets');
  });

  it('헤더가 이르면 그것도 첫 패킷으로 맞춘다 — 안 그러면 없는 겹침이 생긴다', async () => {
    const src = build(T0 - 5_000, lastPacketMs);
    const seg = await probeSegment({ src, name: 'x.jdr', path: 'data/x.jdr', size: src.size });
    expect(seg.startMs).toBe(T0);
    expect(seg.headerShiftMs).toBe(-5_000);
  });

  it('헤더와 패킷이 같으면 어긋남 0이고 헤더 출처 그대로다', async () => {
    const src = build(T0, lastPacketMs);
    const seg = await probeSegment({ src, name: 'x.jdr', path: 'data/x.jdr', size: src.size });
    expect(seg.startMs).toBe(T0);
    expect(seg.headerShiftMs).toBe(0);
    expect(seg.timeSource).toBe('header');
  });

  it('헤더 시각이 어긋나도 길이는 실제 패킷 기준이다', async () => {
    const src = build(T0 + 7_000, lastPacketMs - 3_000);
    const seg = await probeSegment({ src, name: 'x.jdr', path: 'data/x.jdr', size: src.size });
    expect(seg.startMs).toBe(T0);
    expect(seg.endMs).toBe(lastPacketMs);
    expect(seg.durationMs).toBe(lastPacketMs - T0);
  });

  it('헤더를 그대로 믿었다면 생겼을 빈 구간이 사라진다', async () => {
    // 파일 두 개가 실제로는 붙어 있는데 헤더 시작만 7초씩 늦게 적힌 경우
    const a = build(T0 + 7_000, lastPacketMs);
    const segA = await probeSegment({ src: a, name: 'a.jdr', path: 'data/a.jdr', size: a.size });

    const T1 = lastPacketMs + 33;
    const packets: SynthPacket[] = [];
    for (let f = 0; f < 60; f++) {
      packets.push({ tag: f % 30 === 0 ? '00VI' : '00VP', payload: new Uint8Array(100), timeMs: T1 + Math.round((f * 1000) / 30), aux: f });
    }
    const b = new BufferByteSource(buildJdrBlock(packets, 0, { startMs: T1 + 7_000 }), 'b.jdr');
    const segB = await probeSegment({ src: b, name: 'b.jdr', path: 'data/b.jdr', size: b.size });

    expect(buildLibrary([segA, segB]).gaps).toEqual([]);
  });
});

describe('data + event를 한 주행으로 묶기', () => {
  const T0 = Date.UTC(2026, 8, 12, 8, 0, 0);
  const f = (name: string, folder: string, startSec: number, durSec: number): SegmentInfo => ({
    id: `${folder}/${name}`, name, path: `${folder}/${name}`, folder, size: 70 << 20,
    startMs: T0 + startSec * 1000, endMs: T0 + (startSec + durSec) * 1000, durationMs: durSec * 1000,
    packetCount: 4000, ch0Count: 1800, ch1Count: 1800, gpsCount: 60, sensorCount: 600,
    blockOffsets: [0], timeSource: 'header', endEstimated: false, headerShiftMs: 0,
  });

  it('event가 data의 빈 자리를 대체한 기종에서는 그 자리를 채운다', () => {
    // data에 00:60~00:120이 없고 그 시각이 event에 있다
    const lib = buildLibrary([
      f('a.jdr', 'data', 0, 60),
      f('c.jdr', 'data', 120, 60),
      f('e.jdr', 'event', 60, 60),
    ]);
    expect(lib.segments.map((s) => s.name)).toEqual(['a.jdr', 'e.jdr', 'c.jdr']);
    expect(lib.gaps).toEqual([]);
    expect(lib.duplicates).toEqual([]);
    expect(lib.events[0].inChain).toBe(true);
  });

  it('event를 빼면 그 자리에 빈 구간이 생긴다 — 이게 끊겨 보이던 원인', () => {
    const dataOnly = buildLibrary([f('a.jdr', 'data', 0, 60), f('c.jdr', 'data', 120, 60)]);
    expect(dataOnly.gaps).toHaveLength(1);
    expect(dataOnly.gaps[0].durationMs).toBe(60_000);
  });

  it('이벤트가 여러 건이어도 시각 순으로 줄기에 들어간다', () => {
    const lib = buildLibrary([
      f('a.jdr', 'data', 0, 60),
      f('d.jdr', 'data', 240, 60),
      f('e2.jdr', 'event', 120, 60),
      f('e1.jdr', 'event', 60, 60),
      f('e3.jdr', 'event', 180, 60),
    ]);
    expect(lib.segments.map((s) => s.name)).toEqual(['a.jdr', 'e1.jdr', 'e2.jdr', 'e3.jdr', 'd.jdr']);
    expect(lib.gaps).toEqual([]);
  });

  it('일부만 겹치면 새로 채우는 쪽을 택한다', () => {
    // event가 data 끝자락 5초와 겹치고 55초를 새로 채운다
    const lib = buildLibrary([
      f('a.jdr', 'data', 0, 60),
      f('e.jdr', 'event', 55, 60),
    ]);
    expect(lib.segments.map((s) => s.name)).toEqual(['a.jdr', 'e.jdr']);
    expect(lib.duplicates).toEqual([]);
  });

  it('event 폴더만 있으면 그게 곧 줄기다', () => {
    const lib = buildLibrary([f('e1.jdr', 'event', 0, 60), f('e2.jdr', 'event', 60, 60)]);
    expect(lib.segments).toHaveLength(2);
    expect(lib.events.every((e) => e.inChain)).toBe(true);
  });

  it('event 폴더가 없으면 아무것도 달라지지 않는다', () => {
    const lib = buildLibrary([f('a.jdr', 'data', 0, 60), f('b.jdr', 'data', 60, 60)]);
    expect(lib.segments).toHaveLength(2);
    expect(lib.events).toEqual([]);
    expect(lib.duplicates).toEqual([]);
  });

  it('폴더 이름 대소문자를 가리지 않는다 (Event / EVENT)', () => {
    for (const folder of ['Event', 'EVENT', 'event', 'REC/Event']) {
      const lib = buildLibrary([f('a.jdr', 'data', 0, 60), f('e.jdr', folder, 20, 20)]);
      expect(lib.events, folder).toHaveLength(1);
      expect(lib.segments.map((s) => s.name), folder).toEqual(['a.jdr']);
    }
  });
});
