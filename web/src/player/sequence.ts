/**
 * 여러 세그먼트를 하나의 벽시계 타임라인으로 이어 재생한다 (D1: 연속 병합).
 *
 * 구조는 단순하게 간다 — 현재 세그먼트 하나를 기존 JdrPlayer에 맡기고,
 * 경계에서 다음 세그먼트로 갈아탄다. 그래서 디코더 재설정에 따른
 * 짧은 끊김이 생길 수 있는데(D3), 다음 세그먼트를 미리 파싱해 두어 줄인다.
 *
 * 위치는 언제나 **절대 벽시계 시각(ms)** 이다. 어느 파일에서 온 프레임인지
 * 항상 되짚을 수 있어야 하므로 세그먼트 인덱스를 함께 통지한다.
 */
import { BufferedByteSource, type ByteSource } from '../core/byte-source';
import type { JdrDocument } from '../core/types';
import type { SegmentInfo } from '../core/segment';
import { type Library, gapAt, resolvePlayPosition, segmentIndexAt } from '../core/library';
import { JdrPlayer, type PlayerStatus } from './player';

export interface LoadedSegment {
  doc: JdrDocument;
  src: ByteSource;
}

export interface SegmentLoader {
  load(seg: SegmentInfo): Promise<LoadedSegment>;
}

/** 경계 몇 ms 전부터 다음 세그먼트를 미리 읽을지 */
const PRELOAD_LEAD_MS = 2500;
/** ⏮ 을 눌렀을 때, 이 시간 안이면 이전 파일로 / 지났으면 현재 파일 처음으로 (플레이어 관례) */
const PREV_FILE_RESTART_MS = 3000;

export class SequencePlayer {
  private inner: JdrPlayer | null = null;
  private current: LoadedSegment | null = null;
  private index = -1;
  private preloading: string | null = null;
  private preloaded: { id: string; loaded: LoadedSegment } | null = null;
  private wantPlaying = false;
  private speed = 1;
  private muted = false;
  private switching = false;
  /** 전환 중에 들어온 요청. 버리지 않고 마지막 것을 이어서 처리한다. */
  private pendingTarget: { index: number; absMs: number } | null = null;
  private lastAbsMs: number;

  onTimeUpdate: ((absMs: number, segIndex: number) => void) | null = null;
  onPlayingChange: ((playing: boolean) => void) | null = null;
  onSegmentChange: ((segIndex: number, status: PlayerStatus | null) => void) | null = null;
  /** 구간을 여는 중임을 알린다 (파싱에 수십~수백 ms가 걸린다) */
  onSegmentLoading: ((segIndex: number) => void) | null = null;

  constructor(
    private readonly lib: Library,
    private readonly loader: SegmentLoader,
    private readonly canvases: HTMLCanvasElement[],
    private readonly onError: (msg: string) => void,
    private readonly codecOverride?: string,
  ) {
    this.lastAbsMs = lib.startMs;
  }

  get startMs(): number { return this.lib.startMs; }
  get endMs(): number { return this.lib.endMs; }
  get spanMs(): number { return this.lib.spanMs; }
  get position(): number { return this.lastAbsMs; }
  get segmentIndex(): number { return this.index; }
  get currentSegment(): SegmentInfo | null {
    return this.index >= 0 ? this.lib.segments[this.index] : null;
  }
  /** 현재 재생 중인 세그먼트의 파싱 결과 (요약 패널 등에서 쓴다) */
  get currentDoc(): JdrDocument | null {
    return this.current?.doc ?? null;
  }
  get currentSource(): ByteSource | null {
    return this.current?.src ?? null;
  }
  get isPlaying(): boolean { return this.wantPlaying; }
  get channelStats(): { decoded: number; rendered: number; dropped: number }[] {
    return this.inner?.channelStats ?? [];
  }

  /** 읽기 진단 — waitMs가 크면 끊김의 원인이 디코딩이 아니라 파일 읽기다 */
  get ioStats(): { hits: number; misses: number; waitMs: number } | null {
    const src = this.current?.src;
    return src instanceof BufferedByteSource
      ? { hits: src.stats.hits, misses: src.stats.misses, waitMs: src.stats.waitMs }
      : null;
  }

