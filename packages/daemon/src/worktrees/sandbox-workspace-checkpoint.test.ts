import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockContainerManager } from '../test-utils/mock-helpers.js';
import { checkpointSandboxWorkspace } from './sandbox-workspace-checkpoint.js';

const execFileAsync = promisify(execFile);

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@test',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, env: gitEnv });
}

describe('checkpointSandboxWorkspace', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'autopod-checkpoint-test-'));
  });

  afterEach(async () => {
    const checkpointPath = `/tmp/.autopod-checkpoint-${path.basename(tmpRoot)}-1.bundle`;
    await rm(checkpointPath, { force: true });
    await rm(`${checkpointPath}.meta`, { force: true });
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('captures and materializes dirty sandbox work through a real Git bundle', async () => {
    const seed = path.join(tmpRoot, 'seed');
    const host = path.join(tmpRoot, 'host');
    const sandbox = path.join(tmpRoot, 'sandbox');
    await git(tmpRoot, ['init', '--initial-branch=main', seed]);
    await writeFile(path.join(seed, 'tracked.txt'), 'base\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '-m', 'base']);
    await git(tmpRoot, ['clone', '--no-hardlinks', seed, host]);
    await git(tmpRoot, ['clone', '--no-hardlinks', seed, sandbox]);
    await writeFile(path.join(sandbox, 'tracked.txt'), 'changed in sandbox\n');
    await git(sandbox, ['add', 'tracked.txt']);
    await git(sandbox, ['commit', '-m', 'agent commit']);
    await writeFile(path.join(sandbox, 'new.txt'), 'new sandbox file\n');

    const containerManager = createMockContainerManager();
    containerManager.execInContainer = vi.fn(async (_containerId, command) => {
      const executable = command[0];
      const args = command.slice(1);
      if (!executable || !args[1]) {
        return { stdout: '', stderr: 'invalid test command', exitCode: 64 };
      }
      args[1] = args[1].replace('cd /workspace', `cd ${sandbox}`);
      try {
        const result = await execFileAsync(executable, args, { env: gitEnv });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
      } catch (err) {
        const failure = err as { stdout?: string; stderr?: string; code?: number };
        return {
          stdout: failure.stdout ?? '',
          stderr: failure.stderr ?? (err instanceof Error ? err.message : String(err)),
          exitCode: typeof failure.code === 'number' ? failure.code : 1,
        };
      }
    });
    containerManager.readFile = vi.fn(async (_containerId, remotePath) =>
      readFile(remotePath, 'utf8'),
    );
    containerManager.readFileBinary = vi.fn(async (_containerId, remotePath) =>
      readFile(remotePath),
    );

    const result = await checkpointSandboxWorkspace({
      containerManager,
      containerId: 'sandbox-1',
      podId: path.basename(tmpRoot),
      worktreePath: host,
      sequence: 1,
    });

    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({
      transferVerified: true,
      bundleVerified: true,
      hostImported: true,
      lineageVerified: true,
      promoted: true,
      materialized: true,
    });
    await expect(readFile(path.join(host, 'tracked.txt'), 'utf8')).resolves.toBe(
      'changed in sandbox\n',
    );
    await expect(readFile(path.join(host, 'new.txt'), 'utf8')).resolves.toBe('new sandbox file\n');
  });
});
