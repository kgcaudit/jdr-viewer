/**
 * 시간 신축 — 속도는 바뀌고 음높이는 그대로여야 한다.
 *
 * "음높이가 유지되는가"는 영점 교차 횟수로 잰다. 사인파의 영점 교차는
 * 초당 2f회다. playbackRate로 2배속하면 이 값이 두 배가 되고,
 * 시간 신축이면 그대로다. 이게 두 방식을 가르는 결정적 차이다.
 */
import { describe, expect, it } from 'vitest';
import { stretch, TimeStretcher } from '../src/core/timestretch';

const SR = 8000;

function sine(freq: number, seconds: number, sr = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

/** 초당 영점 교차 횟수 → 대략적인 기본 주파수 = 이 값 / 2 */
function crossingsPerSecond(x: Float32Array, sr = SR): number {
  let n = 0;
  for (let i = 1; i < x.length; i++) {
    if ((x[i - 1] < 0 && x[i] >= 0) || (x[i - 1] >= 0 && x[i] < 0)) n++;
  }
  return (n / x.length) * sr;
}

describe('시간 신축', () => {
  it('1배속은 손대지 않는다', () => {
    const x = sine(300, 1);
    expect(stretch(x, 1)).toBe(x);
  });

  it('2배속이면 길이가 절반이 된다', () => {
    const x = sine(300, 2);
    const y = stretch(x, 2);
    expect(y.length / x.length).toBeCloseTo(0.5, 1);
  });

  it('0.5배속이면 길이가 두 배가 된다', () => {
    const x = sine(300, 2);
    const y = stretch(x, 0.5);
    expect(y.length / x.length).toBeCloseTo(2, 1);
  });

  it.each([0.5, 2, 4])('%s배속에서 음높이가 유지된다', (speed) => {
    const x = sine(300, 3);
    const before = crossingsPerSecond(x);
    const after = crossingsPerSecond(stretch(x, speed));
    expect(before).toBeCloseTo(600, -1);
    // 표본 재생(playbackRate)이었다면 speed배가 됐을 값이다
    expect(after / before).toBeGreaterThan(0.9);
    expect(after / before).toBeLessThan(1.1);
  });

  it('표본 재생과 달라야 의미가 있다 — 2배속 비교', () => {
    const x = sine(300, 3);
    // playbackRate 흉내: 한 칸 건너 뽑기
    const resampled = new Float32Array(Math.floor(x.length / 2));
    for (let i = 0; i < resampled.length; i++) resampled[i] = x[i * 2];
    expect(crossingsPerSecond(resampled) / crossingsPerSecond(x)).toBeCloseTo(2, 1);
    expect(crossingsPerSecond(stretch(x, 2)) / crossingsPerSecond(x)).toBeCloseTo(1, 1);
  });

  it('끊어서 밀어 넣어도 통째로 넣은 것과 길이가 같다', () => {
    const x = sine(300, 4);
    const whole = stretch(x, 2);

    const s = new TimeStretcher();
    s.speed = 2;
    const chunks: Float32Array[] = [];
    const step = 500 * (SR / 1000); // 재생이 쓰는 500ms 조각
    for (let at = 0; at < x.length; at += step) chunks.push(s.push(x.subarray(at, at + step)));
    const pieced = chunks.reduce((a, c) => a + c.length, 0);

    expect(Math.abs(pieced - whole.length)).toBeLessThan(OVERLAP_SLACK);
  });

  it('조각 경계에서 튀지 않는다 — 표본 간 급변이 없다', () => {
    const x = sine(300, 4);
    const s = new TimeStretcher();
    s.speed = 2;
    const out: number[] = [];
    const step = 500 * (SR / 1000);
    for (let at = 0; at < x.length; at += step) out.push(...s.push(x.subarray(at, at + step)));

    // 300Hz 사인의 한 표본 간 최대 변화는 2π·300/8000 ≈ 0.236.
    // 이어 붙인 자리가 어긋나면 이 값을 크게 넘는다.
    let worst = 0;
    for (let i = 1; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i] - out[i - 1]));
    expect(worst).toBeLessThan(0.5);
  });

  it('무음 구간을 넣어도 무음이 나온다 (주차 구간)', () => {
    const x = new Float32Array(SR * 2);
    const y = stretch(x, 2);
    expect(y.length).toBeGreaterThan(0);
    expect(y.every((v) => v === 0)).toBe(true);
  });

  it('말도 안 되는 배속은 잘라서 받는다', () => {
    const s = new TimeStretcher();
    s.speed = 100;
    expect(s.speed).toBe(8);
    s.speed = 0.01;
    expect(s.speed).toBe(0.25);
  });
});

/** 겹침 한 칸(128표본) 정도의 오차는 원리상 피할 수 없다 */
const OVERLAP_SLACK = 256;
