import { cpSync, mkdirSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['better-sqlite3'],
  onSuccess: async () => {
    mkdirSync('dist/db/migrations', { recursive: true });
    cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
  },
});
