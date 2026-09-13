/** 영상 2채널 + 음성을 하나의 시간축으로 묶는 재생 엔진. */
import type { ByteSource } from '../core/byte-source';
import type { JdrDocument } from '../core/types';
import { AudioPlayer } from './audio';
import { ChannelVideo, type ChannelStatus } from './video';
import { hasWebCodecs } from './index';

export interface PlayerStatus {
  channels: ChannelStatus[];
  hasAudio: boolean;
  webCodecs: boolean;
}

export class JdrPlayer {
  private channels: ChannelVideo[] = [];
  private audio: AudioPlayer;
  private raf = 0;
  private playing = false;
  private speed = 1;
  /** 상대 시각 (ms). 재생의 단일 진실 공급원. */
  private positionMs = 0;
  /** performance.now() 기반 클럭용 기준점 */
  private wallOrigin = 0;
  private posOrigin = 0;

  onTimeUpdate: ((ms: number) => void) | null = null;
  onPlayingChange: ((playing: boolean) => void) | null = null;
  /** 끝까지 재생됐을 때. 사용자가 누른 일시정지와 구분하기 위해 따로 둔다. */
  onEnded: (() => void) | null = null;

  readonly durationMs: number;

  constructor(
    private readonly doc: JdrDocument,
    src: ByteSource,
    canvases: HTMLCanvasElement[],
    private readonly onError: (msg: string) => void,
    codecOverride?: string,
  ) {
    this.durationMs = Math.max(0, doc.durationSec * 1000);
    this.audio = new AudioPlayer(doc, src);
    if (hasWebCodecs()) {
      for (let ch = 0; ch < canvases.length; ch++) {
        this.channels.push(new ChannelVideo(doc, src, ch, canvases[ch], onError, codecOverride));
      }
    }
  }

  async init(): Promise<PlayerStatus> {
    const channels: ChannelStatus[] = [];
    for (const c of this.channels) channels.push(await c.init());
    if (this.channels.length === 0) {
      for (let ch = 0; ch < 2; ch++) {
        channels.push({
          available: false,
          reason: '이 브라우저는 WebCodecs를 지원하지 않아 영상을 재생할 수 없습니다',
          width: this.doc.video[ch]?.bitstream?.width ?? 0,
          height: this.doc.video[ch]?.bitstream?.height ?? 0,
          codec: this.doc.video[ch]?.bitstream?.codec ?? null,
        });
      }
    }
    // 첫 화면을 보여주기 위해 0초 위치로 한 번 채운다.
    // init()이 오래 걸리는 동안 사용자가 이미 재생을 눌렀을 수 있으므로 그때는 건드리지 않는다.
    if (!this.playing && this.positionMs === 0) {
      this.seek(0);
      void this.pumpOnce();
    }
    return { channels, hasAudio: this.audio.hasAudio, webCodecs: hasWebCodecs() };
  }

  get position(): number {
    return this.positionMs;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** 재생 진단용 계수 (?debug=1) */
  get channelStats(): { decoded: number; rendered: number; dropped: number }[] {
    return this.channels.map((c) => ({ ...c.stats }));
  }

  async play(): Promise<void> {
    if (this.playing) return;
    if (this.positionMs >= this.durationMs) this.seek(0);
    this.playing = true;
    this.wallOrigin = performance.now();
    this.posOrigin = this.positionMs;
    // 배속에서도 음성을 낸다. 음높이는 시간 신축으로 지킨다(core/timestretch.ts).
    // 오디오 장치가 없거나 8kHz를 못 열어도 영상 재생은 계속되어야 한다.
    try {
      this.audio.setSpeed(this.speed);
      await this.audio.start(this.positionMs);
    } catch (e) {
      this.onError(`음성 재생 실패 (영상은 계속 재생됩니다): ${e instanceof Error ? e.message : String(e)}`);
    }
    this.onPlayingChange?.(true);
    this.loop();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.audio.stop();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.onPlayingChange?.(false);
  }

  seek(ms: number): void {
    const clamped = Math.max(0, Math.min(ms, this.durationMs));
    this.positionMs = clamped;
    this.posOrigin = clamped;
    this.wallOrigin = performance.now();
    for (const c of this.channels) c.seek(clamped);
    if (this.playing) {
      void this.audio.start(clamped);
    }
    this.onTimeUpdate?.(clamped);
  }

  setSpeed(speed: number): void {
    if (speed === this.speed) return;
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.speed = speed;
    // 예약해 둔 소리는 옛 배속이라 못 쓴다. play()가 새로 잡는다.
    this.audio.setSpeed(speed);
    if (wasPlaying) void this.play();
  }

  getSpeed(): number {
    return this.speed;
  }

  setMuted(muted: boolean): void {
    this.audio.setMuted(muted);
  }

  /** 정지 상태에서 한 프레임 이동 */
  async step(delta: number): Promise<void> {
    const ch = this.channels.find((c) => c.status.available) ?? this.channels[0];
    if (!ch) return;
    const idx = ch.index;
    let f = 0;
    while (f < idx.count && idx.relMs[f] <= this.positionMs) f++;
    const target = Math.max(0, Math.min(idx.count - 1, f - 1 + delta));
    this.seek(idx.relMs[target] + 0.5);
    await this.pumpOnce();
  }

  /** 정지 상태에서도 현재 위치 프레임을 그려준다. */
  async pumpOnce(timeoutMs = 700): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    const targets = this.channels.filter((c) => c.status.available);
    const drawn = new Set<ChannelVideo>();
    while (performance.now() < deadline && drawn.size < targets.length) {
      for (const c of targets) {
        await c.pump(this.positionMs);
        if (c.render(this.positionMs)) drawn.add(c);
      }
      if (drawn.size >= targets.length) break;
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  private loop = (): void => {
    if (!this.playing) return;
    const audioMs = this.audio.currentMs();
    // 오디오가 있으면 그것이 마스터 클럭. 없으면 벽시계.
    this.positionMs =
      audioMs !== null
        ? audioMs
        : this.posOrigin + (performance.now() - this.wallOrigin) * this.speed;

    if (this.positionMs >= this.durationMs) {
      this.positionMs = this.durationMs;
      this.onTimeUpdate?.(this.positionMs);
      this.pause();
      this.onEnded?.();
      return;
    }

    for (const c of this.channels) {
      void c.pump(this.positionMs);
      c.render(this.positionMs);
    }
    void this.audio.tick();
    this.onTimeUpdate?.(this.positionMs);
    this.raf = requestAnimationFrame(this.loop);
  };

  close(): void {
    this.pause();
    for (const c of this.channels) c.close();
    this.audio.close();
  }
}
