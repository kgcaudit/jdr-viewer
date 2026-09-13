import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

let dir = '';
let codec: string | null = null;

/**
 * 실제 기기 모양으로 폴더를 만든다.
 * - 파일명은 순번뿐 (시각 정보 없음)
 * - 번호 순서와 시각 순서가 어긋남 (루프 녹화 덮어쓰기)
 * - 하루 안에 운행이 둘로 나뉨 (오전/오후)
 * - event 폴더는 data와 같은 시각을 담음
 */
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:5173/e2e/fixture.html');
  await page.waitForFunction(() => typeof window.buildSampleJdr === 'function');

  dir = mkdtempSync(join(tmpdir(), 'jdr-cal-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(join(dir, 'event'), { recursive: true });

  const plan: { file: string; start: string }[] = [];
  // 9/8 오전 운행 3개 (번호는 큰 쪽)
  for (let i = 0; i < 3; i++) {
    plan.push({ file: `data/${String(460 + i).padStart(8, '0')}.jdr`, start: `2026-09-08T08:09:${String(19 + i * 2).padStart(2, '0')}` });
  }
  // 9/8 오후 운행 3개 — 공백 10분 이상이라 다른 세션
  for (let i = 0; i < 3; i++) {
    plan.push({ file: `data/${String(463 + i).padStart(8, '0')}.jdr`, start: `2026-09-08T22:24:${String(53 + i * 2).padStart(2, '0')}` });
  }
  // 9/9 2개 (번호는 작은 쪽 = 덮어쓰기로 더 최근)
  for (let i = 0; i < 2; i++) {
    plan.push({ file: `data/${String(1 + i).padStart(8, '0')}.jdr`, start: `2026-09-09T08:10:${String(10 + i * 2).padStart(2, '0')}` });
  }
  plan.push({ file: 'event/00000000.jdr', start: '2026-09-08T08:09:19' });

  for (const p of plan) {
    const arr = await page.evaluate((s) => window.buildSampleJdr(s), p.start);
    writeFileSync(join(dir, p.file), Buffer.from(arr));
  }
  writeFileSync(join(dir, 'data', 'broken.jdr'), Buffer.alloc(40_000, 0xab));
  codec = await page.evaluate(() => window.sampleCodec);
  await page.close();
});

test.afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function openFolder(page: Page): Promise<void> {
  await page.goto(codec?.startsWith('avc1') ? '/' : `/?codec=${encodeURIComponent(codec ?? 'vp8')}`);
  await page.locator('#folder-input').setInputFiles(dir);
  await expect(page.locator('#view-calendar')).toBeVisible({ timeout: 60_000 });
}

/** 9/8 오전 운행을 연다 */
async function openMorningSession(page: Page): Promise<void> {
  await openFolder(page);
  await page.locator('[data-day="2026-09-08"]').click();
  await page.locator('[data-session="0"]').click();
  await expect(page.locator('#btn-play')).toBeEnabled({ timeout: 60_000 });
}

