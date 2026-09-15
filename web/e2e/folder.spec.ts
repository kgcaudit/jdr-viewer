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
  // event 폴더 파일은 따로 센다 (data와 같은 시각을 겹쳐 쓰므로)
  await expect(page.locator('[data-open-day]')).toContainText('6개 + 이벤트 1');
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

test('data와 event를 처음부터 함께 본다', async ({ page }) => {
  await openFolder(page);
  // 기기는 한 주행을 두 폴더에 나눠 쓰므로 둘 다 켜져 있어야 한다
  await expect(page.locator('input[data-folder="data"]')).toBeChecked();
  await expect(page.locator('input[data-folder="event"]')).toBeChecked();

  await page.locator('[data-day="2026-09-08"]').click();
  await expect(page.locator('.session-row').nth(0)).toContainText('3개 + 이벤트 1');

  // event를 빼면 평상시 파일만 남는다
  await page.locator('input[data-folder="event"]').uncheck();
  await page.locator('[data-day="2026-09-08"]').click();
  await expect(page.locator('.session-row').nth(0)).toContainText('3개');
});

test('event가 data와 같은 시각이면 되풀이 재생하지 않는다', async ({ page }) => {
  await openMorningSession(page);
  await page.locator('.tab[data-tab="segments"]').click();
  const panel = page.locator('#tab-segments');

  // 픽스처의 event 파일은 data/00000460과 같은 시각이다
  await expect(page.locator('#file-note')).toContainText('구간 1/3');
  // 그래도 "여기서 이벤트가 걸렸다"는 사실은 남는다
  await expect(panel).toContainText('이벤트 1건');
  await expect(panel).toContainText('data와 같은 시각');
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

test('인덱스를 저장해 폴더에 두면 다음에 훑기를 건너뛴다', async ({ page }, testInfo) => {
  await openFolder(page);
  // 처음에는 직접 읽는다
  await expect(page.locator('#calendar')).toContainText('직접 읽음');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#btn-save-index').click(),
  ]);
  expect(download.suggestedFilename()).toBe('jdr-index.json');

  // 저장한 인덱스를 폴더에 넣는다 (사용자가 손으로 옮기는 것과 같다)
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
    page.locator('#btn-save-index').click(),
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

test('타임라인에 오르지 못한 파일이 몇 개인지 밝힌다', async ({ page }) => {
  // 실기기 카드: 826개를 읽었는데 화면에는 660개뿐이었다. 나머지 166개가
  // 어디 갔는지 화면에 한 줄도 없었다 — 감사 자료에서 그러면 안 된다.
  await openFolder(page);
  const cal = page.locator('#calendar');
  // 고정 폴더에는 못 읽는 파일(broken.jdr)이 하나 있다
  await expect(cal).toContainText('타임라인에 없습니다');
  await expect(cal).toContainText('열지 못한 파일 1개');
});

test('인덱스가 꼬이면 갱신 버튼으로 원본에서 다시 만든다', async ({ page }, testInfo) => {
  await openFolder(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#btn-save-index').click(),
  ]);
  const saved = join(testInfo.outputDir, 'idx-bad.json');
  await download.saveAs(saved);

  const { readFileSync, writeFileSync, rmSync } = await import('node:fs');
  // 모든 행의 종료 시각을 한 시간 뒤로 밀어 "꼬인 인덱스"를 만든다.
  // 크기·수정시각은 그대로라 앱은 이 인덱스를 믿는다 — 사용자가 손쓸 수 없던 상황이다.
  const idx = JSON.parse(readFileSync(saved, 'utf8'));
  for (const row of idx.rows) row[4] = row[3] + 3_600_000;
  writeFileSync(join(dir, 'jdr-index.json'), JSON.stringify(idx));

  try {
    const fresh = await page.context().browser()!.newContext();
    const p2 = await fresh.newPage();
    await p2.goto('http://127.0.0.1:5173/');
    await p2.locator('#folder-input').setInputFiles(dir);
    await expect(p2.locator('#view-calendar')).toBeVisible({ timeout: 60_000 });
    await expect(p2.locator('#calendar')).toContainText('인덱스 파일 10개');

    // 저장과 갱신은 나란히 있어야 한다 — 꼬인 걸 고치고 곧바로 저장하는 흐름이다
    await expect(p2.locator('.idx-row #btn-save-index')).toBeVisible();
    await expect(p2.locator('.idx-row #btn-rebuild-index')).toBeVisible();

    const meta = p2.locator('.cal-cell.is-on .cal-meta').first();
    const before = (await meta.textContent()) ?? '';
    expect(before, '꼬인 인덱스라 길이가 부풀어 있다').toContain('시간');

    p2.once('dialog', (d) => void d.accept());
    await p2.locator('#btn-rebuild-index').click();

    // 인덱스도 캐시도 쓰지 않고 전부 원본에서 읽는다
    await expect(p2.locator('#calendar')).toContainText('직접 읽음 10개', { timeout: 60_000 });
    await expect(p2.locator('#calendar')).not.toContainText('인덱스 파일 10개');
    await expect(p2.locator('#calendar')).toContainText('원본 10개를 다시 읽었습니다');

    const after = (await meta.textContent()) ?? '';
    expect(after, '원본 값으로 돌아와야 한다').not.toContain('시간');
    expect(after).not.toBe(before);

    // 브라우저 캐시에도 낡은 값이 남아 있었다. 갱신이 그것까지 덮어써야
    // 다음에 열 때 다시 꼬이지 않는다.
    rmSync(join(dir, 'jdr-index.json'), { force: true });
    await p2.goto('http://127.0.0.1:5173/');
    await p2.locator('#folder-input').setInputFiles(dir);
    await expect(p2.locator('#view-calendar')).toBeVisible({ timeout: 60_000 });
    await expect(p2.locator('#calendar')).toContainText('브라우저 캐시 10개');
    expect(await p2.locator('.cal-cell.is-on .cal-meta').first().textContent()).not.toContain('시간');
    await fresh.close();
  } finally {
    rmSync(join(dir, 'jdr-index.json'), { force: true });
  }
});

test('인덱스 뒤에 추가된 파일은 그것만 읽고, 두 번째부터는 캐시가 받는다', async ({ page }, testInfo) => {
  await openFolder(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#btn-save-index').click(),
  ]);
  const saved = join(testInfo.outputDir, 'idx-partial.json');
  await download.saveAs(saved);

  const { readFileSync, writeFileSync, rmSync } = await import('node:fs');
  // 한 행을 빼서 "인덱스를 저장한 뒤 녹화된 파일"을 흉내낸다
  const idx = JSON.parse(readFileSync(saved, 'utf8'));
  idx.rows = idx.rows.filter((r: unknown[]) => !String(r[0]).endsWith('00000460.jdr'));
  idx.count = idx.rows.length;
  writeFileSync(join(dir, 'jdr-index.json'), JSON.stringify(idx));

  try {
    const fresh = await page.context().browser()!.newContext();
    const p2 = await fresh.newPage();
    await p2.goto('http://127.0.0.1:5173/');

    // 첫 열기: 인덱스에 없는 1개만 직접 읽고, 다시 저장하라고 알린다
    await p2.locator('#folder-input').setInputFiles(dir);
    await expect(p2.locator('#view-calendar')).toBeVisible({ timeout: 60_000 });
    await expect(p2.locator('#calendar')).toContainText('인덱스 파일 9개');
    await expect(p2.locator('#calendar')).toContainText('직접 읽음 1개');
    await expect(p2.locator('#calendar')).toContainText('인덱스에 없는 파일이 1개');
    await expect(p2.locator('#btn-save-index')).toHaveClass(/btn-primary/);

    // 두 번째 열기: 인덱스 파일이 그대로여도 캐시가 그 1개를 받아준다
    await p2.locator('#folder-input').setInputFiles(dir);
    await expect(p2.locator('#view-calendar')).toBeVisible({ timeout: 60_000 });
    await expect(p2.locator('#calendar')).toContainText('브라우저 캐시 1개');
    await expect(p2.locator('#calendar')).not.toContainText('직접 읽음');
    await fresh.close();
  } finally {
    rmSync(join(dir, 'jdr-index.json'), { force: true });
  }
});

