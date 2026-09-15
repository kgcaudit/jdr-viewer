import { describe, expect, it } from 'vitest';
import { formatNominatim, placeNominatim, geoKey } from '../src/core/geocode';

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
