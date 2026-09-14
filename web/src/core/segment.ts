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
import { packTag, TagKind, tagKind } from './tags';

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
  /**
   * 기기가 미리 잡아 두기만 하고 **아직 녹화하지 않은 빈 파일**.
   * 고장이 아니라 예약 공간이므로 "읽지 못한 파일"과 섞어 세면 안 된다.
   */
  blank?: boolean;
  /**
   * 파일 **안에서** 녹화가 끊긴 시간의 합(ms).
   *
   * 기기는 미리 잡아 둔 파일 하나에 이어서 쓴다. 주차로 세워 두었다가
   * 시동을 걸면 같은 파일 안에 몇 분~몇십 분짜리 구멍이 생긴다. 그 구멍을
   * 세지 않으면 주차 시간이 "녹화됨"으로 잡힌다.
   */
  innerGapMs?: number;
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
 * 담긴 내용이 받쳐 줄 수 있는 최저 속도 — 패킷 하나에 1초.
 *
 * 주차 저속 녹화(1fps)까지 감안해도 이보다 느릴 수는 없다. 이걸 넘는 길이는
 * 녹화된 시간이 아니라 **파일에 적힌 다른 무엇**이다(파일을 닫은 시각,
 * 시동을 걸며 덧붙인 GPS 패킷 한 줄 따위).
 */
const MIN_RATE_PER_SEC = 1;
/** 헤더가 0번지에 없을 때 훑어볼 범위. 이보다 뒤면 이 파일은 건너뛴다. */
const SCAN_LIMIT = 4 << 20;
const MAGIC = [0x31, 0x42, 0x45, 0x4a];

/**
 * 첫 블록 자리. 못 찾으면 at = -1.
 *
 * 어차피 앞머리를 통째로 읽으므로 **비어 있는지도 같이 본다.** 기기가 미리
 * 잡아 두기만 한 파일과 "내용은 있는데 못 읽는 파일"을 가르는 데 쓴다.
 * 표본을 뜨는 것보다 확실하고, 읽기는 한 번도 늘지 않는다.
 *
 * "전부 0"을 요구하면 안 된다. 실기기의 event 폴더 `idx_db`는 512바이트가
 * 전부 0인데 **딱 한 자리**, 헤더 크기 표식(+0x1FC = 0x200)만 찍혀 있었다.
 * 기기는 빈 자리에도 껍데기를 남긴다. 그걸 "내용 있음"으로 치면 멀쩡한
 * 예약 파일 166개가 다시 "열지 못한 파일"이 된다.
 */
