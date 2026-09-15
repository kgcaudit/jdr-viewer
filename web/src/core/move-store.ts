/**
 * 이동기록(휴대폰 GPS) 저장소.
 *
 * 블랙박스와 달리 이동기록은 **업로드한 콘텐츠**라 디스크에서 다시 고를 수 없다.
 * 그래서 파싱한 좌표를 **날짜별로 IndexedDB에 직접 저장**하고, 다음에 올리는
 * 기록과 **병합**한다. 도와줘가 하루 2,000건까지만 주므로, 바쁜 날은 여러 번
 * 올려 채운다 — 같은 시각(ms) 점은 하나로 합쳐 중복을 막는다.
 *
 * 인덱스 증분 로딩: 진입 때 날짜 목록만 읽고, 새 업로드분만 병합해 추가한다.
 *
 * 개인정보: 실제 위치다. 이 저장소는 사용자의 브라우저 안에만 있고, 밖으로
 * 나가지 않는다. 파일 내보내기로만 옮긴다.
 */
import { formatRecordedTime } from './time';
import { isValidLatLon, type PhoneFix } from './phone-track';

/** 저장용 압축 점 — 대조·표시에 필요한 최소 필드만 */
export interface MovePoint {
  /** 벽시계 ms (차량 GPS와 같은 기준) */
  t: number;
  lat: number;
  lon: number;
  /** 원본 속도(표시용) */
  speed: number;
  /** 정확도(m) */
  acc: number;
  /** OS 활동유형 */
  act: string;
  /** 주소 라벨 (체류 지점 표기용). 옛 저장분엔 없을 수 있다. */
  addr?: string;
  /** 그 지점의 체류시간(ms) — 원본 staytime. 체류 도출의 근거. 옛 저장분엔 없다. */
  stay?: number;
}

/** 하루치 이동기록 (병합된 결과) */
export interface MoveDay {
  dayKey: string;
  points: MovePoint[];
  updatedAt: number;
  /** 이 날짜에 병합된 업로드 파일 이름들 (증빙 추적성) */
  sources: string[];
}

/** 목록에 쓰는 요약 (점 배열 없이 가볍게) */
export interface MoveDaySummary {
  dayKey: string;
  count: number;
  startMs: number;
  endMs: number;
  updatedAt: number;
  sources: string[];
}

export function toMovePoint(f: PhoneFix): MovePoint {
  const p: MovePoint = { t: f.timeMs, lat: f.lat, lon: f.lon, speed: f.rawSpeed, acc: f.accuracyM, act: f.activity };
  if (f.address) p.addr = f.address;
  if (f.stayMs) p.stay = f.stayMs;
  return p;
}

export function movePointToFix(p: MovePoint): PhoneFix {
  return {
    timeMs: p.t, lat: p.lat, lon: p.lon, rawSpeed: p.speed, accuracyM: p.acc,
    activity: p.act, stayMs: p.stay ?? 0, provider: '', battery: 0, address: p.addr ?? '',
  };
}

/** 벽시계 ms → 'YYYY-MM-DD' (timeMs가 Date.UTC 기준이므로 UTC로 자른다) */
export function dayKeyOf(timeMs: number): string {
  return formatRecordedTime(timeMs, false).slice(0, 10);
}

/** PhoneFix들을 날짜별로 가른다 */
export function splitByDay(fixes: PhoneFix[]): Map<string, MovePoint[]> {
  const out = new Map<string, MovePoint[]>();
  for (const f of fixes) {
    if (!Number.isFinite(f.timeMs) || !isValidLatLon(f.lat, f.lon)) continue;
    const key = dayKeyOf(f.timeMs);
    let arr = out.get(key);
    if (!arr) { arr = []; out.set(key, arr); }
    arr.push(toMovePoint(f));
  }
  return out;
}

/**
 * 기존 하루 점들과 새 점들을 병합한다.
 *
 * 같은 시각(ms)은 하나로 — 먼저 있던 것을 지킨다(안정적). 새 시각만 채워지므로
 * 2,000건 상한으로 잘렸던 하루가 여러 업로드로 완성된다. 시각 순으로 세운다.
 */
export function mergePoints(existing: MovePoint[], incoming: MovePoint[]): { points: MovePoint[]; added: number } {
  const byT = new Map<number, MovePoint>();
  for (const p of existing) byT.set(p.t, p);
  let added = 0;
  for (const p of incoming) {
    if (byT.has(p.t)) continue;
    byT.set(p.t, p);
    added++;
  }
  const points = [...byT.values()].sort((a, b) => a.t - b.t);
  return { points, added };
}

export function summarize(day: MoveDay): MoveDaySummary {
  return {
    dayKey: day.dayKey,
    count: day.points.length,
    startMs: day.points.length ? day.points[0].t : NaN,
    endMs: day.points.length ? day.points[day.points.length - 1].t : NaN,
    updatedAt: day.updatedAt,
    sources: day.sources,
  };
}

// ── 파일 내보내기/불러오기 (기기 간 이동) ───────────────────

