import { describe, expect, it } from 'vitest';
import {
  parsePhoneTrack, parsePhoneTime, haversineM, isValidLatLon, PhoneTrackError,
} from '../src/core/phone-track';

/** 도와줘 응답 형식으로 하나 만든다 */
function record(o: Record<string, unknown>): Record<string, unknown> {
  return {
    timestamp: '2026-09-12 08:00:00', staytime: 0, latitude: 37.5, longitude: 127.0,
    accuracy: 10, speed: 0, battery: 80, address: '서울', updated_at: '2026-09-12 08:00:01',
    provider: 'gps', activity_type: 'STILL', ...o,
  };
}
function file(rows: Record<string, unknown>[]): string {
  return JSON.stringify({ success: true, message: '위치기록 조회 완료', data: [rows], errors: [] });
}

describe('휴대폰 위치기록 파싱', () => {
  it('도와줘 형식(data:[[...]])을 읽는다', () => {
    const t = file([record({ timestamp: '2026-09-12 08:00:00' }), record({ timestamp: '2026-09-12 08:05:00', latitude: 37.51 })]);
    const fixes = parsePhoneTrack(t);
    expect(fixes).toHaveLength(2);
    expect(fixes[0].lat).toBe(37.5);
    expect(fixes[0].activity).toBe('STILL');
  });

  it('시각은 벽시계 숫자를 그대로 담는다 (차량 GPS와 같은 기준)', () => {
    // 차량 GPS는 Date.UTC(적힌 숫자)로 담긴다. KST 오프셋을 더하면 초 단위로 어긋난다.
    const fixes = parsePhoneTrack(file([record({ timestamp: '2026-09-12 23:35:58' })]));
    expect(fixes[0].timeMs).toBe(Date.UTC(2026, 8, 12, 23, 35, 58));
  });

  it('좌표가 0이거나 없는 점은 버린다 (위성 미수신)', () => {
    const t = file([record({ latitude: 0, longitude: 0 }), record({ latitude: 37.5, longitude: 127.0 })]);
    expect(parsePhoneTrack(t)).toHaveLength(1);
  });

  it('시각 순으로 세운다', () => {
    const t = file([record({ timestamp: '2026-09-12 09:00:00' }), record({ timestamp: '2026-09-12 08:00:00' })]);
    const fixes = parsePhoneTrack(t);
    expect(fixes[0].timeMs).toBeLessThan(fixes[1].timeMs);
  });

  it('data가 여러 토막이면 모두 펼친다', () => {
    const t = JSON.stringify({ data: [[record({})], [record({ timestamp: '2026-09-12 10:00:00' })]] });
    expect(parsePhoneTrack(t)).toHaveLength(2);
  });

  it('JSON이 아니면 명확히 실패한다', () => {
    expect(() => parsePhoneTrack('<html>로그인이 필요합니다')).toThrow(PhoneTrackError);
  });

  it('data 배열이 없으면 실패한다', () => {
    expect(() => parsePhoneTrack('{"success":false}')).toThrow(PhoneTrackError);
  });

  it('숫자가 문자열로 와도 읽는다', () => {
    const t = file([record({ latitude: '37.500000', longitude: '127.000000', accuracy: '13' })]);
    const f = parsePhoneTrack(t)[0];
    expect(f.lat).toBe(37.5);
    expect(f.accuracyM).toBe(13);
  });
});

describe('parsePhoneTime', () => {
  it('공백·T 구분자 모두 읽는다', () => {
    expect(parsePhoneTime('2026-09-12 08:30:15')).toBe(Date.UTC(2026, 8, 12, 8, 30, 15));
    expect(parsePhoneTime('2026-09-12T08:30:15')).toBe(Date.UTC(2026, 8, 12, 8, 30, 15));
  });
  it('형식이 아니면 NaN', () => {
    expect(parsePhoneTime('어제')).toBeNaN();
    expect(parsePhoneTime(12345)).toBeNaN();
  });
});

describe('haversine 거리', () => {
  it('같은 점은 0', () => {
    expect(haversineM(37.5, 127, 37.5, 127)).toBe(0);
  });
  it('위도 0.001도 ≈ 111 m', () => {
    // 1도 ≈ 111.32 km → 0.001도 ≈ 111.3 m
    expect(haversineM(37.5, 127, 37.501, 127)).toBeGreaterThan(105);
    expect(haversineM(37.5, 127, 37.501, 127)).toBeLessThan(118);
  });
  it('서울–부산 ≈ 325 km 안팎', () => {
    const d = haversineM(37.5665, 126.9780, 35.1796, 129.0756) / 1000;
    expect(d).toBeGreaterThan(300);
    expect(d).toBeLessThan(340);
  });
});

describe('isValidLatLon', () => {
  it('0,0과 범위 밖을 거른다', () => {
    expect(isValidLatLon(0, 0)).toBe(false);
    expect(isValidLatLon(37.5, 127)).toBe(true);
    expect(isValidLatLon(91, 127)).toBe(false);
  });
});
