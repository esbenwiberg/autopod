import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    passWithNoTests: true,
    // Built-CLI HTTP fixtures spawn real Node processes. Bound file concurrency
    // so package-wide runs do not starve their existing test deadlines.
    maxWorkers: 2,
  },
  resolve: {
    alias: {
      '@autopod/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
});
