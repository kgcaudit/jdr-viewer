/**
 * H.264 Annex-B 비트스트림 분석.
 *
 * WebCodecs는 VideoDecoderConfig.description을 생략하면 Annex-B로 동작하므로
 * 원래는 여기까지 안 해도 된다. 다만 두 가지 때문에 필요하다.
 *
 *  1) codec 문자열("avc1.PPCCLL")을 만들려면 SPS 앞 3바이트가 필요하다.
 *  2) Annex-B 모드에서 key 청크는 SPS/PPS를 포함해야 한다. JDR의 00VI 패킷이
 *     이를 포함하지 않는 기종이 있을 수 있어, 없으면 앞에 붙여줘야 한다.
 */

export interface NalUnit {
  /** data 안에서 NAL 페이로드(헤더 바이트 포함)가 시작하는 위치 */
  start: number;
  /** 페이로드 길이 (start code 제외) */
  length: number;
  /** start code까지 포함한 시작 위치 */
  rawStart: number;
  type: number;
}

export const NAL_IDR = 5;
export const NAL_SPS = 7;
export const NAL_PPS = 8;

/** Annex-B start code(3 또는 4바이트)를 훑어 NAL 유닛 목록을 만든다. */
export function findNalUnits(data: Uint8Array, limit = Infinity): NalUnit[] {
  const out: NalUnit[] = [];
  const n = data.length;
  let i = 0;
  let prev: NalUnit | null = null;

  while (i + 3 <= n && out.length < limit) {
    if (data[i] === 0 && data[i + 1] === 0) {
      let scLen = 0;
      if (data[i + 2] === 1) scLen = 3;
      else if (i + 4 <= n && data[i + 2] === 0 && data[i + 3] === 1) scLen = 4;

      if (scLen > 0) {
        const start = i + scLen;
        if (start < n) {
          if (prev) prev.length = i - prev.start;
          prev = { rawStart: i, start, length: n - start, type: data[start] & 0x1f };
          out.push(prev);
        }
        i = start + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** emulation prevention byte(0x03)를 제거한 RBSP를 만든다. */
function toRbsp(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  let o = 0;
  for (let i = 0; i < data.length; i++) {
    if (i >= 2 && data[i] === 0x03 && data[i - 1] === 0 && data[i - 2] === 0) continue;
    out[o++] = data[i];
  }
  return out.subarray(0, o);
}

class BitReader {
  private pos = 0;
  constructor(private readonly d: Uint8Array) {}
  bit(): number {
    const byte = this.d[this.pos >> 3];
    if (byte === undefined) return 0;
    const b = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v >>> 0;
  }
  /** 부호 없는 exp-Golomb */
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0 && zeros < 32) zeros++;
    if (zeros === 0) return 0;
    return (1 << zeros) - 1 + this.bits(zeros);
  }
  /** 부호 있는 exp-Golomb */
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) >> 1 : -(k >> 1);
  }
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

export interface SpsInfo {
  profileIdc: number;
  constraintFlags: number;
  levelIdc: number;
  width: number;
  height: number;
  /** WebCodecs configure()용 코덱 문자열 */
  codec: string;
}

/** SPS NAL(헤더 바이트 포함)에서 해상도와 코덱 문자열을 뽑는다. */
export function parseSps(nal: Uint8Array): SpsInfo | null {
  if (nal.length < 4 || (nal[0] & 0x1f) !== NAL_SPS) return null;
  const rbsp = toRbsp(nal.subarray(1));
  if (rbsp.length < 3) return null;

  const profileIdc = rbsp[0];
  const constraintFlags = rbsp[1];
  const levelIdc = rbsp[2];
  const codec =
    'avc1.' +
    profileIdc.toString(16).padStart(2, '0') +
    constraintFlags.toString(16).padStart(2, '0') +
    levelIdc.toString(16).padStart(2, '0');

  try {
    const r = new BitReader(rbsp.subarray(3));
    r.ue(); // seq_parameter_set_id

    let chromaFormatIdc = 1;
    if (HIGH_PROFILES.has(profileIdc)) {
      chromaFormatIdc = r.ue();
      if (chromaFormatIdc === 3) r.bit(); // separate_colour_plane_flag
      r.ue(); // bit_depth_luma_minus8
      r.ue(); // bit_depth_chroma_minus8
      r.bit(); // qpprime_y_zero_transform_bypass_flag
      if (r.bit()) {
        // seq_scaling_matrix_present_flag
        const lists = chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < lists; i++) {
          if (r.bit()) {
            const size = i < 6 ? 16 : 64;
            let lastScale = 8;
            let nextScale = 8;
            for (let j = 0; j < size; j++) {
              if (nextScale !== 0) nextScale = (lastScale + r.se() + 256) % 256;
              lastScale = nextScale === 0 ? lastScale : nextScale;
            }
          }
        }
      }
    }

    r.ue(); // log2_max_frame_num_minus4
    const picOrderCntType = r.ue();
    if (picOrderCntType === 0) {
      r.ue(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (picOrderCntType === 1) {
      r.bit(); // delta_pic_order_always_zero_flag
      r.se(); // offset_for_non_ref_pic
      r.se(); // offset_for_top_to_bottom_field
      const cycle = r.ue();
      for (let i = 0; i < cycle; i++) r.se();
    }

    r.ue(); // max_num_ref_frames
    r.bit(); // gaps_in_frame_num_value_allowed_flag

    const widthMbsMinus1 = r.ue();
    const heightMapUnitsMinus1 = r.ue();
    const frameMbsOnly = r.bit();
    if (!frameMbsOnly) r.bit(); // mb_adaptive_frame_field_flag
    r.bit(); // direct_8x8_inference_flag

    let cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
    if (r.bit()) {
      cropLeft = r.ue();
      cropRight = r.ue();
      cropTop = r.ue();
      cropBottom = r.ue();
    }

    // 4:2:0(chroma_format_idc=1)에서 crop 단위는 2. monochrome(0)은 1.
    const subWidthC = chromaFormatIdc === 0 || chromaFormatIdc === 3 ? 1 : 2;
    const subHeightC = chromaFormatIdc === 1 ? 2 : 1;
    const cropUnitX = subWidthC;
    const cropUnitY = subHeightC * (2 - frameMbsOnly);

    const width = (widthMbsMinus1 + 1) * 16 - cropUnitX * (cropLeft + cropRight);
    const height = (2 - frameMbsOnly) * (heightMapUnitsMinus1 + 1) * 16 - cropUnitY * (cropTop + cropBottom);

    if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
      return { profileIdc, constraintFlags, levelIdc, width: 0, height: 0, codec };
    }
    return { profileIdc, constraintFlags, levelIdc, width, height, codec };
  } catch {
    return { profileIdc, constraintFlags, levelIdc, width: 0, height: 0, codec };
  }
}

/** payload 안의 SPS/PPS NAL을 start code까지 포함해 이어붙인 바이트를 만든다. */
export function extractParameterSets(payload: Uint8Array): Uint8Array | null {
  const nals = findNalUnits(payload);
  const wanted = nals.filter((n) => n.type === NAL_SPS || n.type === NAL_PPS);
  if (wanted.length === 0) return null;
  let total = 0;
  for (const n of wanted) total += 4 + n.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const n of wanted) {
    out.set([0, 0, 0, 1], o);
    o += 4;
    out.set(payload.subarray(n.start, n.start + n.length), o);
    o += n.length;
  }
  return out;
}

/**
 * key 청크로 넘길 바이트를 만든다.
 * 페이로드에 이미 SPS/PPS가 있으면 그대로, 없으면 앞에 붙인다.
 */
export function buildKeyChunk(payload: Uint8Array, parameterSets: Uint8Array | null): Uint8Array {
  if (!parameterSets) return payload;
  const nals = findNalUnits(payload, 8);
  if (nals.some((n) => n.type === NAL_SPS)) return payload;
  const out = new Uint8Array(parameterSets.length + payload.length);
  out.set(parameterSets, 0);
  out.set(payload, parameterSets.length);
  return out;
}
