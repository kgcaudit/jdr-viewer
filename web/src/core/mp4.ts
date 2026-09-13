/**
 * 구간을 MP4로 내보내기.
 *
 * 원본 JDR은 건드리지 않으므로 **내보낸 파일은 파생물**이다. 바이트를 원본과
 * 맞출 이유가 없고, 맞추려 들면 `.h264` 같은 아무도 못 여는 파일이 나온다.
 *
 * 그렇다고 화질을 버릴 필요도 없다. 영상은 **담는 그릇만 바꾼다**(리먹스).
 * 할 일은 두 가지뿐이다.
 *   - Annex-B 시작코드(00 00 00 01)를 4바이트 길이 접두사로
 *   - 키프레임의 SPS·PPS를 뽑아 avcC로
 * 픽셀은 원본 그대로이고, 디코딩도 인코딩도 하지 않아 빠르다.
 *
 * 음성만은 손을 댄다. MP4에 두루 통하는 건 AAC인데 원본은 8kHz PCM이라
 * 표본율을 올려 다시 인코딩한다. 손대지 않은 소리가 필요하면 WAV 내보내기가
 * 따로 있다.
 */
import {
  AudioBufferSource, BufferTarget, CanvasSource, EncodedPacket, EncodedVideoPacketSource,
  getFirstEncodableAudioCodec, getFirstEncodableVideoCodec, Mp4OutputFormat, Output,
  type AudioCodec,
} from 'mediabunny';
import type { ByteSource } from './byte-source';
import { findNalUnits, NAL_PPS, NAL_SPS, parseSps } from './nal';
import { AUDIO_SAMPLE_RATE, PACKET_HEADER_SIZE } from './parser';
import type { SegmentInfo } from './segment';
import { TagKind, tagChannel, tagIsKeyframe, tagKind } from './tags';
import type { JdrDocument } from './types';
import { pcmFromBytes } from './vad';

/** AAC로 내보낼 표본율. 8kHz를 인코더가 받아 주느냐를 아예 피한다. */
export const MP4_AUDIO_RATE = 48_000;
const MP4_AUDIO_BITRATE = 64_000;
/** 오디오를 이만큼씩 끊어 넣는다 */
const AUDIO_CHUNK_SAMPLES = AUDIO_SAMPLE_RATE; // 1초

export interface AvcConfig {
  /** avcC (AVCDecoderConfigurationRecord) */
  description: Uint8Array;
  codec: string;
  width: number;
  height: number;
}

/**
 * 키프레임 하나에서 avcC를 만든다.
 *
 * avcC는 SPS·PPS를 담고, 그 안의 profile/compat/level 세 바이트가 코덱
 * 문자열(avc1.640028)과 같은 값이다. SPS의 첫 바이트는 NAL 헤더이므로
 * 프로파일은 `sps[1]`부터다.
 */
export function buildAvcConfig(payload: Uint8Array): AvcConfig | null {
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  for (const nal of findNalUnits(payload)) {
    const bytes = payload.subarray(nal.start, nal.start + nal.length);
    if (nal.type === NAL_SPS && !sps) sps = bytes;
    else if (nal.type === NAL_PPS && !pps) pps = bytes;
  }
  if (!sps || !pps || sps.length < 4) return null;

  const info = parseSps(sps);
  const out = new Uint8Array(11 + sps.length + pps.length);
  const dv = new DataView(out.buffer);
  out[0] = 1;              // configurationVersion
  out[1] = sps[1];         // AVCProfileIndication
  out[2] = sps[2];         // profile_compatibility
  out[3] = sps[3];         // AVCLevelIndication
  out[4] = 0xff;           // 6비트 예약 + lengthSizeMinusOne = 3 (길이 4바이트)
  out[5] = 0xe1;           // 3비트 예약 + SPS 1개
  dv.setUint16(6, sps.length, false);
  out.set(sps, 8);
  let at = 8 + sps.length;
  out[at++] = 1;           // PPS 1개
  dv.setUint16(at, pps.length, false);
  at += 2;
  out.set(pps, at);

  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return {
    description: out,
    codec: info?.codec ?? `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`,
    width: info?.width ?? 0,
    height: info?.height ?? 0,
  };
}

