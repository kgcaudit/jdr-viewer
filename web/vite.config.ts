/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  // e2e/는 Playwright가 돌린다 — vitest가 주워가지 않도록 범위를 좁힌다
  test: { include: ['test/**/*.test.ts'] },
  base: './',
  build: { target: 'es2022' },
  worker: { format: 'es' },
  server: { host: '127.0.0.1', port: 5173 },
});
