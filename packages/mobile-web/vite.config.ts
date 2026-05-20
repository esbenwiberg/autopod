import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// API paths the daemon mounts at the root (no /api prefix). Vite dev server
// proxies these to the running daemon so the SPA can fetch them same-origin
// during local development.
const DAEMON_PROXY_PATHS = [
  '/pods',
  '/profiles',
  '/health',
  '/events',
  '/diff',
  '/memory',
  '/history',
  '/scheduled-jobs',
  '/skills',
  '/actions',
  '/files',
  '/screenshots',
  '/series',
  '/issue-watcher',
];

const DAEMON_DEV_URL = process.env.AUTOPOD_DAEMON_URL ?? 'http://127.0.0.1:3100';

export default defineConfig({
  base: '/mobile/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      DAEMON_PROXY_PATHS.map((p) => [
        p,
        { target: DAEMON_DEV_URL, changeOrigin: true, ws: p === '/events' },
      ]),
    ),
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