/**
 * Annex-B 페이로드를 MP4가 쓰는 길이 접두사 형식으로 바꾼다.
 *
 * SPS·PPS는 avcC에 이미 들어가므로 뺀다. 접근 단위 구분자(AUD, 타입 9)도
 * MP4에서는 필요 없다. 나머지는 바이트 그대로 옮긴다 — 재인코딩이 아니다.
 */
export function annexBToAvcc(payload: Uint8Array): Uint8Array {
  const keep = findNalUnits(payload).filter(
    (n) => n.type !== NAL_SPS && n.type !== NAL_PPS && n.type !== 9,
  );
  let total = 0;
  for (const n of keep) total += 4 + n.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let at = 0;
  for (const n of keep) {
    dv.setUint32(at, n.length, false);
    out.set(payload.subarray(n.start, n.start + n.length), at + 4);
    at += 4 + n.length;
  }
  return out;
}

/**
 * 구간 안의 소리를 **절대 시각 자리에 맞춰** 이어 붙여 내보낸다.
 *
 * 오디오 패킷은 주차 등으로 중간이 비므로 그냥 이어 붙이면 영상과 어긋난다.
 * 비는 자리는 무음으로 채운다 (재생 쪽 audio.ts와 같은 원칙).
 */
class AudioTimeline {
  private buf = new Float32Array(new ArrayBuffer(AUDIO_CHUNK_SAMPLES * 4));
  private used = 0;
  /** 지금까지 내보낸 표본 수 (구간 시작 기준) */
  private written = 0;
  private closed = false;

  constructor(
    private readonly emit: (chunk: Float32Array<ArrayBuffer>) => Promise<void>,
  ) {}

  /** relSample 위치에 pcm을 쓴다. 순서대로 들어온다고 본다. */
  async write(relSample: number, pcm: Float32Array<ArrayBuffer>): Promise<void> {
    if (this.closed) return;
    const cursor = this.written + this.used;
    if (relSample < cursor) {
      // 겹치면 이미 쓴 만큼은 버린다 (파일 경계에서 살짝 겹칠 수 있다)
      const skip = cursor - relSample;
      if (skip >= pcm.length) return;
      pcm = pcm.subarray(skip);
      relSample = cursor;
    }
    await this.pad(relSample - cursor);
    await this.push(pcm);
  }

  private async pad(samples: number): Promise<void> {
    let left = samples;
    while (left > 0) {
      const take = Math.min(left, this.buf.length - this.used);
      this.buf.fill(0, this.used, this.used + take);
      this.used += take;
      left -= take;
      if (this.used === this.buf.length) await this.flush();
    }
  }

  private async push(pcm: Float32Array<ArrayBuffer>): Promise<void> {
    let at = 0;
    while (at < pcm.length) {
      const take = Math.min(pcm.length - at, this.buf.length - this.used);
      this.buf.set(pcm.subarray(at, at + take), this.used);
      this.used += take;
      at += take;
      if (this.used === this.buf.length) await this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.used === 0) return;
    const chunk = new Float32Array(new ArrayBuffer(this.used * 4));
    chunk.set(this.buf.subarray(0, this.used));
    await this.emit(chunk);
    this.written += this.used;
    this.used = 0;
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }
}

export interface Mp4Progress {
  ratio: number;
  name: string;
  index: number;
  total: number;
}

export interface Mp4Result {
  blob: Blob;
  /** 실제로 담긴 첫 프레임 시각 — 키프레임까지 거슬러 올라가므로 요청보다 이를 수 있다 */
  actualFromMs: number;
  segmentCount: number;
  /** 음성을 넣었는가. 인코더가 없으면 영상만 들어간다. */
  hasAudio: boolean;
}

export interface Mp4Loader {
  load(seg: SegmentInfo): Promise<{ doc: JdrDocument; src: ByteSource }>;
}

/** 이 브라우저가 MP4에 넣을 수 있는 소리 코덱. 없으면 영상만 넣는다. */
async function pickAudioCodec(): Promise<AudioCodec | null> {
  try {
    return await getFirstEncodableAudioCodec(['aac', 'opus'], {
      numberOfChannels: 1,
      sampleRate: MP4_AUDIO_RATE,
    });
  } catch {
    return null;
  }
}

