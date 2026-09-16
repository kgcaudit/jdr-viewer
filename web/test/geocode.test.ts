import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatNominatim, placeNominatim, geoKey, reverseGeocode, setPreferredProvider } from '../src/core/geocode';

describe('리버스 지오코딩 포맷', () => {
  it('행정구역을 큰→작은 순으로 한글 주소를 만든다', () => {
    const j = {
      address: {
        house_number: '251', village: '가산리', town: '진천읍',
        county: '진천군', state: '충청북도', country: '대한민국',
      },
      display_name: '251, 가산리, 진천읍, 진천군, 충청북도, 대한민국',
    };
    expect(formatNominatim(j)).toBe('충청북도 진천군 진천읍 가산리 251');
  });

  it('address 조립이 비면 display_name 을 뒤집어 쓴다', () => {
    const j = { display_name: '세종대로 110, 태평로1가, 중구, 서울특별시, 대한민국' };
    expect(formatNominatim(j)).toBe('서울특별시 중구 태평로1가 세종대로 110');
  });

  it('중복 값은 한 번만 넣는다', () => {
    const j = { address: { city: '서울특별시', state: '서울특별시', road: '세종대로' } };
    expect(formatNominatim(j)).toBe('서울특별시 세종대로');
  });

  it('빈 응답이면 빈 문자열', () => {
    expect(formatNominatim({})).toBe('');
  });

  it('상호명은 name 을 우선, 없으면 시설/상점 필드에서 뽑는다', () => {
    expect(placeNominatim({ name: '진천군청', address: { amenity: '군청' } })).toBe('진천군청');
    expect(placeNominatim({ address: { shop: '가산리마트' } })).toBe('가산리마트');
    // 번지 등 숫자로 시작하는 값은 상호명이 아니다
    expect(placeNominatim({ address: { building: '251' } })).toBe('');
    expect(placeNominatim({})).toBe('');
  });

  it('좌표 캐시 키는 소수 4자리로 묶는다(≈11m)', () => {
    expect(geoKey(36.8738267, 127.4712511)).toBe('36.8738,127.4713');
    expect(geoKey(36.87381, 127.47129)).toBe('36.8738,127.4713'); // 같은 자리로 묶임
  });
});

/**
 * 대표 상호명 채우기 — 카카오 장소검색이 상호명을 주면 그걸 쓰고, 주소만 있고
 * 상호명이 비면 OSM 상호명으로 보충한다(주소는 카카오 것을 지킨다).
 * 실기에서 "바츠커피"가 비어 찍히던 문제의 회귀 방지.
 */
describe('reverseGeocode 상호명 보충', () => {
  let fetchCalls = 0;
  beforeEach(() => {
    fetchCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetchCalls++;
      return {
        ok: true,
        json: async () => ({ name: '바츠커피', address: { city: '용인시', road: '중부대로', house_number: '1' } }),
      } as unknown as Response;
    }));
  });
  afterEach(() => { setPreferredProvider(null); vi.unstubAllGlobals(); });

  it('카카오가 상호명을 주면 OSM을 부르지 않는다', async () => {
    setPreferredProvider(async () => ({ addr: '용인시 처인구', place: '바츠커피' }));
    const info = await reverseGeocode(37.11, 127.11);
    expect(info.place).toBe('바츠커피');
    expect(fetchCalls).toBe(0);
  });

  it('카카오 주소만 있고 상호명이 비면 OSM 상호명으로 보충한다(주소는 카카오 유지)', async () => {
    setPreferredProvider(async () => ({ addr: '용인시 처인구 중부대로 1', place: '' }));
    const info = await reverseGeocode(37.22, 127.22);
    expect(info.addr).toBe('용인시 처인구 중부대로 1'); // 카카오 주소는 그대로
    expect(info.place).toBe('바츠커피');                 // 상호명만 OSM으로 보충
    expect(fetchCalls).toBe(1);
  });

  it('우선 제공자가 없으면 OSM으로 전체를 얻는다', async () => {
    const info = await reverseGeocode(37.33, 127.33);
    expect(info.place).toBe('바츠커피');
    expect(fetchCalls).toBe(1);
  });
});