test('다시 저장하면 인덱스 경고가 사라진다', async ({ page }, testInfo) => {
  await openFolder(page);
  const [first] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#btn-save-index').click(),
  ]);
  const saved = join(testInfo.outputDir, 'idx-warn.json');
  await first.saveAs(saved);

  const { readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const idx = JSON.parse(readFileSync(saved, 'utf8'));
  idx.rows = idx.rows.slice(0, -1);
  idx.count = idx.rows.length;
  writeFileSync(join(dir, 'jdr-index.json'), JSON.stringify(idx));

  try {
    const fresh = await page.context().browser()!.newContext();
    const p2 = await fresh.newPage();
    await p2.goto('http://127.0.0.1:5173/');
    await p2.locator('#folder-input').setInputFiles(dir);
    await expect(p2.locator('#view-calendar')).toBeVisible({ timeout: 60_000 });
    await expect(p2.locator('#calendar')).toContainText('인덱스에 없는 파일이');

    const [again] = await Promise.all([
      p2.waitForEvent('download'),
      p2.locator('#btn-save-index').click(),
    ]);
    // 새로 저장한 인덱스에는 빠졌던 파일까지 들어 있다
    const out = join(testInfo.outputDir, 'idx-again.json');
    await again.saveAs(out);
    expect(JSON.parse(readFileSync(out, 'utf8')).count).toBe(10);
    await expect(p2.locator('#calendar')).not.toContainText('인덱스에 없는 파일이');
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

/** "0:01.4" → 1.4 */
function parseClock(text: string): number {
  const m = /(\d+):(\d+(?:\.\d+)?)/.exec(text.trim());
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

test('재생이 끝나도 시간이 길이를 넘지 않는다', async ({ page }) => {
  test.skip(codec === null, '이 브라우저에서 쓸 수 있는 인코더가 없습니다');
  await openMorningSession(page);
  await page.locator('#btn-play').click();

  // 마지막 구간까지 간 뒤 멈출 때까지 기다린다
  await expect(page.locator('#file-note')).toContainText('구간 3/3', { timeout: 30_000 });
  await expect(page.locator('#btn-play')).toHaveText('▶', { timeout: 30_000 });

  const label = (await page.locator('#time-label').textContent()) ?? '';
  const [pos, dur] = label.split('/').map(parseClock);
  expect(Number.isFinite(pos) && Number.isFinite(dur)).toBe(true);
  // 헤더 종료 시각이 실제보다 이르면 "1:10.7 / 1:08.9" 처럼 넘어가던 문제
  expect(pos, `재생 위치(${pos})가 길이(${dur})를 넘으면 안 된다`).toBeLessThanOrEqual(dur + 0.15);
});

test('스트립을 끌면 말풍선이 따라오고, 뗄 때 이동한다', async ({ page }) => {
  await openMorningSession(page);
  const track = page.locator('#strip-track');
  const bubble = page.locator('#strip-bubble');
  await expect(track).toBeVisible();
  await expect(bubble).toBeHidden();

  const box = (await track.boundingBox())!;
  // 3번째 구간쯤을 겨냥해 누른 채로 끈다
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(bubble).toBeVisible();
  const at20 = await bubble.innerText();
  expect(at20).toMatch(/\d\d:\d\d:\d\d/);
  expect(at20).toContain('.jdr');

  // 끌면 내용이 바뀐다 (아직 이동은 하지 않는다)
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2);
  const at85 = await bubble.innerText();
  expect(at85).not.toBe(at20);
  await expect(page.locator('#file-note')).toContainText('구간 1/3');

  // 떼면 그제서야 이동한다
  await page.mouse.up();
  await expect(bubble).toBeHidden();
  await expect(page.locator('#file-note')).toContainText('구간 3/3', { timeout: 20_000 });
});

test('스트립 구간이 손가락으로 겨냥할 만큼 넓다', async ({ page }) => {
  // 터치 기기(폰)로 흉내낸다 — 트랙이 두꺼워져야 한다
  const touch = await page.context().browser()!.newContext({
    viewport: { width: 390, height: 780 },
    hasTouch: true,
    isMobile: true,
  });
  const p2 = await touch.newPage();
  try {
    await p2.goto(codec?.startsWith('avc1') ? '/' : `/?codec=${encodeURIComponent(codec ?? 'vp8')}`);
    await p2.locator('#folder-input').setInputFiles(dir);
    await expect(p2.locator('#view-calendar')).toBeVisible({ timeout: 60_000 });
    await p2.locator('[data-day="2026-09-08"]').click();
    await p2.locator('[data-session="0"]').click();
    await expect(p2.locator('#btn-play')).toBeEnabled({ timeout: 60_000 });

    expect(await p2.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const track = await p2.locator('#strip-track').boundingBox();
    expect(track!.height, '터치 표적은 두꺼워야 한다').toBeGreaterThanOrEqual(40);

    const widths = await p2.locator('#strip-track .strip-seg').evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).getBoundingClientRect().width),
    );
    expect(widths.length).toBe(3);
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(7);

    // 길게 눌러도 텍스트 선택·하이라이트가 생기지 않는다
    const style = await p2.locator('#strip-track').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { touchAction: cs.touchAction, userSelect: cs.userSelect };
    });
    expect(style.touchAction).toBe('none');
    expect(style.userSelect).toBe('none');
  } finally {
    await touch.close();
  }
});

test('마우스에서는 스트립이 과하게 두껍지 않다', async ({ page }) => {
  await openMorningSession(page);
  const track = await page.locator('#strip-track').boundingBox();
  expect(track!.height).toBeLessThan(40);
});

test('빈 구간을 눌러도 녹화가 있는 시각으로만 간다', async ({ page }) => {
  // 오전+오후를 한 번에 여는 날짜 단위 열기 → 가운데에 13시간 공백이 있다
  await openFolder(page);
  await page.locator('[data-day="2026-09-08"]').click();
  await page.locator('[data-open-day]').click();
  await expect(page.locator('#btn-play')).toBeEnabled({ timeout: 60_000 });

  const gap = page.locator('#strip-track .strip-gap').first();
  await expect(gap).toBeVisible();
  const box = (await gap.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
  await page.mouse.down();
  const text = await page.locator('#strip-bubble').innerText();
  await page.mouse.up();

  // 공백 뒤쪽을 눌렀으니 오후 운행 첫 파일의 시작으로 붙어야 한다
  expect(text).toContain('22:24');
  await expect(page.locator('#file-note')).toContainText('구간 4/6', { timeout: 20_000 });
});

test('즐겨찾기를 담고 목록에서 바로 돌아간다', async ({ page }) => {
  await openMorningSession(page);
  const star = page.locator('#btn-bookmarks');
  await expect(star).toBeVisible();
  await expect(page.locator('#bm-count')).toHaveText('0');

  // 3번째 구간으로 옮긴 뒤 담는다
  await page.locator('#btn-next-file').click();
  await page.locator('#btn-next-file').click();
  await expect(page.locator('#file-note')).toContainText('구간 3/3', { timeout: 20_000 });
  await page.locator('#btn-bookmark').click();
  await expect(page.locator('#btn-bookmark')).toHaveText('★');
  await expect(page.locator('#bm-count')).toHaveText('1');

  // 1번째 구간으로 돌아가면 별이 빈다.
  // ⏮ 는 "조금 지났으면 현재 파일 처음으로"라 한 번에 한 칸씩만 확인하며 누른다.
  for (const want of ['구간 3/3', '구간 2/3', '구간 1/3']) {
    await page.locator('#btn-prev-file').click();
    await expect(page.locator('#file-note')).toContainText(want, { timeout: 20_000 });
  }
  await expect(page.locator('#btn-bookmark')).toHaveText('☆');

  // 목록에서 누르면 담아둔 구간으로 간다
  await star.click();
  await expect(page.locator('#bm-panel')).toBeVisible();
  await page.locator('#bm-panel [data-goto]').first().click();
  await expect(page.locator('#bm-overlay')).toBeHidden();
  await expect(page.locator('#file-note')).toContainText('구간 3/3', { timeout: 20_000 });
  await expect(page.locator('#btn-bookmark')).toHaveText('★');
});

test('다른 날짜의 즐겨찾기도 캘린더를 거치지 않고 간다', async ({ page }) => {
  await openMorningSession(page);
  await page.locator('#btn-bookmark').click();
  await expect(page.locator('#bm-count')).toHaveText('1');

  // 9/9로 옮긴다
  await page.locator('#btn-back-calendar').click();
  await page.locator('[data-day="2026-09-09"]').click();
  // 하단 운행 칩과 이름이 겹치므로 캘린더 안의 목록을 집는다
  await page.locator('#calendar [data-session="0"]').click();
  await expect(page.locator('#btn-play')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#recorded-time')).toContainText('2026-09-09');

  // 즐겨찾기를 누르면 9/8 오전 운행이 다시 열린다
  await page.locator('#btn-bookmarks').click();
  await page.locator('#bm-panel [data-goto]').first().click();
  await expect(page.locator('#recorded-time')).toContainText('2026-09-08', { timeout: 60_000 });
  await expect(page.locator('#btn-bookmark')).toHaveText('★');
});

test('즐겨찾기를 파일로 저장하고 다시 불러온다', async ({ page }, testInfo) => {
  await openMorningSession(page);
  await page.locator('#btn-bookmark').click();
  await page.locator('#btn-next-file').click();
  await expect(page.locator('#file-note')).toContainText('구간 2/3', { timeout: 20_000 });
  await page.locator('#btn-bookmark').click();
  await expect(page.locator('#bm-count')).toHaveText('2');

  await page.locator('#btn-bookmarks').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#bm-save').click(),
  ]);
  expect(download.suggestedFilename()).toBe('jdr-bookmarks.json');
  const saved = join(testInfo.outputDir, 'jdr-bookmarks.json');
  await download.saveAs(saved);

  const { readFileSync } = await import('node:fs');
  const parsed = JSON.parse(readFileSync(saved, 'utf8'));
  expect(parsed.format).toBe('jdr-viewer-bookmarks');
  expect(parsed.count).toBe(2);
  // 어느 파일의 몇 초인지가 남아야 증거로 쓸 수 있다
  expect(parsed.marks[0]).toHaveProperty('path');
  expect(parsed.marks[0]).toHaveProperty('relMs');

  // 즐겨찾기가 없는 새 브라우저에서 불러온다
  const fresh = await page.context().browser()!.newContext();
  const p2 = await fresh.newPage();
  try {
    await p2.goto(codec?.startsWith('avc1') ? '/' : `/?codec=${encodeURIComponent(codec ?? 'vp8')}`);
    await p2.locator('#folder-input').setInputFiles(dir);
    await expect(p2.locator('#view-calendar')).toBeVisible({ timeout: 60_000 });
    await expect(p2.locator('#bm-count')).toHaveText('0');

    await p2.locator('#btn-bookmarks').click();
    await expect(p2.locator('#bm-overlay')).toBeVisible();
    await p2.locator('#bm-file-input').setInputFiles({
      name: 'jdr-bookmarks.json',
      mimeType: 'application/json',
      buffer: readFileSync(saved),
    });
    await expect(p2.locator('#toast')).toContainText('2개를 불러왔습니다');
    await expect(p2.locator('#bm-count')).toHaveText('2');

    // 불러온 즐겨찾기로 바로 갈 수 있다
    await p2.locator('#bm-panel [data-goto]').first().click();
    await expect(p2.locator('#btn-play')).toBeEnabled({ timeout: 60_000 });
    await expect(p2.locator('#file-note')).toContainText('구간 1/3');
  } finally {
    await fresh.close();
  }
});

