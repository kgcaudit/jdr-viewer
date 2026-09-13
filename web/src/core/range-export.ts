/**
 * 시간 구간 내보내기 — 음성(WAV)과 표(CSV).
 *
 * 파일 하나가 50초 남짓이라 **파일 단위 내보내기는 쓸모가 없다.**
 * "07:57:13부터 08:02:13까지"처럼 사람이 말하는 단위로 뽑아야 한다.
 *
 * 영상은 여기가 아니라 `mp4.ts`가 만든다 — 아무 데서나 열리는 MP4여야
 * 쓸모가 있고, 그러려면 그릇을 바꿔야 하기 때문이다.
 *
 * 파일명은 사람이 알아볼 수 있어야 한다. 원본 파일명(00000440.jdr)은
 * 녹화기가 붙인 순번일 뿐이라 언제 찍힌 건지 알 수 없다.
 *   260909_075713-080213_Front.mp4
 */
import type { ByteSource, Bytes } from './byte-source';
import type { SegmentInfo } from './segment';
import type { JdrDocument } from './types';
import { AUDIO_SAMPLE_RATE, GSENSOR_SCALE, PACKET_HEADER_SIZE } from './parser';
import { TagKind, tagKind } from './tags';
import { BlobCollector, wavHeader, yieldToUi } from './export';
import { formatRecordedTime } from './time';

export type RangeKind = 'front' | 'rear' | 'both' | 'audio' | 'gps' | 'sensor';

export const RANGE_LABEL: Record<RangeKind, string> = {
  front: '전방 영상', rear: '후방 영상', both: '전방+후방 한 화면',
  audio: '음성 (원본 그대로)', gps: 'GPS', sensor: 'G센서',
};

/** 이 종류가 영상인가 (MP4로 만든다) */
export function isVideoKind(kind: RangeKind): boolean {
  return kind === 'front' || kind === 'rear' || kind === 'both';
}

/** 파일명에 붙는 이름. 사람이 보고 무엇인지 알 수 있어야 한다. */
const RANGE_SUFFIX: Record<RangeKind, string> = {
  front: 'Front.mp4', rear: 'Rear.mp4', both: 'Both.mp4',
  audio: 'Audio.wav', gps: 'GPS.csv', sensor: 'Sensor.csv',
};

export interface TimeRange {
  fromMs: number;
  toMs: number;
}

/** 구간을 열어 주는 쪽 (재생이 쓰는 로더를 그대로 쓴다) */
export interface RangeLoader {
  load(seg: SegmentInfo): Promise<{ doc: JdrDocument; src: ByteSource }>;
}

export interface RangeResult {
  blob: Blob;
  /**
   * 실제로 담긴 첫 패킷 시각. 영상은 직전 키프레임까지 거슬러 올라가므로
   * 요청한 시작 시각보다 몇 초 이를 수 있다. 화면에 그대로 알린다 —
   * 파일이 요청과 다르다면 그 사실을 숨기면 안 된다.
   */
  actualFromMs: number;
  /** 이 구간에 걸친 원본 파일 수 */
  segmentCount: number;
}

