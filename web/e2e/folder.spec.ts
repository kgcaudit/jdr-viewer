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

test('인덱스 파일을 내보내 폴더에 두면 다음에 훑기를 건너뛴다', async ({ page }, testInfo) => {
  await openFolder(page);
  // 처음에는 직접 읽는다
  await expect(page.locator('#calendar')).toContainText('직접 읽음');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#btn-export-index').click(),
  ]);
  expect(download.suggestedFilename()).toBe('jdr-index.json');

  // 내려받은 인덱스를 폴더에 넣는다 (사용자가 손으로 복사하는 것과 같다)
  const saved = join(testInfo.outputDir, 'jdr-index.json');
  await download.saveAs(saved);
  const { copyFileSync, readFileSync } = await import('node:fs');
  copyFileSync(saved, join(dir, 'jdr-index.json'));

  const text = readFileSync(saved, 'utf8');
  expect(text).toContain('"format": "jdr-viewer-index"');
  expect(JSON.parse(text).count).toBe(10); // data 9 + broken 1

  try {
    // 캐시가 끼어들지 않도록 새 컨텍스트에서 연다
    const fresh = await page.context().browser()!.newContext();
    const p2 = await fresh.newPage();
    await p2.goto(codec?.startsWith('avc1') ? 'http://127.0.0.1:5173/' : `http://127.0.0.1:5173/?codec=${encodeURIComponent(codec ?? 'vp8')}`);
    await p2.locator('#folder-input').setInputFiles(dir);
    await expect(p2.locator('#view-calendar')).toBeVisible({ timeout: 60_000 });

    await expect(p2.locator('#calendar')).toContainText('인덱스 파일 10개');
    await expect(p2.locator('#calendar')).not.toContainText('직접 읽음');
    await expect(p2.locator('#calendar')).toContainText('헤더 훑기를 건너뛰었습니다');
    // 인덱스로 읽어도 날짜·운행이 그대로 나와야 한다
    await expect(p2.locator('.cal-cell.is-on')).toHaveCount(2);
    await p2.locator('[data-day="2026-09-08"]').click();
    await expect(p2.locator('.session-row')).toHaveCount(2);
    // 그리고 실제로 재생까지 된다
    await p2.locator('[data-session="0"]').click();
    await expect(p2.locator('#btn-play')).toBeEnabled({ timeout: 60_000 });
    await expect(p2.locator('#file-note')).toContainText('구간 1/3');
    await fresh.close();
  } finally {
    const { rmSync } = await import('node:fs');
    rmSync(join(dir, 'jdr-index.json'), { force: true });
  }
});

test('파일이 바뀌면 그 파일만 다시 읽는다', async ({ page }, testInfo) => {
  await openFolder(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#btn-export-index').click(),
  ]);
  const saved = join(testInfo.outputDir, 'idx.json');
  await download.saveAs(saved);

  const { readFileSync, writeFileSync, rmSync } = await import('node:fs');
  // 한 파일의 수정 시각을 조작해 "바뀐 파일"을 흉내낸다
  const idx = JSON.parse(readFileSync(saved, 'utf8'));
  const row = idx.rows.find((r: unknown[]) => String(r[0]).endsWith('00000460.jdr'));
  row[2] = 1;                       // mtime 불일치
  writeFileSync(join(dir, 'jdr-index.json'), JSON.stringify(idx));

  try {
    const fresh = await page.context().browser()!.newContext();
    const p2 = await fresh.newPage();
    await p2.goto('http://127.0.0.1:5173/');
    await p2.locator('#folder-input').setInputFiles(dir);
    await expect(p2.locator('#view-calendar')).toBeVisible({ timeout: 60_000 });
    // 9개는 인덱스에서, 1개는 직접
    await expect(p2.locator('#calendar')).toContainText('인덱스 파일 9개');
    await expect(p2.locator('#calendar')).toContainText('직접 읽음 1개');
    await fresh.close();
  } finally {
    rmSync(join(dir, 'jdr-index.json'), { force: true });
  }
});