export const MOVE_FILE_NAME = 'jdr-movement.json';
export const MOVE_FORMAT = 'jdr-viewer-movement';
export const MOVE_VERSION = 1;

export interface MoveFile {
  format: string;
  version: number;
  generatedAt: string;
  note: string;
  days: MoveDay[];
}

export class MoveFileError extends Error {}

export function serializeMoveDays(days: MoveDay[]): string {
  const file: MoveFile = {
    format: MOVE_FORMAT,
    version: MOVE_VERSION,
    generatedAt: new Date().toISOString(),
    note: 'Movement Analysis System 이동기록입니다. 불러오기로 되살릴 수 있습니다. 원본은 건드리지 않습니다.',
    days,
  };
  return JSON.stringify(file) + '\n';
}

export function parseMoveFile(text: string): MoveDay[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new MoveFileError('이동기록 파일이 올바른 JSON이 아닙니다'); }
  const obj = raw as Partial<MoveFile>;
  if (obj.format !== MOVE_FORMAT) throw new MoveFileError('Movement Analysis System 이동기록 파일이 아닙니다');
  if (typeof obj.version !== 'number' || obj.version > MOVE_VERSION) {
    throw new MoveFileError(`지원하지 않는 이동기록 버전입니다 (${String(obj.version)})`);
  }
  if (!Array.isArray(obj.days)) throw new MoveFileError('이동기록 파일에 days가 없습니다');
  return obj.days.filter((d): d is MoveDay => !!d && typeof d.dayKey === 'string' && Array.isArray(d.points));
}

// ── IndexedDB 저장소 ────────────────────────────────

const DB_NAME = 'jdr-viewer-movement';
const DB_VERSION = 1;
const STORE = 'days';

export class MoveStore {
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
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'dayKey' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('blocked'));
      });
      return this.db;
    } catch {
      this.unavailable = true;
      return null;
    }
  }

  get persistent(): boolean { return !this.unavailable; }

  /** 날짜 목록(요약)만 — 점 배열까지 다 읽지 않게 가볍게 */
  async listDays(): Promise<MoveDaySummary[]> {
    const db = await this.open();
    if (!db) return [];
    try {
      const rows = await new Promise<MoveDay[]>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve((req.result ?? []) as MoveDay[]);
        req.onerror = () => reject(req.error);
      });
      return rows.map(summarize).sort((a, b) => a.dayKey.localeCompare(b.dayKey));
    } catch {
      return [];
    }
  }

  async getDay(dayKey: string): Promise<MoveDay | null> {
    const db = await this.open();
    if (!db) return null;
    try {
      return await new Promise<MoveDay | null>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(dayKey);
        req.onsuccess = () => resolve((req.result as MoveDay) ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  private async putDay(day: MoveDay): Promise<void> {
    const db = await this.open();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(day);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /**
   * 업로드한 점들을 날짜별로 갈라 기존 저장분과 병합한다.
   * @returns 날짜별 추가 개수
   */
  async mergeUpload(fixes: PhoneFix[], source: string): Promise<{ dayKey: string; added: number; total: number }[]> {
    const byDay = splitByDay(fixes);
    const result: { dayKey: string; added: number; total: number }[] = [];
    for (const [dayKey, incoming] of byDay) {
      const prev = (await this.getDay(dayKey)) ?? { dayKey, points: [], updatedAt: 0, sources: [] };
      const { points, added } = mergePoints(prev.points, incoming);
      const sources = source && !prev.sources.includes(source) ? [...prev.sources, source] : prev.sources;
      await this.putDay({ dayKey, points, updatedAt: Date.now(), sources });
      result.push({ dayKey, added, total: points.length });
    }
    return result.sort((a, b) => a.dayKey.localeCompare(b.dayKey));
  }

  /** 파일에서 불러온 하루들을 병합한다 */
  async mergeDays(days: MoveDay[]): Promise<number> {
    let total = 0;
    for (const d of days) {
      const prev = (await this.getDay(d.dayKey)) ?? { dayKey: d.dayKey, points: [], updatedAt: 0, sources: [] };
      const { points, added } = mergePoints(prev.points, d.points);
      const sources = [...new Set([...prev.sources, ...d.sources])];
      await this.putDay({ dayKey: d.dayKey, points, updatedAt: Date.now(), sources });
      total += added;
    }
    return total;
  }

  /** 모든 날짜를 한 번에 비운다 (전체 삭제) */
  async clearAll(): Promise<void> {
    const db = await this.open();
    if (!db) return;
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch { /* 다음 진입에서 다시 보인다 */ }
  }

  async removeDay(dayKey: string): Promise<void> {
    const db = await this.open();
    if (!db) return;
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(dayKey);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch { /* 다음 진입에서 다시 보인다 */ }
  }

  async allDays(): Promise<MoveDay[]> {
    const db = await this.open();
    if (!db) return [];
    try {
      return await new Promise<MoveDay[]>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve((req.result ?? []) as MoveDay[]);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return [];
    }
  }
}
