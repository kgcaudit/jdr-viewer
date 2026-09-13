/**
 * 세그먼트 프로브 — 파일 하나의 "시간 범위"를 아주 싸게 알아낸다.
 *
 * 폴더에 든 파일을 전부 파싱하면 파일당 수백 ms가 든다(1000개면 수 분).
 * 대신 JEB 헤더 512바이트만 읽으면 시간 범위·패킷 수·채널 구성이 나온다.
 * 블록이 여러 개여도 `다음 블록 = indexOffset + packetCount * 12` 로
 * 체인을 따라가면 되므로, 블록 수만큼의 작은 읽기로 끝난다.
 */
import type { ByteSource } from './byte-source';
import { INDEX_ENTRY_SIZE, JEB_HEADER_SIZE, PACKET_HEADER_SIZE, readSystemTimeFromView, validateHeader } from './parser';
import { systemTimeToMs } from './time';

/** 시간 범위를 어디서 얻었는지 — UI에 신뢰도를 표시하기 위함 */
export type TimeSource = 'header' | 'packets' | 'filename' | 'unknown';

export interface SegmentInfo {
  id: string;
  /** 파일 이름 */
  name: string;
  /** 폴더 기준 상대 경로 */
  path: string;
  /** 소속 하위 폴더 ('' = 최상위) */
  folder: string;
  size: number;
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
  /** 종료 시각을 프레임 수로 추정했는가 */
  endEstimated: boolean;
  /**
   * 헤더에 적힌 시작 시각이 실제 첫 패킷보다 얼마나 늦었나(ms).
   * 0이 아니면 헤더를 그대로 믿었을 때 그만큼 없는 빈 구간이 생긴다.
   */
  headerShiftMs: number;
  /** 읽을 수 없는 파일이면 사유 */
  error?: string;
}

const MAX_BLOCKS = 8192;
/** 헤더가 0번지에 없을 때 훑어볼 범위. 이보다 뒤면 이 파일은 건너뛴다. */
const SCAN_LIMIT = 4 << 20;
const MAGIC = [0x31, 0x42, 0x45, 0x4a];

async function findFirstBlock(src: ByteSource): Promise<number> {
  // 거의 모든 파일은 0번지에서 시작한다
  if (await validateHeader(src, 0)) return 0;
  const chunk = await src.read(0, Math.min(SCAN_LIMIT, src.size));
  for (let i = 1; i + 4 <= chunk.length; i++) {
    if (chunk[i] === MAGIC[0] && chunk[i + 1] === MAGIC[1] && chunk[i + 2] === MAGIC[2] && chunk[i + 3] === MAGIC[3]) {
      if (await validateHeader(src, i)) return i;
    }
  }
  return -1;
}

/** 파일명에서 YYYYMMDDHHMMSS를 뽑는다 (구분자 허용). 헤더 시각이 없을 때의 최후 보루. */
export function timeFromFileName(name: string): number {
  const digits = name.replace(/[^0-9]/g, '');
  for (let i = 0; i + 14 <= digits.length; i++) {
    const s = digits.slice(i, i + 14);
    const ms = systemTimeToMs(
      Number(s.slice(0, 4)), Number(s.slice(4, 6)), Number(s.slice(6, 8)),
      Number(s.slice(8, 10)), Number(s.slice(10, 12)), Number(s.slice(12, 14)), 0,
    );
    // 블랙박스 파일로 그럴듯한 범위만 인정
    if (Number.isFinite(ms) && ms > Date.UTC(2000, 0, 1) && ms < Date.UTC(2100, 0, 1)) return ms;
  }
  return NaN;
}

export interface ProbeSource {
  src: ByteSource;
  name: string;
  path: string;
  size: number;
}

