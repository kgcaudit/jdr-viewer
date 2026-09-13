/**
 * PCM s16le 8kHz mono 재생 + 마스터 클럭.
 *
 * AudioContext.currentTime이 정밀한 클럭이라 A/V 동기의 기준으로 쓴다.
 * 오디오 패킷은 주차모드 등으로 중간이 비므로, 절대 시각 기준으로 배치하고
 * 빈 구간은 무음으로 채운다 (원본 Python 도구는 단순 이어붙이기라 어긋난다).
 *
 * 배속에서도 소리가 난다. 파형을 다시 뽑지 않고 **시간만 신축**하므로
 * 음높이가 유지된다 (core/timestretch.ts). 블랙박스는 음성이 증거인
 * 경우가 많아 2배속에서 다람쥐 소리가 나면 못 쓴다.
 */
import type { ByteSource } from '../core/byte-source';
import type { JdrDocument } from '../core/types';
import { PACKET_HEADER_SIZE, AUDIO_SAMPLE_RATE } from '../core/parser';
import { TagKind, tagKind } from '../core/tags';
import { TimeStretcher } from '../core/timestretch';
import { placeSample } from '../core/audio-place';

/** 한 번에 만들어 예약하는 오디오 구간 길이 */
const SEGMENT_MS = 500;
/** 미리 예약해 둘 길이 */
const SCHEDULE_AHEAD_MS = 1500;

interface AudioPacketRef {
  startMs: number;
  endMs: number;
  /** 실제로 파형을 놓을 자리(표본). 시각을 그대로 믿지 않는다 — audio-place.ts */
  startSample: number;
  endSample: number;
  offset: number;
  size: number;
}

/**
 * 패킷마다 실제로 놓을 표본 자리를 한 번에 정해 둔다.
 *
 * 창(500ms)을 만들 때마다 따로 계산하면 창 경계에서 규칙이 갈릴 수 있으므로,
 * 파일을 열 때 한 번만 정하고 그 뒤로는 그대로 쓴다.
 */