test('즐겨찾기를 지울 수 있다', async ({ page }) => {
  await openMorningSession(page);
  await page.locator('#btn-bookmark').click();
  await expect(page.locator('#bm-count')).toHaveText('1');

  await page.locator('#btn-bookmarks').click();
  await page.locator('#bm-panel [data-remove]').first().click();
  await expect(page.locator('#bm-count')).toHaveText('0');
  await expect(page.locator('#bm-panel')).toContainText('아직 없습니다');
  await expect(page.locator('#btn-bookmark')).toHaveText('☆');
});

test('재생 위치의 벽시계 시각이 탐색 막대와 내보내기 칸 양쪽에 있다', async ({ page }) => {
  // 구간을 지정해 내보낼 때 필요한 건 "지금 몇 시인가"다. 파일 안 위치
  // (0:02.8)만으로는 시작·끝을 고를 수 없고, 내보내기 칸까지 내려오면
  // 위쪽 재생 막대는 화면 밖이라 보이지 않는다.
  await openMorningSession(page);
  const clock = page.locator('#time-clock');
  await expect(clock).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  const atStart = await clock.textContent();

  await page.locator('[data-tab="export"]').click();
  await expect(page.locator('#rng-now-time')).toHaveText(atStart!);

  // 자리를 옮기면 양쪽이 같이 움직인다
  await page.locator('#btn-fwd10').click();
  await expect(clock).not.toHaveText(atStart!);
  await expect(page.locator('#rng-now-time')).toHaveText(await clock.textContent() ?? '');

  // [지금]을 누르면 그 시각이 시작 칸에 들어간다
  await page.locator('[data-now="from"]').click();
  const from = await page.locator('#rng-from').inputValue();
  expect(from).toBe(await clock.textContent());
});

test('시간 구간을 지정해 여러 파일을 하나로 내보낸다', async ({ page }, testInfo) => {
  await openMorningSession(page);
  await page.locator('.tab[data-tab="export"]').click();
  const panel = page.locator('#range-export');
  await expect(panel).toBeVisible();

  // 기본값은 현재 파일
  await expect(panel.locator('.rng-sum')).toContainText('원본 1개 파일');

  // 운행 전체로 넓히면 파일 3개에 걸친다
  await panel.locator('[data-preset="session"]').click();
  await expect(panel.locator('.rng-sum')).toContainText('원본 3개 파일');

  // 파일명이 사람이 읽을 수 있는 시각 규칙이다
  const names = await panel.locator('.export-item span').first().textContent();
  expect(names).toMatch(/^\d{6}_\d{6}-\d{6}_Front\.mp4$/);

  // 영상은 코덱을 타므로(이 컨테이너 픽스처는 VP8) 음성으로 이어붙이기를 확인한다
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    panel.locator('[data-range="audio"]').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^\d{6}_\d{6}-\d{6}_Audio\.wav$/);

  const saved = join(testInfo.outputDir, download.suggestedFilename());
  await download.saveAs(saved);
  const { statSync } = await import('node:fs');
  // 파일 3개 분량이 한 파일에 담겼다
  expect(statSync(saved).size).toBeGreaterThan(10_000);
});

test('구간을 좁히면 결과도 작아진다', async ({ page }, testInfo) => {
  await openMorningSession(page);
  await page.locator('.tab[data-tab="export"]').click();
  const panel = page.locator('#range-export');
  const { statSync } = await import('node:fs');

  const grab = async (): Promise<number> => {
    const [d] = await Promise.all([
      page.waitForEvent('download'),
      panel.locator('[data-range="audio"]').click(),
    ]);
    const at = join(testInfo.outputDir, `${Date.now()}_${d.suggestedFilename()}`);
    await d.saveAs(at);
    return statSync(at).size;
  };

  await panel.locator('[data-preset="session"]').click();
  const whole = await grab();

  await panel.locator('[data-preset="file"]').click();
  const one = await grab();

  expect(one).toBeLessThan(whole);
});

test('끝이 시작보다 빠르면 내보내기를 막는다', async ({ page }) => {
  await openMorningSession(page);
  await page.locator('.tab[data-tab="export"]').click();
  const panel = page.locator('#range-export');

  const from = await panel.locator('#rng-from').inputValue();
  await panel.locator('#rng-to').fill(from);
  await panel.locator('#rng-to').dispatchEvent('change');

  await expect(panel.locator('.rng-sum')).toContainText('끝이 시작보다 빠릅니다');
  await expect(panel.locator('[data-range="front"]')).toBeDisabled();
  await expect(panel.locator('[data-range="both"]')).toBeDisabled();
});

test('내보내기는 구간 단위 하나뿐이다', async ({ page }) => {
  await openMorningSession(page);
  await page.locator('.tab[data-tab="export"]').click();

  await expect(page.locator('#range-export')).toContainText('구간 지정');
  // 파일 하나를 통째로 저장하는 항목은 없다
  expect(await page.locator('#file-export').count()).toBe(0);
  expect(await page.locator('[data-export]').count()).toBe(0);

  // 저장 항목은 전부 시각 규칙 파일명을 달고 있다
  const names = await page.locator('#range-export .export-item span').first().textContent();
  expect(names).toMatch(/^\d{6}_\d{6}-\d{6}_/);
});

test('SHA-256은 저장이 아니라 점검이라 요약 탭에 남는다', async ({ page }) => {
  await openMorningSession(page);
  await page.locator('.tab[data-tab="summary"]').click();
  const summary = page.locator('#tab-summary');
  await expect(summary).toContainText('SHA-256');

  // 폴더 모드에서는 비싸서 자동 계산하지 않는다 — 누르면 계산한다
  const btn = summary.locator('#btn-hash');
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(summary.locator('.hash')).toHaveText(/^[0-9a-f]{64}$/, { timeout: 30_000 });
});

test('날짜 칩이 연도까지 보여 준다', async ({ page }) => {
  await openMorningSession(page);
  // 09-09 가 아니라 26/09/09
  await expect(page.locator('#session-chips')).toContainText('26/09/08 전체');
});

test('빈 구간이 왜 비었는지 알려 준다', async ({ page }) => {
  // 9/8 전체를 열면 오전·오후 사이에 13시간 공백이 있다
  await openFolder(page);
  await page.locator('[data-day="2026-09-08"]').click();
  await page.locator('[data-open-day]').click();
  await expect(page.locator('#btn-play')).toBeEnabled({ timeout: 60_000 });

  await page.locator('.tab[data-tab="segments"]').click();
  const panel = page.locator('#tab-segments');
  await expect(panel).toContainText('빈 구간 1곳');
  // 파일 번호가 건너뛰었는지 이어지는지를 밝힌다
  await expect(panel.locator('.gap-why')).toContainText('.jdr');
  await expect(panel).toContainText('파일 번호가 건너뛰면');
});