/**
 * 한 채널(전방/후방)을 MP4로 만든다.
 *
 * 영상은 재인코딩 없이 옮기고, 소리는 같은 구간의 것을 함께 넣는다
 * (기기 마이크는 하나라 앞뒤가 같은 소리를 쓴다).
 */
export async function buildRangeMp4(
  channel: 0 | 1,
  segments: SegmentInfo[],
  loader: Mp4Loader,
  range: { fromMs: number; toMs: number },
  onProgress?: (p: Mp4Progress) => void,
): Promise<Mp4Result> {
  const list = segments.filter((s) => s.endMs > range.fromMs && s.startMs < range.toMs);
  if (list.length === 0) throw new Error('이 시간 구간에 해당하는 영상이 없습니다');

  // 리먹스는 H.264일 때만 된다. 그릇만 바꾸는 것이라 다른 코덱은 담을 수 없다.
  // (이 확인을 먼저 해야 한참 읽고 나서 실패하지 않는다.)
  const probe = await loader.load(list[0]);
  const srcCodec = probe.doc.video[channel]?.bitstream?.codec ?? '';
  if (!srcCodec.startsWith('avc')) {
    throw new Error(
      `이 파일의 영상은 H.264가 아니라 그대로 MP4에 담을 수 없습니다${srcCodec ? ` (${srcCodec})` : ''}. ` +
      '전방+후방 한 화면은 다시 압축하므로 그쪽은 됩니다.',
    );
  }

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });

  const videoSource = new EncodedVideoPacketSource('avc');
  output.addVideoTrack(videoSource);

  const audioCodec = await pickAudioCodec();
  let audioSource: AudioBufferSource | null = null;
  if (audioCodec) {
    audioSource = new AudioBufferSource({
      codec: audioCodec,
      bitrate: MP4_AUDIO_BITRATE,
      // 8kHz를 인코더가 받아 주느냐를 피한다. 없던 소리가 생기진 않는다.
      transform: { sampleRate: MP4_AUDIO_RATE, numberOfChannels: 1 },
    });
    output.addAudioTrack(audioSource);
  }

  await output.start();

  const timeline = audioSource
    ? new AudioTimeline(async (chunk) => {
        const ab = new AudioBuffer({
          length: chunk.length, numberOfChannels: 1, sampleRate: AUDIO_SAMPLE_RATE,
        });
        ab.copyToChannel(chunk, 0);
        await audioSource.add(ab);
      })
    : null;

  let config: AvcConfig | null = null;
  let firstMs = Infinity;
  /** 아직 시각을 모르는 마지막 프레임 (다음 프레임이 와야 길이를 안다) */
  let pending: { data: Uint8Array; key: boolean; absMs: number } | null = null;

  const pushFrame = async (nextMs: number | null): Promise<void> => {
    if (!pending || !config) return;
    const durSec = nextMs === null ? 1 / 30 : Math.max(1 / 1000, (nextMs - pending.absMs) / 1000);
    await videoSource.add(
      new EncodedPacket(
        pending.data,
        pending.key ? 'key' : 'delta',
        (pending.absMs - firstMs) / 1000,
        durSec,
      ),
      { decoderConfig: { codec: config.codec, codedWidth: config.width, codedHeight: config.height, description: config.description } },
    );
    pending = null;
  };

  for (let n = 0; n < list.length; n++) {
    const seg = list[n];
    onProgress?.({ ratio: n / list.length, name: seg.name, index: n + 1, total: list.length });
    const { doc, src } = await loader.load(seg);
    const p = doc.packets;

    // ── 영상 ──
    const isMine = (i: number) => tagKind(p.tag[i]) === TagKind.Video && tagChannel(p.tag[i]) === channel;
    let startKey = -1;
    for (let i = 0; i < p.count; i++) {
      if (!isMine(i)) continue;
      if (p.timeMs[i] > range.fromMs) break;
      if (tagIsKeyframe(p.tag[i])) startKey = i;
    }
    for (let i = Math.max(0, startKey); i < p.count; i++) {
      if (!isMine(i)) continue;
      if (p.timeMs[i] > range.toMs) break;
      if (startKey < 0 && p.timeMs[i] < range.fromMs) continue;

      const payload = await src.read(p.offset[i] + PACKET_HEADER_SIZE, p.size[i]);
      if (!config && tagIsKeyframe(p.tag[i])) config = buildAvcConfig(payload);
      if (!config) continue; // 키프레임을 만나기 전에는 담지 않는다
      if (!Number.isFinite(firstMs)) firstMs = p.timeMs[i];

      await pushFrame(p.timeMs[i]);
      pending = { data: annexBToAvcc(payload), key: tagIsKeyframe(p.tag[i]), absMs: p.timeMs[i] };
    }

    // ── 소리 ──
    if (timeline) {
      for (let i = 0; i < p.count; i++) {
        if (tagKind(p.tag[i]) !== TagKind.Audio || p.size[i] < 2) continue;
        if (p.timeMs[i] < range.fromMs || p.timeMs[i] > range.toMs) continue;
        const base = Number.isFinite(firstMs) ? firstMs : range.fromMs;
        const rel = Math.round(((p.timeMs[i] - base) / 1000) * AUDIO_SAMPLE_RATE);
        if (rel < 0) continue;
        const bytes = await src.read(p.offset[i] + PACKET_HEADER_SIZE, p.size[i]);
        await timeline.write(rel, pcmFromBytes(bytes));
      }
    }
  }

  await pushFrame(null);
  await timeline?.close();
  videoSource.close();
  audioSource?.close();
  await output.finalize();

  if (!config) throw new Error('이 구간에서 키프레임을 찾지 못했습니다');
  onProgress?.({ ratio: 1, name: '', index: list.length, total: list.length });

  const buffer = (output.target as BufferTarget).buffer;
  return {
    blob: new Blob([buffer ?? new ArrayBuffer(0)], { type: 'video/mp4' }),
    actualFromMs: Number.isFinite(firstMs) ? firstMs : range.fromMs,
    segmentCount: list.length,
    hasAudio: !!audioSource,
  };
}

