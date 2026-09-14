/**
 * 프로브 결과 캐시 (IndexedDB).
 *
 * 헤더 512바이트라 해도 파일 수백 개면 모바일에서 수십 초가 될 수 있다.
 * 같은 폴더를 다시 열 때는 건너뛴다.
 *
 * 키는 파일명+크기+수정시각이라, 파일이 바뀌면 자동으로 다시 읽는다.
 * IndexedDB를 못 쓰는 환경(file://, 시크릿 모드)에서도 조용히 동작해야 한다.
 */
import type { SegmentInfo, TimeSource } from './segment';

const DB_NAME = 'jdr-viewer';
/** 3: 시작 시각 계산이 바뀌어 예전 캐시는 버린다 */
// 4: 블록 체인 되찾기 / 5: 종료 시각을 패킷 기준으로
// 예전 값에는 잘린 길이와 부풀려진 길이가 굳어 있으므로 통째로 버린다
const DB_VERSION = 5;
const STORE = 'probes';

/** 캐시에 담는 값 — 경로/폴더처럼 열 때마다 달라지는 건 넣지 않는다 */
export interface ProbeCacheValue {
  key: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  packetCount: number;
  ch0Count: number;
  ch1Count: number;
  gpsCount: number;
  sensorCount: number;
  blockOffsets: number[];
  timeSource: TimeSource;
  endEstimated: boolean;
  headerShiftMs: number;
  coveredBytes?: number;
  error?: string;
}

export function cacheKeyOf(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

export function toCacheValue(key: string, seg: SegmentInfo): ProbeCacheValue {
  return {
    key,
    startMs: seg.startMs, endMs: seg.endMs, durationMs: seg.durationMs,
    packetCount: seg.packetCount, ch0Count: seg.ch0Count, ch1Count: seg.ch1Count,
    gpsCount: seg.gpsCount, sensorCount: seg.sensorCount,
    blockOffsets: seg.blockOffsets, timeSource: seg.timeSource,
    endEstimated: seg.endEstimated, headerShiftMs: seg.headerShiftMs,
    coveredBytes: seg.coveredBytes, error: seg.error,
  };
}

export function fromCacheValue(
  v: ProbeCacheValue,
  meta: { name: string; path: string; folder: string; size: number },
): SegmentInfo {
  return {
    id: meta.path || meta.name,
    name: meta.name, path: meta.path, folder: meta.folder, size: meta.size,
    startMs: v.startMs, endMs: v.endMs, durationMs: v.durationMs,
    packetCount: v.packetCount, ch0Count: v.ch0Count, ch1Count: v.ch1Count,
    gpsCount: v.gpsCount, sensorCount: v.sensorCount,
    blockOffsets: v.blockOffsets, timeSource: v.timeSource,
    endEstimated: v.endEstimated, headerShiftMs: v.headerShiftMs ?? 0,
    coveredBytes: v.coveredBytes ?? 0, error: v.error,
  };
}

export class ProbeCache {
  private db: IDBDatabase | null = null;
  private unavailable = false;

  private async open(): Promise<IDBDatabase | null> {
    if (this.db) return this.db;
    if (this.unavailable) return null;
    try {
      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          // 계산 방식이 바뀌면 예전 값을 그대로 쓸 수 없으므로 통째로 다시 만든다
          if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
          db.createObjectStore(STORE, { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('blocked'));
      });
      return this.db;
    } catch {
      // file:// 이나 시크릿 모드에서는 못 쓸 수 있다. 캐시 없이 동작하면 된다.
      this.unavailable = true;
      return null;
    }
  }

  async getMany(keys: string[]): Promise<Map<string, ProbeCacheValue>> {
    const out = new Map<string, ProbeCacheValue>();
    const db = await this.open();
    if (!db || keys.length === 0) return out;
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        for (const key of keys) {
          const req = store.get(key);
          req.onsuccess = () => {
            if (req.result) out.set(key, req.result as ProbeCacheValue);
          };
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch {
      /* 캐시 실패는 성능 문제일 뿐이다 */
    }
    return out;
  }

  async putMany(values: ProbeCacheValue[]): Promise<void> {
    const db = await this.open();
    if (!db || values.length === 0) return;
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        for (const v of values) store.put(v);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch {
      /* 저장 실패해도 이번 세션은 정상 동작한다 */
    }
  }
}
