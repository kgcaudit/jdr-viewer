/**
 * JDR 파서 — 플랫폼 독립 (DOM 의존 없음).
 * 포맷 근거는 docs/00-jdr-format-spec.md 참조.
 */
import type { ByteSource } from './byte-source';
import { WindowReader } from './byte-source';
import { Sha256 } from './sha256';
import { systemTimeToMs } from './time';
import { TagKind, packTag, tagChannel, tagIsKeyframe, tagKind, tagString } from './tags';
import { buildKeyChunk, extractParameterSets, findNalUnits, parseSps, NAL_IDR, NAL_PPS, NAL_SPS } from './nal';
import type {
  BitstreamInfo, GpsFix, GsensorSeries, JdrBlockInfo, JdrDocument,
  PacketTable, ParseProgress, VideoChannelInfo,
} from './types';

export const JEB_HEADER_SIZE = 0x200;
export const PACKET_HEADER_SIZE = 28;
export const INDEX_ENTRY_SIZE = 12;
export const AUDIO_SAMPLE_RATE = 8000;
/** G센서 raw 1024 ≈ 1g (샘플 기반 추정치) */
export const GSENSOR_SCALE = 1024;

/** magic은 JEB1(0x4A454231)의 리틀엔디안 표현이라 디스크에는 "1BEJ"로 보인다. */
const MAGIC = [0x31, 0x42, 0x45, 0x4a];
const SCAN_CHUNK = 4 << 20;

export class JdrParseError extends Error {}

export interface ParseOptions {
  /**
   * SHA-256을 계산할지. 폴더 모드에서 수십 개 파일을 미리 읽을 때는 끈다
   * (해시는 파일 전체를 읽어야 해서 가장 비싼 단계다).
   */
  hash?: boolean;
  /**
   * 이미 알고 있는 JEB 블록 오프셋. 주면 파일 전체 magic 스캔을 건너뛴다.
   * probeSegment()가 헤더 체인을 따라가며 구해 둔 값을 그대로 쓴다.
   */
  blockOffsets?: number[];
}

function matchMagic(buf: Uint8Array, i: number): boolean {
  return buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3];
}

/**
 * 파일을 한 번만 훑으면서 SHA-256과 JEB magic 후보 위치를 동시에 구한다.
 * (해시와 스캔을 따로 돌면 대용량에서 I/O가 두 배가 된다.)
 */
async function hashAndScan(
  src: ByteSource,
  onProgress?: (p: ParseProgress) => void,
  withHash = true,
): Promise<{ sha256: string; candidates: number[] }> {
  const hash = new Sha256();
  const candidates: number[] = [];
  let tail = new Uint8Array(0);
  let pos = 0;

  while (pos < src.size) {
    const chunk = await src.read(pos, SCAN_CHUNK);
    if (chunk.length === 0) break;
    if (withHash) hash.update(chunk);

    // 청크 경계에 걸친 magic 처리
    if (tail.length > 0) {
      const span = new Uint8Array(tail.length + Math.min(3, chunk.length));
      span.set(tail, 0);
      span.set(chunk.subarray(0, span.length - tail.length), tail.length);
      for (let i = 0; i < tail.length; i++) {
        if (i + 4 <= span.length && matchMagic(span, i)) candidates.push(pos - tail.length + i);
      }
    }

    for (let i = 0; i + 4 <= chunk.length; i++) {
      if (chunk[i] === MAGIC[0] && matchMagic(chunk, i)) candidates.push(pos + i);
    }

    tail = chunk.slice(Math.max(0, chunk.length - 3));
    pos += chunk.length;
    onProgress?.({ phase: 'scan', done: pos, total: src.size });
  }

  return { sha256: withHash ? hash.digestHex() : '', candidates };
}

export interface HeaderRaw {
  offset: number;
  packetCount: number;
  indexOffset: number;
  /** 인덱스 테이블이 파일 안에 온전히 들어있는가 */
  indexAvailable: boolean;
  raw: Uint8Array;
}

