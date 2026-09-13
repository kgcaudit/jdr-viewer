/**
 * 추출물 생성 조각들.
 *
 * 파일 하나를 통째로 저장하는 기능은 없앴다 — 원본이 50초짜리라 그 단위로
 * 뽑아야 쓸 데가 없었다. 지금은 `range-export.ts`가 **시간 구간**으로 뽑고,
 * 여기에는 그 재료(조각 모으기·WAV 머리글)와 CSV 생성기만 남는다.
 */
import type { ByteSource, Bytes } from './byte-source';
import type { JdrDocument } from './types';
import { PACKET_HEADER_SIZE, GSENSOR_SCALE, AUDIO_SAMPLE_RATE } from './parser';
import { TagKind, tagKind } from './tags';
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
