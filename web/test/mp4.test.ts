/**
 * MP4로 바꿀 때 손대는 두 가지 — avcC 만들기와 Annex-B → 길이 접두사.
 *
 * 이 둘만 맞으면 **픽셀은 원본 그대로** 옮겨진다. 재인코딩이 아니므로
 * 화질 손실도, 디코딩 비용도 없다. 대신 한 바이트만 틀려도 파일이 안 열린다.
 */
import { describe, expect, it } from 'vitest';
import { annexBToAvcc, buildAvcConfig } from '../src/core/mp4';

/** 1920x1080 High profile SPS (실기기에서 가져온 값) */
const SPS = new Uint8Array([
  0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78,
  0x02, 0x27, 0xe5, 0x84, 0x00, 0x00, 0x03, 0x00,
  0x04, 0x00, 0x00, 0x03, 0x00, 0xf0, 0x3c, 0x60, 0xc6, 0x58,
]);
const PPS = new Uint8Array([0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0]);

function annexB(...nals: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const n of nals) total += 4 + n.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const n of nals) {
    out.set([0, 0, 0, 1], at);
    out.set(n, at + 4);
    at += 4 + n.length;
  }
  return out;
}

const idr = (payload: number[]) => new Uint8Array([0x65, ...payload]);
const slice = (payload: number[]) => new Uint8Array([0x41, ...payload]);

describe('avcC 만들기', () => {
  it('키프레임에서 SPS·PPS를 뽑아 담는다', () => {
    const cfg = buildAvcConfig(annexB(SPS, PPS, idr([1, 2, 3])));
    expect(cfg).not.toBeNull();
    const d = cfg!.description;
    expect(d[0]).toBe(1);              // configurationVersion
    expect(d[1]).toBe(SPS[1]);         // profile (High = 0x64)
    expect(d[2]).toBe(SPS[2]);
    expect(d[3]).toBe(SPS[3]);         // level
    expect(d[4]).toBe(0xff);           // 길이 접두사 4바이트
    expect(d[5]).toBe(0xe1);           // SPS 1개
  });

  it('SPS·PPS가 길이와 함께 그대로 들어간다', () => {
    const d = buildAvcConfig(annexB(SPS, PPS, idr([9])))!.description;
    const dv = new DataView(d.buffer);
    expect(dv.getUint16(6, false)).toBe(SPS.length);
    expect([...d.subarray(8, 8 + SPS.length)]).toEqual([...SPS]);
    const at = 8 + SPS.length;
    expect(d[at]).toBe(1);             // PPS 1개
    expect(dv.getUint16(at + 1, false)).toBe(PPS.length);
    expect([...d.subarray(at + 3)]).toEqual([...PPS]);
  });

  it('코덱 문자열과 해상도를 함께 알려 준다', () => {
    const cfg = buildAvcConfig(annexB(SPS, PPS, idr([1])))!;
    expect(cfg.codec).toBe('avc1.640028');
    expect(cfg.width).toBe(1920);
    expect(cfg.height).toBe(1080);
  });

  it('SPS나 PPS가 없으면 만들지 않는다 (억지로 넘기지 않는다)', () => {
    expect(buildAvcConfig(annexB(SPS, idr([1])))).toBeNull();
    expect(buildAvcConfig(annexB(PPS, idr([1])))).toBeNull();
    expect(buildAvcConfig(annexB(idr([1])))).toBeNull();
    expect(buildAvcConfig(new Uint8Array(0))).toBeNull();
  });

  it('3바이트 시작코드도 읽는다', () => {
    const buf = new Uint8Array([0, 0, 1, ...SPS, 0, 0, 1, ...PPS, 0, 0, 1, 0x65, 7]);
    expect(buildAvcConfig(buf)?.codec).toBe('avc1.640028');
  });
});

describe('Annex-B → 길이 접두사', () => {
  it('시작코드를 길이로 바꾼다 — 바이트는 그대로', () => {
    const body = slice([10, 20, 30, 40]);
    const out = annexBToAvcc(annexB(body));
    const dv = new DataView(out.buffer);
    expect(dv.getUint32(0, false)).toBe(body.length);
    expect([...out.subarray(4)]).toEqual([...body]);
  });

  it('SPS·PPS는 뺀다 — avcC에 이미 있다', () => {
    const body = idr([1, 2, 3]);
    const out = annexBToAvcc(annexB(SPS, PPS, body));
    expect(out.length).toBe(4 + body.length);
    expect([...out.subarray(4)]).toEqual([...body]);
  });

  it('접근 단위 구분자(AUD)도 뺀다', () => {
    const aud = new Uint8Array([0x09, 0x10]);
    const body = slice([5]);
    expect(annexBToAvcc(annexB(aud, body)).length).toBe(4 + body.length);
  });

  it('NAL이 여럿이면 각각 길이가 붙는다', () => {
    const a = slice([1, 1, 1]);
    const b = slice([2, 2]);
    const out = annexBToAvcc(annexB(a, b));
    const dv = new DataView(out.buffer);
    expect(dv.getUint32(0, false)).toBe(a.length);
    expect(dv.getUint32(4 + a.length, false)).toBe(b.length);
    expect(out.length).toBe(8 + a.length + b.length);
  });

  it('SEI 같은 나머지는 남긴다 (버리지 않는다)', () => {
    const sei = new Uint8Array([0x06, 0x05, 0x01, 0xff]);
    const out = annexBToAvcc(annexB(sei, slice([3])));
    const dv = new DataView(out.buffer);
    expect(dv.getUint32(0, false)).toBe(sei.length);
  });

  it('빈 입력은 빈 결과', () => {
    expect(annexBToAvcc(new Uint8Array(0)).length).toBe(0);
  });

  it('픽셀 바이트가 하나도 바뀌지 않는다 — 재인코딩이 아니다', () => {
    const body = slice([...Array(500).keys()].map((i) => (i * 7) & 0xff));
    const out = annexBToAvcc(annexB(SPS, PPS, body));
    expect([...out.subarray(4)]).toEqual([...body]);
  });
});
