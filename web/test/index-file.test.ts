import { describe, expect, it } from 'vitest';
import {
  buildIndexFile, entryToSegment, findIndexFile, INDEX_FILE_NAME, IndexFileError,
  indexMatches, parseIndexFile, serializeIndexFile,
} from '../src/core/index-file';
import type { SegmentInfo } from '../src/core/segment';

const seg = (name: string, folder = 'data'): SegmentInfo => ({
  id: `${folder}/${name}`, name, path: `${folder}/${name}`, folder, size: 73_400_320,
  startMs: Date.UTC(2026, 8, 9, 8, 16, 0), endMs: Date.UTC(2026, 8, 9, 8, 17, 9),
  durationMs: 69_000, packetCount: 5309, ch0Count: 2095, ch1Count: 2095,
  gpsCount: 70, sensorCount: 699, blockOffsets: [0], timeSource: 'header', endEstimated: false,
});

/** 실제 70MB 버퍼를 만들 수는 없으니 size만 실제 값으로 맞춰 준다 */
const fileFor = (s: SegmentInfo, lastModified = 1_757_000_000_000, size = s.size): File => {
  const f = new File([new Uint8Array(4)], s.name, { lastModified });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

describe('인덱스 파일', () => {
  it('내보낸 것을 그대로 다시 읽는다', () => {
    const items = [seg('00000465.jdr'), seg('00000466.jdr')].map((s) => ({ seg: s, file: fileFor(s) }));
    const text = serializeIndexFile(buildIndexFile(items));
    const parsed = parseIndexFile(text);

    expect(parsed.size).toBe(2);
    const e = parsed.get('data/00000465.jdr')!;
    expect(e.size).toBe(73_400_320);
    expect(e.seg.startMs).toBe(items[0].seg.startMs);
    expect(e.seg.endMs).toBe(items[0].seg.endMs);
    expect(e.seg.durationMs).toBe(69_000);
    expect(e.seg.ch0Count).toBe(2095);
    expect(e.seg.blockOffsets).toEqual([0]);
    expect(e.seg.timeSource).toBe('header');
  });

  it('읽어 들인 항목이 원래 세그먼트와 같아진다', () => {
    const original = seg('00000465.jdr');
    const text = serializeIndexFile(buildIndexFile([{ seg: original, file: fileFor(original) }]));
    const entry = parseIndexFile(text).get(original.path)!;
    const restored = entryToSegment(entry, {
      name: original.name, path: original.path, folder: original.folder, size: original.size,
    });
    expect(restored).toEqual(original);
  });

  it('사람이 읽을 수 있는 JSON이다 (감사 기록으로도 쓴다)', () => {
    const s = seg('00000465.jdr');
    const text = serializeIndexFile(buildIndexFile([{ seg: s, file: fileFor(s) }]));
    expect(text).toContain('"format": "jdr-viewer-index"');
    expect(text).toContain('"generatedAt"');
    expect(text).toContain('원본 JDR은 건드리지 않습니다');
    expect(() => JSON.parse(text)).not.toThrow();
    // 행 하나가 한 줄이어야 diff가 읽힌다
    expect(text).toMatch(/\n {4}\["data\/00000465\.jdr",/);
  });

  it('파일이 바뀌면 인덱스를 쓰지 않는다', () => {
    const s = seg('00000465.jdr');
    const text = serializeIndexFile(buildIndexFile([{ seg: s, file: fileFor(s, 111) }]));
    const entry = parseIndexFile(text).get(s.path)!;

    expect(indexMatches(entry, fileFor(s, 111))).toBe(true);
    // 수정 시각이 다름 (덮어쓰기로 내용이 바뀐 경우)
    expect(indexMatches(entry, fileFor(s, 222))).toBe(false);
    // 크기가 다름
    expect(indexMatches(entry, fileFor(s, 111, 12_345))).toBe(false);
  });

  it('읽을 수 없는 파일은 사유를 남긴다 (조용히 무시하지 않는다)', () => {
    expect(() => parseIndexFile('not json')).toThrow(IndexFileError);
    expect(() => parseIndexFile('{"format":"other"}')).toThrow(/JDR Viewer 인덱스 파일이 아닙니다/);
    expect(() => parseIndexFile('{"format":"jdr-viewer-index","version":99,"rows":[]}'))
      .toThrow(/지원하지 않는 인덱스 버전/);
    // 옛 버전은 조용히 쓰지 않고 다시 읽게 한다 (계산 방식이 바뀌었으므로)
    expect(() => parseIndexFile('{"format":"jdr-viewer-index","version":1,"rows":[]}'))
      .toThrow(/인덱스 형식이 갱신되었습니다/);
    expect(() => parseIndexFile('{"format":"jdr-viewer-index","version":2}'))
      .toThrow(/rows가 없습니다/);
  });

  it('깨진 행은 건너뛰고 나머지는 살린다', () => {
    const s = seg('00000465.jdr');
    const index = buildIndexFile([{ seg: s, file: fileFor(s) }]);
    (index.rows as unknown[]).push(['짧은행', 1]);
    const parsed = parseIndexFile(serializeIndexFile(index));
    expect(parsed.size).toBe(1);
  });

  it('읽지 못한 파일의 사유도 함께 담는다', () => {
    const bad = { ...seg('broken.jdr'), error: 'JEB1 블록을 찾지 못했습니다' };
    const text = serializeIndexFile(buildIndexFile([{ seg: bad, file: fileFor(bad) }]));
    expect(parseIndexFile(text).get('data/broken.jdr')!.seg.error).toBe('JEB1 블록을 찾지 못했습니다');
  });

  it('828개 규모에서도 파일이 작다', () => {
    const items = Array.from({ length: 828 }, (_, i) => {
      const s = seg(`${String(i).padStart(8, '0')}.jdr`);
      return { seg: s, file: fileFor(s) };
    });
    const text = serializeIndexFile(buildIndexFile(items));
    expect(parseIndexFile(text).size).toBe(828);
    // 58GB 폴더의 인덱스가 200KB를 넘으면 안 된다
    expect(new TextEncoder().encode(text).length).toBeLessThan(200 * 1024);
  });
});

describe('인덱스 파일 찾기', () => {
  const mk = (path: string): File => {
    const f = new File([''], path.split('/').pop()!);
    Object.defineProperty(f, 'webkitRelativePath', { value: path });
    return f;
  };

  it('폴더 어디에 있어도 찾는다', () => {
    expect(findIndexFile([mk('SD/data/a.jdr'), mk(`SD/${INDEX_FILE_NAME}`)])?.name).toBe(INDEX_FILE_NAME);
    expect(findIndexFile([mk(`SD/data/${INDEX_FILE_NAME}`)])?.name).toBe(INDEX_FILE_NAME);
    expect(findIndexFile([mk('SD/data/a.jdr')])).toBeNull();
  });

  it('여러 개면 가장 위의 것을 쓴다', () => {
    const found = findIndexFile([mk(`SD/data/deep/${INDEX_FILE_NAME}`), mk(`SD/${INDEX_FILE_NAME}`)]);
    expect((found as File & { webkitRelativePath: string }).webkitRelativePath).toBe(`SD/${INDEX_FILE_NAME}`);
  });
});
