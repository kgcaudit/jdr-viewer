import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

let dir = '';
let codec: string | null = null;

/**
 * 실제 기기처럼 data/ 아래에 순번 파일들을 깔되,
 * 번호 순서와 시각 순서를 어긋나게 만들어 정렬을 검증한다.
 * 중간에 빈 구간도 넣는다.
 */
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:5173/e2e/fixture.html');
  await page.waitForFunction(() => typeof window.buildSampleJdr === 'function');
  codec = await page.evaluate(() => window.sampleCodec);

  dir = mkdtempSync(join(tmpdir(), 'jdr-folder-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(join(dir, 'event'), { recursive: true });

  const plan: { file: string; start: string }[] = [
    // 번호는 465가 먼저지만 시각은 뒤 — 루프 녹화 덮어쓰기 상황
    { file: 'data/00000465.jdr', start: '2026-01-15T09:30:03' },
    { file: 'data/00000001.jdr', start: '2026-01-15T09:30:00' },
    // 빈 구간 뒤에 이어지는 파일
    { file: 'data/00000466.jdr', start: '2026-01-15T09:31:00' },
    // event는 data와 같은 시각을 담는다 (겹침)
    { file: 'event/00000000.jdr', start: '2026-01-15T09:30:00' },
  ];
  for (const p of plan) {
    const arr = await page.evaluate((s) => window.buildSampleJdr(s), p.start);
    writeFileSync(join(dir, p.file), Buffer.from(arr));
  }
  // 읽을 수 없는 파일도 하나 — 조용히 버리지 않는지 본다
  writeFileSync(join(dir, 'data', 'broken.jdr'), Buffer.alloc(40_000, 0xab));
  await page.close();
});

test.afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function openFolder(page: Page): Promise<void> {
  await page.goto(codec?.startsWith('avc1') ? '/' : `/?codec=${encodeURIComponent(codec ?? 'vp8')}`);
  await page.locator('#folder-input').setInputFiles(dir);
  await expect(page.locator('#btn-play')).toBeEnabled({ timeout: 60_000 });
}

test('폴더를 열면 기록 시각 순으로 타임라인을 만든다', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openFolder(page);

  // 기본 선택은 가장 길게 찍힌 폴더(data) 하나
  await page.locator('.tab[data-tab="segments"]').click();
  const rows = page.locator('.seg-row .seg-name');
  await expect(rows).toHaveCount(3);
  // 번호가 아니라 시각 순이어야 한다
  await expect(rows.nth(0)).toHaveText('00000001.jdr');
  await expect(rows.nth(1)).toHaveText('00000465.jdr');
  await expect(rows.nth(2)).toHaveText('00000466.jdr');

  // 읽지 못한 파일을 사유와 함께 보여준다
  await expect(page.locator('#tab-segments')).toContainText('broken.jdr');
  await expect(page.locator('#tab-segments')).toContainText('JEB1');
  expect(errors).toEqual([]);
});

test('빈 구간을 찾아 표시한다', async ({ page }) => {
  await openFolder(page);
  await page.locator('.tab[data-tab="segments"]').click();
  await expect(page.locator('#tab-segments')).toContainText('빈 구간');
  // 타임라인 스트립에도 그린다 (숨기지 않는다)
  expect(await page.locator('#strip-track .strip-gap').count()).toBeGreaterThanOrEqual(1);
  await expect(page.locator('#strip-track .strip-seg')).toHaveCount(3);
});

test('요약에 병합 타임라인이 나온다', async ({ page }) => {
  await openFolder(page);
  const summary = page.locator('#tab-summary');
  await expect(summary).toContainText('병합 타임라인');
  await expect(summary).toContainText('구간');
  await expect(summary).toContainText('빈 구간');
  await expect(summary).toContainText('현재 구간 파일');
});

test('폴더를 추가하면 겹침을 알려준다', async ({ page }) => {
  await openFolder(page);
  await page.locator('.tab[data-tab="segments"]').click();
  await page.locator('input[data-folder="event"]').check();
  await expect(page.locator('#btn-play')).toBeEnabled({ timeout: 30_000 });
  await page.locator('.tab[data-tab="summary"]').click();
  await expect(page.locator('#tab-summary')).toContainText('겹칩니다');
});

test('현재 프레임의 출처 파일을 항상 표시한다', async ({ page }) => {
  await openFolder(page);
  await expect(page.locator('#source-note')).toContainText('출처 data/00000001.jdr');
  await expect(page.locator('#source-note')).toContainText('구간 1/3');
});

test('파일 경계를 넘어 이어서 재생한다', async ({ page }) => {
  test.skip(codec === null, '이 브라우저에서 쓸 수 있는 인코더가 없습니다');
  await openFolder(page);

  // 첫 구간 끝 가까이로 이동한 뒤 재생 → 다음 구간으로 자동 전환되어야 한다
  await page.locator('#seek').evaluate((el: HTMLInputElement) => {
    el.value = '1200'; // 첫 파일(1.5초) 끝 무렵
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('#btn-play').click();

  await expect(page.locator('#source-note')).toContainText('구간 2/3', { timeout: 25_000 });
  await expect(page.locator('#source-note')).toContainText('00000465.jdr');

  // 전환 후에도 영상이 그려져야 한다
  await page.waitForFunction(() => {
    const c = document.getElementById('canvas-0') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let min = 255; let max = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i] < min) min = d[i]; if (d[i] > max) max = d[i]; }
    return max - min > 40;
  }, undefined, { timeout: 20_000 });
});

test('빈 구간으로 이동하면 다음 구간 시작으로 건너뛴다', async ({ page }) => {
  await openFolder(page);
  const before = await page.locator('#source-note').textContent();
  expect(before).toContain('구간 1/3');

  // 갭 한가운데(약 09:30:30)로 이동
  await page.locator('#seek').evaluate((el: HTMLInputElement) => {
    el.value = '30000';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#source-note')).toContainText('구간 3/3', { timeout: 20_000 });
  await expect(page.locator('#recorded-time')).toContainText('09:31:00');
});

test('전 구간 GPS 스캔이 백그라운드로 끝난다', async ({ page }) => {
  await openFolder(page);
  await page.locator('.tab[data-tab="map"]').click();
  await expect(page.locator('#scan-note')).toContainText('전 구간 스캔 완료', { timeout: 30_000 });
  await expect(page.locator('#scan-note')).toContainText('GPS');
  await expect(page.locator('#map path.leaflet-interactive').first()).toBeVisible();
});
