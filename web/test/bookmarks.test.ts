import { describe, expect, it } from 'vitest';
import {
  BookmarkFileError, bookmarkAt, bookmarkId, defaultLabel, mergeBookmarks,
  parseBookmarks, serializeBookmarks, sortBookmarks, type Bookmark,
} from '../src/core/bookmarks';

const T = (h: number, m: number, s = 0) => new Date(2026, 8, 8, h, m, s).getTime();

const mark = (path: string, relMs: number, absMs: number, label = 'x'): Bookmark => ({
  id: bookmarkId(path, relMs), absMs, dayKey: '2026-09-08',
  path, name: path.split('/').pop()!, relMs, label, createdAt: 1,
});

describe('즐겨찾기 식별', () => {
  it('같은 장면을 두 번 담아도 하나다 (1초로 뭉뚱그린다)', () => {
    expect(bookmarkId('data/a.jdr', 12_300)).toBe(bookmarkId('data/a.jdr', 12_400));
    expect(bookmarkId('data/a.jdr', 12_300)).not.toBe(bookmarkId('data/a.jdr', 13_600));
  });

  it('파일이 다르면 다른 항목이다', () => {
    expect(bookmarkId('data/a.jdr', 1000)).not.toBe(bookmarkId('data/b.jdr', 1000));
  });

  it('기본 이름은 월-일 시:분:초', () => {
    expect(defaultLabel(T(14, 32, 5))).toBe('09-08 14:32:05');
  });
});

describe('현재 지점 판정', () => {
  const list = [mark('data/a.jdr', 30_000, T(8, 10)), mark('data/b.jdr', 5_000, T(9, 0))];

  it('2초 안이면 같은 지점으로 본다', () => {
    expect(bookmarkAt(list, 'data/a.jdr', 31_500)?.path).toBe('data/a.jdr');
    expect(bookmarkAt(list, 'data/a.jdr', 28_100)?.path).toBe('data/a.jdr');
  });

  it('2초를 넘으면 다른 지점이다', () => {
    expect(bookmarkAt(list, 'data/a.jdr', 33_000)).toBeNull();
  });

  it('같은 시각이라도 파일이 다르면 아니다', () => {
    expect(bookmarkAt(list, 'data/c.jdr', 30_000)).toBeNull();
  });

  it('가장 가까운 것을 고른다', () => {
    const many = [
      mark('data/a.jdr', 30_000, T(8, 10), '앞'),
      mark('data/a.jdr', 31_000, T(8, 10, 1), '뒤'),
    ];
    expect(bookmarkAt(many, 'data/a.jdr', 30_900)?.label).toBe('뒤');
  });
});

describe('파일 저장·불러오기', () => {
  const list = [mark('data/b.jdr', 5_000, T(9, 0), '나중'), mark('data/a.jdr', 30_000, T(8, 10), '먼저')];

  it('시각 순으로 저장된다', () => {
    const parsed = JSON.parse(serializeBookmarks(list));
    expect(parsed.marks.map((m: Bookmark) => m.label)).toEqual(['먼저', '나중']);
    expect(parsed.count).toBe(2);
  });

  it('저장한 것을 그대로 되읽는다', () => {
    const back = parseBookmarks(serializeBookmarks(list));
    expect(back).toHaveLength(2);
    expect(back[0]).toMatchObject({ path: 'data/a.jdr', relMs: 30_000, label: '먼저' });
  });

  it('JDR Viewer 파일이 아니면 사유를 알린다', () => {
    expect(() => parseBookmarks('{"format":"다른거"}')).toThrow(BookmarkFileError);
    expect(() => parseBookmarks('{ 이건 JSON이 아님')).toThrow(/JSON/);
  });

  it('미래 버전은 거부한다', () => {
    const text = serializeBookmarks(list).replace('"version": 1', '"version": 99');
    expect(() => parseBookmarks(text)).toThrow(/지원하지 않는/);
  });

  it('망가진 항목은 건너뛰고 나머지는 살린다', () => {
    const obj = JSON.parse(serializeBookmarks(list));
    obj.marks.push({ path: 'data/c.jdr' });       // absMs 없음
    obj.marks.push({ absMs: T(10, 0) });          // path 없음
    obj.marks.push({ path: 'data/d.jdr', absMs: T(10, 0) }); // 나머지는 채워진다
    const back = parseBookmarks(JSON.stringify(obj));
    expect(back.map((b) => b.path)).toEqual(['data/a.jdr', 'data/b.jdr', 'data/d.jdr']);
    expect(back[2].label).toBe(defaultLabel(T(10, 0)));
    expect(back[2].id).toBe(bookmarkId('data/d.jdr', 0));
  });
});

describe('합치기', () => {
  it('없던 것만 들어온다', () => {
    const cur = [mark('data/a.jdr', 30_000, T(8, 10), '내가 쓴 이름')];
    const inc = [mark('data/a.jdr', 30_000, T(8, 10), '남의 이름'), mark('data/z.jdr', 0, T(11, 0))];
    const { list, added } = mergeBookmarks(cur, inc);
    expect(added).toBe(1);
    expect(list).toHaveLength(2);
    // 같은 지점이면 원래 이름을 지킨다
    expect(list.find((b) => b.path === 'data/a.jdr')!.label).toBe('내가 쓴 이름');
  });

  it('합친 뒤에도 시각 순이다', () => {
    const { list } = mergeBookmarks(
      [mark('data/c.jdr', 0, T(12, 0))],
      [mark('data/a.jdr', 0, T(8, 0)), mark('data/b.jdr', 0, T(10, 0))],
    );
    expect(list.map((b) => b.absMs)).toEqual([T(8, 0), T(10, 0), T(12, 0)]);
  });

  it('빈 목록끼리 합쳐도 터지지 않는다', () => {
    expect(mergeBookmarks([], [])).toEqual({ list: [], added: 0 });
  });
});

describe('정렬', () => {
  it('원본을 건드리지 않는다', () => {
    const src = [mark('data/b.jdr', 0, T(9, 0)), mark('data/a.jdr', 0, T(8, 0))];
    const sorted = sortBookmarks(src);
    expect(src[0].path).toBe('data/b.jdr');
    expect(sorted[0].path).toBe('data/a.jdr');
  });
});
