import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pod, Profile } from '@autopod/shared';
import { expect, it, vi } from 'vitest';
import { createMockContainerManager } from '../test-utils/mock-helpers.js';
import {
  COMMAND_PREFLIGHT_PROBE,
  discoverCommandLaunchers,
  inspectRequiredCommands,
} from './required-command-preflight.js';

it('probes real local launcher availability without interpreting an executable argument as shell code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'command-preflight-'));
  const marker = join(dir, 'must-not-exist');
  try {
    const names = ['sh', 'autopod_no_such_compiler_83cfa', `sh; touch ${marker}`];
    const result = JSON.parse(
      execFileSync(process.execPath, ['-e', COMMAND_PREFLIGHT_PROBE, JSON.stringify(names)], {
        encoding: 'utf8',
      }),
    );
    expect(result.map((entry: { available: boolean }) => entry.available)).toEqual([
      true,
      false,
      false,
    ]);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('distinguishes static command launchers, quoted arguments and unresolved shell dependencies', () => {
  expect(
    discoverCommandLaunchers(`NODE_ENV=test node -e 'console.log(";")' && dotnet test`),
  ).toEqual(['node', 'dotnet']);
  expect(discoverCommandLaunchers('npm run build | tee build.log')).toEqual(['npm', 'tee']);
  expect(discoverCommandLaunchers('$(select_runner) test')).toBeNull();
  expect(discoverCommandLaunchers('if true; then npm test; fi')).toBeNull();
  expect(discoverCommandLaunchers('cd packages/app && ./test.sh')).toBeNull();
});
it('keeps an unavailable probe unknown and records explicit dependencies separately from newly created scripts', async () => {
  const cm = createMockContainerManager();
  vi.mocked(cm.execInContainer).mockResolvedValue({ exitCode: 0, stdout: 'malformed', stderr: '' });
  const pod = {
    options: { validate: true },
    contract: {
      executionRequirements: { version: 1, executables: ['node'] },
      requiredFacts: [
        { id: 'created', command: './new.sh', artifact: { path: 'new.sh', change: 'create' } },
        { id: 'dynamic', command: '$RUNNER test', artifact: { path: 'test.ts', change: 'update' } },
      ],
    },
  } as Pod;
  const result = await inspectRequiredCommands(cm, 'container', pod, {
    buildCommand: 'npm run build',
  } as Profile);
  expect(result.explicitDependencies).toBe(true);
  expect(result.deferredArtifacts).toEqual(['fact:created']);
  expect(result.unresolvedSources).toEqual(['fact:dynamic']);
  expect(result.requirements.every((entry) => entry.available === null)).toBe(true);
  expect(result.requirements.map((entry) => entry.executable)).toEqual(['node', 'npm']);
});
