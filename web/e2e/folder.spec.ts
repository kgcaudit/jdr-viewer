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