test('캘린더로 나가면 화면 깨움을 놓아준다 — 배터리', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __wake: { releases: number } };
    w.__wake = { releases: 0 };
    const nav = navigator as Navigator & { wakeLock?: { request(t: string): Promise<unknown> } };
    const orig = nav.wakeLock?.request.bind(nav.wakeLock);
    if (!orig) return;
    nav.wakeLock!.request = (async (type?: string) => {
      const s = (await orig(type ?? 'screen')) as { release(): Promise<void> };
      const release = s.release.bind(s);
      s.release = async () => { w.__wake.releases++; return release(); };
      return s;
    }) as typeof nav.wakeLock.request;
  });

  await openMorningSession(page);
  await expect(page.locator('#btn-wake')).toBeVisible();
  await expect(page.locator('#btn-wake')).toHaveClass(/is-on/);

  await page.locator('#btn-back-calendar').click();
  await expect(page.locator('#view-calendar')).toBeVisible();
  // 캘린더에서는 칩도 감추고 잠금도 놓는다
  await expect(page.locator('#btn-wake')).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { __wake: { releases: number } }).__wake.releases))
    .toBeGreaterThan(0);

  // 다시 들어가면 다시 켜진다
  await page.locator('#calendar [data-session="0"]').click();
  await expect(page.locator('#btn-play')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#btn-wake')).toHaveClass(/is-on/);
});

test('탐색 막대를 파일 뒷부분으로 끌어도 그 파일 안에 머문다', async ({ page }) => {
  await openMorningSession(page);
  await expect(page.locator('#file-note')).toContainText('구간 1/3');

  const seek = page.locator('#seek');
  const max = Number(await seek.getAttribute('max'));
  expect(max).toBeGreaterThan(1000);

  // 파일의 90% 지점으로 끈다 — 예전에는 여기서 다음 파일로 튕겼다
  await seek.fill(String(Math.round(max * 0.9)));
  await seek.dispatchEvent('change');

  // 예전에는 여기서 다음 파일로 튕겨 나가며 위치가 0 근처로 되돌아갔다
  await expect(page.locator('#file-note')).toContainText('구간 1/3');
  const value = Number(await seek.inputValue());
  expect(value / Number(await seek.getAttribute('max'))).toBeGreaterThan(0.8);
});

test('탐색 막대 위치와 시간 표시가 어긋나지 않는다', async ({ page }) => {
  await openMorningSession(page);
  const seek = page.locator('#seek');

  for (const ratio of [0.25, 0.5, 0.75]) {
    const max = Number(await seek.getAttribute('max'));
    await seek.fill(String(Math.round(max * ratio)));
    await seek.dispatchEvent('change');
    await page.waitForTimeout(200);

    const value = Number(await seek.inputValue());
    const nowMax = Number(await seek.getAttribute('max'));
    const label = (await page.locator('#time-label').textContent()) ?? '';
    const m = /^(\d+):(\d+)\.(\d)/.exec(label);
    expect(m, label).not.toBeNull();
    const labelMs = (Number(m![1]) * 60 + Number(m![2])) * 1000 + Number(m![3]) * 100;

    // 막대가 가리키는 위치와 글자가 같은 곳을 가리켜야 한다
    expect(Math.abs(value - labelMs), `${ratio}: 막대 ${value}ms vs 글자 ${labelMs}ms`).toBeLessThan(1500);
    expect(value / nowMax).toBeCloseTo(labelMs / nowMax, 1);
  }
});

test('휴대폰에서는 한 번에 한 대만 보이고, 딱지를 눌러 오간다', async ({ page }) => {
  // PIP로 겹쳐 놓았더니 한 번 누르면 바뀌는데 **다시 눌러도 안 돌아왔다.**
  // 격자 항목은 position:static이어도 z-index가 먹혀, 뒤바뀐 큰 칸이 DOM
  // 순서상 뒤에 있으면서 같은 z-index라 작은 칸을 덮어 버렸다.
  // 겹치지 않으면 가려질 일도 없다.
  await page.setViewportSize({ width: 412, height: 915 });
  await openMorningSession(page);

  const shown = () => page.evaluate(() =>
    [...document.querySelectorAll('.video-cell')].map((c) => getComputedStyle(c).display !== 'none'));

  expect(await shown(), '처음엔 전방만 보인다').toEqual([true, false]);

  await page.locator('.video-cell').first().locator('[data-swap-ch]').click();
  expect(await shown(), '후방으로 바뀐다').toEqual([false, true]);

  // **다시 눌러도 돌아와야 한다** — 이게 안 되던 것이 이번 버그다
  await page.locator('.video-cell').nth(1).locator('[data-swap-ch]').click();
  expect(await shown(), '전방으로 되돌아온다').toEqual([true, false]);
});

test('넓은 화면에서는 두 대를 나란히 두고 전환하지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openMorningSession(page);
  const shown = () => page.evaluate(() =>
    [...document.querySelectorAll('.video-cell')].map((c) => getComputedStyle(c).display !== 'none'));
  expect(await shown()).toEqual([true, true]);

  // 딱지를 눌러도 하나가 사라지면 안 된다
  await page.locator('.video-cell').first().locator('[data-swap-ch]').click();
  expect(await shown()).toEqual([true, true]);
});

test('좁은 화면에서 스크롤해도 벽시계·띠·재생이 위에 붙어 남는다', async ({ page }) => {
  // 무대를 못박아 두니 패널에 남는 높이가 97px까지 눌렸다. 그래서 좁은
  // 화면에서는 페이지가 통째로 스크롤되게 되돌리되, 예전처럼 맥락까지
  // 잃지는 않는다 — 영상만 올라가 사라지고 도크는 위에 붙는다.
  await page.setViewportSize({ width: 412, height: 620 });
  await openMorningSession(page);
  await page.locator('[data-tab="export"]').click();

  const probe = () => page.evaluate(() => {
    const inView = (el: Element | null): boolean => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.top >= -1 && r.bottom <= window.innerHeight + 1 && r.height > 0;
    };
    const tabs = document.querySelector('.tabs')!.getBoundingClientRect();
    const dock = document.getElementById('stage-dock')!.getBoundingClientRect();
    return {
      docked: document.body.classList.contains('is-docked'),
      clock: inView(document.getElementById('time-clock')),
      strip: inView(document.querySelector('.strip-track')),
      play: inView(document.getElementById('btn-play')),
      video: inView(document.getElementById('video-grid')),
      tabsInView: tabs.top >= -1 && tabs.bottom <= window.innerHeight + 1,
      // 탭이 도크 아래에 붙어야 한다 (서로 겹치면 안 된다)
      tabsBelowDock: Math.round(tabs.top) >= Math.round(dock.bottom) - 1,
    };
  });

  const scroller = page.locator('#view-main');
  await scroller.evaluate((e) => { e.scrollTop = e.scrollHeight; });
  await page.waitForTimeout(250);
  const after = await probe();

  expect(after.docked, '도크가 위에 붙어야 한다').toBe(true);
  expect(after.video, '영상은 올라가 사라진다').toBe(false);
  expect(after.clock, '벽시계는 남는다').toBe(true);
  expect(after.strip, '구간 띠는 남는다').toBe(true);
  expect(after.play, '재생 버튼은 남는다').toBe(true);
  expect(after.tabsInView, '탭도 손에 닿는다').toBe(true);
  expect(after.tabsBelowDock, '탭은 도크 아래에 붙는다').toBe(true);

  // 맨 위로 돌아오면 영상이 다시 보인다
  await scroller.evaluate((e) => { e.scrollTop = 0; });
  await page.waitForTimeout(250);
  const top = await probe();
  expect(top.docked).toBe(false);
  expect(top.video, '맨 위에서는 영상이 보인다').toBe(true);
});

test('붙어도 도크 높이가 그대로다 — 튀지 않는다', async ({ page }) => {
  // 붙을 때 도크 안을 접어 줄였더니(271→150) 그만큼 아래가 위로 튀어 올랐다.
  // 튀어 오르면 경계가 다시 화면에 들어와 붙었다/떨어졌다를 되풀이한다.
  // 도크에는 컨트롤과 띠만 두고, 곁가지는 도크 밖으로 내보내 높이를 못박았다.
  for (const height of [545, 620, 915]) {
    await page.setViewportSize({ width: 412, height });
    await openMorningSession(page);
    await page.locator('[data-tab="export"]').click();

    const dockH = () => page.evaluate(() => ({
      h: Math.round(document.getElementById('stage-dock')!.getBoundingClientRect().height),
      docked: document.body.classList.contains('is-docked'),
    }));

    const before = await dockH();
    expect(before.docked, `${height}: 맨 위에서는 떨어져 있다`).toBe(false);

    const scroller = page.locator('#view-main');
    await scroller.evaluate((e) => { e.scrollTop = e.scrollHeight; });
    await page.waitForTimeout(250);
    const after = await dockH();

    expect(after.docked, `${height}: 붙어야 한다`).toBe(true);
    expect(after.h, `${height}: 붙어도 높이가 같아야 한다`).toBe(before.h);
  }
});

