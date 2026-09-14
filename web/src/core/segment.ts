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
  /**
   * 블록 체인이 실제로 덮은 바이트 수. `size`와 크게 차이 나면 **파일 뒷부분을
   * 못 읽은 것**이고, 그만큼 파일이 짧아 보여 없는 빈 구간이 생긴다.
   * 진단용이라 없을 수도 있다(옛 인덱스).
   */
  coveredBytes?: number;
  /** 읽을 수 없는 파일이면 사유 */
  error?: string;
}

const MAX_BLOCKS = 8192;
/**
 * 체인이 끊겼을 때 다음 블록을 찾아 훑을 범위 — 좁은 것부터 넓혀 간다.
 *
 * 블록은 인덱스 테이블 바로 뒤에 붙는 게 원칙이지만, 기기가 블록 사이를
 * 정렬(패딩)하거나 블록 하나를 쓰다 말면 계산한 자리에 헤더가 없다.
 * 거기서 그냥 멈추면 **그 뒤의 블록을 전부 잃는다** — 파일이 실제보다
 * 짧아 보이고, 파일 사이에 없는 빈 구간이 생긴다.
 *
 * 그래도 프로브는 파일당 몇 KB만 읽는 게 존재 이유다. 그래서 정렬 패딩이
 * 있을 만한 4KB부터 보고, 없을 때만 넓힌다. 넓히는 건 파일당 몇 번으로
 * 묶어 둔다 — 뒤에 쓰레기가 붙은 파일 하나 때문에 폴더 전체가 느려지면 안 된다.
 */
const RESUME_STEPS = [4 << 10, 64 << 10, 256 << 10];
/** 넓혀 훑기를 파일당 몇 번까지 허용할지 */
const RESUME_WIDE_BUDGET = 4;
/**
 * 헤더 종료 시각을 믿을지 가르는 최저 프레임률.
 * 주차 저속 녹화까지 감안해 아주 느슨하게 잡는다 — 이걸 넘어서면
 * 녹화 길이가 아니라 다른 무엇이 적힌 것이다.
 */
const MIN_FPS = 1;
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
    coveredBytes: 0,
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

  /** 블록 체인이 실제로 덮은 마지막 바이트 — 파일 전체와 견줘 진단에 쓴다 */
  let coveredTo = first;
  let wideBudget = RESUME_WIDE_BUDGET;
  while (pos >= 0 && pos < size && offsets.length < MAX_BLOCKS) {
    const h = await validateHeader(src, pos);
    if (!h) {
      // 계산한 자리에 헤더가 없다. 패딩일 수 있으니 앞으로 훑어 따라잡는다.
      const found = await findNextBlock(src, pos, size, wideBudget);
      if (found.at < 0) break;
      if (found.wide) wideBudget--;
      pos = found.at;
      continue;
    }
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
    coveredTo = Math.max(coveredTo, Math.min(next, size));
    pos = next > pos ? next : -1;
  }

  if (offsets.length === 0 || !firstHeader || !lastHeader) {
    return { ...base, error: '헤더를 읽을 수 없습니다' };
  }
  base.blockOffsets = offsets;
  base.coveredBytes = Math.max(0, coveredTo - first);

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
  // 종료도 **마지막 패킷이 기준**이다. 시작과 같은 원칙이며, 여기서 한쪽만
  // 봐주면 안 된다. 예전에는 헤더보다 **늦을 때만** 패킷을 썼는데, 헤더의
  // 종료 시각(+0xA4)에는 기기가 그 파일을 마지막으로 손댄 시각이 적히는
  // 일이 있다. 주차로 다섯 시간 세워 둔 뒤 시동을 걸면 마지막 주행 파일
  // 하나가 **5시간 35분짜리**가 되고, 그러면 주차 시간이 녹화된 것처럼
  // 덮여 빈 구간이 통째로 사라진다. 기록에 없는 시간을 있다고 하는 셈이라
  // 감사 자료로서 가장 나쁜 종류의 오류다.
  if (Number.isFinite(fromPackets.endMs) && fromPackets.endMs >= startMs) {
    if (endMs !== fromPackets.endMs) timeSource = 'packets';
    endMs = fromPackets.endMs;
  } else if (!Number.isFinite(endMs) || endMs < startMs) {
    endMs = NaN;
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
  const frames = Math.max(base.ch0Count, base.ch1Count);
  let endEstimated = false;
  if (!Number.isFinite(endMs) || endMs <= startMs) {
    endMs = startMs + (frames > 1 ? ((frames - 1) / 30) * 1000 : 0);
    endEstimated = true;
  } else if (timeSource === 'header' && frames > 1 && endMs - startMs > (frames / MIN_FPS) * 1000) {
    // 패킷을 못 읽어 헤더 값을 쓰는 경우다. 담긴 프레임 수가 도저히 받쳐
    // 주지 못하는 길이라면 그건 녹화 길이가 아니라 파일을 닫은 시각이다.
    endMs = startMs + ((frames - 1) / 30) * 1000;
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

/**
 * `from` 부터 앞으로 훑어 다음 JEB1 블록 머리를 찾는다. 없으면 at = -1.
 *
 * 참고 구현(파이썬 도구)은 파일 전체에서 매직을 찾는다. 프로브는 파일당
 * 몇 KB만 읽는 게 목적이라 그럴 수 없으므로, **체인이 끊긴 자리 근처부터
 * 좁게** 보고 필요할 때만 넓힌다. 정렬 패딩이라면 첫 걸음에서 끝난다.
 *
 * `wide`는 4KB를 넘겨 훑었는지 — 호출한 쪽이 그 횟수를 묶어 두기 위함이다.
 */
async function findNextBlock(
  src: ByteSource, from: number, size: number, wideBudget: number,
): Promise<{ at: number; wide: boolean }> {
  if (from + JEB_HEADER_SIZE > size) return { at: -1, wide: false };
  let scanned = 0;
  for (let step = 0; step < RESUME_STEPS.length; step++) {
    const wide = step > 0;
    if (wide && wideBudget <= 0) break;
    const want = Math.min(RESUME_STEPS[step], size - from);
    if (want <= scanned) break;
    // 이미 본 데는 다시 읽지 않는다. 청크 경계에 걸친 매직 때문에 3바이트만 겹친다.
    const at = await scanForBlock(src, from + Math.max(0, scanned - 3), from + want);
    if (at >= 0) return { at, wide };
    scanned = want;
    if (want >= size - from) break;
  }
  return { at: -1, wide: scanned > RESUME_STEPS[0] };
}

/** [from, to) 안에서 검증까지 통과하는 첫 JEB1 머리 */
async function scanForBlock(src: ByteSource, from: number, to: number): Promise<number> {
  const length = to - from;
  if (length < 4) return -1;
  const chunk = await src.read(from, length);
  for (let i = 0; i + 4 <= chunk.length; i++) {
    if (chunk[i] !== MAGIC[0] || chunk[i + 1] !== MAGIC[1]) continue;
    if (chunk[i + 2] !== MAGIC[2] || chunk[i + 3] !== MAGIC[3]) continue;
    const at = from + i;
    if (await validateHeader(src, at)) return at;
  }
  return -1;
}
