import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Execute the actual package script against a lightweight vitest stand-in. This
// verifies inherited V8 configuration, not just that a flag appears in JSON.
describe('daemon test process memory', () => {
  it.each([
    { configured: '', expectedMb: 4096 },
    { configured: '--max-old-space-size=768', expectedMb: 768 },
  ])('uses the default heap and preserves explicit settings: $configured', ({
    configured,
    expectedMb,
  }) => {
    const directory = mkdtempSync(join(tmpdir(), 'autopod-test-heap-'));
    try {
      const script = JSON.parse(
        readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
      ).scripts.test;
      writeFileSync(
        join(directory, 'vitest'),
        [
          `#!${process.execPath}`,
          "const v8 = require('node:v8');",
          'console.log(JSON.stringify({ options: process.env.NODE_OPTIONS, limit: v8.getHeapStatistics().heap_size_limit }));',
        ].join('\n'),
        { mode: 0o755 },
      );
      const result = JSON.parse(
        execFileSync('sh', ['-c', script], {
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            ...process.env,
            PATH: `${directory}${delimiter}${process.env.PATH}`,
            NODE_OPTIONS: configured,
          },
        }),
      );
      expect(result.options).toBe(configured || '--max-old-space-size=4096');
      expect(result.limit).toBeGreaterThanOrEqual(expectedMb * 1024 * 1024);
      // V8 also reserves young-generation space (192 MiB on Node 24 here).
      // Compare against a process configured directly, not a guessed overhead.
      const expectedLimit = Number(
        execFileSync(
          process.execPath,
          [
            `--max-old-space-size=${expectedMb}`,
            '-p',
            "require('node:v8').getHeapStatistics().heap_size_limit",
          ],
          { encoding: 'utf8', timeout: 10_000, env: { ...process.env, NODE_OPTIONS: '' } },
        ),
      );
      expect(result.limit).toBe(expectedLimit);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