test('넓은 화면에서는 캘린더가 좌우로 갈린다 — 고르는 곳과 결과', async ({ page }) => {
  // 세로로만 쌓으면 폭이 아무리 넓어도 상세가 시작하는 자리가 512px로 고정이라,
  // 날짜를 고를 때마다 스크롤로 왕복해야 했다. 인덱스 저장 버튼은 1024x768에서도
  // 화면 밖으로 109px 나가 있었다.
  await page.setViewportSize({ width: 1024, height: 768 });
  await openFolder(page);
  await page.locator('[data-day="2026-09-08"]').click();

  const box = await page.evaluate(() => {
    const rect = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
    const inView = (sel: string) => {
      const r = rect(sel);
      return r.top >= -1 && r.bottom <= window.innerHeight + 1 && r.height > 0;
    };
    return {
      isGrid: getComputedStyle(document.getElementById('calendar')!).display === 'grid',
      masterRight: Math.round(rect('.cal-master').right),
      sideLeft: Math.round(rect('.cal-side').left),
      sessionInView: inView('.session-row'),
      openInView: inView('[data-open-day]'),
      saveInView: inView('#btn-save-index'),
    };
  });

  expect(box.isGrid, '달력과 상세가 좌우로 갈려야 한다').toBe(true);
  expect(box.sideLeft, '상세가 달력 오른쪽에 있어야 한다').toBeGreaterThanOrEqual(box.masterRight);
  expect(box.sessionInView, '운행 목록이 보여야 한다').toBe(true);
  expect(box.openInView, '이 날짜 전체 열기가 보여야 한다').toBe(true);
  expect(box.saveInView, '인덱스 저장이 화면 밖으로 나가면 안 된다').toBe(true);
});

test('좁은 화면에서는 세로로 쌓이고 날짜를 고른 결과가 아래에 붙는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFolder(page);
  await page.locator('[data-day="2026-09-08"]').click();

  const box = await page.evaluate(() => {
    const rect = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
    return {
      isGrid: getComputedStyle(document.getElementById('calendar')!).display === 'grid',
      masterBottom: Math.round(rect('.cal-master').bottom),
      sideTop: Math.round(rect('.cal-side').top),
      docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  expect(box.isGrid, '좁은 화면은 한 열이다').toBe(false);
  expect(box.sideTop, '상세는 달력 아래에 온다').toBeGreaterThanOrEqual(box.masterBottom - 1);
  expect(box.docScrollX, '가로 스크롤이 생기면 안 된다').toBeLessThanOrEqual(1);
  // 눌러도 화면이 그대로면 "눌린 건가?" 싶으므로 결과가 보이는 자리로 옮겨 준다
  await expect(page.locator('.session-row').first()).toBeInViewport();
});

/** 폴드형 기기에서 실제로 깨졌던 크기들 */
const FOLD_SIZES = [
  { name: '폴드 메인 세로', width: 984, height: 1092 },
  { name: '폴드 메인 가로', width: 1092, height: 984 },
  { name: '폴드 커버', width: 412, height: 915 },
  { name: '폴드 커버·주소창', width: 412, height: 620 },
  { name: '옛 커버(좁음)', width: 344, height: 882 },
  { name: '눕힌 폰', width: 700, height: 390 },
];

for (const size of FOLD_SIZES) {
  test(`${size.name} — 탭바가 살아 있고 영상 아래 검은 여백이 없다`, async ({ page }) => {
    // 412×620에서 패널 높이가 0이 되어 탭바가 화면 밖으로 2px 나갔고,
    // 984×1092에서는 영상 칸이 253×717인데 그림은 253×142라 칸마다
    // 575px이 검정이었다. 둘 다 실측으로 확인한 뒤 고친 것들이다.
    await page.setViewportSize({ width: size.width, height: size.height });
    await openMorningSession(page);

    const m = await page.evaluate(() => {
      const inView = (el: Element | null): boolean => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.top >= -1 && r.bottom <= window.innerHeight + 1 && r.height > 0;
      };
      const cell = document.querySelector('.video-cell')!.getBoundingClientRect();
      const canvas = document.querySelector('#canvas-0')!.getBoundingClientRect();
      const panels = document.querySelector('.tab-panels') as HTMLElement;
      return {
        tabsInView: inView(document.querySelector('.tabs')),
        summaryTabInView: inView(document.querySelector('[data-tab="summary"]')),
        panelH: Math.round(panels.clientHeight),
        clockInView: inView(document.getElementById('time-clock')),
        stripInView: inView(document.querySelector('.strip-track')),
        // 칸이 그림보다 얼마나 큰가 = 검은 여백 (테두리 2px은 허용)
        blackPx: Math.round(cell.height - canvas.height),
        // 그림 자체가 16:9인가
        ratioOff: Math.abs(canvas.width / canvas.height - 16 / 9),
        docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });

    expect(m.tabsInView, '탭바가 화면 안에 있어야 한다').toBe(true);
    expect(m.summaryTabInView, '요약 탭에 손이 닿아야 한다').toBe(true);
    expect(m.panelH, '패널이 최소한의 높이를 가져야 한다').toBeGreaterThan(40);
    expect(m.clockInView, '벽시계가 보여야 한다').toBe(true);
    expect(m.stripInView, '구간 띠가 보여야 한다').toBe(true);
    expect(m.blackPx, '영상 아래 검은 여백이 없어야 한다').toBeLessThanOrEqual(4);
    expect(m.ratioOff, '영상이 16:9를 유지해야 한다').toBeLessThan(0.02);
    expect(m.docScrollX, '가로 스크롤이 생기면 안 된다').toBeLessThanOrEqual(1);
  });
}

test('영상 배치는 화면 폭이 아니라 무대 폭으로 정한다', async ({ page }) => {
  // 984px 폴드를 세로로 들면 화면은 넓지만 무대 열은 530px뿐이다. 화면 폭으로
  // 판단하면 영상 두 칸이 253px씩으로 쪼그라든다 — 8인치 화면에 엄지손톱만 한 영상.
  await page.setViewportSize({ width: 984, height: 1092 });
  await openMorningSession(page);
  const narrowStage = await page.evaluate(() => {
    const front = document.querySelector('#canvas-0')!.getBoundingClientRect();
    const rear = document.querySelector('.video-cell:last-child')!;
    return { frontW: Math.round(front.width), single: getComputedStyle(rear).display === 'none' };
  });
  expect(narrowStage.single, '무대가 좁으면 한 번에 한 대만 보인다').toBe(true);
  expect(narrowStage.frontW, '전방이 무대 폭을 다 써야 한다').toBeGreaterThan(450);

  // 무대가 넓어지면 나란히 놓는다
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(200);
  const wideStage = await page.evaluate(() => {
    const rear = document.querySelector('.video-cell:last-child')!;
    return { single: getComputedStyle(rear).display === 'none' };
  });
  expect(wideStage.single, '무대가 넓으면 전방·후방을 나란히 놓는다').toBe(false);
});

test('영상을 접으면 스크롤이 짧아지고, 벽시계·띠·재생은 남는다', async ({ page }) => {
  // 좁은 화면은 이제 페이지가 통째로 스크롤되므로 접기가 패널 "높이"를
  // 늘리지는 않는다. 대신 영상만큼 **스크롤이 짧아진다** — 표를 보러
  // 내려가는 거리가 줄어든다. 맥락(벽시계·띠·재생)은 그대로 남아야 한다.
  await page.setViewportSize({ width: 412, height: 620 });
  await openMorningSession(page);
  await page.locator('[data-tab="sensor"]').click();
  // 차트는 스캔이 끝난 뒤에 그려진다. 그 전에 재면 센서 패널이 103px짜리
  // 빈 자리라, 접은 뒤(차트가 그려진 598px)와 견주면 **접었더니 길어진
  // 것처럼** 보인다. 재는 동안 패널이 변하지 않도록 다 그려질 때까지 기다린다.
  await page.waitForFunction(
    () => (document.getElementById('chart-speed')?.getBoundingClientRect().height ?? 0) > 100,
    undefined, { timeout: 15_000 });

  const probe = () => page.evaluate(() => {
    const inView = (el: Element | null): boolean => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.top >= -1 && r.bottom <= window.innerHeight + 1 && r.height > 0;
    };
    const sc = document.getElementById('view-main') as HTMLElement;
    return {
      scrollable: sc.scrollHeight - sc.clientHeight,
      videoShown: (document.getElementById('video-grid') as HTMLElement).offsetParent !== null,
      clock: inView(document.getElementById('time-clock')),
      strip: inView(document.querySelector('.strip-track')),
      play: inView(document.getElementById('btn-play')),
    };
  });

  const before = await probe();
  expect(before.videoShown).toBe(true);

  await page.locator('#btn-fold-stage').click();
  await page.waitForTimeout(150);
  const after = await probe();

  expect(after.videoShown, '영상은 숨는다').toBe(false);
  expect(after.scrollable, '영상 높이만큼 스크롤이 짧아진다').toBeLessThan(before.scrollable - 100);
  expect(after.clock, '접어도 벽시계는 남는다').toBe(true);
  expect(after.strip, '접어도 구간 띠는 남는다').toBe(true);
  expect(after.play, '접어도 재생 버튼은 남는다').toBe(true);

  await page.locator('#btn-fold-stage').click();
  expect((await probe()).videoShown).toBe(true);
});

test('접은 상태를 기억한다', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 760 });
  await openMorningSession(page);
  await page.locator('#btn-fold-stage').click();
  await expect(page.locator('body')).toHaveClass(/is-stage-folded/);

  // 다시 열어도 접힌 채로 시작한다 — 한 번 정한 모양을 계속 쓴다
  await openMorningSession(page);
  await expect(page.locator('body')).toHaveClass(/is-stage-folded/);
  await expect(page.locator('#btn-fold-stage')).toHaveAttribute('aria-expanded', 'false');

  await page.locator('#btn-fold-stage').click();
  await expect(page.locator('body')).not.toHaveClass(/is-stage-folded/);
});


