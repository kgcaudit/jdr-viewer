/**
 * 세그먼트 지연 로더 + LRU.
 *
 * 패킷 테이블은 패킷당 24바이트다. 1시간짜리 파일이면 10MB 남짓이라
 * 수십 개를 전부 들고 있으면 수백 MB가 된다. 현재 + 앞뒤 정도만 남긴다.
 *
 * 폴더 모드에서는 SHA-256을 계산하지 않는다(파일 전체를 읽어야 해서 가장 비싸다).
 * 필요할 때 따로 계산한다. 블록 오프셋은 프로브 때 이미 구해 두었으므로
 * magic 스캔도 건너뛴다.
 */
import { BlobByteSource } from '../core/byte-source';
import { parseJdr } from '../core/parser';
import type { SegmentInfo } from '../core/segment';
import type { LoadedSegment, SegmentLoader } from './sequence';

export class FileSegmentLoader implements SegmentLoader {
  private cache = new Map<string, LoadedSegment>();
  private inflight = new Map<string, Promise<LoadedSegment>>();

  constructor(
    private readonly files: Map<string, File>,
    private readonly maxEntries = 3,
    /** 단일 파일 모드에서는 증거용 해시를 계산한다. 폴더 모드에서는 너무 비싸서 끈다. */
    private readonly withHash = false,
  ) {}

  async load(seg: SegmentInfo): Promise<LoadedSegment> {
    const hit = this.cache.get(seg.id);
    if (hit) {
      // LRU: 최근 사용을 뒤로 보낸다
      this.cache.delete(seg.id);
      this.cache.set(seg.id, hit);
      return hit;
    }
    const running = this.inflight.get(seg.id);
    if (running) return running;

    const file = this.files.get(seg.id);
    if (!file) throw new Error(`파일을 찾을 수 없습니다: ${seg.path}`);

    const job = (async () => {
      const src = new BlobByteSource(file, seg.name);
      const doc = await parseJdr(src, undefined, {
        hash: this.withHash,
        blockOffsets: seg.blockOffsets.length > 0 ? seg.blockOffsets : undefined,
      });
      const loaded: LoadedSegment = { doc, src };
      this.cache.set(seg.id, loaded);
      while (this.cache.size > this.maxEntries) {
        const oldest = this.cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      return loaded;
    })();

    this.inflight.set(seg.id, job);
    try {
      return await job;
    } finally {
      this.inflight.delete(seg.id);
    }
  }

  /** 이미 파싱해 둔 결과를 캐시에 넣는다 (단일 파일 모드에서 두 번 읽지 않기 위함) */
  prime(id: string, doc: import('../core/types').JdrDocument, src: import('../core/byte-source').ByteSource): void {
    this.cache.set(id, { doc, src });
  }

  clear(): void {
    this.cache.clear();
  }
}
