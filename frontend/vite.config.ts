import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/**
 * Dev-режим: Vite віддає фронтенд на :5173 і проксіює /api (включно з
 * WebSocket-апгрейдами) на бекенд :8080 — жодного CORS.
 * Продакшен: `vite build` → dist/, який роздає сам бекенд.
 */
export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