// ── 전방·후방을 한 화면에 ─────────────────────────────

/** 합성본의 가로 폭. 세로는 두 채널을 위아래로 쌓은 만큼. */
const COMPOSITE_WIDTH = 960;
const COMPOSITE_BITRATE = 3_000_000;
/** 디코더가 앞서 만들어 두는 프레임 수 (GPU 메모리라 많이 쌓으면 안 된다) */
const FRAME_QUEUE_MAX = 6;

/**
 * 디코더 하나를 "다음 프레임 주세요"로 쓸 수 있게 감싼다.
 *
 * WebCodecs는 넣는 쪽과 나오는 쪽이 비동기로 따로 도므로, 그대로 두 채널을
 * 맞물리기가 어렵다. 큐를 두고 기다릴 수 있게 만든다.
 */
class FrameStream {
  private decoder: VideoDecoder;
  private queue: VideoFrame[] = [];
  private waiter: (() => void) | null = null;
  private ended = false;
  private failed: Error | null = null;

  constructor(config: VideoDecoderConfig) {
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.queue.push(frame);
        this.wake();
      },
      error: (e) => { this.failed = e instanceof Error ? e : new Error(String(e)); this.wake(); },
    });
    this.decoder.configure(config);
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  get saturated(): boolean {
    return this.queue.length >= FRAME_QUEUE_MAX || this.decoder.decodeQueueSize > FRAME_QUEUE_MAX;
  }

  decode(chunk: EncodedVideoChunk): void {
    if (this.decoder.state === 'configured') this.decoder.decode(chunk);
  }

  end(): void {
    this.ended = true;
    if (this.decoder.state === 'configured') void this.decoder.flush().then(() => this.wake()).catch(() => this.wake());
  }

  /** 다음 프레임. 더 없으면 null. */
  async next(): Promise<VideoFrame | null> {
    for (;;) {
      if (this.failed) throw this.failed;
      const frame = this.queue.shift();
      if (frame) return frame;
      if (this.ended && this.decoder.decodeQueueSize === 0) return null;
      await new Promise<void>((r) => { this.waiter = r; });
    }
  }

  close(): void {
    for (const f of this.queue) f.close();
    this.queue = [];
    if (this.decoder.state !== 'closed') this.decoder.close();
  }
}

