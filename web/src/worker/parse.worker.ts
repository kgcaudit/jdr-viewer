/// <reference lib="webworker" />
/**
 * 파싱 전용 워커.
 * 수십만 패킷 파싱이 메인 스레드를 막으면 UI가 얼어붙는다.
 */
import { BlobByteSource } from '../core/byte-source';
import { parseJdr, JdrParseError } from '../core/parser';
import type { JdrDocument, ParseProgress } from '../core/types';

export type WorkerRequest = { type: 'parse'; file: File };
export type WorkerResponse =
  | { type: 'progress'; progress: ParseProgress }
  | { type: 'done'; doc: JdrDocument }
  | { type: 'error'; message: string; recoverable: boolean };

let lastPost = 0;

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  if (ev.data.type !== 'parse') return;
  const file = ev.data.file;
  try {
    const doc = await parseJdr(new BlobByteSource(file, file.name), (progress) => {
      // 진행률을 너무 자주 보내면 그 자체가 병목이 된다
      const now = performance.now();
      if (now - lastPost < 60 && progress.phase !== 'analyze') return;
      lastPost = now;
      (self as unknown as Worker).postMessage({ type: 'progress', progress } satisfies WorkerResponse);
    });

    const p = doc.packets;
    const transfer: Transferable[] = [
      p.blockNo.buffer, p.offset.buffer, p.size.buffer, p.tag.buffer, p.aux.buffer, p.timeMs.buffer,
      doc.gsensor.timeMs.buffer, doc.gsensor.x.buffer, doc.gsensor.y.buffer, doc.gsensor.z.buffer,
    ];
    (self as unknown as Worker).postMessage({ type: 'done', doc } satisfies WorkerResponse, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      recoverable: err instanceof JdrParseError,
    } satisfies WorkerResponse);
  }
};
