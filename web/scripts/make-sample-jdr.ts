/**
 * 테스트용 합성 JDR 생성기 (Node).
 *
 *   npx tsx scripts/make-sample-jdr.ts out.jdr --mb 150
 *
 * 영상 페이로드는 디코딩 가능한 H.264가 아니라 채움 데이터다.
 * 파싱 성능·대용량 처리·요약/내보내기 경로를 확인하는 용도.
 */
import { writeFileSync } from 'node:fs';
import { buildJdrBlock, gpsPayload, gsensorPayload, pcmTone, type SynthPacket } from '../test/synth';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--')) ?? 'sample.jdr';
const mbIndex = args.indexOf('--mb');
const targetMb = mbIndex >= 0 ? Number(args[mbIndex + 1]) : 20;
const targetBytes = targetMb * 1024 * 1024;

const FPS = 30;
const T0 = Date.UTC(2026, 0, 15, 9, 30, 0, 0);
/** 1280x720 30fps 블랙박스의 대략적인 프레임 크기 */
const KEY_BYTES = 90_000;
const DELTA_BYTES = 12_000;

function fill(size: number, seed: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(size);
  b.set([0, 0, 0, 1, seed % 15 === 0 ? 0x65 : 0x41]);
  for (let i = 5; i < size; i += 997) b[i] = (i * seed) & 0xff;
  return b;
}

const packets: SynthPacket[] = [];
let bytes = 0;
let frame = 0;
while (bytes < targetBytes) {
  const t = T0 + Math.round((frame * 1000) / FPS);
  const isKey = frame % 15 === 0;
  for (const ch of ['00', '01']) {
    const payload = fill(isKey ? KEY_BYTES : DELTA_BYTES, frame + ch.charCodeAt(1));
    packets.push({ tag: `${ch}V${isKey ? 'I' : 'P'}`, payload, timeMs: t, aux: frame });
    bytes += payload.length + 28;
  }
  if (frame % 6 === 0) {
    const payload = pcmTone(1600, frame * 1600);
    packets.push({ tag: '00AD', payload, timeMs: t, aux: frame });
    bytes += payload.length + 28;
  }
  if (frame % 30 === 0) {
    const s = frame / 30;
    packets.push({
      tag: '00GP',
      timeMs: t,
      payload: gpsPayload({
        year: 2026, month: 1, day: 15,
        hour: Math.floor(s / 3600), minute: Math.floor(s / 60) % 60, second: s % 60,
        latNmea: 3733.5678 + s * 0.004,
        lonNmea: 12658.1234 + s * 0.005,
        altitude: 40 + (s % 20),
        speed: 50 + 25 * Math.sin(s / 12),
      }),
    });
    bytes += 96 + 28;
  }
  if (frame % 3 === 0) {
    packets.push({
      tag: '00SE',
      timeMs: t,
      payload: gsensorPayload(
        Math.round(Math.sin(frame / 30) * 250),
        Math.round(Math.cos(frame / 37) * 190),
        1024 + (frame % 1800 === 900 ? 2600 : Math.round(Math.sin(frame / 11) * 70)),
      ),
    });
    bytes += 12 + 28;
  }
  frame++;
}

const buf = buildJdrBlock(packets);
writeFileSync(out, buf);
console.log(
  `${out} · ${(buf.length / 1024 / 1024).toFixed(1)} MB · ` +
  `패킷 ${packets.length.toLocaleString('ko-KR')}개 · ` +
  `${(frame / FPS).toFixed(1)}초 분량`,
);
