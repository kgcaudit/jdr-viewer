/**
 * 단일 HTML 빌드.
 * JS·CSS·워커·이미지를 전부 index.html 안에 넣어, 파일 하나만 열면 동작하게 한다.
 */
import { defineConfig, mergeConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import base from './vite.config';

export default mergeConfig(
  base,
  defineConfig({
    plugins: [viteSingleFile()],
    build: {
      outDir: 'dist-single',
      cssCodeSplit: false,
      // Leaflet의 작은 PNG까지 전부 data URI로
      assetsInlineLimit: 100_000_000,
      reportCompressedSize: false,
    },
  }),
);
