import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  test: {
    include: [
      'scripts/benchmarks/fleet-list.bench.mjs',
      'scripts/benchmarks/fleet-list.checks.mjs',
    ],
    passWithNoTests: false,
    maxWorkers: 1,
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 120_000,
  },
});