  /** 첫 세그먼트를 붙이고 첫 프레임을 띄운다. */
  async init(): Promise<PlayerStatus | null> {
    if (this.lib.segments.length === 0) return null;
    return this.activate(0, this.lib.segments[0].startMs);
  }

  async play(): Promise<void> {
    if (this.wantPlaying) return;
    this.wantPlaying = true;
    this.onPlayingChange?.(true);
    if (this.lastAbsMs >= this.lib.endMs) await this.seek(this.lib.startMs);
    await this.inner?.play();
  }

  pause(): void {
    if (!this.wantPlaying) return;
    this.wantPlaying = false;
    this.inner?.pause();
    this.onPlayingChange?.(false);
  }

  /** 절대 시각으로 이동. 빈 구간이면 다음 세그먼트 시작으로 건너뛴다 (D2). */
  async seek(absMs: number): Promise<void> {
    const clamped = Math.max(this.lib.startMs, Math.min(absMs, this.lib.endMs));
    const target = resolvePlayPosition(this.lib, clamped);
    if (!target) return;
    if (target.index === this.index && this.inner) {
      const rel = target.absMs - this.lib.segments[this.index].startMs;
      this.inner.seek(rel);
      this.lastAbsMs = target.absMs;
      this.onTimeUpdate?.(target.absMs, this.index);
      if (!this.wantPlaying) await this.inner.pumpOnce();
      return;
    }
    await this.activate(target.index, target.absMs);
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.inner?.setSpeed(speed);
  }