/** magic만으로는 오탐이 나므로 헤더 필드까지 검증한다 (사양 문서 2장). */
export async function validateHeader(src: ByteSource, offset: number): Promise<HeaderRaw | null> {
  if (offset + JEB_HEADER_SIZE > src.size) return null;
  const raw = await src.read(offset, JEB_HEADER_SIZE);
  if (raw.length < JEB_HEADER_SIZE) return null;
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

  if (dv.getUint32(0x1fc, true) !== JEB_HEADER_SIZE) return null;
  const packetCount = dv.getUint32(0x04, true);
  if (packetCount === 0 || packetCount >= 10_000_000) return null;
  const indexOffset = dv.getUint32(0xb8, true);
  // 인덱스는 반드시 헤더 뒤에 온다. 파일 끝을 넘어서는 것 자체는 허용한다 —
  // 녹화 중 전원이 끊긴 파일이 그렇기 때문이다. 그래도 앞쪽 패킷은 멀쩡하므로
  // 블록을 버리지 않고 "인덱스 없음"으로만 표시한다.
  // (magic + sentinel 0x200 + 패킷 수 범위를 이미 통과했으므로 오탐 위험은 낮다.)
  if (indexOffset < JEB_HEADER_SIZE) return null;
  const indexAvailable = indexOffset + packetCount * INDEX_ENTRY_SIZE <= src.size;

  return { offset, packetCount, indexOffset, indexAvailable, raw };
}

export function readSystemTimeFromView(dv: DataView, off: number): number {
  return systemTimeToMs(
    dv.getUint16(off, true),      // year
    dv.getUint16(off + 2, true),  // month
    dv.getUint16(off + 6, true),  // day (off+4는 dayOfWeek이라 버린다)
    dv.getUint16(off + 8, true),
    dv.getUint16(off + 10, true),
    dv.getUint16(off + 12, true),
    dv.getUint16(off + 14, true),
  );
}

function readAsciiZ(raw: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end && i < raw.length; i++) {
    const c = raw[i];
    if (c === 0) break;
    if (c >= 0x20 && c <= 0x7e) s += String.fromCharCode(c);
  }
  return s;
}

/** NMEA ddmm.mmmm / dddmm.mmmm → 십진 도 */
export function nmeaToDegrees(value: number): number {
  if (!Number.isFinite(value) || value === 0) return 0;
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const deg = Math.floor(abs / 100);
  return sign * (deg + (abs - deg * 100) / 60);
}

