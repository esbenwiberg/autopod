import path from 'node:path';
import { defineConfig } from 'vitest/config';

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
