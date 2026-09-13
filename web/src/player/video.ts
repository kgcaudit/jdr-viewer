/**
 * 채널 하나를 담당하는 WebCodecs 디코더 + 캔버스 렌더러.
 *
 * 안드로이드 MediaCodec과 달리 description을 생략하면 Annex-B를 그대로 받아준다.
 * JDR 태그(00VI/00VP)가 key/delta를 알려주므로 비트스트림을 뒤질 필요도 없다.
 */
import type { ByteSource } from '../core/byte-source';
import type { JdrDocument } from '../core/types';
import { PACKET_HEADER_SIZE, buildKeyChunk } from '../core/parser';
import { buildFrameIndex, keyframeAtOrBefore, type FrameIndex } from './index';

/** 디코더에 미리 넣어둘 프레임 수 */
const QUEUE_TARGET = 16;
/** 렌더 대기열 최대치 (VideoFrame은 GPU 메모리를 잡으므로 많이 쌓으면 안 된다) */
const PENDING_MAX = 6;

export interface ChannelStatus {
  available: boolean;
  reason?: string;
  width: number;
  height: number;
  codec: string | null;
}

export class ChannelVideo {
  readonly index: FrameIndex;
  private decoder: VideoDecoder | null = null;
  private pending: VideoFrame[] = [];
  private nextFrame = 0;
  private feeding = false;
  /** 시크할 때마다 올려서, 진행 중이던 비동기 읽기 결과를 버린다 */
  private generation = 0;
  private config: VideoDecoderConfig | null = null;
  private parameterSets: Uint8Array | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private lastDrawnMs = -1;
  status: ChannelStatus = { available: false, width: 0, height: 0, codec: null };
  /** 끊김을 진단하기 위한 계수 (?debug=1 일 때 화면에 표시) */
  readonly stats = { decoded: 0, rendered: 0, dropped: 0 };

  constructor(
    private readonly doc: JdrDocument,
    private readonly src: ByteSource,
    readonly channel: number,
    private readonly canvas: HTMLCanvasElement,
    private readonly onError: (msg: string) => void,
    /** 코덱 자동 판별이 실패하는 JDR 변형을 위한 수동 지정 (?codec=...) */
    private readonly codecOverride?: string,
  ) {
    this.index = buildFrameIndex(doc, channel);
  }

  get frameCount(): number {
    return this.index.count;
  }

  async init(): Promise<ChannelStatus> {
    const info = this.doc.video[this.channel];
    if (!info || this.index.count === 0) {
      this.status = { available: false, reason: '이 채널에는 영상이 없습니다', width: 0, height: 0, codec: null };
      return this.status;
    }
    const bs = info.bitstream;
    // 코덱 문자열을 못 구했으면 가장 흔한 baseline으로 시도한다.
    const codec = this.codecOverride ?? bs?.codec ?? 'avc1.42E01E';
    this.parameterSets = bs?.parameterSets ?? null;

    const config: VideoDecoderConfig = {
      codec,
      // 파일 재생에서는 저지연보다 고른 처리량이 중요하다.
      // true면 디코더가 버퍼링을 거의 하지 않아 프레임이 튀는 원인이 된다.
      optimizeForLatency: false,
      hardwareAcceleration: 'prefer-hardware',
      // description 없음 → Annex-B 모드
    };
    if (bs?.width && bs.height) {
      config.codedWidth = bs.width;
      config.codedHeight = bs.height;
    }

    try {
      let support = await VideoDecoder.isConfigSupported(config);
      if (!support.supported) {
        // 하드웨어 디코더를 못 쓰는 기기면 지정을 빼고 다시 확인한다
        delete config.hardwareAcceleration;
        support = await VideoDecoder.isConfigSupported(config);
      }
      if (!support.supported) {
        this.status = {
          available: false,
          reason: `이 브라우저가 ${codec} 디코딩을 지원하지 않습니다`,
          width: bs?.width ?? 0, height: bs?.height ?? 0, codec,
        };
        return this.status;
      }
    } catch (e) {
      this.status = {
        available: false,
        reason: `디코더 설정 확인 실패: ${e instanceof Error ? e.message : String(e)}`,
        width: 0, height: 0, codec,
      };
      return this.status;
    }

    this.config = config;
    // desynchronized: 합성기와의 동기화를 풀어 모바일에서 프레임 지연을 줄인다
    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.setCanvasSize(bs?.width || 1280, bs?.height || 720);
    this.status = {
      available: true,
      width: bs?.width ?? 0,
      height: bs?.height ?? 0,
      codec,
    };
    this.createDecoder();
    return this.status;
  }

  /** 크기가 실제로 달라질 때만 바꾼다. width 대입은 그 자체로 캔버스를 지운다. */
  private setCanvasSize(width: number, height: number): void {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.fillBlack();
  }