async function findFirstBlock(src: ByteSource): Promise<{ at: number; headNoise: number }> {
  // 거의 모든 파일은 0번지에서 시작한다
  if (await validateHeader(src, 0)) return { at: 0, headNoise: Infinity };
  const chunk = await src.read(0, Math.min(SCAN_LIMIT, src.size));
  let headNoise = 0;
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] !== 0) headNoise++;
    if (i + 4 > chunk.length) continue;
    if (chunk[i] !== MAGIC[0] || chunk[i + 1] !== MAGIC[1]) continue;
    if (chunk[i + 2] !== MAGIC[2] || chunk[i + 3] !== MAGIC[3]) continue;
    if (await validateHeader(src, i)) return { at: i, headNoise: Infinity };
  }
  return { at: -1, headNoise };
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
    coveredBytes: 0, innerGapMs: 0,
  };

  const found = await findFirstBlock(src);
  const first = found.at;
  if (first < 0) {
    // 기기는 카드를 포맷할 때 녹화할 자리를 **미리 파일로 잡아 둔다.** 아직
    // 쓰이지 않은 그 파일은 0으로 채워져 있을 뿐 고장난 게 아니다.
    // "읽지 못한 파일"로 세면 사용자는 증거가 깨진 줄 안다.
    if (found.headNoise <= BLANK_NOISE_BYTES && await looksBlank(src)) {
      return { ...base, blank: true, error: '아직 녹화되지 않은 빈 파일입니다 (기기가 미리 잡아 둔 자리)' };
    }
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
  /** 블록마다 헤더에 적힌 시간 범위 — 파일 안의 공백을 찾는 데 쓴다 */
  const blockTimes: { startMs: number; endMs: number }[] = [];
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
    blockTimes.push({
      startMs: readSystemTimeFromView(dv, 0x94),
      endMs: readSystemTimeFromView(dv, 0xa4),
    });
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
  // 파일은 70MB처럼 미리 잡혀 있고 녹화는 그보다 일찍 끝난다. 남은 꼬리가
  // 0으로 채워져 있으면 **못 읽은 게 아니라 안 쓴 것**이다. 그걸 "덜 읽음"으로
  // 세면 멀쩡한 파일 수백 개가 경고로 뜬다.
  base.coveredBytes = (coveredTo < size && await isZeroRun(src, coveredTo, size))
    ? size
    : Math.max(0, coveredTo - first);
  base.innerGapMs = innerGapOf(blockTimes);

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
  } else if (durationExceedsContent(endMs - startMs, frames, base.packetCount)) {
    // **시각 출처를 가리지 않는 최후의 방어선이다.**
    //
    // 헤더든 패킷이든, 70MB에 영상 50초를 담은 파일이 다섯 시간짜리일 수는
    // 없다. 그런 값이 나오면 그건 녹화 길이가 아니다. 조용히 믿으면 주차
    // 시간이 "녹화된 구간"으로 덮여 없는 기록을 있다고 말하게 된다.
    // 담긴 프레임으로 고치고 화면에 "길이 추정"이라고 밝힌다.
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
const TAIL_SCAN = 48;

/**
 * 첫 패킷과 마지막 패킷의 시각을 읽는다.
 *
 * 마지막 패킷 하나만 보면 안 된다. 꼬리에 시각이 비었거나 깨진 패킷이 붙어
 * 있으면 종료 시각을 못 구하고, 그러면 **헤더에 적힌(실제보다 이른) 값이
 * 그대로 남아** 파일이 짧아진다. 파일이 짧아지면 두 가지가 한꺼번에 틀어진다.
 *   - 파일 사이에 없는 빈 구간이 생긴다
 *   - 탐색 막대를 파일 뒷부분으로 끌면 범위를 벗어나 다음 파일로 튕겨 나간다
 *
 * 그래서 끝에서부터 거슬러 올라가며 시각이 읽히는 패킷을 찾는다.
 * 인덱스 항목은 붙어 있으므로 한 번에 읽어 두고 패킷 헤더만 몇 번 더 본다.
 *
 * **영상·음성 패킷을 먼저 친다.** 구간의 길이를 정하는 건 담긴 내용이지
 * 파일에 마지막으로 적힌 무언가가 아니다. 기기는 시동을 걸 때 직전 파일
 * 꼬리에 GPS·센서 패킷을 한둘 더 적기도 하는데, 그걸 끝으로 삼으면 주차한
 * 다섯 시간이 통째로 "녹화된 구간"이 된다. 인덱스 항목의 앞 4바이트가
 * 태그라 **추가 읽기 없이** 가려낼 수 있다.
 */
async function timeRangeFromPackets(
  src: ByteSource, firstBlock: number, lastIndexOffset: number, lastCount: number,
): Promise<{ startMs: number; endMs: number }> {
  let startMs = NaN;
  /** 영상·음성 중 가장 늦은 시각 — 이게 있으면 이걸 쓴다 */
  let mediaEnd = NaN;
  /** 종류를 가리지 않은 마지막 시각 — 영상·음성을 못 찾았을 때만 쓴다 */
  let anyEnd = NaN;
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
          const at = k * INDEX_ENTRY_SIZE;
          const packetOffset = ev.getUint32(at + 8, true);
          if (packetOffset <= 0 || packetOffset + PACKET_HEADER_SIZE > src.size) continue;
          const kind = tagKind(packTag(
            ev.getUint8(at), ev.getUint8(at + 1), ev.getUint8(at + 2), ev.getUint8(at + 3),
          ));
          const isMedia = kind === TagKind.Video || kind === TagKind.Audio;
          // 영상·음성을 이미 찾았으면 그 앞은 볼 것도 없다
          if (!isMedia && Number.isFinite(anyEnd)) continue;
          const tail = await src.read(packetOffset, PACKET_HEADER_SIZE);
          if (tail.length !== PACKET_HEADER_SIZE) continue;
          const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
          const t = readSystemTimeFromView(tv, 12);
          if (!Number.isFinite(t)) continue;
          if (!Number.isFinite(anyEnd) || t > anyEnd) anyEnd = t;
          if (isMedia) {
            mediaEnd = t;
            break;
          }
        }
      }
    }
  } catch {
    /* 읽기 실패는 상위에서 파일명 폴백으로 처리 */
  }
  return { startMs, endMs: Number.isFinite(mediaEnd) ? mediaEnd : anyEnd };
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

