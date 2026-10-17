import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  base: './',
  build: { target: 'es2022', assetsInlineLimit: 0 },
  // names the offline copy after the build; empty in dev, so no offline copy there
  define: { __BUILD__: JSON.stringify(command === 'build' ? Date.now().toString(36) : '') },
}));