export async function parseJdr(
  src: ByteSource,
  onProgress?: (p: ParseProgress) => void,
  options: ParseOptions = {},
): Promise<JdrDocument> {
  const needScan = !options.blockOffsets;
  const needHash = options.hash ?? true;

  let sha256 = '';
  let candidates: number[];
  if (needScan || needHash) {
    const r = await hashAndScan(src, onProgress, needHash);
    sha256 = r.sha256;
    candidates = needScan ? r.candidates : options.blockOffsets!;
  } else {
    candidates = options.blockOffsets!;
  }

  const headers: HeaderRaw[] = [];
  for (const c of candidates) {
    const h = await validateHeader(src, c);
    if (h) headers.push(h);
  }
  if (headers.length === 0) {
    throw new JdrParseError(
      '유효한 JEB1 블록을 찾지 못했습니다. 지원하지 않는 JDR 변형이거나 손상된 파일일 수 있습니다.',
    );
  }
  headers.sort((a, b) => a.offset - b.offset);

  const declaredTotal = headers.reduce((s, h) => s + h.packetCount, 0);
  const packets: PacketTable = {
    count: 0,
    blockNo: new Uint16Array(declaredTotal),
    offset: new Float64Array(declaredTotal),
    size: new Uint32Array(declaredTotal),
    tag: new Uint32Array(declaredTotal),
    aux: new Uint32Array(declaredTotal),
    timeMs: new Float64Array(declaredTotal),
  };

  const gps: GpsFix[] = [];
  const gsTime: number[] = [];
  const gsX: number[] = [];
  const gsY: number[] = [];
  const gsZ: number[] = [];

  const wr = new WindowReader(src, 2 << 20);
  const blocks: JdrBlockInfo[] = [];
  let w = 0;

  for (let blockNo = 0; blockNo < headers.length; blockNo++) {
    const h = headers[blockNo];
    const hv = new DataView(h.raw.buffer, h.raw.byteOffset, h.raw.byteLength);
    const blockStart = w;
    let pos = h.offset + JEB_HEADER_SIZE;
    let truncated = false;

    for (let i = 0; i < h.packetCount; i++) {
      if (!(await wr.ensure(pos, PACKET_HEADER_SIZE))) {
        truncated = true;
        break;
      }
      const tag = packTag(wr.u8(pos), wr.u8(pos + 1), wr.u8(pos + 2), wr.u8(pos + 3));
      const size = wr.u32(pos + 4);
      const payloadStart = pos + PACKET_HEADER_SIZE;
      if (payloadStart + size > src.size) {
        truncated = true;
        break;
      }

      packets.blockNo[w] = blockNo;
      packets.offset[w] = pos;
      packets.size[w] = size;
      packets.tag[w] = tag;
      packets.aux[w] = wr.u32(pos + 8);
      packets.timeMs[w] = systemTimeToMs(
        wr.u16(pos + 12), wr.u16(pos + 14), wr.u16(pos + 18),
        wr.u16(pos + 20), wr.u16(pos + 22), wr.u16(pos + 24), wr.u16(pos + 26),
      );

      // GPS / G센서는 페이로드가 작고 바로 뒤에 있으므로 이 패스에서 같이 읽는다.
      const kind = tagKind(tag);
      if (kind === TagKind.Gps && size >= 96 && (await wr.ensure(payloadStart, 96))) {
        const p = payloadStart;
        const gpsTimeMs = systemTimeToMs(
          wr.i32(p + 4), wr.i32(p + 8), wr.i32(p + 12),
          wr.i32(p + 16), wr.i32(p + 20), wr.i32(p + 24), 0,
        );
        const latNmea = wr.f64(p + 64);
        const lonNmea = wr.f64(p + 72);
        gps.push({
          timeMs: packets.timeMs[w],
          gpsTimeMs,
          pdop: wr.f64(p + 40),
          hdop: wr.f64(p + 48),
          vdop: wr.f64(p + 56),
          latNmea,
          lonNmea,
          lat: nmeaToDegrees(latNmea),
          lon: nmeaToDegrees(lonNmea),
          altitude: wr.f64(p + 80),
          speed: wr.f64(p + 88),
        });
      } else if (kind === TagKind.Sensor && size >= 12 && (await wr.ensure(payloadStart, 12))) {
        gsTime.push(packets.timeMs[w]);
        gsX.push(wr.i32(payloadStart));
        gsY.push(wr.i32(payloadStart + 4));
        gsZ.push(wr.i32(payloadStart + 8));
      }

      w++;
      pos = payloadStart + size;
      if ((i & 0x3fff) === 0) onProgress?.({ phase: 'packets', done: w, total: declaredTotal });
    }

    const parsed = w - blockStart;

    // 12바이트 인덱스 테이블과 대조 — 무결성 지표
    let mismatches = 0;
    if (parsed > 0 && h.indexAvailable) {
      const idxBytes = await src.read(h.indexOffset, h.packetCount * INDEX_ENTRY_SIZE);
      const idv = new DataView(idxBytes.buffer, idxBytes.byteOffset, idxBytes.byteLength);
      const checkable = Math.min(parsed, Math.floor(idxBytes.length / INDEX_ENTRY_SIZE));
      for (let n = 0; n < checkable; n++) {
        const o = n * INDEX_ENTRY_SIZE;
        const idxTag = packTag(idxBytes[o], idxBytes[o + 1], idxBytes[o + 2], idxBytes[o + 3]);
        if (
          idxTag !== packets.tag[blockStart + n] ||
          idv.getUint32(o + 4, true) !== packets.size[blockStart + n] ||
          idv.getUint32(o + 8, true) !== packets.offset[blockStart + n]
        ) {
          mismatches++;
        }
      }
      mismatches += h.packetCount - checkable;
    }

    blocks.push({
      blockNo,
      headerOffset: h.offset,
      packetCount: h.packetCount,
      videoCh0Count: hv.getUint32(0x08, true),
      videoCh1Count: hv.getUint32(0x0c, true),
      audioCount: hv.getUint32(0x48, true),
      gpsCount: hv.getUint32(0x88, true),
      sensorCount: hv.getUint32(0x8c, true),
      indexOffset: h.indexOffset,
      startTimeMs: readSystemTimeFromView(hv, 0x94),
      endTimeMs: readSystemTimeFromView(hv, 0xa4),
      gpsHint: readAsciiZ(h.raw, 0xf8, 0x140),
      indexMismatches: mismatches,
      indexAvailable: h.indexAvailable,
      truncated: truncated || !h.indexAvailable,
    });
  }

  packets.count = w;
  onProgress?.({ phase: 'analyze' });

  // ── 집계 ───────────────────────────────────────────────
  const tagCounts: Record<string, number> = {};
  let firstTimeMs = Infinity;
  let lastTimeMs = -Infinity;
  /**
   * 영상·음성만 본 마지막 시각.
   *
   * 구간의 길이를 정하는 건 담긴 **내용**이지 파일에 마지막으로 적힌
   * 무언가가 아니다. 기기는 시동을 걸 때 직전 파일 꼬리에 GPS·센서 패킷을
   * 덧붙이기도 하는데, 그걸 끝으로 삼으면 주차한 몇 시간이 통째로
   * "녹화된 구간"이 된다.
   */
  let contentEndMs = -Infinity;
  let audioPackets = 0;
  let audioBytes = 0;
  const videoTimes: number[][] = [[], []];
  const videoKeyframes = [0, 0];
  const firstKeyIndex = [-1, -1];

  for (let i = 0; i < w; i++) {
    const tag = packets.tag[i];
    const name = tagString(tag);
    tagCounts[name] = (tagCounts[name] ?? 0) + 1;

    const t = packets.timeMs[i];
    if (Number.isFinite(t)) {
      if (t < firstTimeMs) firstTimeMs = t;
      if (t > lastTimeMs) lastTimeMs = t;
    }

    const kind = tagKind(tag);
    if (kind === TagKind.Video) {
      const ch = tagChannel(tag);
      if (ch === 0 || ch === 1) {
        if (Number.isFinite(t)) videoTimes[ch].push(t);
        if (tagIsKeyframe(tag)) {
          videoKeyframes[ch]++;
          if (firstKeyIndex[ch] < 0) firstKeyIndex[ch] = i;
        }
      }
    } else if (kind === TagKind.Audio) {
      audioPackets++;
      audioBytes += packets.size[i];
    }
    if ((kind === TagKind.Video || kind === TagKind.Audio) && Number.isFinite(t) && t > contentEndMs) {
      contentEndMs = t;
    }
  }

  const video: VideoChannelInfo[] = [];
  for (let ch = 0; ch < 2; ch++) {
    let bitstream: BitstreamInfo | null = null;
    if (firstKeyIndex[ch] >= 0) {
      const idx = firstKeyIndex[ch];
      const payload = await src.read(packets.offset[idx] + PACKET_HEADER_SIZE, Math.min(packets.size[idx], 1 << 20));
      bitstream = inspectBitstream(payload);
      // 키프레임에 SPS/PPS가 없으면 뒤쪽 패킷에서 찾아본다.
      if (bitstream && !bitstream.hasSps) {
        bitstream.parameterSets = await findParameterSetsNearby(src, packets, ch, idx);
        if (bitstream.parameterSets) {
          const sps = findNalUnits(bitstream.parameterSets).find((n) => n.type === NAL_SPS);
          if (sps) {
            const info = parseSps(bitstream.parameterSets.subarray(sps.start, sps.start + sps.length));
            if (info) {
              bitstream.codec = info.codec;
              bitstream.width = info.width || null;
              bitstream.height = info.height || null;
            }
          }
        }
      }
    }
    video.push({
      channel: ch,
      frameCount: videoTimes[ch].length,
      keyframeCount: videoKeyframes[ch],
      fps: estimateFps(videoTimes[ch]),
      bitstream,
    });
  }

  const gsensor: GsensorSeries = {
    count: gsTime.length,
    timeMs: Float64Array.from(gsTime),
    x: Int32Array.from(gsX),
    y: Int32Array.from(gsY),
    z: Int32Array.from(gsZ),
  };

  // 영상·음성이 하나도 없으면(GPS만 있는 파일) 어쩔 수 없이 마지막 패킷을 쓴다
  const playEndMs = Number.isFinite(contentEndMs) ? contentEndMs : lastTimeMs;

  return {
    fileName: src.name,
    fileSize: src.size,
    sha256,
    blocks,
    packets,
    tagCounts,
    firstTimeMs: Number.isFinite(firstTimeMs) ? firstTimeMs : NaN,
    lastTimeMs: Number.isFinite(lastTimeMs) ? lastTimeMs : NaN,
    contentEndMs: Number.isFinite(contentEndMs) ? contentEndMs : NaN,
    // 재생 길이는 **영상·음성이 끝나는 곳**까지다. lastTimeMs를 쓰면 주차해 둔
    // 사이 꼬리에 덧붙은 패킷 한 줄이 파일 길이를 통째로 늘린다 — 실기에서
    // 72초짜리 00000528.jdr이 9시간 30분으로 잡혔다(22:18:17에 시작해 다음 날
    // 아침 07:48:41, 바로 다음 파일이 시작하는 그 시각까지). 구간 시각은
    // contentEndMs로 이미 바로잡아 두었는데 재생기만 몰랐다.
    durationSec: Number.isFinite(firstTimeMs) && Number.isFinite(playEndMs) ? (playEndMs - firstTimeMs) / 1000 : 0,
    indexMismatches: blocks.reduce((s, b) => s + b.indexMismatches, 0),
    video,
    audio: {
      packetCount: audioPackets,
      totalBytes: audioBytes,
      sampleRate: AUDIO_SAMPLE_RATE,
      sampleCount: Math.floor(audioBytes / 2),
    },
    gps,
    gsensor,
  };
}

