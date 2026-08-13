import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { clearUnusedResourceTimings } from './performance-cleanup.js';

const SECRET_SCAN = String.raw`
  import { performance } from 'node:perf_hooks';
  import { lintSource } from '@secretlint/core';
  import { creator } from '@secretlint/secretlint-rule-preset-recommend';

  const scan = lintSource({
    source: {
      content: 'const value = "not-a-secret";',
      filePath: 'fixture.ts',
      ext: '.ts',
      contentType: 'text',
    },
    options: {
      config: {
        rules: [{
          id: '@secretlint/secretlint-rule-preset-recommend',
          rule: creator,
        }],
      },
    },
  });
  __CLEANUP__
  await scan;
  await new Promise((resolve) => setImmediate(resolve));
  console.log('survived');
`;

function runSecretlintRace(cleanup: string) {
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', SECRET_SCAN.replace('__CLEANUP__', cleanup)],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );
}

describe('daemon performance cleanup', () => {
  it('reproduces the missing-mark crash caused by clearing process-global User Timing', () => {
    const result = runSecretlintRace('performance.clearMarks(); performance.clearMeasures();');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('performance mark has not been set');
    expect(result.stderr).toContain('@secretlint/secretlint-rule-preset-recommend');
  });

  it('does not clear User Timing while Secretlint owns an in-flight mark', () => {
    const cleanup = `(${clearUnusedResourceTimings.toString()})(performance);`;
    const result = runSecretlintRace(cleanup);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('survived');
    expect(result.stderr).not.toContain('performance mark has not been set');
  });

  it('clears Resource Timing without touching User Timing APIs', () => {
    const calls: string[] = [];
    const fake = {
      clearResourceTimings: () => calls.push('resources'),
      clearMarks: () => calls.push('marks'),
      clearMeasures: () => calls.push('measures'),
    } as unknown as Performance;

    clearUnusedResourceTimings(fake);

    expect(calls).toEqual(['resources']);
  });
});
