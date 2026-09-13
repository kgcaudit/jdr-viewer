/**
 * 폴더 인덱스 파일.
 *
 * 브라우저 캐시(IndexedDB)만으로는 부족하다.
 *  - 기기·브라우저를 넘지 못한다 (PC에서 만든 걸 폰에서 못 쓴다)
 *  - 브라우저 데이터를 지우면 사라진다
 *  - 단일 HTML 파일을 다른 위치로 옮기면 origin이 달라져 날아간다
 *
 * 그래서 훑은 결과를 **파일로 저장해** 폴더에 함께 두면, 다음에 열 때 그걸 읽고
 * 헤더 훑기를 통째로 건너뛴다. 사람이 열어볼 수 있는 JSON이라
 * "이 폴더에 무엇이 언제 있었는지"의 기록으로도 쓸 수 있다.
 *
 * 브라우저는 폴더에 직접 쓸 수 없으므로 저장은 다운로드로 하고,
 * 사용자가 그 파일을 폴더에 복사해 두면 이후로는 자동으로 인식된다.
 */
import type { SegmentInfo, TimeSource } from './segment';

export const INDEX_FILE_NAME = 'jdr-index.json';
export const INDEX_FORMAT = 'jdr-viewer-index';
/** 2: 종료 시각을 실제 마지막 패킷 기준으로 바로잡음 (v1은 다시 읽는다) */
export const INDEX_VERSION = 2;

/** 행을 배열로 저장한다 — 키 이름이 828번 반복되면 파일이 3배가 된다 */
const FIELDS = [
  'path', 'size', 'mtime', 'start', 'end', 'packets',
  'ch0', 'ch1', 'gps', 'sensor', 'blocks', 'timeSource', 'endEstimated', 'error',
] as const;

type Row = [
  string, number, number, number, number, number,
  number, number, number, number, number[], string, number, string | null,
];

export interface IndexFile {
  format: string;
  version: number;
  generatedAt: string;
  note: string;
  count: number;
  fields: readonly string[];
  rows: Row[];
}

export interface IndexEntry {
  path: string;
  size: number;
  mtime: number;
  seg: Omit<SegmentInfo, 'id' | 'name' | 'path' | 'folder' | 'size'>;
}

export function buildIndexFile(items: { seg: SegmentInfo; file: File }[]): IndexFile {
  const rows: Row[] = items.map(({ seg, file }) => [
    seg.path, seg.size, file.lastModified,
    seg.startMs, seg.endMs, seg.packetCount,
    seg.ch0Count, seg.ch1Count, seg.gpsCount, seg.sensorCount,
    seg.blockOffsets, seg.timeSource, seg.endEstimated ? 1 : 0, seg.error ?? null,
  ]);
  return {
    format: INDEX_FORMAT,
    version: INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    note: 'JDR Viewer가 만든 폴더 인덱스입니다. 이 폴더에 두면 다음에 열 때 헤더 훑기를 건너뜁니다. 원본 JDR은 건드리지 않습니다.',
    count: rows.length,
    fields: FIELDS,
    rows,
  };
}

export function serializeIndexFile(index: IndexFile): string {
  // rows는 한 줄에 하나씩 — 사람이 열어봐도 읽히고, diff도 된다
  const head = JSON.stringify(
    { ...index, rows: '@@ROWS@@' } as unknown as Record<string, unknown>,
    null, 2,
  );
  const body = index.rows.map((r) => '    ' + JSON.stringify(r)).join(',\n');
  return head.replace('"@@ROWS@@"', `[\n${body}\n  ]`) + '\n';
}

export class IndexFileError extends Error {}

/** 파싱 + 최소 검증. 형식이 다르면 조용히 무시하지 말고 이유를 남긴다. */
export function parseIndexFile(text: string): Map<string, IndexEntry> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new IndexFileError('인덱스 파일이 올바른 JSON이 아닙니다');
  }
  const obj = raw as Partial<IndexFile>;
  if (obj.format !== INDEX_FORMAT) {
    throw new IndexFileError('JDR Viewer 인덱스 파일이 아닙니다');
  }
  if (typeof obj.version !== 'number' || obj.version > INDEX_VERSION) {
    throw new IndexFileError(`지원하지 않는 인덱스 버전입니다 (${String(obj.version)})`);
  }
  if (obj.version < INDEX_VERSION) {
    throw new IndexFileError(
      `인덱스 형식이 갱신되었습니다 (v${obj.version} → v${INDEX_VERSION}). 다시 읽은 뒤 저장해 주세요`,
    );
  }
  if (!Array.isArray(obj.rows)) {
    throw new IndexFileError('인덱스 파일에 rows가 없습니다');
  }

  const out = new Map<string, IndexEntry>();
  for (const r of obj.rows as Row[]) {
    if (!Array.isArray(r) || r.length < FIELDS.length || typeof r[0] !== 'string') continue;
    out.set(r[0], {
      path: r[0],
      size: Number(r[1]),
      mtime: Number(r[2]),
      seg: {
        startMs: Number(r[3]), endMs: Number(r[4]),
        durationMs: Math.max(0, Number(r[4]) - Number(r[3])),
        packetCount: Number(r[5]),
        ch0Count: Number(r[6]), ch1Count: Number(r[7]),
        gpsCount: Number(r[8]), sensorCount: Number(r[9]),
        blockOffsets: Array.isArray(r[10]) ? r[10].map(Number) : [],
        timeSource: (r[11] as TimeSource) ?? 'unknown',
        endEstimated: r[12] === 1,
        error: r[13] ?? undefined,
      },
    });
  }
  return out;
}

/**
 * 인덱스 항목이 지금 이 파일과 같은 것인지 확인한다.
 * 크기나 수정 시각이 다르면 파일이 바뀐 것이므로 쓰지 않는다.
 */
export function indexMatches(entry: IndexEntry, file: File): boolean {
  return entry.size === file.size && entry.mtime === file.lastModified;
}

export function entryToSegment(
  entry: IndexEntry,
  meta: { name: string; path: string; folder: string; size: number },
): SegmentInfo {
  return { id: meta.path || meta.name, name: meta.name, path: meta.path, folder: meta.folder, size: meta.size, ...entry.seg };
}

/** 폴더에서 인덱스 파일을 찾는다 (하위 폴더 어디에 있어도 된다) */
export function findIndexFile(files: File[]): File | null {
  const matches = files.filter((f) => f.name.toLowerCase() === INDEX_FILE_NAME);
  if (matches.length === 0) return null;
  // 여러 개면 가장 위(경로가 짧은) 것을 쓴다
  return matches.sort((a, b) => {
    const pa = (a as File & { webkitRelativePath?: string }).webkitRelativePath || a.name;
    const pb = (b as File & { webkitRelativePath?: string }).webkitRelativePath || b.name;
    return pa.split('/').length - pb.split('/').length || pa.localeCompare(pb);
  })[0];
}
