import { describe, expect, it } from 'vitest';
import { BufferByteSource } from '../src/core/byte-source';
import { estimateFps, nmeaToDegrees, parseJdr, JdrParseError } from '../src/core/parser';
import { buildGpsCsv, buildGsensorCsv, extractWav } from '../src/core/export';
import { systemTimeToMs, formatRecordedTime } from '../src/core/time';
import { packTag, tagChannel, tagIsKeyframe, tagKind, tagString, TagKind } from '../src/core/tags';
import { findNalUnits, parseSps, buildKeyChunk, extractParameterSets } from '../src/core/nal';
import { Sha256 } from '../src/core/sha256';
import { trimmedContentEnd } from '../src/core/duration';
import { buildJdrBlock, concatBlocks, gpsPayload, gsensorPayload, pcmTone, type SynthPacket } from './synth';

const T0 = Date.UTC(2026, 0, 15, 9, 30, 0, 0);

/** 대조군: 브라우저/Node 공통 Web Crypto */
async function webCryptoSha256(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 사양대로 조립한 합성 JDR 한 덩어리 */
function sampleBlock(baseOffset = 0): { bytes: Uint8Array<ArrayBuffer>; packets: SynthPacket[] } {
  const packets: SynthPacket[] = [];
  // 30fps 영상 2채널, 1초 분량 + 센서
  for (let f = 0; f < 30; f++) {
    const t = T0 + Math.round((f * 1000) / 30);
    for (const ch of ['00', '01']) {
      packets.push({
        tag: `${ch}V${f % 15 === 0 ? 'I' : 'P'}`,
        payload: new Uint8Array([0, 0, 0, 1, f % 15 === 0 ? 0x65 : 0x41, f, ch.charCodeAt(1)]),
        timeMs: t,
        aux: f,
      });
    }
    if (f % 6 === 0) {
      packets.push({ tag: '00AD', payload: pcmTone(1600, f * 1600), timeMs: t });
    }
  }
  packets.push({
    tag: '00GP',
    timeMs: T0 + 500,
    payload: gpsPayload({
      year: 2026, month: 1, day: 15, hour: 0, minute: 30, second: 0,
      latNmea: 3733.5678, lonNmea: 12658.1234, altitude: 42.5, speed: 61.2,
    }),
  });
  packets.push({ tag: '00SE', payload: gsensorPayload(12, -8, 1024), timeMs: T0 + 100 });
  packets.push({ tag: '00SE', payload: gsensorPayload(2048, 0, 1024), timeMs: T0 + 200 });
  return { bytes: buildJdrBlock(packets, baseOffset), packets };
}

describe('태그 패킹', () => {
  it('영상/오디오/GPS/센서를 구분한다', () => {
    const vi0 = packTag(0x30, 0x30, 0x56, 0x49);
    expect(tagString(vi0)).toBe('00VI');
    expect(tagKind(vi0)).toBe(TagKind.Video);
    expect(tagChannel(vi0)).toBe(0);
    expect(tagIsKeyframe(vi0)).toBe(true);

    const vp1 = packTag(0x30, 0x31, 0x56, 0x50);
    expect(tagChannel(vp1)).toBe(1);
    expect(tagIsKeyframe(vp1)).toBe(false);

    expect(tagKind(packTag(0x30, 0x30, 0x41, 0x44))).toBe(TagKind.Audio);
    expect(tagKind(packTag(0x39, 0x39, 0x47, 0x50))).toBe(TagKind.Gps); // 채널 자리는 무시
    expect(tagKind(packTag(0x30, 0x30, 0x53, 0x45))).toBe(TagKind.Sensor);
    expect(tagKind(packTag(0x41, 0x42, 0x43, 0x44))).toBe(TagKind.Other);
  });
});

describe('SYSTEMTIME', () => {
  it('타임존에 영향받지 않고 기록된 값을 그대로 돌려준다', () => {
    const ms = systemTimeToMs(2026, 1, 15, 9, 30, 0, 250);
    expect(formatRecordedTime(ms)).toBe('2026-01-15 09:30:00.250');
  });
  it('범위를 벗어난 값은 NaN', () => {
    expect(Number.isNaN(systemTimeToMs(2026, 13, 1, 0, 0, 0, 0))).toBe(true);
    expect(Number.isNaN(systemTimeToMs(1900, 1, 1, 0, 0, 0, 0))).toBe(true);
    expect(Number.isNaN(systemTimeToMs(2026, 1, 1, 24, 0, 0, 0))).toBe(true);
  });
});

describe('NMEA 변환', () => {
  it('ddmm.mmmm를 십진 도로 바꾼다', () => {
    expect(nmeaToDegrees(3733.5678)).toBeCloseTo(37 + 33.5678 / 60, 9);
    expect(nmeaToDegrees(12658.1234)).toBeCloseTo(126 + 58.1234 / 60, 9);
    expect(nmeaToDegrees(-3733.5678)).toBeCloseTo(-(37 + 33.5678 / 60), 9);
    expect(nmeaToDegrees(0)).toBe(0);
  });
});

describe('SHA-256 스트리밍', () => {
  it('빈 입력', () => {
    expect(new Sha256().digestHex())
      .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('"abc"', () => {
    const h = new Sha256();
    h.update(new TextEncoder().encode('abc'));
    expect(h.digestHex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('블록 경계를 넘는 입력을 나눠 넣어도 같은 값', async () => {
    const data = new Uint8Array(1000).map((_, i) => (i * 7) & 0xff);
    const a = new Sha256();
    a.update(data);
    const b = new Sha256();
    for (let i = 0; i < data.length; i += 37) b.update(data.subarray(i, i + 37));
    expect(b.digestHex()).toBe(a.digestHex());

    expect(a.digestHex()).toBe(await webCryptoSha256(data));
  });
});

describe('Annex-B NAL', () => {
  it('3바이트/4바이트 start code를 모두 인식한다', () => {
    const data = new Uint8Array([0, 0, 0, 1, 0x67, 0xaa, 0, 0, 1, 0x68, 0xbb, 0xcc, 0, 0, 0, 1, 0x65, 0x01]);
    const nals = findNalUnits(data);
    expect(nals.map((n) => n.type)).toEqual([7, 8, 5]);
    expect(nals[0].length).toBe(2);
    expect(nals[1].length).toBe(3);
  });

  it('실제 1920x1080 High profile SPS를 크롭까지 정확히 해석한다', () => {
    // 널리 인용되는 실제 SPS. High profile 경로(chroma/scaling matrix)와
    // 1088 → 1080 크롭 계산을 함께 검증한다.
    const sps = Uint8Array.from(
      ('67 64 00 28 ac d9 40 78 02 27 e5 84 00 00 03 00 04 00 00 03 00 ca 3c 60 c6 58')
        .split(' ').map((h) => parseInt(h, 16)),
    );
    const info = parseSps(sps);
    expect(info).not.toBeNull();
    expect(info!.profileIdc).toBe(100);
    expect(info!.codec).toBe('avc1.640028');
    expect(info!.width).toBe(1920);
    expect(info!.height).toBe(1080);
  });

  it('Baseline profile SPS도 해석한다 (640x480)', () => {
    const sps = Uint8Array.from([0x67, 0x42, 0xc0, 0x1f, 0xda, 0x02, 0x80, 0xf6, 0x80, 0x6d, 0x0a, 0x13, 0x50]);
    const info = parseSps(sps);
    expect(info!.codec).toBe('avc1.42c01f');
    expect(info!.width).toBe(640);
    expect(info!.height).toBe(480);
  });

  it('SPS/PPS가 없는 키프레임 앞에 파라미터 세트를 붙인다', () => {
    const ps = extractParameterSets(
      new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0, 0, 0, 1, 0x68, 0xce]),
    );
    expect(ps).not.toBeNull();
    const idrOnly = new Uint8Array([0, 0, 0, 1, 0x65, 0x11, 0x22]);
    const merged = buildKeyChunk(idrOnly, ps);
    expect(merged.length).toBe(ps!.length + idrOnly.length);
    expect(findNalUnits(merged).map((n) => n.type)).toEqual([7, 8, 5]);
    // 이미 SPS가 있으면 그대로 둔다
    const withSps = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x65, 0x01]);
    expect(buildKeyChunk(withSps, ps)).toBe(withSps);
  });
});

describe('fps 추정', () => {
  it('33/34ms 교대 패턴에서 30fps로 스냅된다', () => {
    const times: number[] = [];
    for (let i = 0; i < 300; i++) times.push(Math.round((i * 1000) / 30));
    expect(estimateFps(times)).toBe(30);
  });
  it('데이터가 부족하면 기본값', () => {
    expect(estimateFps([])).toBe(30);
    expect(estimateFps([1])).toBe(30);
  });
});

describe('JDR 파싱', () => {
  it('블록/패킷/센서/GPS를 모두 읽는다', async () => {
    const { bytes, packets } = sampleBlock();
    const doc = await parseJdr(new BufferByteSource(bytes, 'sample.jdr'));

    expect(doc.blocks).toHaveLength(1);
    expect(doc.packets.count).toBe(packets.length);
    expect(doc.indexMismatches).toBe(0);
    expect(doc.blocks[0].truncated).toBe(false);
    expect(doc.blocks[0].gpsHint).toBe('SYNT');

    expect(doc.tagCounts['00VI']).toBe(2);
    expect(doc.tagCounts['00VP']).toBe(28);
    expect(doc.tagCounts['01VI']).toBe(2);

    expect(doc.video[0].frameCount).toBe(30);
    expect(doc.video[0].keyframeCount).toBe(2);
    expect(doc.video[1].frameCount).toBe(30);

    expect(doc.gps).toHaveLength(1);
    expect(doc.gps[0].lat).toBeCloseTo(37 + 33.5678 / 60, 6);
    expect(doc.gps[0].speed).toBeCloseTo(61.2, 6);
    expect(doc.gps[0].altitude).toBeCloseTo(42.5, 6);

    expect(doc.gsensor.count).toBe(2);
    expect(doc.gsensor.z[0]).toBe(1024);
    expect(doc.gsensor.x[1]).toBe(2048);

    expect(doc.audio.packetCount).toBe(5);
    expect(doc.audio.sampleCount).toBe(5 * 1600);
    expect(formatRecordedTime(doc.firstTimeMs)).toBe('2026-01-15 09:30:00.000');
  });

  it('SHA-256이 Web Crypto 결과와 일치한다', async () => {
    const { bytes } = sampleBlock();
    const doc = await parseJdr(new BufferByteSource(bytes, 'sample.jdr'));
    expect(doc.sha256).toBe(await webCryptoSha256(bytes));
  });

  it('블록이 여러 개여도 이어서 읽는다', async () => {
    const a = sampleBlock(0).bytes;
    const b = sampleBlock(a.length).bytes;
    const doc = await parseJdr(new BufferByteSource(concatBlocks([a, b]), 'multi.jdr'));
    expect(doc.blocks).toHaveLength(2);
    expect(doc.packets.count).toBe(136); // 68 × 2 블록
    expect(doc.indexMismatches).toBe(0);
    expect(doc.blocks[1].headerOffset).toBe(a.length);
  });

  it('앞에 쓰레기 바이트가 붙어 있어도 블록을 찾는다', async () => {
    const { bytes } = sampleBlock(64);
    const junk = new Uint8Array(64).fill(0x31); // magic 첫 글자로 오탐 유도
    const doc = await parseJdr(new BufferByteSource(concatBlocks([junk, bytes]), 'junk.jdr'));
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].headerOffset).toBe(64);
    expect(doc.indexMismatches).toBe(0);
  });

  it('4MB 청크 경계에 걸친 magic도 찾는다', async () => {
    const pad = new Uint8Array((4 << 20) - 2);
    const { bytes } = sampleBlock(pad.length);
    const doc = await parseJdr(new BufferByteSource(concatBlocks([pad, bytes]), 'boundary.jdr'));
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].headerOffset).toBe(pad.length);
  });

  it('인덱스 테이블이 잘린 파일도 읽을 수 있는 데까지 읽는다', async () => {
    // 녹화 중 전원이 끊긴 파일을 흉내낸다 (인덱스 테이블이 통째로 날아감)
    const { bytes } = sampleBlock();
    const doc = await parseJdr(new BufferByteSource(bytes.subarray(0, bytes.length - 400), 'cut.jdr'));
    expect(doc.blocks[0].indexAvailable).toBe(false);
    expect(doc.blocks[0].truncated).toBe(true);
    expect(doc.packets.count).toBe(68); // 패킷 자체는 온전하다
    expect(doc.indexMismatches).toBe(0); // 대조할 인덱스가 없으므로 0
  });

  it('페이로드 중간에서 끊긴 파일도 앞부분은 살린다', async () => {
    const { bytes } = sampleBlock();
    const doc = await parseJdr(new BufferByteSource(bytes.subarray(0, 0x200 + 600), 'cut2.jdr'));
    expect(doc.blocks[0].truncated).toBe(true);
    expect(doc.packets.count).toBeGreaterThan(0);
    expect(doc.packets.count).toBeLessThan(68);
  });

  it('JEB 블록이 없으면 명확한 오류', async () => {
    const junk = new Uint8Array(4096).fill(0xab);
    await expect(parseJdr(new BufferByteSource(junk, 'bad.jdr'))).rejects.toBeInstanceOf(JdrParseError);
  });
});

