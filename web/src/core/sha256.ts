/**
 * 스트리밍 SHA-256.
 *
 * crypto.subtle.digest()는 버퍼 전체를 한 번에 받아야 해서 수 GB 파일에 쓸 수 없다.
 * 증거성 해시는 반드시 계산되어야 하므로 청크 단위 구현을 직접 둔다.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private w = new Uint32Array(64);
  private block = new Uint8Array(64);
  private blockLen = 0;
  private totalLen = 0;
  private finalized: string | null = null;

  update(data: Uint8Array): void {
    if (this.finalized !== null) throw new Error('digestHex() 이후에는 update()할 수 없습니다');
    this.totalLen += data.length;
    let i = 0;
    if (this.blockLen > 0) {
      const need = 64 - this.blockLen;
      const take = Math.min(need, data.length);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      i = take;
      if (this.blockLen === 64) {
        this.compress(this.block, 0);
        this.blockLen = 0;
      }
    }
    for (; i + 64 <= data.length; i += 64) this.compress(data, i);
    if (i < data.length) {
      this.block.set(data.subarray(i), 0);
      this.blockLen = data.length - i;
    }
  }

  /** 패딩 압축이 내부 상태를 바꾸므로 결과를 캐시해 몇 번 불러도 같은 값이 나오게 한다. */
  digestHex(): string {
    if (this.finalized !== null) return this.finalized;
    const bitLen = this.totalLen * 8;
    const pad = new Uint8Array(this.blockLen < 56 ? 64 : 128);
    pad.set(this.block.subarray(0, this.blockLen), 0);
    pad[this.blockLen] = 0x80;
    // 길이는 64비트 빅엔디안. 2^53 미만이면 상위 워드/하위 워드로 나눠 쓰면 된다.
    const dv = new DataView(pad.buffer);
    dv.setUint32(pad.length - 8, Math.floor(bitLen / 0x1_0000_0000), false);
    dv.setUint32(pad.length - 4, bitLen >>> 0, false);
    for (let i = 0; i < pad.length; i += 64) this.compress(pad, i);
    let out = '';
    for (let i = 0; i < 8; i++) out += this.h[i].toString(16).padStart(8, '0');
    this.finalized = out;
    return out;
  }

  private compress(data: Uint8Array, off: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      w[i] =
        ((data[off + i * 4] << 24) | (data[off + i * 4 + 1] << 16) |
         (data[off + i * 4 + 2] << 8) | data[off + i * 4 + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.h;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    const hh = this.h;
    hh[0] = (hh[0] + a) >>> 0; hh[1] = (hh[1] + b) >>> 0;
    hh[2] = (hh[2] + c) >>> 0; hh[3] = (hh[3] + d) >>> 0;
    hh[4] = (hh[4] + e) >>> 0; hh[5] = (hh[5] + f) >>> 0;
    hh[6] = (hh[6] + g) >>> 0; hh[7] = (hh[7] + h) >>> 0;
  }
}
