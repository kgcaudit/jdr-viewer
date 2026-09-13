/**
 * 구간 하나를 훑어 말한 구간을 뽑고, 내보내기 짝(WAV+CSV)을 만드는 경로.
 *
 * 오디오 패킷은 파일 곳곳에 흩어져 있으므로 "이어붙이기가 맞는가"가 먼저다.
 */
import { describe, expect, it } from 'vitest';
import { BufferByteSource } from '../src/core/byte-source';
import { parseJdr } from '../src/core/parser';
import { analyzeSegment, buildSpeechCsv, buildSpeechWav, extractPcm } from '../src/core/speech';
import { speechTotalMs } from '../src/core/vad';
import { buildJdrBlock, pcmCabin, type SynthPacket } from './synth';

const T0 = Date.UTC(2026, 0, 15, 9, 30, 0, 0);
/** 오디오 패킷 하나 = 0.2초 */
const CHUNK = 1600;

/** 20초짜리 파일. voiceFrom~voiceTo 초에만 말소리가 있다. */
function cabinFile(seconds: number, voiceFrom: number, voiceTo: number, noise = 0.08) {
  const packets: SynthPacket[] = [];
  const count = (seconds * 8000) / CHUNK;
  for (let i = 0; i < count; i++) {
    packets.push({
      tag: '00AD',
      payload: pcmCabin(CHUNK, i * CHUNK, { noise, voiceFrom, voiceTo }),
      timeMs: T0 + (i * CHUNK * 1000) / 8000,
    });
  }
  const bytes = buildJdrBlock(packets);
  return new BufferByteSource(bytes, 'cabin.jdr');
}

describe('구간 음성 훑기', () => {
  it('흩어진 AD 패킷을 순서대로 이어붙인다', async () => {
    const src = cabinFile(10, -1, -1);
    const doc = await parseJdr(src);
    const pcm = await extractPcm(src, doc);
    expect(pcm.length).toBe(10 * 8000);
    expect(doc.audio.packetCount).toBe(50);
  });

  it('훑기 진행률이 0에서 100까지 올라간다', async () => {
    const src = cabinFile(10, -1, -1);
    const doc = await parseJdr(src);
    const seen: number[] = [];
    await extractPcm(src, doc, (done, total) => seen.push(done / total));
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('주행 잡음만 있는 구간에서는 아무것도 찾지 않는다', async () => {
    const src = cabinFile(20, -1, -1);
    const doc = await parseJdr(src);
    const r = await analyzeSegment(src, doc, { path: 'data/a.jdr', name: 'a.jdr' });
    expect(r.spans).toEqual([]);
    expect(r.audioMs).toBeCloseTo(20_000, -1);
  });

  it('말소리가 있으면 그 위치를 찾는다', async () => {
    const src = cabinFile(20, 7, 11);
    const doc = await parseJdr(src);
    const r = await analyzeSegment(src, doc, { path: 'data/a.jdr', name: 'a.jdr' });
    expect(r.spans.length).toBeGreaterThan(0);
    const s = r.spans[0];
    expect(s.startMs).toBeGreaterThan(6_000);
    expect(s.endMs).toBeLessThan(12_500);
  });

  it('결과에 어느 파일인지가 남는다 — 증거 추적성', async () => {
    const src = cabinFile(20, 7, 11);
    const doc = await parseJdr(src);
    const r = await analyzeSegment(src, doc, { path: 'data/00000460.jdr', name: '00000460.jdr' });
    expect(r.path).toBe('data/00000460.jdr');
    expect(r.baseMs).toBe(T0);
  });
});

describe('내보내기 짝', () => {
  async function analysed() {
    const src = cabinFile(20, 7, 11);
    const doc = await parseJdr(src);
    return analyzeSegment(src, doc, { path: 'data/a.jdr', name: 'a.jdr' });
  }

  it('WAV는 말한 구간만 담아 원본보다 훨씬 작다', async () => {
    const r = await analysed();
    const wav = buildSpeechWav([r]);
    const talkBytes = (speechTotalMs(r.spans) / 1000) * 8000 * 2;
    expect(wav.size).toBeCloseTo(talkBytes + 44, -2);
    expect(wav.size).toBeLessThan((r.audioMs / 1000) * 8000 * 2 * 0.5);
  });

  it('CSV가 잘라낸 위치를 원본 파일·시각으로 되짚어 준다', async () => {
    const r = await analysed();
    const csv = buildSpeechCsv([r]);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('wav_start_s,wav_end_s,source_file,file_start_s,file_end_s,recorded_at,duration_s,score');
    expect(lines.length).toBe(1 + r.spans.length);

    const cols = lines[1].split(',');
    expect(cols[2]).toBe('data/a.jdr');
    expect(Number(cols[0])).toBe(0);                       // 잘라낸 WAV의 0초에서 시작
    expect(Number(cols[3])).toBeCloseTo(r.spans[0].startMs / 1000, 2);
    expect(cols[5]).toBe(new Date(T0 + r.spans[0].startMs).toISOString());
  });

  it('WAV 시각과 CSV 시각이 어긋나지 않는다', async () => {
    const src = cabinFile(40, 5, 8);
    const doc = await parseJdr(src);
    const r = await analyzeSegment(src, doc, { path: 'data/a.jdr', name: 'a.jdr' });
    // 일부러 구간을 둘로 쪼갠 결과를 만든다
    const two = { ...r, spans: [r.spans[0], { startMs: 20_000, endMs: 22_000, score: 0.5 }] };
    const rows = buildSpeechCsv([two]).trim().split('\n').slice(1).map((l) => l.split(','));
    // 두 번째 줄의 wav_start_s는 첫 줄 길이와 같아야 한다 (이어붙인 순서 그대로)
    expect(Number(rows[1][0])).toBeCloseTo(Number(rows[0][6]), 3);
    expect(buildSpeechWav([two]).size).toBeCloseTo(
      (Number(rows[0][6]) + Number(rows[1][6])) * 8000 * 2 + 44, -2,
    );
  });

  it('찾은 게 없으면 빈 WAV와 머리글만 있는 CSV', async () => {
    const src = cabinFile(20, -1, -1);
    const doc = await parseJdr(src);
    const r = await analyzeSegment(src, doc, { path: 'data/a.jdr', name: 'a.jdr' });
    expect(buildSpeechWav([r]).size).toBe(44);
    expect(buildSpeechCsv([r]).trim().split('\n')).toHaveLength(1);
  });
});
