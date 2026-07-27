import { defineConfig } from 'vite';

export default defineConfig({
  // 상대 경로로 빌드 — GitHub Pages처럼 하위 경로(/pdf/)에 배포해도 동작
  base: './',
});