test('휴대폰에서는 전방이 폭을 꽉 채운다 — 좌우 검은 여백이 없다', async ({ page }) => {
  // 실기(폴드 커버)에서 영상 칸이 2.6:1로 납작해지고 그림 좌우에 검은 여백이
  // 남았다. 주소창까지 낀 svh(약 575)에 `--vh - 430` 예산이 걸려 칸 높이가
  // 145px로 잡히고, 그만큼 폭도 270px로 줄었기 때문이다(폭은 384가 남는데).
  // 한 줄기로 스크롤하는 지금은 영상이 아랫줄 몫을 낼 이유가 없다.
  for (const height of [575, 915]) {
    await page.setViewportSize({ width: 412, height });
    await openMorningSession(page);
    const box = await page.evaluate(() => {
      const c = document.getElementById('canvas-0') as HTMLCanvasElement;
      const cell = c.closest('.video-cell')!;
      const r = c.getBoundingClientRect();
      const cr = cell.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), cellW: Math.round(cr.width) };
    });
    // 칸을 꽉 채워야 좌우에 검은 띠가 남지 않는다 (테두리 1px씩은 뺀다)
    expect(box.cellW - box.w, `${height}: 좌우 검은 여백`).toBeLessThanOrEqual(2);
    // 상자 자체가 16:9여야 위아래로도 여백이 없다
    expect(box.w / box.h).toBeCloseTo(16 / 9, 1);
  }
});

test('영상 전환 딱지의 글자가 보인다 — 빈 알약이 아니다', async ({ page }) => {
  // button은 색과 테두리를 물려받지 않아 UA 기본값(검은 buttontext,
  // 2px outset)이 남았다. 반투명 검정 배경 위 검은 글자 = 실기에서
  // 글자 없는 빈 알약으로 보였다.
  await page.setViewportSize({ width: 412, height: 915 });
  await openMorningSession(page);
  const chip = await page.evaluate(() => {
    const el = document.querySelector('.chip-swap')!;
    const cs = getComputedStyle(el);
    const mk = document.querySelector('.chip-swap-mark')!.getBoundingClientRect();
    return { color: cs.color, border: cs.borderTopWidth, text: el.textContent?.trim(), markW: mk.width };
  });
  expect(chip.text, '어느 쪽인지 글자로 알려 준다').toContain('전방');
  expect(chip.color, '영상 위 흰 글자').toBe('rgb(255, 255, 255)');
  expect(chip.border, 'UA 기본 테두리가 남으면 안 된다').toBe('0px');
  // 전환 표식(⇄)이 곧 "이건 버튼이다"라는 신호다. 컨테이너 질의를 기본값
  // 앞에 두는 바람에 폭이 0이어서, 실기에서 전환 버튼인 줄 알 수가 없었다.
  expect(chip.markW, '좁은 화면에서는 전환 표식이 보인다').toBeGreaterThan(0);

  // 두 대가 나란히 보이는 폭에서는 바꿀 것이 없으니 표식도 없다
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(100);
  const wide = await page.evaluate(() =>
    document.querySelector('.chip-swap-mark')!.getBoundingClientRect().width);
  expect(wide, '넓은 화면에는 전환 표식이 없다').toBe(0);
});


/**
 * 한국(UTC+9) 기기에서 담은 즐겨찾기.
 *
 * 실기에서 23:35:58로 담은 것의 **큰 글자가 다음 날 08:35:58**로 찍혔다.
 * 이름만 로컬 게터로 만들어 보는 사람의 시간대만큼 밀린 것이다.
 * UTC 기기에서는 이 어긋남이 보이지 않으므로 시간대를 한국으로 두고 본다.
 */