describe('끝의 외톨이 프레임 떼기', () => {
  it('끝이 촘촘하면 그대로, 크게 벌어지면 앞의 촘촘한 곳까지 되짚는다', () => {
    expect(trimmedContentEnd([0, 33, 66, 99])).toBe(99);                 // 촘촘 → 그대로
    expect(trimmedContentEnd([0, 33, 66, 99, 99 + 65_000])).toBe(99);    // 외톨이 하나 → 뗌
    expect(trimmedContentEnd([0, 40_000, 80_000])).toBe(0);              // 전부 벌어지면 첫 점
    expect(Number.isNaN(trimmedContentEnd([]))).toBe(true);
  });
});

describe('내보내기', () => {
  it('GPS/G센서 CSV와 WAV를 만든다', async () => {
    const { bytes } = sampleBlock();
    const src = new BufferByteSource(bytes, 'sample.jdr');
    const doc = await parseJdr(src);

    const gpsCsv = buildGpsCsv(doc);
    expect(gpsCsv.split('\r\n')[0]).toContain('latitude_deg');
    expect(gpsCsv).toContain('2026-01-15 09:30:00.500');

    const gsCsv = buildGsensorCsv(doc);
    expect(gsCsv).toContain('2,0,1'); // x_g_est = 2048/1024 = 2

    const wav = await extractWav(src, doc);
    const head = new Uint8Array(await wav.slice(0, 44).arrayBuffer());
    expect(String.fromCharCode(...head.subarray(0, 4))).toBe('RIFF');
    expect(new DataView(head.buffer).getUint32(24, true)).toBe(8000);
    expect(wav.size).toBe(44 + 5 * 1600 * 2);
  });
});

