/**
 * PCM s16le 8kHz mono 재생 + 마스터 클럭.
 *
 * AudioContext.currentTime이 정밀한 클럭이라 A/V 동기의 기준으로 쓴다.
 * 오디오 패킷은 주차모드 등으로 중간이 비므로, 절대 시각 기준으로 배치하고
 * 빈 구간은 무음으로 채운다 (원본 Python 도구는 단순 이어붙이기라 어긋난다).
 */
import type { ByteSource } from '../core/byte-source';
import type { JdrDocument } from '../core/types';
import { PACKET_HEADER_SIZE, AUDIO_SAMPLE_RATE } from '../core/parser';
import { TagKind, tagKind } from '../core/tags';

/** 한 번에 만들어 예약하는 오디오 구간 길이 */
const SEGMENT_MS = 500;
/** 미리 예약해 둘 길이 */
const SCHEDULE_AHEAD_MS = 1500;

interface AudioPacketRef {
  startMs: number;
  endMs: number;
  offset: number;
  size: number;
}

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private refs: AudioPacketRef[] = [];
  private sources: AudioBufferSourceNode[] = [];
  /** 예약이 끝난 지점(상대 ms) */
  private scheduledMs = 0;
  /** 재생 시작 시점의 상대 ms */
  private originMs = 0;
  /** 재생 시작 시점의 ctx.currentTime */
  private originCtx = 0;
  private running = false;
  private scheduling = false;
  readonly hasAudio: boolean;

  constructor(doc: JdrDocument, private readonly src: ByteSource) {
    const p = doc.packets;
    for (let i = 0; i < p.count; i++) {
      if (tagKind(p.tag[i]) !== TagKind.Audio || p.size[i] < 2) continue;
      const startMs = p.timeMs[i] - doc.firstTimeMs;
      if (!Number.isFinite(startMs)) continue;
      this.refs.push({
        startMs,
        endMs: startMs + (p.size[i] / 2 / AUDIO_SAMPLE_RATE) * 1000,
        offset: p.offset[i] + PACKET_HEADER_SIZE,
        size: p.size[i],
      });
    }
    this.refs.sort((a, b) => a.startMs - b.startMs);
    this.hasAudio = this.refs.length > 0;
  }

  /** 브라우저 정책상 사용자 제스처 안에서 호출되어야 한다. */
  async start(fromMs: number): Promise<void> {
    if (!this.hasAudio) return;
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.stopSources();
    this.originMs = fromMs;
    this.originCtx = this.ctx.currentTime + 0.08; // 예약 여유
    this.scheduledMs = fromMs;
    this.running = true;
    await this.schedule();
  }

  stop(): void {
    this.running = false;
    this.stopSources();
  }

  setVolume(v: number): void {
    if (this.gain) this.gain.gain.value = v;
  }

  setMuted(muted: boolean): void {
    if (this.gain) this.gain.gain.value = muted ? 0 : 1;
  }

  /** 현재 재생 위치(상대 ms). 오디오가 없으면 null. */
  currentMs(): number | null {
    if (!this.running || !this.ctx) return null;
    return this.originMs + (this.ctx.currentTime - this.originCtx) * 1000;
  }

  /** 주기적으로 불러 앞쪽 구간을 채운다. */
  async tick(): Promise<void> {
    if (!this.running || this.scheduling) return;
    const cur = this.currentMs();
    if (cur === null) return;
    if (this.scheduledMs - cur < SCHEDULE_AHEAD_MS) await this.schedule();
  }

  private async schedule(): Promise<void> {
    if (!this.ctx || !this.gain || this.scheduling) return;
    this.scheduling = true;
    try {
      const cur = this.currentMs() ?? this.originMs;
      while (this.running && this.scheduledMs - cur < SCHEDULE_AHEAD_MS) {
        const segStart = this.scheduledMs;
        const segEnd = segStart + SEGMENT_MS;
        const samples = Math.round((SEGMENT_MS / 1000) * AUDIO_SAMPLE_RATE);
        const buffer = this.ctx.createBuffer(1, samples, AUDIO_SAMPLE_RATE);
        const out = buffer.getChannelData(0); // 기본값 0 = 무음 (갭 채우기)
        let wrote = false;

        for (const ref of this.refs) {
          if (ref.endMs <= segStart) continue;
          if (ref.startMs >= segEnd) break;
          const bytes = await this.src.read(ref.offset, ref.size);
          const pcm = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          const count = Math.floor(bytes.byteLength / 2);
          const baseSample = Math.round(((ref.startMs - segStart) / 1000) * AUDIO_SAMPLE_RATE);
          for (let s = 0; s < count; s++) {
            const dst = baseSample + s;
            if (dst < 0) continue;
            if (dst >= samples) break;
            out[dst] = pcm.getInt16(s * 2, true) / 32768;
            wrote = true;
          }
        }

        if (wrote) {
          const node = this.ctx.createBufferSource();
          node.buffer = buffer;
          node.connect(this.gain);
          const when = this.originCtx + (segStart - this.originMs) / 1000;
          node.start(Math.max(when, this.ctx.currentTime));
          node.onended = () => {
            const i = this.sources.indexOf(node);
            if (i >= 0) this.sources.splice(i, 1);
          };
          this.sources.push(node);
        }
        this.scheduledMs = segEnd;
        if (this.refs.length > 0 && segStart > this.refs[this.refs.length - 1].endMs) break;
      }
    } finally {
      this.scheduling = false;
    }
  }

  private stopSources(): void {
    for (const s of this.sources) {
      try { s.stop(); } catch { /* 이미 끝났으면 무시 */ }
    }
    this.sources = [];
  }

  close(): void {
    this.stop();
    this.ctx?.close();
    this.ctx = null;
  }
}