export interface RangeProgress {
  /** 0~1 */
  ratio: number;
  /** 지금 읽고 있는 파일 */
  name: string;
  /** 몇 번째 / 전체 */
  index: number;
  total: number;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** 기록된 벽시계 기준 YYMMDD (표시와 같은 UTC 게터를 쓴다) */
function ymd(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear() % 100)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function hms(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/**
 * `260909_075713-080213_Front.h264`
 * 날짜가 바뀌면 끝에도 날짜를 붙인다 — `260909_235000-260910_001200_Front.h264`
 */
export function rangeFileName(range: TimeRange, kind: RangeKind): string {
  const start = `${ymd(range.fromMs)}_${hms(range.fromMs)}`;
  const end = ymd(range.toMs) === ymd(range.fromMs)
    ? hms(range.toMs)
    : `${ymd(range.toMs)}_${hms(range.toMs)}`;
  return `${start}-${end}_${RANGE_SUFFIX[kind]}`;
}

/** 구간과 겹치는 세그먼트 (시각 순) */
export function segmentsInRange(segments: SegmentInfo[], range: TimeRange): SegmentInfo[] {
  return segments.filter((s) => s.endMs > range.fromMs && s.startMs < range.toMs);
}

/**
 * 대략의 크기. 실제로 읽기 전에 "이거 몇 GB인가"를 알려 주기 위한 것이다.
 *
 * 파일 안에서 채널별로 몇 바이트인지는 파싱해야 알 수 있으므로,
 * **프레임 수 비율로 나눈 어림값**이다. 화면에도 "대략"이라고 쓴다.
 */
export function estimateRangeBytes(segments: SegmentInfo[], range: TimeRange, kind: RangeKind): number {
  let total = 0;
  for (const s of segmentsInRange(segments, range)) {
    const overlap = Math.min(s.endMs, range.toMs) - Math.max(s.startMs, range.fromMs);
    if (overlap <= 0) continue;
    const share = s.durationMs > 0 ? overlap / s.durationMs : 1;
    const seconds = overlap / 1000;

    if (kind === 'audio') { total += seconds * AUDIO_SAMPLE_RATE * 2; continue; }
    if (kind === 'gps') { total += (s.gpsCount * share) * 90; continue; }
    if (kind === 'sensor') { total += (s.sensorCount * share) * 70; continue; }
    // 합성은 다시 압축하므로 원본 크기와 무관하다 (약 3Mbps + 소리)
    if (kind === 'both') { total += seconds * (3_000_000 / 8 + 8_000); continue; }

    // 영상: 파일의 대부분이 영상이고, 두 채널이 프레임 수 비율로 나눠 가진다고 본다.
    // MP4는 그릇만 바꾸는 것이라 크기가 거의 같고, 소리(초당 8KB)만 더해진다.
    const frames = s.ch0Count + s.ch1Count;
    if (frames === 0) continue;
    const mine = kind === 'front' ? s.ch0Count : s.ch1Count;
    total += s.size * 0.95 * (mine / frames) * share + seconds * 8_000;
  }
  return Math.round(total);
}

// ── 실제 추출 ────────────────────────────────────────

/** 영상이 아닌 종류는 그냥 시각으로 자른다 */
function pickByKind(doc: JdrDocument, kind: TagKind, range: TimeRange): number[] {
  const p = doc.packets;
  const picked: number[] = [];
  for (let i = 0; i < p.count; i++) {
    if (tagKind(p.tag[i]) !== kind) continue;
    if (p.timeMs[i] < range.fromMs) continue;
    if (p.timeMs[i] > range.toMs) break;
    picked.push(i);
  }
  return picked;
}

const BOM = '﻿';

/**
 * 구간을 하나의 파일로 만든다.
 *
 * 여러 세그먼트에 걸치면 순서대로 이어 붙인다. 영상은 세그먼트마다 자체
 * SPS/PPS와 IDR로 시작하므로 Annex-B를 그대로 이어도 재생기가 받아들인다.
 */
export async function buildRange(
  kind: RangeKind,
  segments: SegmentInfo[],
  loader: RangeLoader,
  range: TimeRange,
  onProgress?: (p: RangeProgress) => void,
): Promise<RangeResult> {
  const list = segmentsInRange(segments, range);
  if (list.length === 0) throw new Error('이 시간 구간에 해당하는 영상이 없습니다');

  const out = new BlobCollector();
  const gpsRows: string[] = [];
  const sensorRows: string[] = [];
  let audioBytes = 0;
  let lastYield = performance.now();
  /** 실제로 담긴 첫 패킷 시각 — 키프레임 때문에 요청보다 이를 수 있다 */
  let firstMs = Infinity;

  for (let n = 0; n < list.length; n++) {
    const seg = list[n];
    onProgress?.({ ratio: n / list.length, name: seg.name, index: n + 1, total: list.length });
    const { doc, src } = await loader.load(seg);
    const p = doc.packets;

    if (kind === 'gps') {
      for (const g of doc.gps) {
        if (g.timeMs < range.fromMs || g.timeMs > range.toMs) continue;
        gpsRows.push([
          formatRecordedTime(g.timeMs), formatRecordedTime(g.gpsTimeMs), seg.name,
          g.pdop, g.hdop, g.vdop, g.latNmea, g.lonNmea, g.lat, g.lon, g.altitude, g.speed,
        ].join(','));
      }
      continue;
    }
    if (kind === 'sensor') {
      const s = doc.gsensor;
      for (let i = 0; i < s.count; i++) {
        if (s.timeMs[i] < range.fromMs || s.timeMs[i] > range.toMs) continue;
        sensorRows.push([
          formatRecordedTime(s.timeMs[i]), seg.name,
          s.x[i], s.y[i], s.z[i],
          (s.x[i] / GSENSOR_SCALE).toFixed(4), (s.y[i] / GSENSOR_SCALE).toFixed(4), (s.z[i] / GSENSOR_SCALE).toFixed(4),
        ].join(','));
      }
      continue;
    }

    const picked = pickByKind(doc, TagKind.Audio, range);
    if (picked.length > 0) firstMs = Math.min(firstMs, p.timeMs[picked[0]]);

    for (let k = 0; k < picked.length; k++) {
      const i = picked[k];
      const bytes = await src.read(p.offset[i] + PACKET_HEADER_SIZE, p.size[i]);
      out.push(bytes);
      if (kind === 'audio') audioBytes += bytes.length;
      if (performance.now() - lastYield > 80) {
        onProgress?.({
          ratio: (n + k / picked.length) / list.length,
          name: seg.name, index: n + 1, total: list.length,
        });
        await yieldToUi();
        lastYield = performance.now();
      }
    }
  }

  onProgress?.({ ratio: 1, name: '', index: list.length, total: list.length });

  const done = (blob: Blob): RangeResult => ({
    blob,
    actualFromMs: Number.isFinite(firstMs) ? firstMs : range.fromMs,
    segmentCount: list.length,
  });

  if (kind === 'gps') {
    const head = 'packet_time,gps_time,source_file,pdop,hdop,vdop,latitude_nmea,longitude_nmea,latitude_deg,longitude_deg,altitude_m,speed_kmh';
    return done(new Blob([BOM + [head, ...gpsRows].join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }));
  }
  if (kind === 'sensor') {
    const head = 'packet_time,source_file,x_raw,y_raw,z_raw,x_g_est,y_g_est,z_g_est';
    return done(new Blob([BOM + [head, ...sensorRows].join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }));
  }
  return done(out.finish(wavHeader(audioBytes, AUDIO_SAMPLE_RATE) as Bytes, 'audio/wav'));
}