/**
 * 주차해 둔 사이 꼬리에 덧붙은 패킷.
 *
 * 실기에서 72초짜리 `data/00000528.jdr`이 **9시간 30분**으로 잡혔다.
 * 22:18:17에 시작해, 다음 날 아침 전원이 들어온 07:48:41 — 바로 다음 파일이
 * 시작하는 그 시각 — 까지 재생 막대가 이어졌다. 인덱스는 영상·음성 기준
 * (contentEndMs)으로 72초라고 제대로 적고 있었는데, 재생기가 쓰는
 * durationSec만 마지막 패킷(lastTimeMs)을 보고 있었다.
 */
describe('재생 길이는 영상·음성이 끝나는 곳까지', () => {
  const START = Date.UTC(2026, 8, 10, 22, 18, 17);
  const WAKE = Date.UTC(2026, 8, 11, 7, 48, 41); // 다음 날 아침 전원

  function withTailPacket(tailTag: string): SynthPacket[] {
    const packets: SynthPacket[] = [];
    for (let f = 0; f < 30; f++) {
      const t = START + Math.round((f * 1000) / 30);
      packets.push({ tag: `00V${f === 0 ? 'I' : 'P'}`, payload: new Uint8Array([0, 0, 0, 1, 0x41, f]), timeMs: t, aux: f });
    }
    // 아침에 깨어나며 덧붙은 한 줄
    packets.push({ tag: tailTag, timeMs: WAKE, payload: gsensorPayload(0, 0, 1) });
    return packets;
  }

  it('꼬리에 붙은 센서 한 줄이 파일 길이를 9시간으로 늘리지 않는다', async () => {
    const bytes = buildJdrBlock(withTailPacket('00SE'));
    const doc = await parseJdr(new BufferByteSource(bytes, 'tail.jdr'));

    expect(doc.lastTimeMs, '마지막 패킷은 아침 것이 맞다').toBe(WAKE);
    expect(doc.contentEndMs, '영상은 1초 만에 끝난다').toBeLessThan(START + 2000);
    // 9시간 30분(34_224초)이 아니라 1초여야 한다
    expect(doc.durationSec).toBeLessThan(2);
  });

  it('영상·음성 패킷 하나가 다음 날 시각을 달아도 파일 길이가 늘어나지 않는다', async () => {
    // 꼬리가 GPS·센서면 contentEndMs(영상·음성만)로 걸러진다. 그런데 영상·음성
    // 패킷 자체가 다음 날 시각을 달고 있으면 contentEndMs가 그걸 집어 든다 —
    // 실기에서 72초짜리가 목록엔 1분대인데 재생기엔 23시간으로 잡혔다.
    // 담긴 프레임이 받쳐 주지 못하는 길이는 프레임 수로 되돌려야 한다.
    for (const tailTag of ['00VP', '00AD']) {
      const doc = await parseJdr(new BufferByteSource(buildJdrBlock(withTailPacket(tailTag)), 'tail-media.jdr'));
      expect(doc.lastTimeMs, '마지막 패킷은 아침 것이 맞다').toBe(WAKE);
      // 9시간 30분이 아니라 1초 안팎(프레임 수 기반 추정)이어야 한다
      expect(doc.contentEndMs, `${tailTag} 꼬리`).toBeLessThan(START + 2000);
      expect(doc.durationSec, `${tailTag} 꼬리`).toBeLessThan(2);
    }
  });

  it('연속 영상 뒤 외톨이 프레임(닫힘·시동 흔적)은 끝에서 뗀다', async () => {
    // 300프레임(10초) 연속 뒤, 65초 지나 프레임 한 장. 프레임 수 기준
    // (durationExceedsContent)으로는 안 걸리는 크기지만 끝의 외톨이라 떼야 한다.
    // 실기 09/16: 08:20:09에 끝난 영상이 08:21:14 외톨이 프레임 때문에 늘어났다.
    const packets: SynthPacket[] = [];
    for (let f = 0; f < 300; f++) {
      const t = START + Math.round((f * 1000) / 30);
      packets.push({ tag: `00V${f === 0 ? 'I' : 'P'}`, payload: new Uint8Array([0, 0, 0, 1, 0x41, f & 0xff]), timeMs: t, aux: f });
    }
    const lone = START + 10_000 + 65_000; // 연속 끝(≈10초) 뒤 65초
    packets.push({ tag: '00VP', payload: new Uint8Array([0, 0, 0, 1, 0x41, 0]), timeMs: lone });
    const doc = await parseJdr(new BufferByteSource(buildJdrBlock(packets), 'tail-lone.jdr'));

    expect(doc.lastTimeMs, '마지막 패킷 자체는 기록에 남긴다').toBe(lone);
    expect(doc.contentEndMs, '끝은 연속 영상까지만(≈10초)').toBeLessThan(START + 11_000);
    expect(doc.durationSec).toBeLessThan(11);
  });

  it('영상·음성이 하나도 없으면 마지막 패킷을 쓴다 (길이가 0이 되면 안 된다)', async () => {
    const fix = (second: number) => gpsPayload({
      year: 2026, month: 9, day: 10, hour: 22, minute: 18, second,
      latNmea: 3730.0, lonNmea: 12700.0, altitude: 30, speed: 0,
    });
    const packets: SynthPacket[] = [
      { tag: '00GP', timeMs: START, payload: fix(17) },
      { tag: '00GP', timeMs: START + 5000, payload: fix(22) },
    ];
    const doc = await parseJdr(new BufferByteSource(buildJdrBlock(packets), 'gps.jdr'));
    expect(doc.durationSec).toBeCloseTo(5, 1);
  });
});
