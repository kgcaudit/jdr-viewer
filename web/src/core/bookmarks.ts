/**
 * 즐겨찾기.
 *
 * "이 구간 다시 봐야 함"을 남겨 두고 나중에 한 번에 돌아오기 위한 것이다.
 * 증거 추적성 원칙상 **절대 시각만으로는 부족하다** — 폴더 구성이 바뀌어도
 * 되짚을 수 있도록 어느 파일의 몇 초인지를 함께 적는다.
 *
 * 저장은 두 겹이다.
 *  - IndexedDB: 이 브라우저에서 자동으로 남는다
 *  - jdr-bookmarks.json: 기기·브라우저를 넘긴다 (인덱스 파일과 같은 방식)
 *
 * 브라우저는 폴더에 직접 쓸 수 없으므로 파일 저장은 다운로드다.
 */

const DB_NAME = 'jdr-viewer-bookmarks';
const DB_VERSION = 1;
const STORE = 'marks';

export const BOOKMARK_FILE_NAME = 'jdr-bookmarks.json';
export const BOOKMARK_FORMAT = 'jdr-viewer-bookmarks';
export const BOOKMARK_VERSION = 1;

/** 이 시각 차이 안이면 "같은 지점"으로 본다 (별이 채워지는 범위) */
export const BOOKMARK_NEAR_MS = 2000;

export interface Bookmark {
  /** 파일 경로 + 파일 안 위치. 같은 지점을 두 번 담지 않도록 이걸 키로 쓴다. */
  id: string;
  /** 절대 벽시계 시각(ms) — 이동은 이 값으로 한다 */
  absMs: number;
  /** 'YYYY-MM-DD'. 파일 하나만 연 모드면 빈 문자열. */
  dayKey: string;
  /** 구간 파일 경로 (폴더 기준 상대) */
  path: string;
  name: string;
  /** 그 파일 안에서의 위치(ms) */
  relMs: number;
  label: string;
  createdAt: number;
}

export function bookmarkId(path: string, relMs: number): string {
  // 1초로 뭉뚱그린다. 같은 장면을 두 번 누르면 같은 항목이어야 한다.
  return `${path}@${Math.round(relMs / 1000)}`;
}

/** 기본 이름 — 사용자가 따로 적지 않으면 이게 남는다 */
export function defaultLabel(absMs: number): string {
  const d = new Date(absMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 시각 순으로 세운다 (목록·파일 모두 이 순서) */
export function sortBookmarks(list: Bookmark[]): Bookmark[] {
  return [...list].sort((a, b) => a.absMs - b.absMs || a.path.localeCompare(b.path));
}

/** 지금 위치가 어느 즐겨찾기 위인지 */
export function bookmarkAt(list: Bookmark[], path: string, relMs: number): Bookmark | null {
  let best: Bookmark | null = null;
  let bestGap = BOOKMARK_NEAR_MS;
  for (const b of list) {
    if (b.path !== path) continue;
    const gap = Math.abs(b.relMs - relMs);
    if (gap <= bestGap) { bestGap = gap; best = b; }
  }
  return best;
}

// ── 파일 ────────────────────────────────────────────

export interface BookmarkFile {
  format: string;
  version: number;
  generatedAt: string;
  note: string;
  count: number;
  marks: Bookmark[];
}

export class BookmarkFileError extends Error {}

export function serializeBookmarks(list: Bookmark[]): string {
  const file: BookmarkFile = {
    format: BOOKMARK_FORMAT,
    version: BOOKMARK_VERSION,
    generatedAt: new Date().toISOString(),
    note: 'JDR Viewer 즐겨찾기입니다. 불러오기로 되살릴 수 있습니다. 원본 JDR은 건드리지 않습니다.',
    count: list.length,
    marks: sortBookmarks(list),
  };
  return JSON.stringify(file, null, 2) + '\n';
}

export function parseBookmarks(text: string): Bookmark[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BookmarkFileError('즐겨찾기 파일이 올바른 JSON이 아닙니다');
  }
  const obj = raw as Partial<BookmarkFile>;
  if (obj.format !== BOOKMARK_FORMAT) throw new BookmarkFileError('JDR Viewer 즐겨찾기 파일이 아닙니다');
  if (typeof obj.version !== 'number' || obj.version > BOOKMARK_VERSION) {
    throw new BookmarkFileError(`지원하지 않는 즐겨찾기 버전입니다 (${String(obj.version)})`);
  }
  if (!Array.isArray(obj.marks)) throw new BookmarkFileError('즐겨찾기 파일에 marks가 없습니다');

  const out: Bookmark[] = [];
  for (const m of obj.marks as Partial<Bookmark>[]) {
    if (!m || typeof m.path !== 'string' || !Number.isFinite(m.absMs)) continue;
    const relMs = Number(m.relMs) || 0;
    out.push({
      id: typeof m.id === 'string' && m.id ? m.id : bookmarkId(m.path, relMs),
      absMs: Number(m.absMs),
      dayKey: typeof m.dayKey === 'string' ? m.dayKey : '',
      path: m.path,
      name: typeof m.name === 'string' && m.name ? m.name : m.path.split('/').pop() || m.path,
      relMs,
      label: typeof m.label === 'string' && m.label ? m.label : defaultLabel(Number(m.absMs)),
      createdAt: Number(m.createdAt) || Date.now(),
    });
  }
  return sortBookmarks(out);
}

/** 불러온 것과 이미 있는 것을 합친다. 같은 지점은 **원래 이름을 지킨다.** */
export function mergeBookmarks(current: Bookmark[], incoming: Bookmark[]): { list: Bookmark[]; added: number } {
  const byId = new Map(current.map((b) => [b.id, b]));
  let added = 0;
  for (const b of incoming) {
    if (byId.has(b.id)) continue;
    byId.set(b.id, b);
    added++;
  }
  return { list: sortBookmarks([...byId.values()]), added };
}

// ── 브라우저 저장 ────────────────────────────────────

export class BookmarkStore {
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
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('blocked'));
      });
      return this.db;
    } catch {
      // file:// 이나 시크릿 모드에서는 못 쓸 수 있다. 그때는 파일 저장만으로 버틴다.
      this.unavailable = true;
      return null;
    }
  }

  /** 브라우저 저장을 쓸 수 있는지 — 못 쓰면 화면에서 파일 저장을 권한다 */
  get persistent(): boolean {
    return !this.unavailable;
  }

  async all(): Promise<Bookmark[]> {
    const db = await this.open();
    if (!db) return [];
    try {
      const rows = await new Promise<Bookmark[]>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve((req.result ?? []) as Bookmark[]);
        req.onerror = () => reject(req.error);
      });
      return sortBookmarks(rows);
    } catch {
      return [];
    }
  }

  async put(list: Bookmark[]): Promise<void> {
    const db = await this.open();
    if (!db || list.length === 0) return;
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        for (const b of list) store.put(b);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch {
      /* 저장 실패해도 이번 세션은 정상 동작한다 */
    }
  }

  async remove(id: string): Promise<void> {
    const db = await this.open();
    if (!db) return;
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch {
      /* 지우기 실패는 다음 열기에서 다시 보인다 */
    }
  }
}