  /** 전환 중 이전 프레임이 남아 보이지 않도록 검게 채운다 */
  fillBlack(): void {
    const ctx = this.ctx ?? this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private createDecoder(): void {
    if (!this.config) return;
    this.decoder = new VideoDecoder({
      // reset()이 이전 작업의 출력 콜백을 취소해 주므로 여기서 generation을 따로
      // 가둬둘 필요가 없다. 가둬두면 seek 이후 모든 프레임이 버려진다.
      output: (frame) => {
        if (frame.displayWidth > 0) {
          this.setCanvasSize(frame.displayWidth, frame.displayHeight);
          this.status.width = frame.displayWidth;
          this.status.height = frame.displayHeight;
        }
        this.stats.decoded++;
        this.pending.push(frame);
        while (this.pending.length > PENDING_MAX) {
          this.pending.shift()!.close();
          this.stats.dropped++;
        }
      },
      error: (e) => {
        this.status.available = false;
        this.status.reason = e.message;
        this.onError(`채널 ${this.channel} 디코딩 오류: ${e.message}`);
      },
    });
    this.decoder.configure(this.config);
  }

  /** 지정 시각으로 이동. 해당 시각 이전의 마지막 키프레임부터 다시 공급한다. */
  seek(relMs: number): void {
    if (!this.decoder || !this.config) return;
    this.generation++;
    for (const f of this.pending) f.close();
    this.pending = [];
    this.lastDrawnMs = -1;
    try {
      this.decoder.reset();
      this.decoder.configure(this.config);
    } catch {
      this.decoder.close();
      this.createDecoder();
    }
    this.nextFrame = keyframeAtOrBefore(this.index, relMs);
  }

  /** 현재 시각 기준으로 디코더에 프레임을 채워 넣는다. */
  async pump(currentMs: number): Promise<void> {
    if (this.feeding || !this.decoder || !this.status.available) return;
    this.feeding = true;
    const gen = this.generation;
    try {
      while (
        gen === this.generation &&
        this.nextFrame < this.index.count &&
        this.decoder.state === 'configured' &&
        this.decoder.decodeQueueSize < QUEUE_TARGET &&
        this.pending.length < PENDING_MAX
      ) {
        const f = this.nextFrame;
        // 너무 먼 미래까지 미리 읽지 않는다
        if (this.index.relMs[f] > currentMs + 2000 && this.decoder.decodeQueueSize > 2) break;

        const pi = this.index.packetIndex[f];
        const payload = await this.src.read(
          this.doc.packets.offset[pi] + PACKET_HEADER_SIZE,
          this.doc.packets.size[pi],
        );
        if (gen !== this.generation) return;

        const isKey = this.index.isKey[f] === 1;
        // Annex-B에서 key 청크는 SPS/PPS를 포함해야 한다. 없으면 앞에 붙인다.
        const data = isKey ? buildKeyChunk(payload, this.parameterSets) : payload;
        this.decoder.decode(
          new EncodedVideoChunk({
            type: isKey ? 'key' : 'delta',
            timestamp: Math.round(this.index.relMs[f] * 1000),
            data,
          }),
        );
        this.nextFrame = f + 1;
      }
    } catch (e) {
      this.onError(`채널 ${this.channel} 공급 오류: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.feeding = false;
    }
  }

  /** 현재 시각에 해당하는 프레임을 캔버스에 그린다. 그렸으면 true. */
  render(currentMs: number): boolean {
    if (!this.ctx || this.pending.length === 0) return false;
    const targetUs = currentMs * 1000;
    let chosen: VideoFrame | null = null;
    while (this.pending.length > 0 && this.pending[0].timestamp <= targetUs) {
      if (chosen) {
        chosen.close();
        this.stats.dropped++;   // 시간을 이미 지나친 프레임은 건너뛴다
      }
      chosen = this.pending.shift()!;
    }
    // 아직 첫 프레임도 못 그렸으면 가장 이른 프레임이라도 보여준다
    if (!chosen && this.lastDrawnMs < 0 && this.pending.length > 0) chosen = this.pending.shift()!;
    if (!chosen) return false;

    if (chosen.displayWidth === this.canvas.width && chosen.displayHeight === this.canvas.height) {
      this.ctx.drawImage(chosen, 0, 0);
    } else {
      this.ctx.drawImage(chosen, 0, 0, this.canvas.width, this.canvas.height);
    }
    this.lastDrawnMs = chosen.timestamp / 1000;
    this.stats.rendered++;
    chosen.close(); // 반드시 닫아야 한다 — 안 닫으면 GPU 메모리가 금방 고갈된다
    return true;
  }

  close(): void {
    this.generation++;
    for (const f of this.pending) f.close();
    this.pending = [];
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
  }
}
