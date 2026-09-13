/// <reference lib="webworker" />
/** 폴더 전체 GPS·G센서 스캔 워커. 재생을 막지 않기 위해 분리했다. */
import { BlobByteSource } from '../core/byte-source';
import { scanSegments, type ScanChunk } from '../core/scan';
import type { SegmentInfo } from '../core/segment';

export interface ScanRequest {
  type: 'scan';
  items: { seg: SegmentInfo; file: File }[];
}
export type ScanResponse =
  | { type: 'chunk'; chunk: ScanChunk }
  | { type: 'done' }
  | { type: 'error'; message: string };

self.onmessage = async (ev: MessageEvent<ScanRequest>) => {
  if (ev.data.type !== 'scan') return;
  const post = (m: ScanResponse, t?: Transferable[]) =>
    (self as unknown as Worker).postMessage(m, t ?? []);
  try {
    await scanSegments(
      ev.data.items.map(({ seg, file }) => ({ seg, src: new BlobByteSource(file, seg.name) })),
      (chunk) => post({ type: 'chunk', chunk }, [
        chunk.sensorTime.buffer, chunk.sensorX.buffer, chunk.sensorY.buffer, chunk.sensorZ.buffer,
      ]),
    );
    post({ type: 'done' });
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
