/**
 * 구간 하나의 음성을 뽑아 "말한 구간"을 찾는다.
 *
 * 오디오는 파일 곳곳에 흩어진 AD 패킷이라, 음성만 뽑으려 해도 결국
 * 파일을 훑어야 한다. 70MB 파일 하나가 약 1.2초다.
 * 그래서 **기본 단위를 "지금 보고 있는 구간"으로** 잡는다.
 * 운행 전체(60개 = 4.2GB)는 사용자가 명시적으로 누를 때만 돌린다.
 */
import type { ByteSource } from './byte-source';
import { AUDIO_SAMPLE_RATE, PACKET_HEADER_SIZE } from './parser';
import { TagKind, tagKind } from './tags';
import type { JdrDocument } from './types';
import { detectSpeech, pcmFromBytes, type SpeechSpan, type VadOptions } from './vad';
import { wavHeader } from './export';

export interface SpeechResult {
  /** 이 결과가 어느 파일 것인지 — 증거 추적성 */
  path: string;
  name: string;
  /** 파일의 첫 패킷 시각 (절대 벽시계 ms) */
  baseMs: number;
  /** 파일 안에서의 말한 구간 */
  spans: SpeechSpan[];
  /** 음성 전체 길이(ms) */
  audioMs: number;
  /** 원본 PCM — 잘라서 내보낼 때 쓴다 */
  pcm: Float32Array;
}

/** AD 패킷을 이어붙여 하나의 PCM으로 만든다 */
export async function extractPcm(
  src: ByteSource,
  doc: JdrDocument,
  onProgress?: (done: number, total: number) => void,
): Promise<Float32Array> {
  const p = doc.packets;
  const indices: number[] = [];
  let totalBytes = 0;
  for (let i = 0; i < p.count; i++) {
    if (tagKind(p.tag[i]) !== TagKind.Audio || p.size[i] < 2) continue;
    indices.push(i);
    totalBytes += p.size[i];
  }
  const out = new Float32Array(Math.floor(totalBytes / 2));
  let at = 0;
  let done = 0;
  let lastYield = performance.now();
  for (const i of indices) {
    const bytes = await src.read(p.offset[i] + PACKET_HEADER_SIZE, p.size[i]);
    const chunk = pcmFromBytes(bytes);
    out.set(chunk.subarray(0, out.length - at), at);
    at += chunk.length;
    done += p.size[i];
    if (performance.now() - lastYield > 80) {
      onProgress?.(done, totalBytes);
      await new Promise((r) => setTimeout(r, 0));
      lastYield = performance.now();
    }
  }
  onProgress?.(totalBytes, totalBytes);
  return at < out.length ? out.subarray(0, at) : out;
}

export async function analyzeSegment(
  src: ByteSource,
  doc: JdrDocument,
  meta: { path: string; name: string },
  options?: VadOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<SpeechResult> {
  const pcm = await extractPcm(src, doc, onProgress);
  return {
    path: meta.path,
    name: meta.name,
    baseMs: doc.firstTimeMs,
    spans: detectSpeech(pcm, options),
    audioMs: (pcm.length / AUDIO_SAMPLE_RATE) * 1000,
    pcm,
  };
}

const msToSamples = (ms: number): number => Math.round((ms / 1000) * AUDIO_SAMPLE_RATE);

/**
 * 말한 구간만 이어붙인 WAV.
 *
 * 3시간에서 4분만 남으므로 PC 전사 흐름으로 넘기기가 훨씬 수월해진다.
 * 어느 위치가 원본의 어디였는지는 `buildSpeechCsv`가 짝을 맞춰 준다.
 */
export function buildSpeechWav(results: SpeechResult[]): Blob {
  const parts: Float32Array[] = [];
  let total = 0;
  for (const r of results) {
    for (const s of r.spans) {
      const from = Math.max(0, msToSamples(s.startMs));
      const to = Math.min(r.pcm.length, msToSamples(s.endMs));
      if (to <= from) continue;
      const piece = r.pcm.subarray(from, to);
      parts.push(piece);
      total += piece.length;
    }
  }
  const pcm = new Int16Array(total);
  let at = 0;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) {
      const v = Math.max(-1, Math.min(1, p[i]));
      pcm[at + i] = Math.round(v * 32767);
    }
    at += p.length;
  }
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return new Blob([wavHeader(bytes.byteLength, AUDIO_SAMPLE_RATE), bytes], { type: 'audio/wav' });
}

/**
 * 대조표.
 *
 * 잘라낸 WAV의 몇 초가 **원본의 어느 파일 몇 초**였는지 적는다.
 * 이게 없으면 전사 결과를 원본으로 되짚을 수 없어 증거로 못 쓴다.
 */
export function buildSpeechCsv(results: SpeechResult[]): string {
  const rows = ['wav_start_s,wav_end_s,source_file,file_start_s,file_end_s,recorded_at,duration_s,score'];
  let cursor = 0;
  for (const r of results) {
    for (const s of r.spans) {
      const dur = (s.endMs - s.startMs) / 1000;
      const at = new Date(r.baseMs + s.startMs).toISOString();
      rows.push([
        cursor.toFixed(3),
        (cursor + dur).toFixed(3),
        r.path,
        (s.startMs / 1000).toFixed(3),
        (s.endMs / 1000).toFixed(3),
        at,
        dur.toFixed(3),
        s.score.toFixed(3),
      ].join(','));
      cursor += dur;
    }
  }
  return rows.join('\n') + '\n';
}