/** 이 구간의 채널별 영상 패킷 (읽기는 나중에) */
interface FrameRef {
  seg: number;
  index: number;
  absMs: number;
  key: boolean;
}

function collectFrames(doc: JdrDocument, channel: number, range: { fromMs: number; toMs: number }, segIdx: number): FrameRef[] {
  const p = doc.packets;
  const mine = (i: number) => tagKind(p.tag[i]) === TagKind.Video && tagChannel(p.tag[i]) === channel;
  let startKey = -1;
  for (let i = 0; i < p.count; i++) {
    if (!mine(i)) continue;
    if (p.timeMs[i] > range.fromMs) break;
    if (tagIsKeyframe(p.tag[i])) startKey = i;
  }
  const out: FrameRef[] = [];
  for (let i = Math.max(0, startKey); i < p.count; i++) {
    if (!mine(i)) continue;
    if (p.timeMs[i] > range.toMs) break;
    if (startKey < 0 && p.timeMs[i] < range.fromMs) continue;
    out.push({ seg: segIdx, index: i, absMs: p.timeMs[i], key: tagIsKeyframe(p.tag[i]) });
  }
  return out;
}

/**
 * 전방·후방을 위아래로 붙여 하나의 MP4로.
 *
 * 이건 **재인코딩**이다. 두 채널을 풀어 그림으로 만든 뒤 다시 압축하므로
 * 리먹스와 달리 느리고 배터리를 많이 쓴다. 대신 보고서에 붙이기 좋은
 * 파일 하나가 나온다.
 *
 * 우리가 그린 글자(채널 이름·시각)와 기기가 영상에 새긴 글자가 헷갈리면
 * 안 되므로, 화면 구석에 만든 주체를 밝힌다.
 */
