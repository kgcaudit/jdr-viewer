/**
 * 바이트 소스 추상화.
 *
 * 브라우저에서는 File/Blob이, 테스트에서는 ArrayBuffer가 들어온다.
 * 파서가 이 인터페이스에만 의존하므로 플랫폼과 무관하게 재사용할 수 있다.
 *
 * 핵심: Blob.slice()는 지연 연산이라 수 GB 파일도 메모리에 올리지 않는다.
 */

/**
 * 읽어온 바이트. TS 5.7부터 TypedArray가 버퍼 종류를 타입 인자로 받는데,
 * 이 소스들은 항상 일반 ArrayBuffer 기반이므로 그렇게 못박아 둔다.
 * (그래야 Blob 생성이나 Transferable 전달에서 타입이 맞는다.)
 */
export type Bytes = Uint8Array<ArrayBuffer>;

export interface ByteSource {
  readonly size: number;
  readonly name: string;
  /** [offset, offset+length) 구간을 읽는다. 범위를 벗어나면 짧게 반환될 수 있다. */
  read(offset: number, length: number): Promise<Bytes>;
}

export class BlobByteSource implements ByteSource {
  constructor(private readonly blob: Blob, readonly name = 'blob') {}
  get size(): number {
    return this.blob.size;
  }
  async read(offset: number, length: number): Promise<Bytes> {
    const end = Math.min(offset + length, this.blob.size);
    if (end <= offset) return new Uint8Array(0);
    return new Uint8Array(await this.blob.slice(offset, end).arrayBuffer());
  }
}

export class BufferByteSource implements ByteSource {
  private readonly bytes: Bytes;
  constructor(buf: ArrayBuffer | Bytes, readonly name = 'buffer') {
    this.bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  }
  get size(): number {
    return this.bytes.length;
  }
  async read(offset: number, length: number): Promise<Bytes> {
    return this.bytes.subarray(offset, Math.min(offset + length, this.bytes.length));
  }
}

/**
 * 앞으로 훑어가며 작은 값을 많이 읽을 때 쓰는 버퍼 리더.
 *
 * 패킷 헤더는 28바이트씩 파일 곳곳에 흩어져 있어서 매번 read()를 하면
 * I/O 횟수가 폭증한다. 큰 창(window)을 잡아두고 벗어날 때만 다시 읽는다.
 * 모든 오프셋은 "파일 절대 위치"로 받는다.
 */
export class WindowReader {
  private buf: Bytes = new Uint8Array(0);
  private view = new DataView(new ArrayBuffer(0));
  private start = 0;

  constructor(private readonly src: ByteSource, private readonly chunk = 1 << 20) {}

  async ensure(offset: number, length: number): Promise<boolean> {
    if (offset < 0 || offset + length > this.src.size) return false;
    if (offset >= this.start && offset + length <= this.start + this.buf.length) return true;
    const want = Math.min(Math.max(this.chunk, length), this.src.size - offset);
    this.buf = await this.src.read(offset, want);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    this.start = offset;
    return this.buf.length >= length;
  }

  u8(offset: number): number { return this.view.getUint8(offset - this.start); }
  u16(offset: number): number { return this.view.getUint16(offset - this.start, true); }
  /** 부호 없는 32비트 — JS는 이게 그냥 된다 (Kotlin의 signed Int 함정이 없음) */
  u32(offset: number): number { return this.view.getUint32(offset - this.start, true); }
  i32(offset: number): number { return this.view.getInt32(offset - this.start, true); }
  f64(offset: number): number { return this.view.getFloat64(offset - this.start, true); }
  bytes(offset: number, length: number): Bytes {
    const rel = offset - this.start;
    return this.buf.subarray(rel, rel + length);
  }
}

/**
 * 읽기 버퍼링.
 *
 * 재생은 프레임마다 16KB 남짓을 읽는다. 69초 영상 하나면 4,190번이고 초당 60번이다.
 * 데스크톱에서는 티가 안 나지만, 모바일에서 Blob.slice()는 호출마다 파일시스템을
 * 거치므로 이 횟수가 그대로 끊김이 된다.
 *
 * 프레임은 파일 안에서도 대체로 순서대로 놓여 있으므로, 큰 덩어리로 미리 읽어두면
 * 대부분 메모리에서 해결된다. 채널 0과 1이 번갈아 나와도 같은 덩어리 안에 있다.
 */