test('폴더를 열면 재생이 아니라 캘린더가 먼저 뜬다', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openFolder(page);

  await expect(page.locator('#view-main')).toBeHidden();
  await expect(page.locator('.cal-title')).toHaveText('2026년 9월');
  // 녹화가 있는 날만 누를 수 있다
  await expect(page.locator('.cal-cell.is-on')).toHaveCount(2);
  await expect(page.locator('[data-day="2026-09-08"]')).toBeVisible();
  await expect(page.locator('[data-day="2026-09-09"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('날짜를 누르면 운행 단위로 나눠 보여준다', async ({ page }) => {
  await openFolder(page);
  await page.locator('[data-day="2026-09-08"]').click();
  // 오전/오후 두 운행
  await expect(page.locator('.session-row')).toHaveCount(2);
  await expect(page.locator('.session-row').nth(0)).toContainText('08:09');
  await expect(page.locator('.session-row').nth(1)).toContainText('22:24');
  await expect(page.locator('[data-open-day]')).toContainText('6개');
});

test('운행을 열면 그 구간만 타임라인에 들어간다', async ({ page }) => {
  await openMorningSession(page);
  await expect(page.locator('#view-main')).toBeVisible();
  await page.locator('.tab[data-tab="segments"]').click();
  await expect(page.locator('.seg-row')).toHaveCount(3);
  await expect(page.locator('#file-note')).toContainText('구간 1/3');
  // 9/8 오전 파일만 들어와야 한다
  await expect(page.locator('#file-note')).toContainText('data/00000460.jdr');
});

test('시간 라벨이 전체가 아니라 현재 파일 기준이다', async ({ page }) => {
  await openMorningSession(page);
  // 파일 하나가 1.5초 남짓이므로 총 길이도 그 정도여야 한다 (전체 합계가 아님)
  const label = await page.locator('#time-label').textContent();
  expect(label).toMatch(/^0:0\d\.\d \/ 0:0[12]\.\d$/);
  const seekMax = await page.locator('#seek').getAttribute('max');
  expect(Number(seekMax)).toBeLessThan(3000);
});

test('⏮⏭ 는 프레임이 아니라 영상 파일을 이동한다', async ({ page }) => {
  await openMorningSession(page);
  await expect(page.locator('#file-note')).toContainText('구간 1/3');

  await page.locator('#btn-next-file').click();
  await expect(page.locator('#file-note')).toContainText('구간 2/3', { timeout: 20_000 });
  await expect(page.locator('#file-note')).toContainText('00000461.jdr');

  await page.locator('#btn-next-file').click();
  await expect(page.locator('#file-note')).toContainText('구간 3/3', { timeout: 20_000 });

  // 재생이 시작된 직후라면 ⏮ 는 이전 파일로 간다
  await page.locator('#btn-prev-file').click();
  await expect(page.locator('#file-note')).toContainText('구간 2/3', { timeout: 20_000 });
});

test('10초 앞으로가 파일 경계를 넘어간다', async ({ page }) => {
  await openMorningSession(page);
  await expect(page.locator('#file-note')).toContainText('구간 1/3');
  // 파일이 1.5초짜리라 +10초면 뒤쪽 파일로 넘어가야 한다
  await page.locator('#btn-fwd10').click();
  await expect(page.locator('#file-note')).toContainText('구간 3/3', { timeout: 20_000 });

  await page.locator('#btn-back10').click();
  await expect(page.locator('#file-note')).toContainText('구간 1/3', { timeout: 20_000 });
});

test('캘린더로 돌아갈 수 있다', async ({ page }) => {
  await openMorningSession(page);
  await page.locator('#btn-back-calendar').click();
  await expect(page.locator('#view-calendar')).toBeVisible();
  // 다른 날짜를 골라 다시 열 수 있다
  await page.locator('[data-day="2026-09-09"]').click();
  await page.locator('[data-open-day]').click();
  await expect(page.locator('#btn-play')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#file-note')).toContainText('구간 1/2');
});

test('스캔은 전체 폴더가 아니라 선택한 구간만 돈다', async ({ page }) => {
  await openMorningSession(page);
  await page.locator('.tab[data-tab="map"]').click();
  await expect(page.locator('#scan-note')).toContainText('스캔 완료', { timeout: 30_000 });
  // 9개 전부가 아니라 3개만
  await expect(page.locator('#scan-note')).toContainText('08:09 운행');
  await expect(page.locator('#map path.leaflet-interactive').first()).toBeVisible();
});

test('폴더를 고르면 기본은 data 하나, event는 체크로 추가', async ({ page }) => {
  await openFolder(page);
  await expect(page.locator('input[data-folder="data"]')).toBeChecked();
  await expect(page.locator('input[data-folder="event"]')).not.toBeChecked();

  await page.locator('input[data-folder="event"]').check();
  await page.locator('[data-day="2026-09-08"]').click();
  // event가 들어오면 오전 운행 파일이 하나 늘어난다
  await expect(page.locator('.session-row').nth(0)).toContainText('4개');
});

test('두 번째로 열면 캐시를 쓴다', async ({ page }) => {
  await openFolder(page);
  await expect(page.locator('.cal-cell.is-on')).toHaveCount(2);
  // 같은 세션에서 다시 열기 → IndexedDB 캐시 적중
  await page.locator('#folder-input').setInputFiles(dir);
  await expect(page.locator('#toast')).toContainText('캐시에서 읽었습니다', { timeout: 60_000 });
  await expect(page.locator('.cal-cell.is-on')).toHaveCount(2);
});

test('작은 화면에서도 캘린더가 무너지지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await openFolder(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, '가로 스크롤이 생기면 안 된다').toBeLessThanOrEqual(1);
  await expect(page.locator('.cal-grid')).toBeVisible();
});
