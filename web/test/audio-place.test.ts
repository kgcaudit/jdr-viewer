/**
 * 소리가 "지직" 깨지는 진짜 원인을 잡아 두는 시험.
 *
 * 기기가 찍는 패킷 시각은 표본 단위로 정확하지 않다. 그 시각을 곧이곧대로
 * 믿고 파형을 놓으면 패킷마다 표본 몇 개짜리 무음(구멍)이나 덮어쓰기(겹침)가
 * 생기고, 초당 여러 번이라 사람 귀에는 계속 깨져 들린다.
 *
 * 여기서 지키는 건 하나다 — **이어질 만하면 이어 붙고, 진짜 공백만 남는다.**
 */
import { describe, expect, it } from 'vitest';
import { AUDIO_JITTER_SAMPLES, placeSample } from '../src/core/audio-place';
import { AudioTimeline } from '../src/core/mp4';

const RATE = 8000;
/** 8kHz s16le에서 ms → 표본 */
const sample = (ms: number): number => Math.round((ms / 1000) * RATE);

describe('placeSample', () => {
  it('첫 패킷은 시각 그대로 놓는다', () => {
    expect(placeSample(-1, 1234)).toBe(1234);
  });

  it('표본 몇 개짜리 틈은 앞 소리에 붙인다 (구멍 = 딱 소리)', () => {
    // 200ms 패킷인데 다음 시각이 202ms → 16표본 구멍
    expect(placeSample(1600, 1616)).toBe(1600);
  });

  it('겹쳐도 덮어쓰지 않고 뒤에 잇는다', () => {
    // 시각이 1ms 당겨져 8표본 겹침
    expect(placeSample(1600, 1592)).toBe(1600);
  });

  it('여러 패킷 시각이 같아도(초 단위 시계) 소리를 잃지 않는다', () => {
    let cursor = -1;
    const placed: number[] = [];
    for (let i = 0; i < 5; i++) {
      const at = placeSample(cursor, 0); // 전부 같은 시각
      placed.push(at);
      cursor = at + 1600;
    }
    expect(placed).toEqual([0, 1600, 3200, 4800, 6400]);
  });

  it('진짜 공백(주차 등)은 그대로 띄운다', () => {
    const gap = AUDIO_JITTER_SAMPLES + 1;
    expect(placeSample(1600, 1600 + gap)).toBe(1600 + gap);
  });

  it('너무 밀리면 포기하고 시각으로 되돌린다 (영상과 벌어지지 않게)', () => {
    expect(placeSample(RATE * 2, 100)).toBe(100);
  });
});

describe('AudioTimeline', () => {
  /** 내보낸 조각을 하나로 이어 붙인다 */
  async function collect(
    writes: { at: number; samples: number }[],
    chunk = 4000,
  ): Promise<Float32Array> {
    const out: number[] = [];
    const tl = new AudioTimeline(async (c) => { out.push(...c); }, chunk);
    for (const w of writes) {
      const pcm = new Float32Array(new ArrayBuffer(w.samples * 4));
      pcm.fill(0.5); // 무음이 아닌 값 — 0이 나오면 그게 구멍이다
      await tl.write(w.at, pcm);
    }
    await tl.close();
    return Float32Array.from(out);
  }

  it('시각이 흔들려도 무음을 끼워 넣지 않는다', async () => {
    // 200ms짜리 패킷인데 시각은 200/401/601/802ms처럼 들쭉날쭉하다
    const writes = [0, 200, 401, 601, 802, 1001].map((ms) => ({
      at: sample(ms), samples: 1600,
    }));
    const pcm = await collect(writes);
    expect(pcm.length).toBe(1600 * writes.length);
    expect(Array.from(pcm).filter((v) => v === 0)).toHaveLength(0);
  });

  it('진짜 공백은 무음으로 남긴다', async () => {
    const pcm = await collect([
      { at: 0, samples: 1600 },
      { at: sample(5000), samples: 1600 }, // 5초 비었다
    ]);
    expect(pcm.length).toBe(sample(5000) + 1600);
    // 가운데는 전부 무음이어야 한다
    for (let i = 1600; i < sample(5000); i++) expect(pcm[i]).toBe(0);
    expect(pcm[sample(5000)]).toBe(0.5);
  });

  it('창 경계를 넘어도 파형이 이어진다', async () => {
    const writes = [0, 200, 400, 600, 800].map((ms) => ({ at: sample(ms), samples: 1600 }));
    const pcm = await collect(writes, 1000); // 일부러 잘게 끊어 내보낸다
    expect(pcm.length).toBe(8000);
    expect(Array.from(pcm).filter((v) => v === 0)).toHaveLength(0);
  });
});