export class BufferedByteSource implements ByteSource {
  private chunks: { start: number; end: number; data: Bytes }[] = [];
  /** 지금 백그라운드로 당겨오는 중인 구간 */
  private inflight = new Map<number, Promise<void>>();
  /**
   * 진단용. waitMs는 "실제로 기다린 시간"이다 —
   * 이 값이 크면 재생 끊김의 원인이 디코딩이 아니라 읽기라는 뜻이다.
   */
  stats = { hits: 0, misses: 0, bytesRead: 0, waitMs: 0 };

  constructor(
    private readonly inner: ByteSource,
    /**
     * 한 번에 읽는 크기.
     *
     * 작게 잡으면 미스 한 번의 대기는 짧아지지만 **미스 자체가 잦아진다**.
     * 인공 지연을 넣고 600프레임을 돌려 보니 1MB×10은 미스 11회/대기 415ms,
     * 4MB×6은 미스 3회/대기 269ms로 4MB 쪽이 모든 지표에서 앞섰다.
     * 채널 0·1이 번갈아 나오므로 창이 넉넉해야 양쪽이 같은 덩어리를 공유한다.
     */
    private readonly chunkSize = 4 << 20,
    private readonly maxChunks = 6,
  ) {}

  get size(): number { return this.inner.size; }
  get name(): string { return this.inner.name; }

  private find(offset: number, end: number): { start: number; end: number; data: Bytes } | null {
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (offset >= c.start && end <= c.end) {
        if (i !== this.chunks.length - 1) {
          this.chunks.splice(i, 1);
          this.chunks.push(c);
        }
        return c;
      }
    }
    return null;
  }

  private store(start: number, data: Bytes): void {
    if (data.length === 0) return;
    this.chunks.push({ start, end: start + data.length, data });
    while (this.chunks.length > this.maxChunks) this.chunks.shift();
  }

  /**
   * 뒤쪽 구간을 미리 당겨온다. 기다리지 않는다.
   * 재생은 파일을 순서대로 훑으므로, 이것만으로 미스가 거의 사라진다.
   */
  prefetch(start: number): void {
    const aligned = Math.max(0, Math.floor(start / this.chunkSize) * this.chunkSize);
    if (aligned >= this.inner.size) return;
    if (this.inflight.has(aligned)) return;
    if (this.find(aligned, aligned + 1)) return;

    const want = Math.min(this.chunkSize, this.inner.size - aligned);
    const job = this.inner
      .read(aligned, want)
      .then((data) => {
        this.stats.bytesRead += data.length;
        this.store(aligned, data);
      })
      .catch(() => { /* 미리 읽기 실패는 실제 읽기에서 다시 시도한다 */ })
      .finally(() => { this.inflight.delete(aligned); });
    this.inflight.set(aligned, job);
  }

  async read(offset: number, length: number): Promise<Bytes> {
    const end = offset + length;
    const hit = this.find(offset, end);
    if (hit) {
      this.stats.hits++;
      // 절반쯤 왔으면 다음 둘을 당겨둔다.
      // 늦게 당기면 프레임 간격(약 16ms) 안에 못 끝나 결국 기다리게 된다.
      if (end > hit.start + this.chunkSize / 2) {
        this.prefetch(hit.end);
        this.prefetch(hit.end + this.chunkSize);
      }
      return hit.data.subarray(offset - hit.start, end - hit.start);
    }

    this.stats.misses++;
    // 실제 읽기도 미리 읽기와 같은 경계에서 시작한다.
    // 어긋나면 같은 구간을 두 번 읽게 된다.
    const aligned = Math.floor(offset / this.chunkSize) * this.chunkSize;
    const t0 = performance.now();

    // 이미 당겨오는 중이면 그게 끝나기를 기다린다
    const running = this.inflight.get(aligned);
    if (running) {
      await running;
      const after = this.find(offset, end);
      if (after) {
        this.stats.waitMs += performance.now() - t0;
        this.prefetch(after.end);
        this.prefetch(after.end + this.chunkSize);
        return after.data.subarray(offset - after.start, end - after.start);
      }
    }

    const want = Math.min(Math.max(this.chunkSize, end - aligned), this.inner.size - aligned);
    const data = await this.inner.read(aligned, want);
    this.stats.waitMs += performance.now() - t0;
    this.stats.bytesRead += data.length;
    this.store(aligned, data);
    // 바로 다음 구간들을 미리 당겨 다음 미스를 막는다
    this.prefetch(aligned + data.length);
    this.prefetch(aligned + data.length + this.chunkSize);
    const from = offset - aligned;
    return data.subarray(from, Math.min(from + length, data.length));
  }

  /** 파싱이 끝난 뒤처럼, 더는 쓰지 않을 버퍼를 비운다 */
  clearBuffers(): void {
    this.chunks = [];
  }
}
