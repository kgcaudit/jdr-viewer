/** 4바이트 ASCII 태그를 uint32(빅엔디안 패킹)로 다루는 헬퍼. */

export const enum TagKind {
  Video = 0,
  Audio = 1,
  Gps = 2,
  Sensor = 3,
  Other = 4,
}

export function packTag(b0: number, b1: number, b2: number, b3: number): number {
  return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
}

export function tagString(tag: number): string {
  return String.fromCharCode((tag >>> 24) & 0xff, (tag >>> 16) & 0xff, (tag >>> 8) & 0xff, tag & 0xff)
    .replace(/[^\x20-\x7e]/g, '.');
}

export function tagKind(tag: number): TagKind {
  const b0 = (tag >>> 24) & 0xff;
  const b1 = (tag >>> 16) & 0xff;
  const b2 = (tag >>> 8) & 0xff;
  const b3 = tag & 0xff;
  // 영상: "00V?" / "01V?"
  if (b0 === 0x30 && (b1 === 0x30 || b1 === 0x31) && b2 === 0x56) return TagKind.Video;
  // 나머지는 채널 자리를 무시하고 뒤 2바이트로 판별 (원본 Python 도구와 동일)
  if (b2 === 0x41 && b3 === 0x44) return TagKind.Audio; // AD
  if (b2 === 0x47 && b3 === 0x50) return TagKind.Gps; // GP
  if (b2 === 0x53 && b3 === 0x45) return TagKind.Sensor; // SE
  return TagKind.Other;
}

/** 영상 태그의 채널 번호 (0 = 전방, 1 = 후방). 영상이 아니면 -1. */
export function tagChannel(tag: number): number {
  if (tagKind(tag) !== TagKind.Video) return -1;
  return ((tag >>> 16) & 0xff) - 0x30;
}

/** 영상 태그가 I-프레임인가 ("...I"). WebCodecs의 chunk type을 여기서 결정한다. */
export function tagIsKeyframe(tag: number): boolean {
  return (tag & 0xff) === 0x49; // 'I'
}
