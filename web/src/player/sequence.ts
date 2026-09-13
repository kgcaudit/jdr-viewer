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
import type { ByteSource } from '../core/byte-source';
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
  private lastAbsMs: number;

  onTimeUpdate: ((absMs: number, segIndex: number) => void) | null = null;
  onPlayingChange: ((playing: boolean) => void) | null = null;
  onSegmentChange: ((segIndex: number, status: PlayerStatus | null) => void) | null = null;

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
    if (this.switching) return null;
    this.switching = true;
    const seg = this.lib.segments[index];
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
