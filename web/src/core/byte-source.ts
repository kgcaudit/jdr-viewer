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