  getSpeed(): number { return this.speed; }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.inner?.setMuted(muted);
  }

  async step(delta: number): Promise<void> {
    if (!this.inner) return;
    await this.inner.step(delta);
  }

  // ── 파일 단위 조작 ─────────────────────────────────

  /** 현재 파일 안에서의 위치(ms) */
  get filePosition(): number {
    if (this.inner) return this.inner.position;
    const seg = this.currentSegment;
    return seg ? Math.max(0, this.lastAbsMs - seg.startMs) : 0;
  }

  /**
   * 현재 파일의 길이(ms).
   * 헤더에 적힌 종료 시각이 실제 마지막 패킷보다 이를 수 있으므로,
   * 실제로 재생 중인 문서의 길이를 쓴다. 안 그러면 "1:10.7 / 1:08.9"처럼 넘어간다.
   */
  get fileDuration(): number {
    return this.inner?.durationMs ?? this.currentSegment?.durationMs ?? 0;
  }

  get segmentCount(): number {
    return this.lib.segments.length;
  }

  /** 현재 파일 안에서 이동 */
  async seekInFile(relMs: number): Promise<void> {
    const seg = this.currentSegment;
    if (!seg) return;
    await this.seek(seg.startMs + Math.max(0, Math.min(relMs, this.fileDuration)));
  }

  /** 초 단위 건너뛰기. 파일 경계를 넘으면 앞/뒤 파일로 이어진다. */
  async skip(deltaMs: number): Promise<void> {
    await this.seek(this.lastAbsMs + deltaMs);
  }

  /**
   * 이전 파일. 재생이 막 시작됐으면 앞 파일로, 조금 지났으면 현재 파일 처음으로 간다.
   * 오디오 플레이어의 오랜 관례이고, 잘못 눌렀을 때 복구가 쉽다.
   */
  async prevFile(): Promise<void> {
    if (this.index < 0) return;
    if (this.filePosition > PREV_FILE_RESTART_MS) {
      await this.seekInFile(0);
      return;
    }
    if (this.index > 0) await this.openSegment(this.index - 1);
    else await this.seekInFile(0);
  }

  async nextFile(): Promise<void> {
    if (this.index < 0) return;
    if (this.index + 1 < this.lib.segments.length) await this.openSegment(this.index + 1);
    else await this.seekInFile(this.fileDuration);
  }

  async pumpOnce(): Promise<void> {
    await this.inner?.pumpOnce();
  }

  /** 특정 세그먼트를 처음부터 재생 */
  async openSegment(index: number): Promise<void> {
    const seg = this.lib.segments[index];
    if (!seg) return;
    await this.activate(index, seg.startMs);
  }

  close(): void {
    this.wantPlaying = false;
    this.inner?.close();
    this.inner = null;
    this.current = null;
    this.preloaded = null;
  }

  // ── 내부 ───────────────────────────────────────────

  private async activate(index: number, absMs: number): Promise<PlayerStatus | null> {
    // 구간 전환에는 파싱·디코더 재설정이 필요해 수백 ms가 걸린다.
    // 그 사이의 클릭을 버리면 "눌러도 반응이 없는" 상태가 되므로 마지막 요청을 기억해 둔다.
    if (this.switching) {
      this.pendingTarget = { index, absMs };
      return null;
    }
    this.switching = true;
    const seg = this.lib.segments[index];
    // 새 구간의 첫 프레임이 나오기까지 이전 화면이 남아 있으면 잔상으로 보인다
    this.clearCanvases();
    this.onSegmentLoading?.(index);
    try {
      const loaded = await this.take(seg);
      this.inner?.close();
      this.current = loaded;

      const player = new JdrPlayer(loaded.doc, loaded.src, this.canvases, this.onError, this.codecOverride);
      this.inner = player;
      this.index = index;
      this.lastAbsMs = absMs;

      player.onTimeUpdate = (relMs) => {
        const abs = seg.startMs + relMs;
        this.lastAbsMs = abs;
        this.onTimeUpdate?.(abs, index);
        this.maybePreload(abs, index);
      };
      player.onEnded = () => void this.advance(index);

      const status = await player.init();
      player.setSpeed(this.speed);
      player.setMuted(this.muted);
      this.onSegmentChange?.(index, status);

      const rel = Math.max(0, absMs - seg.startMs);
      if (rel > 0) player.seek(rel);
      if (this.wantPlaying) await player.play();
      else await player.pumpOnce();
      return status;
    } catch (e) {
      this.onError(`${seg.name} 를 열지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      this.switching = false;
      const next = this.pendingTarget;
      if (next) {
        this.pendingTarget = null;
        void this.activate(next.index, next.absMs);
      }
    }
  }

  /** 구간이 바뀌는 동안 이전 프레임이 남지 않도록 검게 지운다 */
  private clearCanvases(): void {
    for (const c of this.canvases) {
      const ctx = c.getContext('2d');
      if (!ctx) continue;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, c.width, c.height);
    }
  }

  /** 미리 읽어둔 게 있으면 그것을 쓰고, 없으면 지금 읽는다. */
  private async take(seg: SegmentInfo): Promise<LoadedSegment> {
    if (this.preloaded?.id === seg.id) {
      const loaded = this.preloaded.loaded;
      this.preloaded = null;
      return loaded;
    }
    return this.loader.load(seg);
  }

  private maybePreload(absMs: number, index: number): void {
    const seg = this.lib.segments[index];
    const next = this.lib.segments[index + 1];
    if (!seg || !next) return;
    if (seg.endMs - absMs > PRELOAD_LEAD_MS) return;
    if (this.preloaded?.id === next.id || this.preloading === next.id) return;

    this.preloading = next.id;
    void this.loader
      .load(next)
      .then((loaded) => {
        if (this.preloading === next.id) this.preloaded = { id: next.id, loaded };
      })
      .catch(() => { /* 미리 읽기 실패는 조용히 넘어가고, 실제 전환 때 다시 시도한다 */ })
      .finally(() => {
        if (this.preloading === next.id) this.preloading = null;
      });
  }

  private async advance(fromIndex: number): Promise<void> {
    const next = fromIndex + 1;
    if (next >= this.lib.segments.length) {
      this.wantPlaying = false;
      this.onPlayingChange?.(false);
      return;
    }
    await this.activate(next, this.lib.segments[next].startMs);
  }

  /** 현재 시각이 빈 구간인지 (UI 표시용) */
  gapAtPosition(): ReturnType<typeof gapAt> {
    return gapAt(this.lib, this.lastAbsMs);
  }

  segmentAt(absMs: number): number {
    return segmentIndexAt(this.lib, absMs);
  }
}
