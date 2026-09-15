import { describe, expect, it } from 'vitest';
import { mergeCarPoints, type CarPoint } from '../src/core/car-track-store';

const p = (t: number, lat = 37.5, lon = 127): CarPoint => ({ t, lat, lon });

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