/** 첫 키프레임 페이로드를 뜯어 WebCodecs 설정에 필요한 정보를 뽑는다. */
export function inspectBitstream(payload: Uint8Array): BitstreamInfo {
  const nals = findNalUnits(payload, 16);
  const nalTypes = nals.map((n) => n.type);
  const spsNal = nals.find((n) => n.type === NAL_SPS);
  let codec: string | null = null;
  let width: number | null = null;
  let height: number | null = null;

  if (spsNal) {
    const info = parseSps(payload.subarray(spsNal.start, spsNal.start + spsNal.length));
    if (info) {
      codec = info.codec;
      width = info.width || null;
      height = info.height || null;
    }
  }

  return {
    nalTypes,
    hasSps: nalTypes.includes(NAL_SPS),
    hasPps: nalTypes.includes(NAL_PPS),
    hasIdr: nalTypes.includes(NAL_IDR),
    codec,
    width,
    height,
    parameterSets: extractParameterSets(payload),
  };
}

/** 키프레임에 파라미터 세트가 없을 때, 같은 채널의 앞쪽 패킷들을 뒤져본다. */
async function findParameterSetsNearby(
  src: ByteSource,
  packets: PacketTable,
  channel: number,
  keyIndex: number,
): Promise<Uint8Array | null> {
  const from = Math.max(0, keyIndex - 8);
  for (let i = from; i < Math.min(packets.count, keyIndex + 8); i++) {
    if (tagKind(packets.tag[i]) !== TagKind.Video || tagChannel(packets.tag[i]) !== channel) continue;
    const payload = await src.read(packets.offset[i] + PACKET_HEADER_SIZE, Math.min(packets.size[i], 1 << 16));
    const ps = extractParameterSets(payload);
    if (ps) return ps;
  }
  return null;
}

/**
 * 타임스탬프로 fps를 추정한다.
 * 샘플이 33/34ms를 번갈아 쓰므로 중앙값은 30.303fps로 틀린다 → 장구간 평균을 쓴다.
 */
export function estimateFps(times: number[]): number {
  if (times.length < 2) return 30;
  const elapsed = (times[times.length - 1] - times[0]) / 1000;
  if (elapsed <= 0) return 30;
  const fps = (times.length - 1) / elapsed;
  if (!(fps >= 5 && fps <= 120)) return 30;
  const common = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
  let nearest = common[0];
  for (const c of common) if (Math.abs(c - fps) < Math.abs(nearest - fps)) nearest = c;
  return Math.abs(nearest - fps) / nearest < 0.01 ? nearest : fps;
}

export { buildKeyChunk };
