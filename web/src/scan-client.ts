/**
 * 전 구간 GPS·G센서 백그라운드 스캔 (D4).
 * 워커를 쓰되, file://처럼 워커를 못 만드는 환경에서는 메인 스레드로 돌린다.
 */
import ScanWorker from './worker/scan.worker?worker&inline';
import { BlobByteSource } from './core/byte-source';
import { scanSegments, type ScanChunk } from './core/scan';
import type { SegmentInfo } from './core/segment';
import type { ScanRequest, ScanResponse } from './worker/scan.worker';

export interface ScanItemInput {
  seg: SegmentInfo;
  file: File;
}

export class RecordScanJob {
  private worker: Worker | null = null;
  private stopped = false;

  stop(): void {
    this.stopped = true;
    this.worker?.terminate();
    this.worker = null;
  }

  run(items: ScanItemInput[], onChunk: (c: ScanChunk) => void): Promise<void> {
    return new Promise<void>((resolve) => {
      if (items.length === 0) {
        resolve();
        return;
      }
      let worker: Worker | null = null;
      try {
        worker = new ScanWorker();
      } catch {
        worker = null;
      }

      if (!worker) {
        void this.runInline(items, onChunk).then(resolve);
        return;
      }
      this.worker = worker;
      let responded = false;

      worker.onmessage = (ev: MessageEvent<ScanResponse>) => {
        responded = true;
        if (this.stopped) return;
        const msg = ev.data;
        if (msg.type === 'chunk') onChunk(msg.chunk);
        else {
          worker?.terminate();
          this.worker = null;
          resolve();
        }
      };
      worker.onerror = () => {
        worker?.terminate();
        this.worker = null;
        if (responded || this.stopped) {
          resolve();
        } else {
          // 워커를 쓸 수 없는 환경 → 메인 스레드로
          void this.runInline(items, onChunk).then(resolve);
        }
      };
      worker.postMessage({
        type: 'scan',
        items: items.map(({ seg, file }) => ({ seg, file })),
      } satisfies ScanRequest);
    });
  }

  private async runInline(items: ScanItemInput[], onChunk: (c: ScanChunk) => void): Promise<void> {
    await scanSegments(
      items.map(({ seg, file }) => ({ seg, src: new BlobByteSource(file, seg.name) })),
      (chunk) => { if (!this.stopped) onChunk(chunk); },
      () => this.stopped,
    );
  }
}

/** 스캔 결과를 시간순으로 모으는 누산기 */
export class MergedRecords {
  gps: import('./core/types').GpsFix[] = [];
  private sTime: number[] = [];
  private sX: number[] = [];
  private sY: number[] = [];
  private sZ: number[] = [];
  private dirty = false;

  add(chunk: ScanChunk): void {
    if (chunk.gps.length) {
      this.gps.push(...chunk.gps);
      this.dirty = true;
    }
    for (let i = 0; i < chunk.sensorTime.length; i++) {
      this.sTime.push(chunk.sensorTime[i]);
      this.sX.push(chunk.sensorX[i]);
      this.sY.push(chunk.sensorY[i]);
      this.sZ.push(chunk.sensorZ[i]);
    }
  }

  /** 세그먼트가 시간순이 아닐 수 있으므로(루프 녹화 덮어쓰기) 정렬해서 돌려준다 */
  finish(): void {
    if (this.dirty) {
      this.gps.sort((a, b) => a.timeMs - b.timeMs);
      this.dirty = false;
    }
  }

  get gsensor(): import('./core/types').GsensorSeries {
    const order = this.sTime.map((_, i) => i).sort((a, b) => this.sTime[a] - this.sTime[b]);
    const n = order.length;
    const timeMs = new Float64Array(n);
    const x = new Int32Array(n);
    const y = new Int32Array(n);
    const z = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const j = order[i];
      timeMs[i] = this.sTime[j];
      x[i] = this.sX[j];
      y[i] = this.sY[j];
      z[i] = this.sZ[j];
    }
    return { count: n, timeMs, x, y, z };
  }

  get sensorCount(): number { return this.sTime.length; }
}
