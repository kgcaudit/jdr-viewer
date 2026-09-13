import { describe, expect, it } from 'vitest';
import { BufferedByteSource } from '../src/core/byte-source';

/** 실제로 몇 번 읽었는지 세는 소스 */
class CountingSource {
  reads = 0;
  bytes = 0;
  readonly name = 'count.jdr';
  constructor(private readonly data: Uint8Array<ArrayBuffer>) {}
  get size(): number { return this.data.length; }
  async read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    const end = Math.min(offset + length, this.data.length);
    if (end <= offset) return new Uint8Array(0);
    this.reads++;
    this.bytes += end - offset;
    return this.data.slice(offset, end);
  }
}

const makeData = (n: number): Uint8Array<ArrayBuffer> => {
  const d = new Uint8Array(n);
  for (let i = 0; i < n; i++) d[i] = (i * 31) & 0xff;
  return d;
};

describe('읽기 버퍼링', () => {
  it('작은 읽기를 반복해도 같은 구간을 두 번 읽지 않는다', async () => {
    const data = makeData(1 << 20);
    const inner = new CountingSource(data);
    const src = new BufferedByteSource(inner, 256 * 1024, 8);

    // 재생이 프레임을 훑듯 16KB씩 순서대로 읽는다
    for (let off = 0; off + 16384 <= data.length; off += 16384) {
      const got = await src.read(off, 16384);
      expect(got[0]).toBe(data[off]);
      expect(got[16383]).toBe(data[off + 16383]);
    }
    expect(inner.reads).toBe(4);                  // 256KB × 4, 중복 없음
    expect(inner.bytes).toBe(data.length);
  });

  it('앞 구간을 미리 당겨와 실제로 기다리는 일이 거의 없다', async () => {
    const data = makeData(1 << 20);
    const inner = new CountingSource(data);
    const src = new BufferedByteSource(inner, 256 * 1024, 8);

    for (let off = 0; off + 16384 <= data.length; off += 16384) {
      await src.read(off, 16384);
      // 미리 읽기가 끝날 틈을 준다 (실제 재생도 프레임 사이에 시간이 있다)
      await Promise.resolve();
    }
    // 64번 읽는 동안 실제로 기다린 것은 맨 처음 한 번뿐이어야 한다
    expect(src.stats.misses).toBe(1);
    expect(src.stats.hits).toBe(63);
  });

  it('내용이 원본과 정확히 같다', async () => {
    const data = makeData(100_000);
    const src = new BufferedByteSource(new CountingSource(data), 32_768, 2);
    for (const [off, len] of [[0, 10], [99_990, 10], [12_345, 5000], [0, 100_000]] as const) {
      expect(Array.from(await src.read(off, len))).toEqual(Array.from(data.subarray(off, off + len)));
    }
  });

  it('버퍼보다 큰 요청도 그대로 처리한다', async () => {
    const data = makeData(500_000);
    const src = new BufferedByteSource(new CountingSource(data), 64 * 1024, 2);
    const got = await src.read(1000, 300_000);
    expect(got.length).toBe(300_000);
    expect(Array.from(got.subarray(0, 8))).toEqual(Array.from(data.subarray(1000, 1008)));
  });

  it('버퍼 개수 상한을 지킨다 (메모리가 무한정 늘지 않는다)', async () => {
    const data = makeData(8 << 20);
    const inner = new CountingSource(data);
    const src = new BufferedByteSource(inner, 256 * 1024, 3);
    for (let i = 0; i < 12; i++) await src.read(i * 1024 * 1024, 100);
    // 상한이 3이므로 아주 앞쪽은 이미 버려져 다시 읽어야 한다
    const before = inner.reads;
    await src.read(0, 100);
    expect(inner.reads).toBeGreaterThan(before);
    // 방금 읽은 곳은 남아 있다
    const after = inner.reads;
    await src.read(50, 100);
    expect(inner.reads).toBe(after);
  });

  it('파일 끝을 넘겨 요청해도 있는 만큼만 준다', async () => {
    const data = makeData(1000);
    const src = new BufferedByteSource(new CountingSource(data), 4096, 2);
    expect((await src.read(900, 500)).length).toBe(100);
    expect((await src.read(1000, 10)).length).toBe(0);
  });

  it('버퍼를 비우면 다시 읽는다', async () => {
    const data = makeData(100_000);
    const inner = new CountingSource(data);
    const src = new BufferedByteSource(inner, 64 * 1024, 4);
    await src.read(0, 100);
    await src.read(200, 100);
    const readsBefore = inner.reads;
    src.clearBuffers();
    await src.read(0, 100);
    expect(inner.reads).toBeGreaterThan(readsBefore);
  });

  it('미리 당겨온 구간은 기다리지 않고 바로 준다', async () => {
    const data = makeData(1 << 20);
    const inner = new CountingSource(data);
    const src = new BufferedByteSource(inner, 256 * 1024, 8);
    src.prefetch(0);
    await new Promise((r) => setTimeout(r, 0));
    await src.read(1000, 100);
    expect(src.stats.hits).toBe(1);
    expect(src.stats.misses).toBe(0);
  });
});
