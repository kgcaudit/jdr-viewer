/**
 * 차량 GPS 트랙 저장소 (날짜별).
 *
 * 블랙박스 원본은 불변이고, 재생/스캔 때 뷰어가 그날 차량 GPS를
 * `session.records.gps`로 모은다. 그 값을 **날짜별로 영구 저장**해 두면,
 * 이동기록 공간(재생과 분리)에서 재생 없이도 그날 차량 트랙을 꺼내 대조할 수 있다.
 *
 * 같은 파일을 다시 스캔해도 같은 시각 점은 하나로 병합되므로, 여러 운행을
 * 열어 볼수록 그날 트랙이 채워진다.
 *
 * 개인정보 성격은 아니지만(내 차량 경로) 저장 위치는 브라우저 안이다.
 *
 * 또한 뷰어에서 뽑아 둔 **차량 GPS CSV를 직접 불러와** 저장할 수도 있다
 * (무거운 JDR 을 다시 열지 않고 대조하려는 용도). parseCarCsv 참고.
 */
import { parsePhoneTime, isValidLatLon } from './phone-track';
import { formatRecordedTime } from './time';

/** 저장용 차량 점 — 대조엔 시각·좌표만 필요하다 */
export interface CarPoint {
  t: number;
  lat: number;
  lon: number;
}

export class CarCsvError extends Error {}

/**
 * 블랙박스에서 뽑은 차량 GPS CSV 를 날짜별 CarPoint 로 파싱한다.
 *
 * 뷰어가 내보내는 열: packet_time, gps_time, source_file, pdop, hdop, vdop,
 * latitude_nmea, longitude_nmea, **latitude_deg, longitude_deg**, altitude_m, speed_kmh.
 * 시각은 packet_time(기기 벽시계)을 쓰고, 위성 미수신(0,0)·범위 밖은 버린다.
 * 하루를 넘길 수 있어 날짜별로 가른다(휴대폰 기록과 같은 벽시계 기준).
 */
export function parseCarCsv(text: string): Map<string, CarPoint[]> {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) throw new CarCsvError('차량 GPS CSV 가 비어 있습니다');
  const head = lines[0].replace(/^﻿/, '').split(',').map((s) => s.trim().toLowerCase());
  const iT = head.indexOf('packet_time');
  const iLa = head.indexOf('latitude_deg');
  const iLo = head.indexOf('longitude_deg');
  if (iT < 0 || iLa < 0 || iLo < 0) {
    throw new CarCsvError('차량 GPS CSV 형식이 아닙니다 (packet_time·latitude_deg·longitude_deg 열이 필요합니다)');
  }
  const need = Math.max(iT, iLa, iLo);
  const out = new Map<string, CarPoint[]>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = line.split(',');
    if (c.length <= need) continue;
    const lat = Number(c[iLa]);
    const lon = Number(c[iLo]);
    if (!isValidLatLon(lat, lon)) continue; // 0,0 미수신·범위 밖 제외
    const t = parsePhoneTime(c[iT]);
    if (!Number.isFinite(t)) continue;
    const key = formatRecordedTime(t, false).slice(0, 10);
    let arr = out.get(key);
    if (!arr) { arr = []; out.set(key, arr); }
    arr.push({ t, lat, lon });
  }
  if (out.size === 0) throw new CarCsvError('CSV 에서 유효한 차량 좌표를 찾지 못했습니다');
  return out;
}

/** 초 단위로 뭉갠 키 (차량 GPS는 대략 1Hz라 초로 병합하면 자연히 하루 상한이 생긴다) */
function keyOf(t: number): number {
  return Math.round(t / 1000);
}

/** 기존·신규 차량 점을 병합한다 (같은 초는 하나로, 시각 순) */
export function mergeCarPoints(existing: CarPoint[], incoming: CarPoint[]): CarPoint[] {
  const bySec = new Map<number, CarPoint>();
  for (const p of existing) bySec.set(keyOf(p.t), p);
  for (const p of incoming) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    if (p.lat === 0 && p.lon === 0) continue;
    const k = keyOf(p.t);
    if (!bySec.has(k)) bySec.set(k, { t: p.t, lat: p.lat, lon: p.lon });
  }
  return [...bySec.values()].sort((a, b) => a.t - b.t);
}

export interface CarDaySummary {
  dayKey: string;
  count: number;
  updatedAt: number;
}

interface CarDayDoc {
  dayKey: string;
  points: CarPoint[];
  updatedAt: number;
}

const DB_NAME = 'jdr-viewer-cartrack';
const DB_VERSION = 1;
const STORE = 'days';

export class CarTrackStore {
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

  async getDay(dayKey: string): Promise<CarPoint[]> {
    const db = await this.open();
    if (!db) return [];
    try {
      const doc = await new Promise<CarDayDoc | null>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(dayKey);
        req.onsuccess = () => resolve((req.result as CarDayDoc) ?? null);
        req.onerror = () => reject(req.error);
      });
      return doc?.points ?? [];
    } catch {
      return [];
    }
  }

  /** 그날 차량 점을 병합 저장한다. @returns 저장 후 총 개수 (못 쓰면 -1) */
  async putMerge(dayKey: string, incoming: CarPoint[]): Promise<number> {
    if (!dayKey || incoming.length === 0) return -1;
    const db = await this.open();
    if (!db) return -1;
    try {
      const prev = await this.getDay(dayKey);
      const points = mergeCarPoints(prev, incoming);
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ dayKey, points, updatedAt: Date.now() } satisfies CarDayDoc);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      return points.length;
    } catch {
      return -1;
    }
  }

  async listDays(): Promise<CarDaySummary[]> {
    const db = await this.open();
    if (!db) return [];
    try {
      const rows = await new Promise<CarDayDoc[]>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve((req.result ?? []) as CarDayDoc[]);
        req.onerror = () => reject(req.error);
      });
      return rows.map((d) => ({ dayKey: d.dayKey, count: d.points.length, updatedAt: d.updatedAt }));
    } catch {
      return [];
    }
  }
}