/**
 * 이 길이를 담긴 내용이 받쳐 주는가.
 *
 * 영상 프레임 수와 전체 패킷 수 중 **큰 쪽**을 본다. 영상이 없는 파일
 * (음성만 남은 주차 녹화 등)도 패킷 수로는 가늠할 수 있기 때문이다.
 */
export function durationExceedsContent(durationMs: number, frames: number, packets: number): boolean {
  const units = Math.max(frames, packets);
  if (units < 2) return false;
  return durationMs > (units / MIN_RATE_PER_SEC) * 1000;
}

/** 파일 안에서 녹화가 끊긴 시간의 합. 블록 헤더의 시간 범위로 가른다. */
const INNER_GAP_MIN_MS = 10_000;

function innerGapOf(blocks: { startMs: number; endMs: number }[]): number {
  let total = 0;
  for (let i = 1; i < blocks.length; i++) {
    const prevEnd = blocks[i - 1].endMs;
    const curStart = blocks[i].startMs;
    if (!Number.isFinite(prevEnd) || !Number.isFinite(curStart)) continue;
    const gap = curStart - prevEnd;
    if (gap > INNER_GAP_MIN_MS) total += gap;
  }
  return Math.round(total);
}

/** 훑어볼 표본 크기와 지점 수 — 파일 전체를 읽지 않고 "비었는지"만 가른다 */
const BLANK_SAMPLE = 32 << 10;
const BLANK_POINTS = 5;
/**
 * 빈 파일로 볼 때 눈감아 주는 0 아닌 바이트 수.
 *
 * 기기가 빈 자리에 남기는 껍데기(헤더 크기 표식 따위) 몇 바이트는 내용이
 * 아니다. 영상이 한 프레임이라도 있으면 수만 바이트가 되므로 이 문턱을
 * 넘을 일이 없다.
 */
const BLANK_NOISE_BYTES = 64;

/**
 * 앞머리(SCAN_LIMIT)가 0인 건 이미 확인됐다. 그 뒤도 0인지 떠서 본다.
 * 파일 전체를 읽을 수는 없으므로 여기는 표본이다.
 */
async function looksBlank(src: ByteSource): Promise<boolean> {
  if (src.size <= SCAN_LIMIT) return true;
  return isZeroRun(src, SCAN_LIMIT, src.size, BLANK_NOISE_BYTES);
}

/**
 * [from, to) 가 (표본 기준) 전부 0인가.
 *
 * 앞머리만 보면 안 된다. 정렬 패딩 뒤에 진짜 블록이 이어지는 파일에서
 * 앞 32KB만 보고 "빈 꼬리"라고 단정하면 **못 읽은 블록을 없는 셈** 치게 된다.
 * 범위를 나눠 여러 곳을 떠 본다.
 */
async function isZeroRun(src: ByteSource, from: number, to: number, noise = 0): Promise<boolean> {
  const span = to - from;
  if (span <= 0) return true;
  let seen = 0;
  const points = Math.min(BLANK_POINTS, Math.max(1, Math.ceil(span / BLANK_SAMPLE)));
  // **끝을 반드시 본다.** 정렬 패딩 뒤 맨 끝에 블록이 붙어 있는 파일이 있어,
  // 고르게만 뜨면 그 블록을 놓치고 "빈 꼬리"로 단정하게 된다.
  const last = Math.max(from, to - BLANK_SAMPLE);
  for (let i = 0; i < points; i++) {
    const at = points === 1 ? from : from + Math.round(((last - from) * i) / (points - 1));
    const length = Math.min(BLANK_SAMPLE, to - at);
    if (length <= 0) continue;
    const chunk = await src.read(at, length);
    for (let k = 0; k < chunk.length; k++) {
      if (chunk[k] !== 0 && ++seen > noise) return false;
    }
  }
  return true;
}
