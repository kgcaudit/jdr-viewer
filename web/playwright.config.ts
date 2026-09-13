import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

/**
 * 이 컨테이너에는 Chromium이 미리 깔려 있고(PLAYWRIGHT_BROWSERS_PATH),
 * npm의 playwright 버전과 빌드 번호가 어긋날 수 있어 실행 파일을 직접 지정한다.
 * 로컬에서는 평소대로 playwright가 관리하는 브라우저를 쓴다.
 */
const PREINSTALLED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath = existsSync(PREINSTALLED) ? PREINSTALLED : undefined;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    launchOptions: {
      executablePath,
      // 헤드리스에서도 WebCodecs 소프트웨어 경로가 뜨도록
      args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader'],
    },
  },
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 5173',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
