/**
 * 파싱 실행 창구.
 *
 * 기본은 Web Worker다. 단일 HTML을 `file://`로 직접 열면 브라우저가 워커 생성을
 * 막는 경우가 있어, 그때는 메인 스레드에서 그대로 파싱한다.
 * (느리지만 "아무것도 안 되는" 것보다 낫다. 파일 읽기가 전부 async라 진행률은 계속 갱신된다.)
 */
import ParseWorker from './worker/parse.worker?worker&inline';
import { BlobByteSource } from './core/byte-source';
import { JdrParseError, parseJdr } from './core/parser';
import type { JdrDocument, ParseProgress } from './core/types';
import type { WorkerResponse } from './worker/parse.worker';

/** 워커 자체를 쓸 수 없는 환경임을 알리는 내부 신호 */
class WorkerUnavailable extends Error {}

const PROGRESS_INTERVAL_MS = 60;

export class JdrParseJob {
  private worker: Worker | null = null;
  private cancelled = false;

  cancel(): void {
    this.cancelled = true;
    this.worker?.terminate();
    this.worker = null;
  }

  async run(
    file: File,
    onProgress: (p: ParseProgress) => void,
    onFallback: () => void,
  ): Promise<JdrDocument> {
    try {
      return await this.runInWorker(file, onProgress);
    } catch (err) {
      if (!(err instanceof WorkerUnavailable) || this.cancelled) throw err;
      onFallback();
      return parseJdr(new BlobByteSource(file, file.name), throttle(onProgress));
    }
  }

  private runInWorker(file: File, onProgress: (p: ParseProgress) => void): Promise<JdrDocument> {
    return new Promise<JdrDocument>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new ParseWorker();
      } catch (e) {
        reject(new WorkerUnavailable(String(e)));
        return;
      }
      this.worker = worker;
      /** 첫 응답이 오기 전에 죽으면 워커를 쓸 수 없는 환경으로 본다 */
      let responded = false;

      worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        responded = true;
        const msg = ev.data;
        if (msg.type === 'progress') {
          onProgress(msg.progress);
        } else if (msg.type === 'error') {
          worker.terminate();
          this.worker = null;
          reject(msg.recoverable ? new JdrParseError(msg.message) : new Error(msg.message));
        } else {
          worker.terminate();
          this.worker = null;
          resolve(msg.doc);
        }
      };
      worker.onerror = (e) => {
        worker.terminate();
        this.worker = null;
        reject(
          responded
            ? new Error(`파싱 워커 오류: ${e.message}`)
            : new WorkerUnavailable(e.message || 'worker 생성 실패'),
        );
      };

      worker.postMessage({ type: 'parse', file });
    });
  }
}

function throttle(fn: (p: ParseProgress) => void): (p: ParseProgress) => void {
  let last = 0;
  return (p) => {
    const now = performance.now();
    if (p.phase !== 'analyze' && now - last < PROGRESS_INTERVAL_MS) return;
    last = now;
    fn(p);
  };
}
