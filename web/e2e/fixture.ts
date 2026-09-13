/**
 * e2e용 샘플 JDR 생성기 (개발 전용 — 프로덕션 번들에 포함되지 않는다).
 *
 * WebCodecs VideoEncoder로 "진짜" H.264 Annex-B 프레임을 만들어 JDR로 포장한다.
 * 그래야 "브라우저가 JDR 영상을 실제로 디코딩하는가"를 끝까지 검증할 수 있다.
 */
import { buildJdrBlock, gpsPayload, gsensorPayload, pcmTone, type SynthPacket } from '../test/synth';

const WIDTH = 320;
const HEIGHT = 180;
const FRAMES = 45;
const FPS = 30;
const DEFAULT_T0 = Date.UTC(2026, 0, 15, 9, 30, 0, 0);

interface EncodedFrame { data: Uint8Array<ArrayBuffer>; key: boolean }
export interface EncodeResult { frames: EncodedFrame[]; codec: string | null; error?: string }

/**
 * 후보 코덱을 순서대로 시도한다.
 * H.264가 1순위지만, 독점 코덱이 빠진 오픈소스 Chromium 빌드에서는 VP8로 떨어진다.
 * (그래도 WebCodecs 디코딩 → 캔버스 렌더 → 시크 경로는 똑같이 검증된다.)
 */
const CANDIDATES: VideoEncoderConfig[] = [
  { codec: 'avc1.42001f', width: WIDTH, height: HEIGHT, bitrate: 800_000, framerate: FPS, avc: { format: 'annexb' } },
  { codec: 'vp8', width: WIDTH, height: HEIGHT, bitrate: 800_000, framerate: FPS },
];

async function encodeVideo(): Promise<EncodeResult> {
  if (typeof VideoEncoder === 'undefined') return { frames: [], codec: null, error: 'VideoEncoder 미지원' };
  let config: VideoEncoderConfig | null = null;
  for (const c of CANDIDATES) {
    try {
      if ((await VideoEncoder.isConfigSupported(c)).supported) { config = c; break; }
    } catch { /* 다음 후보 */ }
  }
  if (!config) return { frames: [], codec: null, error: '지원되는 인코더 없음' };

  const frames: EncodedFrame[] = [];
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      frames.push({ data: buf, key: chunk.type === 'key' });
    },
    error: (e) => console.error('encoder', e),
  });
  encoder.configure(config);

  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d')!;
  for (let f = 0; f < FRAMES; f++) {
    // 프레임마다 확실히 다른 그림 — 디코딩이 실제로 됐는지 픽셀로 확인하기 위함
    ctx.fillStyle = `hsl(${(f * 8) % 360} 80% 45%)`;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = '#fff';
    ctx.fillRect((f * 6) % (WIDTH - 40), HEIGHT / 2 - 20, 40, 40);
    ctx.font = '20px monospace';
    ctx.fillText(String(f), 8, 26);
    const frame = new VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
    encoder.encode(frame, { keyFrame: f % 15 === 0 });
    frame.close();
  }
  await encoder.flush();
  encoder.close();
  return { frames, codec: config.codec };
}

let encodeResult: EncodeResult | null = null;
async function getEncoded(): Promise<EncodeResult> {
  if (!encodeResult) encodeResult = await encodeVideo();
  return encodeResult;
}

async function buildSampleJdr(T0 = DEFAULT_T0): Promise<Uint8Array<ArrayBuffer>> {
  const { frames, error, codec } = await getEncoded();
  const packets: SynthPacket[] = [];

  for (let f = 0; f < FRAMES; f++) {
    const t = T0 + Math.round((f * 1000) / FPS);
    const enc = frames[f];
    // 인코딩이 안 되는 환경에서도 구조 검증은 되도록 더미 NAL을 넣는다
    const payload = enc?.data ?? new Uint8Array([0, 0, 0, 1, f % 15 === 0 ? 0x65 : 0x41, f]);
    const isKey = enc ? enc.key : f % 15 === 0;
    packets.push({ tag: isKey ? '00VI' : '00VP', payload, timeMs: t, aux: f });
    packets.push({ tag: isKey ? '01VI' : '01VP', payload, timeMs: t, aux: f });
    if (f % 6 === 0) packets.push({ tag: '00AD', payload: pcmTone(1600, f * 1600), timeMs: t });
  }

  // 서울 근처를 북동쪽으로 달리는 경로
  for (let i = 0; i < 15; i++) {
    packets.push({
      tag: '00GP',
      timeMs: T0 + i * 100,
      payload: gpsPayload({
        year: 2026, month: 1, day: 15, hour: 0, minute: 30, second: i,
        latNmea: 3733.5678 + i * 0.01,
        lonNmea: 12658.1234 + i * 0.012,
        altitude: 40 + i,
        speed: 55 + i * 1.5,
      }),
    });
  }
  for (let i = 0; i < 60; i++) {
    packets.push({
      tag: '00SE',
      timeMs: T0 + i * 25,
      payload: gsensorPayload(
        Math.round(Math.sin(i / 4) * 300),
        Math.round(Math.cos(i / 5) * 180),
        1024 + (i === 30 ? 2400 : Math.round(Math.sin(i / 3) * 60)), // 30번째에 충격
      ),
    });
  }

  packets.sort((a, b) => a.timeMs - b.timeMs);
  const bytes = buildJdrBlock(packets);
  document.getElementById('status')!.textContent = error
    ? `더미 영상으로 생성 (${error}) · ${bytes.length} bytes`
    : `실제 ${codec} ${frames.length}프레임 포함 · ${bytes.length} bytes`;
  return bytes;
}

declare global {
  interface Window {
    /** startIso를 주면 그 시각에서 시작하는 파일을 만든다 (폴더 병합 테스트용) */
    buildSampleJdr: (startIso?: string) => Promise<number[]>;
    sampleCodec: string | null;
  }
}

window.buildSampleJdr = async (startIso?: string) =>
  Array.from(await buildSampleJdr(startIso ? Date.parse(`${startIso}Z`) : DEFAULT_T0));
void (async () => {
  window.sampleCodec = (await getEncoded()).codec;
})();