export async function buildCompositeMp4(
  segments: SegmentInfo[],
  loader: Mp4Loader,
  range: { fromMs: number; toMs: number },
  codecOverride: string | undefined,
  onProgress?: (p: Mp4Progress) => void,
): Promise<Mp4Result> {
  const list = segments.filter((s) => s.endMs > range.fromMs && s.startMs < range.toMs);
  if (list.length === 0) throw new Error('이 시간 구간에 해당하는 영상이 없습니다');

  // 먼저 프레임 목록과 해상도를 모은다 (파싱 결과는 로더가 캐시한다)
  const loaded: { doc: JdrDocument; src: ByteSource }[] = [];
  const front: FrameRef[] = [];
  const rear: FrameRef[] = [];
  for (let n = 0; n < list.length; n++) {
    const one = await loader.load(list[n]);
    loaded.push(one);
    front.push(...collectFrames(one.doc, 0, range, n));
    rear.push(...collectFrames(one.doc, 1, range, n));
  }
  if (front.length === 0) throw new Error('전방 영상이 없어 합성할 수 없습니다');

  const shape = loaded[0].doc.video[0]?.bitstream;
  const w = shape?.width || 1280;
  const h = shape?.height || 720;
  const cellW = COMPOSITE_WIDTH;
  const cellH = Math.round((h / w) * cellW / 2) * 2;
  const hasRear = rear.length > 0;
  const outW = cellW;
  const outH = hasRear ? cellH * 2 : cellH;

  const videoCodec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'vp8'], {
    width: outW, height: outH, bitrate: COMPOSITE_BITRATE,
  });
  if (!videoCodec) throw new Error('이 브라우저에서는 영상을 인코딩할 수 없습니다');

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('캔버스를 만들 수 없습니다');

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  const videoSource = new CanvasSource(canvas, { codec: videoCodec, bitrate: COMPOSITE_BITRATE });
  output.addVideoTrack(videoSource);

  const audioCodec = await pickAudioCodec();
  let audioSource: AudioBufferSource | null = null;
  if (audioCodec) {
    audioSource = new AudioBufferSource({
      codec: audioCodec, bitrate: MP4_AUDIO_BITRATE,
      transform: { sampleRate: MP4_AUDIO_RATE, numberOfChannels: 1 },
    });
    output.addAudioTrack(audioSource);
  }
  await output.start();

  const firstMs = front[0].absMs;
  const decoderConfig: VideoDecoderConfig = {
    codec: codecOverride ?? loaded[0].doc.video[0]?.bitstream?.codec ?? 'avc1.640028',
    codedWidth: w, codedHeight: h, optimizeForLatency: true,
    // description 없음 → Annex-B 그대로
  };

  const fs = new FrameStream(decoderConfig);
  const rs = hasRear ? new FrameStream(decoderConfig) : null;

  /** 패킷을 읽어 디코더에 밀어 넣는 공급기 */
  const feeder = (refs: FrameRef[], stream: FrameStream) => {
    let at = 0;
    return async (): Promise<void> => {
      while (at < refs.length && !stream.saturated) {
        const r = refs[at++];
        const { doc, src } = loaded[r.seg];
        const p = doc.packets;
        const payload = await src.read(p.offset[r.index] + PACKET_HEADER_SIZE, p.size[r.index]);
        stream.decode(new EncodedVideoChunk({
          type: r.key ? 'key' : 'delta',
          timestamp: (r.absMs - firstMs) * 1000,
          data: payload,
        }));
      }
      if (at >= refs.length) stream.end();
    };
  };
  const feedFront = feeder(front, fs);
  const feedRear = rs ? feeder(rear, rs) : null;

  const label = (text: string, x: number, y: number): void => {
    ctx.font = 'bold 16px sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(x, y, ctx.measureText(text).width + 12, 24);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x + 6, y + 17);
  };

  let rearFrame: VideoFrame | null = null;
  let done = 0;
  try {
    for (;;) {
      await feedFront();
      await feedRear?.();
      const f = await fs.next();
      if (!f) break;

      // 후방은 같은 시각에 가장 가까운 프레임을 쓴다
      if (rs) {
        while (!rearFrame || rearFrame.timestamp < f.timestamp - 16_000) {
          const next = await rs.next();
          if (!next) break;
          rearFrame?.close();
          rearFrame = next;
          await feedRear?.();
        }
      }

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(f, 0, 0, cellW, cellH);
      if (rearFrame) ctx.drawImage(rearFrame, 0, cellH, cellW, cellH);
      label('전방 CH0', 8, 8);
      if (rearFrame) label('후방 CH1', 8, cellH + 8);
      label('JDR Viewer 합성', 8, outH - 32);

      const tsSec = f.timestamp / 1_000_000;
      f.close();
      await videoSource.add(tsSec, 1 / 30);

      done++;
      if ((done & 15) === 0) {
        onProgress?.({ ratio: done / front.length, name: `${done}/${front.length}프레임`, index: done, total: front.length });
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  } finally {
    rearFrame?.close();
    fs.close();
    rs?.close();
  }

  // ── 소리 ──
  if (audioSource) {
    const timeline = new AudioTimeline(async (chunk) => {
      const ab = new AudioBuffer({ length: chunk.length, numberOfChannels: 1, sampleRate: AUDIO_SAMPLE_RATE });
      ab.copyToChannel(chunk, 0);
      await audioSource.add(ab);
    });
    for (const { doc, src } of loaded) {
      const p = doc.packets;
      for (let i = 0; i < p.count; i++) {
        if (tagKind(p.tag[i]) !== TagKind.Audio || p.size[i] < 2) continue;
        if (p.timeMs[i] < range.fromMs || p.timeMs[i] > range.toMs) continue;
        const rel = Math.round(((p.timeMs[i] - firstMs) / 1000) * AUDIO_SAMPLE_RATE);
        if (rel < 0) continue;
        await timeline.write(rel, pcmFromBytes(await src.read(p.offset[i] + PACKET_HEADER_SIZE, p.size[i])));
      }
    }
    await timeline.close();
  }

  videoSource.close();
  audioSource?.close();
  await output.finalize();
  onProgress?.({ ratio: 1, name: '', index: front.length, total: front.length });

  const buffer = (output.target as BufferTarget).buffer;
  return {
    blob: new Blob([buffer ?? new ArrayBuffer(0)], { type: 'video/mp4' }),
    actualFromMs: firstMs,
    segmentCount: list.length,
    hasAudio: !!audioSource,
  };
}
