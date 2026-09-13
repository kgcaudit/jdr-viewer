/**
 * 테스트용 합성 JDR 생성기.
 * 실제 샘플 파일 없이도 파서를 검증하기 위해, 사양 문서대로 파일을 조립한다.
 * e2e에서는 WebCodecs로 만든 진짜 H.264 프레임을 넣어 재생까지 검증한다.
 */

type Bytes = Uint8Array<ArrayBuffer>;

export interface SynthPacket {
  tag: string;
  payload: Bytes;
  timeMs: number;
  aux?: number;
}

const HEADER_SIZE = 0x200;
const PACKET_HEADER_SIZE = 28;
const INDEX_ENTRY_SIZE = 12;

function writeSystemTime(dv: DataView, off: number, ms: number): void {
  const d = new Date(ms);
  dv.setUint16(off, d.getUTCFullYear(), true);
  dv.setUint16(off + 2, d.getUTCMonth() + 1, true);
  dv.setUint16(off + 4, d.getUTCDay(), true);
  dv.setUint16(off + 6, d.getUTCDate(), true);
  dv.setUint16(off + 8, d.getUTCHours(), true);
  dv.setUint16(off + 10, d.getUTCMinutes(), true);
  dv.setUint16(off + 12, d.getUTCSeconds(), true);
  dv.setUint16(off + 14, d.getUTCMilliseconds(), true);
}

function ascii(s: string): number[] {
  return [0, 1, 2, 3].map((i) => s.charCodeAt(i) & 0xff);
}

/** 패킷 목록으로 JEB 블록 하나를 만든다. */
export function buildJdrBlock(packets: SynthPacket[], baseOffset = 0): Bytes {
  let payloadTotal = 0;
  for (const p of packets) payloadTotal += PACKET_HEADER_SIZE + p.payload.length;
  const indexOffset = baseOffset + HEADER_SIZE + payloadTotal;
  const total = HEADER_SIZE + payloadTotal + packets.length * INDEX_ENTRY_SIZE;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);

  const counts = { ch0: 0, ch1: 0, audio: 0, gps: 0, sensor: 0 };
  for (const p of packets) {
    if (p.tag === '00VI' || p.tag === '00VP') counts.ch0++;
    else if (p.tag === '01VI' || p.tag === '01VP') counts.ch1++;
    else if (p.tag.slice(2) === 'AD') counts.audio++;
    else if (p.tag.slice(2) === 'GP') counts.gps++;
    else if (p.tag.slice(2) === 'SE') counts.sensor++;
  }

  out.set(ascii('1BEJ'), 0);
  dv.setUint32(0x04, packets.length, true);
  dv.setUint32(0x08, counts.ch0, true);
  dv.setUint32(0x0c, counts.ch1, true);
  dv.setUint32(0x48, counts.audio, true);
  dv.setUint32(0x88, counts.gps, true);
  dv.setUint32(0x8c, counts.sensor, true);
  if (packets.length > 0) {
    writeSystemTime(dv, 0x94, packets[0].timeMs);
    writeSystemTime(dv, 0xa4, packets[packets.length - 1].timeMs);
  }
  dv.setUint32(0xb8, indexOffset, true);
  out.set(ascii('SYNT'), 0xf8);
  dv.setUint32(0x1fc, HEADER_SIZE, true);

  let pos = HEADER_SIZE;
  let idx = HEADER_SIZE + payloadTotal;
  for (const p of packets) {
    out.set(ascii(p.tag), pos);
    dv.setUint32(pos + 4, p.payload.length, true);
    dv.setUint32(pos + 8, p.aux ?? 0, true);
    writeSystemTime(dv, pos + 12, p.timeMs);
    out.set(p.payload, pos + PACKET_HEADER_SIZE);

    out.set(ascii(p.tag), idx);
    dv.setUint32(idx + 4, p.payload.length, true);
    dv.setUint32(idx + 8, baseOffset + pos, true); // 파일 절대 오프셋
    idx += INDEX_ENTRY_SIZE;

    pos += PACKET_HEADER_SIZE + p.payload.length;
  }

  return out;
}

export function concatBlocks(blocks: Bytes[]): Bytes {
  const total = blocks.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of blocks) { out.set(b, o); o += b.length; }
  return out;
}

/** GPS 페이로드(96바이트)를 사양대로 만든다. */
export function gpsPayload(opts: {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
  latNmea: number; lonNmea: number; altitude: number; speed: number;
  pdop?: number; hdop?: number; vdop?: number;
}): Bytes {
  const buf = new Uint8Array(96);
  const dv = new DataView(buf.buffer);
  dv.setInt32(0, 1, true);
  dv.setInt32(4, opts.year, true);
  dv.setInt32(8, opts.month, true);
  dv.setInt32(12, opts.day, true);
  dv.setInt32(16, opts.hour, true);
  dv.setInt32(20, opts.minute, true);
  dv.setInt32(24, opts.second, true);
  dv.setFloat64(40, opts.pdop ?? 1.5, true);
  dv.setFloat64(48, opts.hdop ?? 0.9, true);
  dv.setFloat64(56, opts.vdop ?? 1.1, true);
  dv.setFloat64(64, opts.latNmea, true);
  dv.setFloat64(72, opts.lonNmea, true);
  dv.setFloat64(80, opts.altitude, true);
  dv.setFloat64(88, opts.speed, true);
  return buf;
}

export function gsensorPayload(x: number, y: number, z: number): Bytes {
  const buf = new Uint8Array(12);
  const dv = new DataView(buf.buffer);
  dv.setInt32(0, x, true);
  dv.setInt32(4, y, true);
  dv.setInt32(8, z, true);
  return buf;
}

/** 8kHz 16-bit mono 사인파 PCM */
export function pcmTone(samples: number, startSample: number, freq = 440): Bytes {
  const buf = new Uint8Array(samples * 2);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * (startSample + i)) / 8000) * 12000);
    dv.setInt16(i * 2, v, true);
  }
  return buf;
}

/**
 * 차 안 소리를 흉내낸 PCM.
 *
 * 노면·엔진(저역이 강한 잡음)에 목소리(하모닉 + 초당 4음절 포락선)를 얹는다.
 * `voiceFrom`~`voiceTo` 초 구간에만 목소리가 들어간다.
 */
export function pcmCabin(
  samples: number, startSample: number,
  opts: { noise?: number; voice?: number; voiceFrom?: number; voiceTo?: number } = {},
): Bytes {
  const { noise = 0.08, voice = 0.5, voiceFrom = -1, voiceTo = -1 } = opts;
  const buf = new Uint8Array(samples * 2);
  const dv = new DataView(buf.buffer);
  let lp = 0;
  let seed = (startSample * 2654435761) >>> 0 || 1;
  for (let i = 0; i < samples; i++) {
    const t = (startSample + i) / 8000;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const white = seed / 0x3fffffff - 1;
    lp = lp * 0.92 + white * 0.08;
    let v = (lp * 3 + white * 0.25) * noise;

    if (t >= voiceFrom && t < voiceTo) {
      let h = 0;
      for (let k = 1; k <= 8 && 150 * k <= 3600; k++) h += Math.sin(2 * Math.PI * 150 * k * t) / k;
      v += h * Math.max(0, Math.sin(2 * Math.PI * 4 * t)) * voice;
    }
    dv.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, v)) * 24000), true);
  }
  return buf;
}
