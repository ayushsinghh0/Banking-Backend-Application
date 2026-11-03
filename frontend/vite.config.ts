/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the Vite server proxies /api to the gateway, so the browser talks to one origin exactly as it
// does behind nginx in production (no CORS, SameSite=Strict session cookie works).
const gateway = process.env.VITE_DEV_GATEWAY_URL || 'http://localhost:8000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      '/api': { target: gateway, changeOrigin: false, xfwd: true },
    },
  },
  preview: { port: 3000, strictPort: true },
  build: {
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: true,
    // Recharts (~520 kB, 150 kB gzipped) is its own chunk and loads only with the pages that draw a chart
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router'],
          query: ['@tanstack/react-query'],
          charts: ['recharts'],
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
    // Generous budgets and half the cores, so a loaded machine (or coverage instrumentation) never turns a
    // correct test into a timeout
    testTimeout: 45_000,
    hookTimeout: 45_000,
    maxWorkers: '50%',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'html', 'json-summary'],
      thresholds: { lines: 85, functions: 80, branches: 75, statements: 85 },
    },
  },
});
