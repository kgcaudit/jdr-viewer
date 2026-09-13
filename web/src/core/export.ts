/** 추출물 생성 — 원본 Python 도구의 출력물과 같은 형식을 목표로 한다. */
import type { ByteSource, Bytes } from './byte-source';
import type { JdrDocument } from './types';
import { PACKET_HEADER_SIZE, GSENSOR_SCALE, AUDIO_SAMPLE_RATE } from './parser';
import { TagKind, tagChannel, tagKind, tagString } from './tags';
import { formatRecordedTime } from './time';

/** Excel에서 한글이 깨지지 않도록 BOM을 붙인다 (원본 도구도 utf-8-sig를 씀). */
const BOM = '﻿';

function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header: string[], rows: (string | number)[][]): string {
  const lines = [header.join(',')];
  for (const r of rows) lines.push(r.map(csvEscape).join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}

export function buildGpsCsv(doc: JdrDocument): string {
  return toCsv(
    ['packet_time', 'gps_time', 'pdop', 'hdop', 'vdop', 'latitude_nmea', 'longitude_nmea',
     'latitude_deg', 'longitude_deg', 'altitude_m', 'speed_kmh'],
    doc.gps.map((g) => [
      formatRecordedTime(g.timeMs), formatRecordedTime(g.gpsTimeMs),
      g.pdop, g.hdop, g.vdop, g.latNmea, g.lonNmea, g.lat, g.lon, g.altitude, g.speed,
    ]),
  );
}

export function buildGsensorCsv(doc: JdrDocument): string {
  const s = doc.gsensor;
  const rows: (string | number)[][] = [];
  for (let i = 0; i < s.count; i++) {
    rows.push([
      formatRecordedTime(s.timeMs[i]),
      s.x[i], s.y[i], s.z[i],
      s.x[i] / GSENSOR_SCALE, s.y[i] / GSENSOR_SCALE, s.z[i] / GSENSOR_SCALE,
    ]);
  }
  return toCsv(['packet_time', 'x_raw', 'y_raw', 'z_raw', 'x_g_est', 'y_g_est', 'z_g_est'], rows);
}

export function buildPacketsCsv(doc: JdrDocument): string {
  const p = doc.packets;
  const rows: (string | number)[][] = [];
  for (let i = 0; i < p.count; i++) {
    rows.push([
      p.blockNo[i], i, '0x' + p.offset[i].toString(16).toUpperCase(),
      tagString(p.tag[i]), p.size[i], p.aux[i], formatRecordedTime(p.timeMs[i]),
    ]);
  }
  return toCsv(['block_no', 'packet_no', 'offset_hex', 'tag', 'payload_size', 'aux', 'timestamp'], rows);
}

export function buildSummaryJson(doc: JdrDocument): string {
  return JSON.stringify(
    {
      input_file: doc.fileName,
      input_size_bytes: doc.fileSize,
      sha256: doc.sha256,
      jdr_format_status: '역분석 기반. 제조사 공식 사양이 아니며 일부 값은 추정치임',
      generated_by: 'JDR Viewer (web)',
      jeb_blocks: doc.blocks.map((b) => ({
        ...b,
        startTime: formatRecordedTime(b.startTimeMs),
        endTime: formatRecordedTime(b.endTimeMs),
      })),
      valid_packets: doc.packets.count,
      index_mismatches: doc.indexMismatches,
      packet_tag_counts: doc.tagCounts,
      first_packet_time: formatRecordedTime(doc.firstTimeMs),
      last_packet_time: formatRecordedTime(doc.lastTimeMs),
      duration_seconds: doc.durationSec,
      video: doc.video.map((v) => ({
        channel: v.channel,
        frames: v.frameCount,
        keyframes: v.keyframeCount,
        estimated_fps: v.fps,
        codec: v.bitstream?.codec ?? null,
        width: v.bitstream?.width ?? null,
        height: v.bitstream?.height ?? null,
        keyframe_contains_parameter_sets: v.bitstream ? v.bitstream.hasSps && v.bitstream.hasPps : null,
      })),
      audio: doc.audio,
      gps_rows: doc.gps.length,
      gsensor_rows: doc.gsensor.count,
      gsensor_scale_note: `raw / ${GSENSOR_SCALE} ≈ g (추정)`,
    },
    null,
    2,
  );
}

/**
 * 패킷 조각을 큰 덩어리로 모아 Blob으로 넘기는 수집기.
 *
 * 프레임마다 Blob 조각을 만들면 3,500개가 넘고, Blob을 만들 때 그만큼 복사가 일어난다.
 * 8MB씩 모아 넘기면 조각이 몇 개로 줄어 모바일에서 체감이 크게 달라진다.
 */
const EXPORT_CHUNK = 8 << 20;

export class BlobCollector {
  private parts: BlobPart[] = [];
  private buf = new Uint8Array(EXPORT_CHUNK);
  private used = 0;

  push(chunk: Uint8Array): void {
    if (chunk.length > EXPORT_CHUNK) {
      this.flush();
      this.parts.push(new Blob([chunk as BlobPart]));
      return;
    }
    if (this.used + chunk.length > EXPORT_CHUNK) this.flush();
    this.buf.set(chunk, this.used);
    this.used += chunk.length;
  }

  private flush(): void {
    if (this.used === 0) return;
    // Blob으로 넘기면 브라우저가 복사해 가므로 버퍼를 다시 쓸 수 있다
    this.parts.push(new Blob([this.buf.subarray(0, this.used) as BlobPart]));
    this.used = 0;
  }

  finish(head?: Uint8Array, type?: string): Blob {
    this.flush();
    return new Blob(head ? [head as BlobPart, ...this.parts] : this.parts, type ? { type } : undefined);
  }
}

/** 오래 도는 작업 중 화면이 멈추지 않도록 양보한다 */
export const yieldToUi = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 채널별 H.264 Annex-B elementary stream을 그대로 이어붙인다. */
export async function extractH264(
  src: ByteSource, doc: JdrDocument, channel: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  const p = doc.packets;
  const indices: number[] = [];
  let totalBytes = 0;
  for (let i = 0; i < p.count; i++) {
    if (tagKind(p.tag[i]) === TagKind.Video && tagChannel(p.tag[i]) === channel) {
      indices.push(i);
      totalBytes += p.size[i];
    }
  }

  const out = new BlobCollector();
  let done = 0;
  let lastYield = performance.now();
  for (let n = 0; n < indices.length; n++) {
    const i = indices[n];
    out.push(await src.read(p.offset[i] + PACKET_HEADER_SIZE, p.size[i]));
    done += p.size[i];
    // 시간 기준으로 양보한다 — 프레임 수로 나누면 기기에 따라 너무 잦거나 뜸해진다
    if (performance.now() - lastYield > 80) {
      onProgress?.(done, totalBytes);
      await yieldToUi();
      lastYield = performance.now();
    }
  }
  onProgress?.(totalBytes, totalBytes);
  return out.finish(undefined, 'video/h264');
}

export function wavHeader(dataBytes: number, sampleRate: number, channels = 1, bits = 16): Bytes {
  const buf = new ArrayBuffer(44);
  const dv = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  const byteRate = (sampleRate * channels * bits) / 8;
  w(0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, (channels * bits) / 8, true);
  dv.setUint16(34, bits, true);
  w(36, 'data');
  dv.setUint32(40, dataBytes, true);
  return new Uint8Array(buf);
}

/** AD 패킷을 이어붙여 WAV(PCM s16le 8kHz mono)로 만든다. */
export async function extractWav(
  src: ByteSource, doc: JdrDocument,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  const p = doc.packets;
  const indices: number[] = [];
  let totalBytes = 0;
  for (let i = 0; i < p.count; i++) {
    if (tagKind(p.tag[i]) !== TagKind.Audio) continue;
    indices.push(i);
    totalBytes += p.size[i];
  }

  const out = new BlobCollector();
  let done = 0;
  let lastYield = performance.now();
  for (const i of indices) {
    out.push(await src.read(p.offset[i] + PACKET_HEADER_SIZE, p.size[i]));
    done += p.size[i];
    if (performance.now() - lastYield > 80) {
      onProgress?.(done, totalBytes);
      await yieldToUi();
      lastYield = performance.now();
    }
  }
  onProgress?.(totalBytes, totalBytes);
  return out.finish(wavHeader(totalBytes, AUDIO_SAMPLE_RATE), 'audio/wav');
}