function placeRefs(refs: AudioPacketRef[]): void {
  let cursor = -1;
  for (const ref of refs) {
    const count = Math.max(0, Math.floor(ref.size / 2));
    const nominal = Math.round((ref.startMs / 1000) * AUDIO_SAMPLE_RATE);
    ref.startSample = placeSample(cursor, nominal);
    ref.endSample = ref.startSample + count;
    cursor = Math.max(cursor, ref.endSample);
  }
  // 드물게 시각이 크게 뒤집히면 자리가 앞뒤로 엇갈릴 수 있다. 창을 훑을 때
  // 앞에서 끊고 나오므로(break) 자리 순서로 다시 세워 둔다.
  refs.sort((a, b) => a.startSample - b.startSample);
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
  /** 배속. 1이 아니면 신축기를 거친다. */
  private speed = 1;
  private readonly stretcher = new TimeStretcher();
  /** 신축기가 내놓았지만 아직 예약하지 않은 표본 */
  private pending = new Float32Array(0);
  /** 놓인 자리 기준 마지막 소리의 끝(ms). 예약을 어디서 멈출지 정한다. */
  private readonly lastAudioMs: number;
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
        startSample: 0,
        endSample: 0,
        offset: p.offset[i] + PACKET_HEADER_SIZE,
        size: p.size[i],
      });
    }
    this.refs.sort((a, b) => a.startMs - b.startMs);
    placeRefs(this.refs);
    this.hasAudio = this.refs.length > 0;
    let lastSample = 0;
    for (const ref of this.refs) lastSample = Math.max(lastSample, ref.endSample);
    this.lastAudioMs = (lastSample / AUDIO_SAMPLE_RATE) * 1000;
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
    this.stretcher.reset();
    this.pending = new Float32Array(0);
    this.originMs = fromMs;
    this.originCtx = this.ctx.currentTime + 0.08; // 예약 여유
    this.scheduledMs = fromMs;
    this.running = true;
    await this.schedule();
  }

  /**
   * 배속을 바꾼다. 이미 예약해 둔 소리는 옛 배속이므로 버린다 —
   * 호출한 쪽이 곧바로 start()로 다시 잡는다.
   */
  setSpeed(speed: number): void {
    if (speed === this.speed) return;
    this.speed = speed;
    this.stretcher.speed = speed;
    this.pending = new Float32Array(0);
    this.stopSources();
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

  /**
   * 현재 재생 위치(상대 ms). 오디오가 없으면 null.
   * 실제로 흐른 시간에 배속을 곱해야 미디어 시각이 된다.
   */
  currentMs(): number | null {
    if (!this.running || !this.ctx) return null;
    return this.originMs + (this.ctx.currentTime - this.originCtx) * 1000 * this.speed;
  }

  /** 주기적으로 불러 앞쪽 구간을 채운다. */
  async tick(): Promise<void> {
    if (!this.running || this.scheduling) return;
    const cur = this.currentMs();
    if (cur === null) return;
    // 미리 채워둘 "미디어 시간"은 배속만큼 늘어야 실제 여유가 같아진다
    if (this.scheduledMs - cur < SCHEDULE_AHEAD_MS * this.speed) await this.schedule();
  }

  /**
   * 미디어 시각 [from, from+SEGMENT_MS) 구간의 파형을 만든다. 빈 곳은 무음.
   *
   * 자리는 시각이 아니라 미리 정해 둔 표본 위치(`startSample`)로 잡는다.
   * 창이 달라도 같은 자리가 나와야 경계에서 파형이 어긋나지 않는다 —
   * 창 시작도 같은 방식으로 표본으로 바꾼다.
   */
  private async readWindow(segStart: number, samples: number): Promise<Float32Array> {
    const base = Math.round((segStart / 1000) * AUDIO_SAMPLE_RATE);
    const out = new Float32Array(samples); // 기본값 0 = 무음 (갭 채우기)
    for (const ref of this.refs) {
      if (ref.endSample <= base) continue;
      if (ref.startSample >= base + samples) break;
      const bytes = await this.src.read(ref.offset, ref.size);
      const pcm = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const count = Math.floor(bytes.byteLength / 2);
      const baseSample = ref.startSample - base;
      for (let s = 0; s < count; s++) {
        const dst = baseSample + s;
        if (dst < 0) continue;
        if (dst >= samples) break;
        out[dst] = pcm.getInt16(s * 2, true) / 32768;
      }
    }
    return out;
  }

  /**
   * 신축기가 내놓은 표본에서 정확히 want만큼 떼어 낸다.
   *
   * 길이를 명목값에 못박는 이유: 조각마다 몇 표본씩 어긋나면 예약 시각과
   * 실제 길이가 벌어져 A/V가 서서히 밀린다. 신축기 출력은 평균적으로
   * 명목값과 같으므로 모자라는 일은 드물고, 모자라면 무음으로 채운다.
   */
  private takePending(want: number): Float32Array {
    const out = new Float32Array(want);
    const n = Math.min(want, this.pending.length);
    out.set(this.pending.subarray(0, n));
    this.pending = this.pending.subarray(n);
    return out;
  }

  private async schedule(): Promise<void> {
    if (!this.ctx || !this.gain || this.scheduling) return;
    this.scheduling = true;
    try {
      const cur = this.currentMs() ?? this.originMs;
      const ahead = SCHEDULE_AHEAD_MS * this.speed;
      while (this.running && this.scheduledMs - cur < ahead) {
        const segStart = this.scheduledMs;
        const inSamples = Math.round((SEGMENT_MS / 1000) * AUDIO_SAMPLE_RATE);
        const media = await this.readWindow(segStart, inSamples);
        // 배속이 걸린 뒤에 도착한 조각도 흐름이 끊기면 안 되므로 항상 통과시킨다
        const produced = this.stretcher.push(media);
        if (produced.length > 0) {
          const merged = new Float32Array(this.pending.length + produced.length);
          merged.set(this.pending, 0);
          merged.set(produced, this.pending.length);
          this.pending = merged;
        }

        const outSamples = Math.max(1, Math.round(inSamples / this.speed));
        const chunk = this.takePending(outSamples);

        let silent = true;
        for (let i = 0; i < chunk.length; i++) {
          if (chunk[i] !== 0) { silent = false; break; }
        }
        // 주차 구간처럼 통째로 무음이면 노드를 만들지 않는다 (긴 공백이 흔하다)
        if (!silent) {
          // 예약해야 할 시각이 이미 지났을 수 있다 (구간 전환·GC 등으로 본선이
          // 멎었을 때). 그때 그냥 "지금"으로 당겨 넣으면 뒤따르는 조각과 겹쳐
          // 겹쳐 울리며 뭉개진다. 지나간 만큼은 **버리고** 남은 데서 잇는다 —
          // 소리가 조금 빠지는 편이 뭉개지는 것보다 낫고, A/V도 어긋나지 않는다.
          const when = this.originCtx + (segStart - this.originMs) / 1000 / this.speed;
          const now = this.ctx.currentTime;
          let data = chunk;
          let at = when;
          if (when < now) {
            const skip = Math.round((now - when) * AUDIO_SAMPLE_RATE);
            if (skip < data.length) {
              data = data.subarray(skip);
              at = now;
            } else {
              data = data.subarray(0, 0);
            }
          }
          if (data.length > 0) {
            const buffer = this.ctx.createBuffer(1, data.length, AUDIO_SAMPLE_RATE);
            buffer.getChannelData(0).set(data);
            const node = this.ctx.createBufferSource();
            node.buffer = buffer;
            node.connect(this.gain);
            node.start(at);
            node.onended = () => {
              const i = this.sources.indexOf(node);
              if (i >= 0) this.sources.splice(i, 1);
            };
            this.sources.push(node);
          }
        }
        this.scheduledMs = segStart + SEGMENT_MS;
        if (segStart > this.lastAudioMs) break;
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
