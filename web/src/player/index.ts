/** 채널별 프레임 인덱스 — 재생과 시크의 기본 자료구조. */
import { TagKind, tagChannel, tagIsKeyframe, tagKind } from '../core/tags';
import type { JdrDocument } from '../core/types';

export interface FrameIndex {
  /** packets 테이블에서의 인덱스 */
  packetIndex: Int32Array;
  /** 첫 패킷 기준 상대 시각(ms) */
  relMs: Float64Array;
  isKey: Uint8Array;
  /** 키프레임만 모은 목록 (프레임 번호 기준) — 시크에 쓴다 */
  keyFrames: Int32Array;
  count: number;
}

export function buildFrameIndex(doc: JdrDocument, channel: number): FrameIndex {
  const p = doc.packets;
  const idx: number[] = [];
  for (let i = 0; i < p.count; i++) {
    if (tagKind(p.tag[i]) === TagKind.Video && tagChannel(p.tag[i]) === channel) idx.push(i);
  }
  const n = idx.length;
  const packetIndex = Int32Array.from(idx);
  const relMs = new Float64Array(n);
  const isKey = new Uint8Array(n);
  const keys: number[] = [];
  for (let f = 0; f < n; f++) {
    relMs[f] = p.timeMs[packetIndex[f]] - doc.firstTimeMs;
    if (tagIsKeyframe(p.tag[packetIndex[f]])) {
      isKey[f] = 1;
      keys.push(f);
    }
  }
  return { packetIndex, relMs, isKey, keyFrames: Int32Array.from(keys), count: n };
}

/** targetMs 이하인 마지막 키프레임의 프레임 번호. 없으면 0. */
export function keyframeAtOrBefore(index: FrameIndex, targetMs: number): number {
  const keys = index.keyFrames;
  if (keys.length === 0) return 0;
  let lo = 0;
  let hi = keys.length - 1;
  let best = keys[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index.relMs[keys[mid]] <= targetMs) {
      best = keys[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** WebCodecs를 쓸 수 있는 브라우저인가. */
export function hasWebCodecs(): boolean {
  return typeof globalThis.VideoDecoder !== 'undefined' && typeof globalThis.EncodedVideoChunk !== 'undefined';
}
