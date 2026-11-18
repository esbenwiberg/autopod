import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Pod } from '@autopod/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxApiClient } from '../containers/sandbox-api-client.js';
import { SandboxContainerManager } from '../containers/sandbox-container-manager.js';
import { logger } from '../test-utils/mock-helpers.js';
import { observeValidationSource } from './validation-source-evidence.js';

const execFileAsync = promisify(execFile);

describe('sandbox validation source observation', () => {
  let workspace: string;
  const pod = {
    containerId: 'sandbox',
    worktreePath: '/host/worktree',
    branch: 'feature',
    executionTarget: 'sandbox',
  } as Pod;
  const git = (...args: string[]) => execFileAsync('git', args, { cwd: workspace });
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'autopod-validation-source-'));
    await git('init', '-b', 'feature');
    await writeFile(join(workspace, 'tracked.txt'), 'seed');
    await git('add', '.');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@test', 'commit', '-m', 'seed');
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function sandbox(mode?: 'truncated' | 'oversized') {
    // Use the real SandboxContainerManager (which rejects maxOutputBytes).
    // Only the remote transport and /workspace mount are replaced.
    const exec = vi.fn<SandboxApiClient['exec']>(async (_id, [command, ...args]) => {
      if (!command) throw new Error('Missing probe command');
      const result = await execFileAsync(
        command,
        args.map((arg) => (arg === '/workspace' ? workspace : arg)),
        { cwd: workspace, maxBuffer: 5 * 1024 * 1024 },
      );
      const stdout =
        mode === 'truncated'
          ? result.stdout.slice(0, -1)
          : mode === 'oversized'
            ? 'x'.repeat(4 * 1024 * 1024 + 1) + result.stdout
            : result.stdout;
      return { stdout, stderr: result.stderr, exitCode: 0 };
    });
    return { exec, cm: new SandboxContainerManager({ exec } as SandboxApiClient, logger) };
  }

  it('observes the exact HEAD and tree through the sandbox adapter', async () => {
    const { cm, exec } = sandbox();
    await expect(observeValidationSource(cm, pod)).resolves.toEqual({
      head: (await git('rev-parse', 'HEAD')).stdout.trim(),
      tree: (await git('rev-parse', 'HEAD^{tree}')).stdout.trim(),
    });
    expect(exec).toHaveBeenCalled();
  });

  it.each(['truncated', 'oversized'] as const)('rejects %s probe output', async (mode) => {
    const { cm, exec } = sandbox(mode);
    await expect(observeValidationSource(cm, pod)).resolves.toBeNull();
    expect(exec).toHaveBeenCalledOnce();
  });

  it('rejects changed worktree bytes and a detached HEAD', async () => {
    const { cm } = sandbox();
    await writeFile(join(workspace, 'tracked.txt'), 'dirty');
    await expect(observeValidationSource(cm, pod)).resolves.toBeNull();
    await git('checkout', '--detach', '--force');
    await expect(observeValidationSource(cm, pod)).resolves.toBeNull();
  });
});
