import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Live Bridge dashboard build.
 *
 * The dev proxy points at a locally running backend. In production the bundle
 * is served as static files by the dashboard container and Nginx routes /api
 * and /ws to the backend, so no API host is ever baked into the bundle.
 *
 * Note: nothing sensitive is ever exposed here. There are deliberately no
 * VITE_* environment variables for Supabase - the frontend never talks to
 * Supabase at all (project rule 25).
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
});