test('깨진 인덱스 파일은 사유를 알리고 직접 읽는다', async ({ page }) => {
  const { writeFileSync, rmSync } = await import('node:fs');
  writeFileSync(join(dir, 'jdr-index.json'), '{ 이건 JSON이 아님');
  try {
    await openFolder(page);
    await expect(page.locator('#calendar')).toContainText('인덱스 파일을 쓸 수 없어');
    await expect(page.locator('#calendar')).toContainText('직접 읽음 10개');
    // 그래도 캘린더는 정상으로 나온다
    await expect(page.locator('.cal-cell.is-on')).toHaveCount(2);
  } finally {
    rmSync(join(dir, 'jdr-index.json'), { force: true });
  }
});

test('같은 날짜의 다른 운행으로 캘린더 없이 바로 옮긴다', async ({ page }) => {
  await openMorningSession(page);
  const chips = page.locator('#session-chips .chip-btn');
  // [09-08 전체] [08:09~] [22:24~]
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(1)).toHaveClass(/is-active/);

  // 오후 운행으로 바로 이동 (캘린더로 돌아가지 않는다)
  await chips.nth(2).click();
  await expect(page.locator('#btn-play')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#view-main')).toBeVisible();
  await expect(page.locator('#file-note')).toContainText('00000463.jdr');
  await expect(page.locator('#session-chips .chip-btn').nth(2)).toHaveClass(/is-active/);

  // 날짜 전체로도 갈 수 있다
  await page.locator('#session-chips .chip-btn').first().click();
  await expect(page.locator('#btn-play')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#file-note')).toContainText('구간 1/6');
});

test('구간이 바뀌어도 지도 위치와 배율이 유지된다', async ({ page }) => {
  await openMorningSession(page);
  await page.locator('.tab[data-tab="map"]').click();
  await expect(page.locator('#map path.leaflet-interactive').first()).toBeVisible({ timeout: 20_000 });

  // 경로 폴리라인의 좌표는 배율·위치가 바뀌면 같이 바뀐다
  const readPath = () => page.locator('#map path.leaflet-interactive').first().getAttribute('d');
  const initial = await readPath();

  // 사용자가 배율을 바꿔 둔 상태를 만든다
  // (짧은 경로라 처음부터 최대 배율이므로 축소로 확인한다)
  await page.locator('#map .leaflet-control-zoom-out').first().click();
  await page.locator('#map .leaflet-control-zoom-out').first().click();
  await expect.poll(readPath, { timeout: 10_000 }).not.toBe(initial);
  const zoomed = await readPath();

  // 다음 파일로 넘어가도 보던 위치·배율이 그대로여야 한다
  await page.locator('#btn-next-file').click();
  await expect(page.locator('#file-note')).toContainText('구간 2/3', { timeout: 20_000 });
  await page.waitForTimeout(1200);
  expect(await readPath()).toBe(zoomed);

  // 필요하면 버튼으로 전체 경로를 다시 맞출 수 있다
  await page.locator('#btn-fit-map').click();
  await expect.poll(readPath, { timeout: 10_000 }).not.toBe(zoomed);
});

test('구간 전환 중 이전 화면이 남지 않는다', async ({ page }) => {
  test.skip(codec === null, '이 브라우저에서 쓸 수 있는 인코더가 없습니다');
  await openMorningSession(page);

  // 첫 프레임이 그려질 때까지 재생
  await page.locator('#btn-play').click();
  await page.waitForFunction(() => {
    const c = document.getElementById('canvas-0') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let min = 255; let max = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i] < min) min = d[i]; if (d[i] > max) max = d[i]; }
    return max - min > 40;
  }, undefined, { timeout: 20_000 });
  await page.locator('#btn-play').click();

  // 전환을 시작한 직후에는 화면이 깨끗이 비워져야 한다 (잔상 금지)
  const cleared = await page.evaluate(async () => {
    const c = document.getElementById('canvas-0') as HTMLCanvasElement;
    (document.getElementById('btn-next-file') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 30));
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) {
      max = Math.max(max, d[i], d[i + 1], d[i + 2]);
    }
    return max;
  });
  expect(cleared, '전환 직후 캔버스가 검게 지워져야 한다').toBeLessThan(12);
  await expect(page.locator('#file-note')).toContainText('구간 2/3', { timeout: 20_000 });
});
