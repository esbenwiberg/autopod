import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@autopod/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
});
