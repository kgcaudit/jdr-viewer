import { describe, expect, it } from 'vitest';
import { mergeCarPoints, parseCarCsv, CarCsvError, type CarPoint } from '../src/core/car-track-store';

const p = (t: number, lat = 37.5, lon = 127): CarPoint => ({ t, lat, lon });

const HEAD = 'packet_time,gps_time,source_file,pdop,hdop,vdop,latitude_nmea,longitude_nmea,latitude_deg,longitude_deg,altitude_m,speed_kmh';
const row = (pt: string, la: number, lo: number): string =>
  `${pt},—,00000007.jdr,1.2,0.8,0.9,0,0,${la},${lo},100,40`;

describe('차량 트랙 병합', () => {
  it('같은 초는 하나로, 새 시각만 더한다', () => {
    const out = mergeCarPoints([p(1000), p(2000)], [p(2000), p(3000)]);
    expect(out.map((x) => x.t)).toEqual([1000, 2000, 3000]);
  });

  it('밀리초가 달라도 같은 초면 하나로', () => {
    const out = mergeCarPoints([p(1000)], [p(1400)]); // 둘 다 1초
    expect(out).toHaveLength(1);
  });

  it('좌표가 0이면 버린다 (위성 미수신)', () => {
    expect(mergeCarPoints([], [p(1000, 0, 0)])).toHaveLength(0);
  });

  it('여러 운행을 열수록 채워진다', () => {
    const drive1 = [p(1000), p(2000)];
    const drive2 = [p(5000), p(6000)];
    const merged = mergeCarPoints(drive1, drive2);
    expect(merged).toHaveLength(4);
  });

  it('시각 순으로 세운다', () => {
    expect(mergeCarPoints([p(3000)], [p(1000)]).map((x) => x.t)).toEqual([1000, 3000]);
  });
});

describe('차량 GPS CSV 파싱', () => {
  it('유효 좌표만 날짜별로 뽑는다 (0,0 미수신 제외)', () => {
    const csv = [HEAD,
      row('2026-09-12 12:10:09.389', 0, 0),       // 미수신 → 제외
      row('2026-09-12 12:18:00.000', 37.31, 127.08),
      row('2026-09-12 13:06:01.000', 37.40, 127.00),
    ].join('\n');
    const byDay = parseCarCsv(csv);
    expect(byDay.size).toBe(1);
    const pts = byDay.get('2026-09-12')!;
    expect(pts).toHaveLength(2);
    expect(pts[0].lat).toBeCloseTo(37.31, 2);
  });

  it('BOM·CRLF·자정 넘김도 처리한다', () => {
    const csv = '﻿' + [HEAD,
      row('2026-09-12 23:59:00', 37.5, 127.0),
      row('2026-09-13 00:01:00', 37.6, 127.1),
    ].join('\r\n');
    const byDay = parseCarCsv(csv);
    expect([...byDay.keys()].sort()).toEqual(['2026-09-12', '2026-09-13']);
  });

  it('열이 안 맞으면 오류', () => {
    expect(() => parseCarCsv('a,b,c\n1,2,3')).toThrow(CarCsvError);
  });

  it('유효 좌표가 하나도 없으면 오류', () => {
    expect(() => parseCarCsv([HEAD, row('2026-09-12 12:00:00', 0, 0)].join('\n'))).toThrow(CarCsvError);
  });
});