test.describe('한국 시간대', () => {
  test.use({ timezoneId: 'Asia/Seoul' });

  test('즐겨찾기 이름과 바로 아래 시각이 어긋나지 않는다', async ({ page }) => {
    await openMorningSession(page);
    await page.locator('#btn-bookmark').click();
    await expect(page.locator('#bm-count')).toHaveText('1');
    await page.locator('#btn-bookmarks').click();

    const label = (await page.locator('#bm-panel .bm-label').first().textContent())?.trim() ?? '';
    const meta = (await page.locator('#bm-panel .bm-meta').first().textContent())?.trim() ?? '';

    // 아래 줄은 `2026-09-08 08:09:19 · 00000460.jdr` 꼴이다
    const when = meta.split('·')[0].trim();
    expect(when, '아래 줄은 기록된 벽시계 시각이다').toMatch(/^2026-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // 큰 글자는 그 앞 연도만 뗀 것이어야 한다. 둘이 어긋나면 어느 쪽을
    // 믿어야 할지 알 수 없어 감사 기록으로 못 쓴다.
    expect(label, '큰 글자와 아래 줄이 같은 시각을 가리킨다').toBe(when.slice(5));
  });
});



test('지도가 도크·탭바 위로 삐져나오지 않는다', async ({ page }) => {
  // 스크롤해서 지도가 위로 올라가면 경로선과 +/- 단추가 **시계와 재생 단추를
  // 가로질러** 그려졌다. Leaflet이 제 안에서 층을 쌓으려고 쓰는 z-index
  // (판 400, 조작 800, 구석 1000)가 도크(5)·탭바(4)와 그대로 겨루고 있었다.
  // 층을 패널 안에서 끊으면 그 숫자가 밖으로 새지 않는다.
  await page.setViewportSize({ width: 412, height: 575 });
  await openMorningSession(page);
  await page.locator('[data-tab="map"]').click();
  await page.waitForTimeout(400);

  const got = await page.evaluate(() => {
    // 층을 새로 여는(stacking context) 가장 가까운 조상을 찾는다
    const opensLayer = (el: Element): boolean => {
      const cs = getComputedStyle(el);
      return cs.isolation === 'isolate' ||
        (cs.position !== 'static' && cs.zIndex !== 'auto') ||
        Number(cs.opacity) < 1 || cs.transform !== 'none' || cs.filter !== 'none' ||
        /paint|layout|strict|content/.test(cs.contain);
    };
    let el: Element | null = document.getElementById('map')!.parentElement;
    while (el && el !== document.documentElement) {
      if (opensLayer(el)) return el.className;
      el = el.parentElement;
    }
    return null;  // 뿌리까지 갔다 = 지도의 z-index가 앱 전체와 겨룬다
  });

  expect(got, '지도의 층이 패널 안에서 끊겨야 한다').toContain('tab-panels');
});

test('지도 칸이 커지면 스스로 다시 잰다', async ({ page }) => {
  // Leaflet은 만들어질 때 잰 크기만큼만 타일을 받는다. 칸이 커져도 알려 주지
  // 않으면 커진 만큼이 **빈 회색으로 남는다.** 탭 누르기·창 크기 말고도
  // 배치가 바뀌는 길이 있으므로 칸 자체를 지켜본다.
  await page.setViewportSize({ width: 412, height: 915 });
  await openMorningSession(page);
  await page.locator('[data-tab="map"]').click();
  await page.waitForTimeout(400);

  const paneH = () => page.evaluate(() =>
    Math.round(document.querySelector('.leaflet-overlay-pane svg')!.getBoundingClientRect().height));
  const before = await paneH();

  await page.evaluate(() => { (document.getElementById('map') as HTMLElement).style.height = '560px'; });
  await page.waitForTimeout(400);

  expect(await paneH(), '커진 칸만큼 지도도 넓어진다').toBeGreaterThan(before + 100);
});

test('현재 주행 위치 — 누를 때만 지금 지점으로 간다', async ({ page }) => {
  await openMorningSession(page);
  await page.locator('[data-tab="map"]').click();
  await page.waitForTimeout(400);

  // 전체 경로 보기로 물러나 둔다 (실제로 이렇게 쓰다가 현재 위치를 찾는다)
  await page.locator('#btn-fit-map').click();
  await page.waitForTimeout(300);

  // 재생을 조금 진행시켜 표식을 출발점에서 떼어 놓는다
  await page.locator('#btn-play').click();
  await page.waitForTimeout(900);
  await page.locator('#btn-play').click();

  const read = () => page.evaluate(() => {
    const m = document.querySelector('.leaflet-marker-pane, .leaflet-overlay-pane')!;
    const dot = document.querySelector('.leaflet-interactive:not(path[stroke-width="4"])') as SVGGraphicsElement | null;
    const box = document.getElementById('map')!.getBoundingClientRect();
    const d = (dot ?? m).getBoundingClientRect();
    return {
      // 표식이 지도 가운데에서 얼마나 떨어져 있나
      dx: Math.abs((d.x + d.width / 2) - (box.x + box.width / 2)),
      dy: Math.abs((d.y + d.height / 2) - (box.y + box.height / 2)),
      zoom: Number(document.querySelector('.leaflet-container')!.className.match(/zoom-(\d+)/)?.[1] ?? 0),
    };
  });

  const before = await read();

  await page.locator('#btn-here-map').click();
  await page.waitForTimeout(500);
  const after = await read();

  // 누르면 지금 지점이 지도 한가운데로 온다
  expect(after.dx, '가로로 가운데').toBeLessThan(4);
  expect(after.dy, '세로로 가운데').toBeLessThan(4);
  // 멀리 물러나 있었으면 거리까지 보이게 당긴다
  expect(before.dx + before.dy, '누르기 전에는 가운데가 아니었다').toBeGreaterThan(8);
});

test('현재 주행 위치는 재생만으로는 지도를 끌고 다니지 않는다', async ({ page }) => {
  // 자동으로 따라가면 손으로 옮겨 살펴보던 것이 매번 튕겨 나간다.
  await openMorningSession(page);
  await page.locator('[data-tab="map"]').click();
  await page.waitForTimeout(400);

  const centre = () => page.evaluate(() => {
    const t = getComputedStyle(document.querySelector('.leaflet-map-pane')!).transform;
    return t;
  });
  const before = await centre();

  await page.locator('#btn-play').click();
  await page.waitForTimeout(1200);
  await page.locator('#btn-play').click();

  expect(await centre(), '재생해도 지도는 그 자리에 있다').toBe(before);
});


test('설명 글이 길어도 두 단추가 화면 밖으로 나가지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 780 });
  await openMorningSession(page);
  await page.locator('[data-tab="map"]').click();
  await page.waitForTimeout(300);

  // 실기에서 실제로 나오는 긴 문구
  await page.evaluate(() => {
    document.getElementById('map-note')!.textContent = '586개 지점 표시 · 위성 미수신 547건 제외';
  });
  await page.waitForTimeout(100);

  const box = await page.evaluate(() => {
    const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    return {
      here: Math.round(r('#btn-here-map').right),
      fit: Math.round(r('#btn-fit-map').right),
      bar: Math.round(r('.map-bar').right),
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    };
  });

  expect(box.scrollW, '가로로 밀려나면 안 된다').toBeLessThanOrEqual(box.clientW);
  expect(box.here, '현재 주행 위치가 칸 안에 있다').toBeLessThanOrEqual(box.bar + 1);
  expect(box.fit, '전체 경로 보기가 칸 안에 있다').toBeLessThanOrEqual(box.bar + 1);
});

