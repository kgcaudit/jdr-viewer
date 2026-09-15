import { describe, expect, it } from 'vitest';
import { matchTracks, CLASS_LABEL, type CarFix } from '../src/core/track-match';
import type { PhoneFix } from '../src/core/phone-track';

const T0 = Date.UTC(2026, 8, 12, 8, 0, 0);

function phone(sec: number, lat: number, lon: number, o: Partial<PhoneFix> = {}): PhoneFix {
  return {
    timeMs: T0 + sec * 1000, lat, lon, rawSpeed: 0, accuracyM: 10,
    activity: '', stayMs: 0, provider: 'gps', battery: 80, address: '', ...o,
  };
}
function car(sec: number, lat: number, lon: number): CarFix {
  return { timeMs: T0 + sec * 1000, lat, lon };
}

// 위도 1도 ≈ 111.32 km. 걷기/주행 거리를 만들기 쉽게 도(°) 증분을 쓴다.
const M = 1 / 111_320; // 대략 1 m에 해당하는 위도 증분

describe('휴대폰 × 차량 GPS 대사', () => {
  it('같은 시각·같은 위치에 차량이 있으면 "이 차량 주행"', () => {
    // 차량이 1초 간격으로 달리고, 휴대폰도 그 위를 따라간다
    const cars: CarFix[] = [];
    const phones: PhoneFix[] = [];
    for (let s = 0; s <= 60; s++) cars.push(car(s, 37.5 + s * 20 * M, 127));
    for (let s = 0; s <= 60; s += 30) phones.push(phone(s, 37.5 + s * 20 * M + 5 * M, 127)); // 5 m 옆
    const { points } = matchTracks(cars, phones);
    expect(points.every((p) => p.klass === 'in_vehicle_this')).toBe(true);
    expect(points[1].carDistM).toBeLessThan(50);
  });

  it('차량 트랙이 없고 느리게 움직이면 "보행"', () => {
    // 초당 1 m ≈ 3.6 km/h (보행)
    const phones: PhoneFix[] = [];
    for (let s = 0; s <= 300; s += 60) phones.push(phone(s, 37.5 + s * 1 * M, 127));
    const { points } = matchTracks([], phones);
    // 양 끝은 이웃이 한쪽뿐이라도 3.6km/h로 잡힌다
    expect(points.slice(1, -1).every((p) => p.klass === 'walking')).toBe(true);
  });

  it('차량 트랙이 없고 빠르게 움직이면 "다른 이동"', () => {
    // 초당 20 m ≈ 72 km/h
    const phones: PhoneFix[] = [];
    for (let s = 0; s <= 300; s += 30) phones.push(phone(s, 37.5 + s * 20 * M, 127));
    const { points } = matchTracks([], phones);
    expect(points.slice(1, -1).every((p) => p.klass === 'moving_other')).toBe(true);
  });

  it('거의 안 움직이면 "체류"', () => {
    const phones: PhoneFix[] = [];
    for (let s = 0; s <= 600; s += 60) phones.push(phone(s, 37.5, 127, { activity: 'STILL' }));
    const { points } = matchTracks([], phones);
    expect(points.every((p) => p.klass === 'stationary')).toBe(true);
  });

  it('원본 staytime 이 크면 speed 가 있어도 체류로 본다', () => {
    // 발췌 사례: speed 3.6인데 staytime 13082초 → 실제로는 정지. 속도에 속지 않는다.
    const p = phone(0, 36.8738267, 127.4712511, { rawSpeed: 3.6, stayMs: 13082 * 1000, activity: '' });
    const { points } = matchTracks([], [p]);
    expect(points[0].klass).toBe('stationary');
  });

  it('원본 staytime 체류는 그 시간만큼 체류로 집계된다(10분 상한에 안 눌림)', () => {
    const before = phone(-60, 37.6, 127.6);            // 직전 이동
    const stay = phone(0, 37.5, 127.0, { stayMs: 13082 * 1000 }); // 3h38m 체류(점 하나)
    const after = phone(13083, 37.4, 127.4);           // 체류 끝나고 이동
    const { points, summary } = matchTracks([], [before, stay, after]);
    expect(points[1].klass).toBe('stationary');
    expect(points[1].spanMs).toBe(13082 * 1000);        // 상한(10분)이 아니라 staytime
    expect(summary.byClass.stationary.spanMs).toBe(13082 * 1000);
  });

  it('같은 시각 차량이 있어도 staytime 이 크면 체류(주차)로 본다', () => {
    // 차량 GPS가 곁에 있어도 오래 머물렀으면 주행이 아니라 체류
    const cars: CarFix[] = [car(0, 37.5, 127)];
    const p = phone(0, 37.5, 127, { stayMs: 30 * 60_000 });
    const { points } = matchTracks(cars, [p]);
    expect(points[0].klass).toBe('stationary');
  });

  it('같은 시각 차량이 있어도 위치가 멀면 이 차량 주행이 아니다', () => {
    // 차량은 여기, 휴대폰은 500 m 밖에서 걷는다 → 보행/다른 이동이지 이 차량 아님
    const cars: CarFix[] = [];
    for (let s = 0; s <= 300; s++) cars.push(car(s, 37.5, 127));
    const phones: PhoneFix[] = [];
    for (let s = 0; s <= 300; s += 60) phones.push(phone(s, 37.5 + 500 * M + s * 1 * M, 127));
    const { points } = matchTracks(cars, phones);
    expect(points.some((p) => p.klass === 'in_vehicle_this')).toBe(false);
  });

  it('속도를 못 낼 때는 활동유형으로 가른다', () => {
    // 점이 하나뿐이라 이웃 속도를 못 낸다 → activity_type에 기댄다
    const walk = matchTracks([], [phone(0, 37.5, 127, { activity: 'WALKING' })]);
    expect(walk.points[0].klass).toBe('walking');
    const veh = matchTracks([], [phone(0, 37.5, 127, { activity: 'IN_VEHICLE' })]);
    expect(veh.points[0].klass).toBe('moving_other');
  });

  it('시간이 멀리 떨어진 차량 점은 견주지 않는다', () => {
    // 차량은 1시간 전에만 있었다 → 시간 창(30초) 밖이라 carDist는 Infinity
    const cars = [car(-3600, 37.5, 127)];
    const { points } = matchTracks(cars, [phone(0, 37.5, 127, { activity: 'WALKING' })]);
    expect(points[0].carDistM).toBe(Infinity);
    expect(points[0].klass).not.toBe('in_vehicle_this');
  });

  it('요약이 분류별 시간·거리·개수를 센다', () => {
    const phones: PhoneFix[] = [];
    for (let s = 0; s <= 600; s += 60) phones.push(phone(s, 37.5, 127, { activity: 'STILL' }));
    const { summary } = matchTracks([], phones);
    expect(summary.points).toBe(11);
    expect(summary.byClass.stationary.points).toBe(11);
    expect(summary.spanTotalMs).toBeGreaterThan(0);
    // 안 움직였으니 총 이동거리는 0에 가깝다
    expect(summary.distTotalM).toBeLessThan(1);
  });

  it('큰 공백이 한 점에 시간을 몰아주지 않는다 (상한 10분)', () => {
    // 두 점 사이가 5시간 → 각자 최대 10분까지만 대표
    const phones = [phone(0, 37.5, 127), phone(5 * 3600, 37.6, 127)];
    const { summary } = matchTracks([], phones);
    expect(summary.spanTotalMs).toBeLessThanOrEqual(20 * 60_000 + 1);
  });

  it('라벨이 모든 분류에 있다', () => {
    for (const k of ['in_vehicle_this', 'walking', 'moving_other', 'stationary', 'unknown'] as const) {
      expect(CLASS_LABEL[k]).toBeTruthy();
    }
  });
});
