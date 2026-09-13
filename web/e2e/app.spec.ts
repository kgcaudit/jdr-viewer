import { expect, test, type Page } from '@playwright/test';

let sampleBytes: Buffer;
/** 픽스처가 실제로 쓴 코덱. 이 컨테이너의 Chromium은 독점 코덱이 빠져 VP8로 떨어진다. */
let sampleCodec: string | null = null;
const isH264 = (): boolean => sampleCodec?.startsWith('avc1') === true;

/** 픽스처 페이지에서 진짜 H.264가 들어간 JDR을 만들어 온다. */
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  const logs: string[] = [];
  page.on('console', (m) => logs.push(`[fixture] ${m.type()}: ${m.text()}`));
  await page.goto('http://127.0.0.1:5173/e2e/fixture.html');
  await page.waitForFunction(() => typeof window.buildSampleJdr === 'function');
  const arr = await page.evaluate(() => window.buildSampleJdr());
  sampleBytes = Buffer.from(arr);
  sampleCodec = await page.evaluate(() => window.sampleCodec);
  const status = await page.locator('#status').textContent();
  console.log(`픽스처: ${status} / 코덱: ${sampleCodec}`);
  if (logs.length) console.log(logs.join('\n'));
  await page.close();
});

async function loadSample(page: Page): Promise<void> {
  // H.264가 아닌 코덱으로 만든 샘플은 ?codec= 으로 알려준다
  await page.goto(isH264() ? '/' : `/?codec=${encodeURIComponent(sampleCodec ?? 'vp8')}`);
  await page.locator('#file-input').setInputFiles({
    name: 'e2e_sample.jdr',
    mimeType: 'application/octet-stream',
    buffer: sampleBytes,
  });
  await expect(page.locator('#view-main')).toBeVisible({ timeout: 30_000 });
}

test('JDR을 열어 요약을 보여준다', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await loadSample(page);

  const summary = page.locator('#tab-summary');
  await expect(summary).toContainText('e2e_sample.jdr');
  await expect(summary).toContainText('SHA-256');
  // 인덱스 테이블이 순차 파싱 결과와 정확히 일치해야 한다
  await expect(summary).toContainText('일치 (불일치 0건)');
  await expect(summary).toContainText('2026-01-15 09:30:00.000');
  await expect(summary).toContainText('GPS');
  // 태그 통계
  await expect(summary).toContainText('00VI');
  await expect(summary).toContainText('00AD');
  expect(errors).toEqual([]);
});

test('SHA-256이 실제 파일 해시와 일치한다', async ({ page }) => {
  await loadSample(page);
  const { createHash } = await import('node:crypto');
  const expected = createHash('sha256').update(sampleBytes).digest('hex');
  await expect(page.locator('#tab-summary')).toContainText(expected);
});

test('H.264 비트스트림 점검 결과를 보여준다', async ({ page }) => {
  await loadSample(page);
  const note = page.locator('#tab-summary .note').first();
  await expect(note).toContainText('H.264 비트스트림 점검');
  if (isH264()) {
    // Annex-B 인코더는 키프레임에 SPS/PPS를 함께 넣는다
    await expect(note).toContainText('키프레임에 SPS·PPS 포함');
  }
});

test('WebCodecs로 실제 영상을 디코딩해 캔버스에 그린다', async ({ page }) => {
  test.skip(sampleCodec === null, '이 브라우저에서 쓸 수 있는 인코더가 없습니다');
  await loadSample(page);

  const supported = await page.evaluate(() => typeof window.VideoDecoder !== 'undefined');
  expect(supported, 'WebCodecs VideoDecoder를 쓸 수 있어야 한다').toBe(true);

  await page.locator('#btn-play').click();
  // 프레임이 캔버스에 실제로 그려질 때까지 기다린다
  await page.waitForFunction(
    () => {
      const c = document.getElementById('canvas-0') as HTMLCanvasElement;
      if (!c || c.width < 2) return false;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let min = 255;
      let max = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < min) min = d[i];
        if (d[i] > max) max = d[i];
      }
      return max - min > 40; // 검은 화면이 아니라 실제 그림이 있다
    },
    undefined,
    { timeout: 20_000 },
  );

  const size = await page.evaluate(() => {
    const c = document.getElementById('canvas-0') as HTMLCanvasElement;
    return { w: c.width, h: c.height };
  });
  expect(size).toEqual({ w: 320, h: 180 });

  // 재생 위치가 실제로 흐르는가
  await page.waitForFunction(
    () => !/^0:00\.0 /.test(document.getElementById('time-label')!.textContent ?? ''),
    undefined,
    { timeout: 15_000 },
  );
});

test('시크하면 해당 위치 프레임으로 이동한다', async ({ page }) => {
  test.skip(sampleCodec === null, '이 브라우저에서 쓸 수 있는 인코더가 없습니다');
  await loadSample(page);
  const readPixels = () =>
    page.evaluate(() => {
      const c = document.getElementById('canvas-0') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      return [d[0], d[1], d[2]].join(',');
    });

  await page.locator('#btn-play').click();
  await page.waitForFunction(() => {
    const c = document.getElementById('canvas-0') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    return d[0] + d[1] + d[2] > 30;
  }, undefined, { timeout: 20_000 });
  await page.locator('#btn-play').click(); // 일시정지
  const before = await readPixels();

  // 끝 근처로 시크 — 프레임마다 색이 다르므로 픽셀이 바뀌어야 한다
  await page.locator('#seek').evaluate((el: HTMLInputElement) => {
    el.value = String(Math.round(Number(el.max) * 0.8));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(readPixels, { timeout: 15_000 }).not.toBe(before);
});

test('지도와 센서 차트를 그린다', async ({ page }) => {
  await loadSample(page);

  await page.locator('.tab[data-tab="map"]').click();
  await expect(page.locator('#map .leaflet-container, #map.leaflet-container')).toHaveCount(1);
  await expect(page.locator('#map path.leaflet-interactive').first()).toBeVisible();
  await expect(page.locator('#map-note')).toContainText('15개 지점 표시');

  await page.locator('.tab[data-tab="sensor"]').click();
  await expect(page.locator('#chart-speed .uplot')).toBeVisible();
  await expect(page.locator('#chart-gsensor .uplot')).toBeVisible();
});

test('GPS CSV를 내보낸다', async ({ page }) => {
  await loadSample(page);
  await page.locator('.tab[data-tab="export"]').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-export="gps"]').click(),
  ]);
  expect(download.suggestedFilename()).toBe('e2e_sample_gps.csv');

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const csv = Buffer.concat(chunks).toString('utf8');

  expect(csv).toContain('latitude_deg');
  expect(csv.trim().split('\r\n')).toHaveLength(16); // 헤더 + 15행
  // NMEA 3733.5678 → 37.559463°
  expect(csv).toContain('37.55946');
  expect(csv).toContain('126.96872');
});

test('작은 화면에서도 레이아웃이 무너지지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await loadSample(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, '가로 스크롤이 생기면 안 된다').toBeLessThanOrEqual(1);
  await expect(page.locator('#btn-play')).toBeVisible();
});