test('큰 시계 위에 날짜가 붙는다 — 영상 속 글자를 읽지 않아도 된다', async ({ page }) => {
  await openMorningSession(page);
  await expect(page.locator('#time-date')).toHaveText(/^2026-09-08$/);
  await expect(page.locator('#time-clock')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
});

test('즐겨찾기 — 폴더가 안 열려 있으면 폴더를 열고 그 지점까지 간다', async ({ page }) => {
  // 예전에는 "그 파일이 든 폴더를 열어 주세요"라고만 하고 끝났다. 사용자가
  // 직접 폴더를 열고, 날짜를 찾아 들어가고, 다시 즐겨찾기를 눌러야 했다.
  await openMorningSession(page);

  // 조금 진행한 지점을 담는다
  await page.locator('#btn-fwd10').click();
  await page.waitForTimeout(300);
  const marked = await page.locator('#time-clock').textContent();
  await page.locator('#btn-bookmark').click();
  await expect(page.locator('#bm-count')).toHaveText('1');

  // 새로 연 것과 같은 상태 — 즐겨찾기는 남지만 폴더는 안 열려 있다
  await page.reload();
  await expect(page.locator('#bm-count')).toHaveText('1', { timeout: 30_000 });
  await expect(page.locator('#view-main')).toBeHidden();

  // 즐겨찾기를 누르면 폴더 고르기가 뜬다
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#btn-bookmarks').click();
  await page.locator('#bm-panel [data-goto]').first().click();
  await (await chooser).setFiles(dir);

  // 캘린더에서 멈추지 않고 그 운행·그 지점까지 간다
  await expect(page.locator('#view-main')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#btn-bookmark')).toHaveText('★', { timeout: 30_000 });
  expect(await page.locator('#time-clock').textContent()).toBe(marked);
});

test('즐겨찾기 — 폴더는 열려 있지만 다른 운행이면 그 운행을 연다', async ({ page }) => {
  await openMorningSession(page);
  await page.locator('#btn-bookmark').click();
  await expect(page.locator('#bm-count')).toHaveText('1');

  // 다른 운행으로 옮긴다
  await page.locator('#btn-back-calendar').click();
  await page.locator('[data-day="2026-09-09"]').click();
  await page.locator('.session-row[data-session="0"]').click();
  await expect(page.locator('#btn-play')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#btn-bookmark')).toHaveText('☆');

  await page.locator('#btn-bookmarks').click();
  await page.locator('#bm-panel [data-goto]').first().click();
  await expect(page.locator('#btn-bookmark')).toHaveText('★', { timeout: 30_000 });
});


test('이동기록 공간 — 다중 업로드·날짜별 병합·상세', async ({ page }) => {
  await page.goto(codec?.startsWith('avc1') ? '/' : `/?codec=${encodeURIComponent(codec ?? 'vp8')}`);
  // 시작화면에 두 공간이 보인다
  await expect(page.locator('.home-card')).toHaveCount(2);
  await page.locator('#btn-move-enter').click();
  await expect(page.locator('#view-move')).toBeVisible();

  // 같은 날의 오전 응답 (2,000건 상한으로 잘린 앞부분이라 치자)
  const mk = (rows: {t:string; la:number; lo:number; act:string}[]) =>
    JSON.stringify({ success:true, data:[rows.map((r)=>({ timestamp:r.t, latitude:r.la, longitude:r.lo, accuracy:10, speed:0, battery:80, address:'', provider:'gps', activity_type:r.act, staytime:0 }))], errors:[] });
  const morning = join(dir, 'm1.txt');
  writeFileSync(morning, mk([
    { t:'2026-09-12 08:00:00', la:37.50, lo:127.00, act:'WALKING' },
    { t:'2026-09-12 08:01:00', la:37.501, lo:127.001, act:'WALKING' },
  ]));
  const afternoon = join(dir, 'm2.txt');
  writeFileSync(afternoon, mk([
    { t:'2026-09-12 20:00:00', la:37.52, lo:127.02, act:'STILL' },
    { t:'2026-09-13 09:00:00', la:37.53, lo:127.03, act:'WALKING' },
  ]));

  // 두 파일을 한 번에 올린다
  await page.locator('#move-upload').click();
  await page.locator('#move-file-input').setInputFiles([morning, afternoon]);
  await page.waitForTimeout(300);

  // 9/12(4점 중 3점 = 오전2 + 오후1)와 9/13(1점)이 목록에 뜬다
  await expect(page.locator('.move-day')).toHaveCount(2);
  await expect(page.locator('[data-day="2026-09-12"]')).toContainText('3점');

  // 9/12를 열면 상세(지도 + 요약)가 뜬다
  await page.locator('[data-day="2026-09-12"]').click();
  await expect(page.locator('#move-detail')).toBeVisible();
  await expect(page.locator('#move-map')).toBeVisible();
  await expect(page.locator('.track-bars')).toBeVisible();

  // 목록으로 돌아온다
  await page.locator('#move-day-back').click();
  await expect(page.locator('.move-day')).toHaveCount(2);

  // 같은 9/12에 새 시각을 더 올리면 병합되어 점이 는다 (4점)
  const more = join(dir, 'm3.txt');
  writeFileSync(more, mk([{ t:'2026-09-12 12:00:00', la:37.51, lo:127.01, act:'WALKING' }]));
  await page.locator('#move-upload').click();
  await page.locator('#move-file-input').setInputFiles([more]);
  await page.waitForTimeout(300);
  await expect(page.locator('[data-day="2026-09-12"]')).toContainText('4점');
});

test('대조 — 블랙박스 스캔이 저장한 차량 GPS로 이 차량 주행을 가린다', async ({ page }) => {
  // 1) 블랙박스 운행을 열면 스캔이 그날 차량 GPS를 IndexedDB에 저장한다.
  await openMorningSession(page);
  await page.waitForFunction(
    () => /스캔 완료/.test(document.getElementById('scan-note')?.textContent ?? ''),
    undefined, { timeout: 30_000 });

  // 저장된 차량 점 몇 개를 읽어 그 위에 휴대폰 점을 얹는다 (겹치면 '이 차량 주행')
  const carPts = await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open('jdr-viewer-cartrack', 1);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const doc: any = await new Promise((res, rej) => {
      const tx = db.transaction('days', 'readonly');
      const rq = tx.objectStore('days').get('2026-09-08');
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
    });
    return doc ? doc.points.slice(0, 4).map((p: any) => ({ t: p.t, lat: p.lat, lon: p.lon })) : [];
  });
  expect(carPts.length, '차량 GPS가 저장돼 있어야 한다').toBeGreaterThan(0);

  // 차량 점과 같은 시각·좌표의 휴대폰 기록을 만든다
  const rows = carPts.map((p: { t: number; lat: number; lon: number }) => ({
    timestamp: new Date(p.t).toISOString().slice(0, 19).replace('T', ' '),
    latitude: p.lat, longitude: p.lon, accuracy: 8, speed: 40,
    battery: 80, address: '', provider: 'gps', activity_type: 'IN_VEHICLE', staytime: 0,
  }));
  const phoneFile = join(dir, 'phone-compare.txt');
  writeFileSync(phoneFile, JSON.stringify({ success: true, data: [rows], errors: [] }));

  // 2) 이동기록 공간으로 가서 올리고 그날을 연다 (같은 컨텍스트라 IndexedDB 유지)
  await page.goto(codec?.startsWith('avc1') ? '/' : `/?codec=${encodeURIComponent(codec ?? 'vp8')}`);
  await page.locator('#btn-move-enter').click();
  await page.locator('#move-upload').click();
  await page.locator('#move-file-input').setInputFiles([phoneFile]);
  await page.waitForTimeout(300);
  await page.locator('[data-day="2026-09-08"]').click();
  await page.waitForTimeout(400);

  // 저장된 차량 GPS가 있으니 자동으로 대조되어 '이 차량 주행'이 나온다
  await expect(page.locator('.track-bars')).toContainText('이 차량 주행');
});


test('이동기록 — 폴더째 올리면 파일들이 날짜별로 병합된다', async ({ page }) => {
  await page.goto(codec?.startsWith('avc1') ? '/' : `/?codec=${encodeURIComponent(codec ?? 'vp8')}`);
  await page.locator('#btn-move-enter').click();

  const mk = (rows: {t:string; la:number; lo:number}[]) =>
    JSON.stringify({ success:true, data:[rows.map((r)=>({ timestamp:r.t, latitude:r.la, longitude:r.lo, accuracy:10, speed:0, battery:80, address:'', provider:'gps', activity_type:'STILL', staytime:0 }))], errors:[] });
  const sub = mkdtempSync(join(tmpdir(), 'movefolder-'));
  writeFileSync(join(sub, '2026.09.12.txt'), mk([{ t:'2026-09-12 08:00:00', la:37.50, lo:127.00 }]));
  writeFileSync(join(sub, '2026.09.12b.txt'), mk([{ t:'2026-09-12 09:00:00', la:37.51, lo:127.01 }]));
  writeFileSync(join(sub, '2026.09.13.txt'), mk([{ t:'2026-09-13 08:00:00', la:37.52, lo:127.02 }]));

  // ⋯ → 폴더 올리기 (입력에 폴더째 넣는다)
  await page.locator('#move-folder-input').setInputFiles(sub);
  await page.waitForTimeout(300);

  await expect(page.locator('.move-day')).toHaveCount(2);
  await expect(page.locator('[data-day="2026-09-12"]')).toContainText('2점'); // 두 파일 병합
  rmSync(sub, { recursive: true, force: true });
});

test('이동기록 상세 — 시간 스크러버로 시각을 본다', async ({ page }) => {
  await page.goto(codec?.startsWith('avc1') ? '/' : `/?codec=${encodeURIComponent(codec ?? 'vp8')}`);
  await page.locator('#btn-move-enter').click();
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push({ timestamp:`2026-09-12 08:0${i}:00`, latitude:37.50+i*0.001, longitude:127.00+i*0.001, accuracy:10, speed:i*4, battery:80, address:'', provider:'gps', activity_type:'WALKING', staytime:0 });
  const f = join(dir, 'scrub.txt'); writeFileSync(f, JSON.stringify({ success:true, data:[rows], errors:[] }));
  await page.locator('#move-file-input').setInputFiles([f]);
  await page.waitForTimeout(300);
  await page.locator('[data-day="2026-09-12"]').click();
  await page.waitForTimeout(400);

  // 처음엔 시작 시각
  await expect(page.locator('#move-seek-time')).toHaveText('08:00:00');
  // 끝까지 끌면 마지막 점 시각(08:05)
  await page.locator('#move-seek').fill('1000');
  await page.locator('#move-seek').dispatchEvent('input');
  await expect(page.locator('#move-seek-time')).toHaveText('08:05:00');
  // 시작·끝 라벨이 지도에 뜬다
  await expect(page.locator('.map-time-label').first()).toBeVisible();
});

test('이동기록 상세 — 한 자리에 머물면 머문 곳과 머문 시간이 뜬다', async ({ page }) => {
  await page.goto(codec?.startsWith('avc1') ? '/' : `/?codec=${encodeURIComponent(codec ?? 'vp8')}`);
  await page.locator('#btn-move-enter').click();
  const rows: any[] = [];
  // 08:00~08:20 한 자리(±10m 지터)에 머문다 → 20분 체류 하나
  for (let i = 0; i <= 20; i++) {
    const mm = String(i).padStart(2, '0');
    rows.push({ timestamp:`2026-09-12 08:${mm}:00`, latitude:37.5000 + (i%2)*0.00005, longitude:127.0000 + (i%2)*0.00005,
      accuracy:10, speed:0, battery:80, address: i===0 ? '집' : '', provider:'gps', activity_type:'STILL', staytime:0 });
  }
  // 08:30~08:32 멀리 이동 (체류 아님)
  rows.push({ timestamp:'2026-09-12 08:30:00', latitude:37.55, longitude:127.05, accuracy:10, speed:30, battery:80, address:'', provider:'gps', activity_type:'IN_VEHICLE', staytime:0 });
  rows.push({ timestamp:'2026-09-12 08:32:00', latitude:37.60, longitude:127.10, accuracy:10, speed:30, battery:80, address:'', provider:'gps', activity_type:'IN_VEHICLE', staytime:0 });
  const f = join(dir, 'stay.txt');
  writeFileSync(f, JSON.stringify({ success:true, data:[rows], errors:[] }));
  await page.locator('#move-file-input').setInputFiles([f]);
  await page.waitForTimeout(300);
  await page.locator('[data-day="2026-09-12"]').click();
  await page.waitForTimeout(400);

  // 머문 곳 블록에 1곳·20분 체류가 뜨고, 대표 주소(집)를 담는다
  const stay = page.locator('.stay-block');
  await expect(stay).toBeVisible();
  await expect(stay.locator('.stay-sum')).toContainText('1곳');
  await expect(stay.locator('.stay-item')).toHaveCount(1);
  await expect(stay.locator('.stay-item').first()).toContainText('20분');
  await expect(stay.locator('.stay-item').first()).toContainText('집');
  // 순번 배지(1)가 카드에 뜬다
  await expect(stay.locator('.stay-rank').first()).toHaveText('1');
  // 지도에도 번호 배지 핀 + 머문 시간 라벨이 뜬다 (OSM 백엔드)
  await expect(page.locator('.stay-pin').first()).toBeVisible();
  await expect(page.locator('.map-stay-label').first()).toBeVisible();
});