export async function probeSegment(input: ProbeSource): Promise<SegmentInfo> {
  const { src, name, path, size } = input;
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const base: SegmentInfo = {
    id: path || name,
    name, path, folder, size,
    startMs: NaN, endMs: NaN, durationMs: 0,
    packetCount: 0, ch0Count: 0, ch1Count: 0, gpsCount: 0, sensorCount: 0,
    blockOffsets: [], timeSource: 'unknown', endEstimated: false, headerShiftMs: 0,
  };

  const first = await findFirstBlock(src);
  if (first < 0) {
    return { ...base, error: 'JEB1 블록을 찾지 못했습니다 (JDR이 아니거나 지원하지 않는 변형)' };
  }

  // ── 블록 체인 따라가기 ──
  const offsets: number[] = [];
  let firstHeader: DataView | null = null;
  let lastHeader: DataView | null = null;
  let lastIndexOffset = 0;
  let lastCount = 0;
  let pos = first;

  while (pos >= 0 && pos < size && offsets.length < MAX_BLOCKS) {
    const h = await validateHeader(src, pos);
    if (!h) break;
    const dv = new DataView(h.raw.buffer, h.raw.byteOffset, h.raw.byteLength);
    if (!firstHeader) firstHeader = dv;
    lastHeader = dv;
    lastIndexOffset = h.indexOffset;
    lastCount = h.packetCount;
    offsets.push(pos);

    base.packetCount += h.packetCount;
    base.ch0Count += dv.getUint32(0x08, true);
    base.ch1Count += dv.getUint32(0x0c, true);
    base.gpsCount += dv.getUint32(0x88, true);
    base.sensorCount += dv.getUint32(0x8c, true);

    // 다음 블록은 인덱스 테이블 바로 뒤에서 시작한다
    const next = h.indexOffset + h.packetCount * INDEX_ENTRY_SIZE;
    pos = next > pos ? next : -1;
  }

  if (offsets.length === 0 || !firstHeader || !lastHeader) {
    return { ...base, error: '헤더를 읽을 수 없습니다' };
  }
  base.blockOffsets = offsets;

  // ── 시간 범위: 헤더 → 패킷 → 파일명 순으로 시도 ──
  let startMs = readSystemTimeFromView(firstHeader, 0x94);
  let endMs = readSystemTimeFromView(lastHeader, 0xa4);
  let timeSource: TimeSource = 'header';

  // 헤더에 적힌 시각은 실제 패킷과 어긋날 수 있다(실기기에서 종료 시각 1.8초 차이 확인).
  // 그대로 두면 재생 길이 표시가 어긋나고, 파일 사이에 없는 빈 구간이 생긴다.
  // 읽기 2번이면 확인되므로 항상 대조한다.
  const fromPackets = await timeRangeFromPackets(src, offsets[0], lastIndexOffset, lastCount);

  // 시작은 **첫 패킷이 기준**이다. 재생도 거기서 시작하므로(doc.firstTimeMs),
  // 헤더 값을 쓰면 타임라인의 절대 시각이 재생과 어긋난다.
  let headerShiftMs = 0;
  if (Number.isFinite(fromPackets.startMs)) {
    if (Number.isFinite(startMs)) headerShiftMs = startMs - fromPackets.startMs;
    startMs = fromPackets.startMs;
    if (headerShiftMs !== 0) timeSource = 'packets';
  }
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    if (Number.isFinite(fromPackets.startMs)) {
      startMs = fromPackets.startMs;
      endMs = fromPackets.endMs;
      timeSource = 'packets';
    }
  } else if (Number.isFinite(fromPackets.endMs) && fromPackets.endMs > endMs) {
    endMs = fromPackets.endMs;
    timeSource = 'packets';
  }
  if (!Number.isFinite(startMs)) {
    const fromName = timeFromFileName(name);
    if (Number.isFinite(fromName)) {
      startMs = fromName;
      endMs = NaN;
      timeSource = 'filename';
    }
  }
  if (!Number.isFinite(startMs)) {
    return { ...base, error: '기록 시각을 알 수 없습니다 (헤더·패킷·파일명 모두 실패)' };
  }

  // 종료 시각을 못 구했으면 프레임 수로 추정한다 (30fps 가정)
  let endEstimated = false;
  if (!Number.isFinite(endMs) || endMs <= startMs) {
    const frames = Math.max(base.ch0Count, base.ch1Count);
    endMs = startMs + (frames > 1 ? ((frames - 1) / 30) * 1000 : 0);
    endEstimated = true;
  }

  return {
    ...base,
    startMs,
    endMs,
    durationMs: Math.max(0, endMs - startMs),
    timeSource,
    endEstimated,
    headerShiftMs: Math.round(headerShiftMs),
  };
}

/** 끝에서부터 이만큼까지는 되짚어 본다 — 마지막 패킷의 시각이 비어 있는 경우가 있다 */
const TAIL_SCAN = 24;

/**
 * 첫 패킷과 마지막 패킷의 시각을 읽는다.
 *
 * 마지막 패킷 하나만 보면 안 된다. 꼬리에 시각이 비었거나 깨진 패킷이 붙어
 * 있으면 종료 시각을 못 구하고, 그러면 **헤더에 적힌(실제보다 이른) 값이
 * 그대로 남아** 파일이 짧아진다. 파일이 짧아지면 두 가지가 한꺼번에 틀어진다.
 *   - 파일 사이에 없는 빈 구간이 생긴다
 *   - 탐색 막대를 파일 뒷부분으로 끌면 범위를 벗어나 다음 파일로 튕겨 나간다
 *
 * 그래서 끝에서부터 거슬러 올라가며 **시각이 읽히는 첫 패킷**을 찾는다.
 * 인덱스 항목은 붙어 있으므로 한 번에 읽어 두고 패킷 헤더만 몇 번 더 본다.
 */
async function timeRangeFromPackets(
  src: ByteSource, firstBlock: number, lastIndexOffset: number, lastCount: number,
): Promise<{ startMs: number; endMs: number }> {
  let startMs = NaN;
  let endMs = NaN;
  try {
    const head = await src.read(firstBlock + JEB_HEADER_SIZE, PACKET_HEADER_SIZE);
    if (head.length === PACKET_HEADER_SIZE) {
      startMs = readSystemTimeFromView(new DataView(head.buffer, head.byteOffset, head.byteLength), 12);
    }

    if (lastCount > 0) {
      const take = Math.min(TAIL_SCAN, lastCount);
      const from = lastIndexOffset + (lastCount - take) * INDEX_ENTRY_SIZE;
      const entries = await src.read(from, take * INDEX_ENTRY_SIZE);
      if (entries.length >= INDEX_ENTRY_SIZE) {
        const ev = new DataView(entries.buffer, entries.byteOffset, entries.byteLength);
        const have = Math.floor(entries.length / INDEX_ENTRY_SIZE);
        for (let k = have - 1; k >= 0; k--) {
          const packetOffset = ev.getUint32(k * INDEX_ENTRY_SIZE + 8, true);
          if (packetOffset <= 0 || packetOffset + PACKET_HEADER_SIZE > src.size) continue;
          const tail = await src.read(packetOffset, PACKET_HEADER_SIZE);
          if (tail.length !== PACKET_HEADER_SIZE) continue;
          const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
          const t = readSystemTimeFromView(tv, 12);
          if (Number.isFinite(t)) {
            // 꼬리 쪽이 시각 순이 아닐 수 있으니 가장 늦은 것을 남긴다
            if (!Number.isFinite(endMs) || t > endMs) endMs = t;
            break;
          }
        }
      }
    }
  } catch {
    /* 읽기 실패는 상위에서 파일명 폴백으로 처리 */
  }
  return { startMs, endMs };
}
