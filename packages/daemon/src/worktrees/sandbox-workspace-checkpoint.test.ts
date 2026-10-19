import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockContainerManager } from '../test-utils/mock-helpers.js';
import {
  checkpointSandboxWorkspace,
  observeSandboxWorkspace,
  resolveSandboxCheckpointSourceHead,
} from './sandbox-workspace-checkpoint.js';

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

function createSandboxContainerManager(sandbox: string) {
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
  containerManager.readFileBinary = vi.fn(async (_containerId, remotePath) => readFile(remotePath));
  return containerManager;
}

describe('checkpointSandboxWorkspace', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'autopod-checkpoint-test-'));
  });

  afterEach(async () => {
    for (const sequence of [1, 2, 3]) {
      const checkpointPath = `/tmp/.autopod-checkpoint-${path.basename(tmpRoot)}-${sequence}.bundle`;
      await rm(checkpointPath, { force: true });
      await rm(`${checkpointPath}.meta`, { force: true });
    }
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('can publish again after recapturing unchanged work and resuming in a fresh sandbox', async () => {
    const seed = path.join(tmpRoot, 'seed');
    const remote = path.join(tmpRoot, 'remote.git');
    const host = path.join(tmpRoot, 'host');
    const sandbox = path.join(tmpRoot, 'sandbox');
    const resumed = path.join(tmpRoot, 'resumed');
    await git(tmpRoot, ['init', '--initial-branch=main', seed]);
    await writeFile(path.join(seed, 'tracked.txt'), 'base\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '-m', 'base']);
    await git(tmpRoot, ['clone', '--bare', seed, remote]);
    await git(tmpRoot, ['clone', remote, host]);
    await git(tmpRoot, ['clone', remote, sandbox]);
    await git(host, ['checkout', '-b', 'feature']);
    await git(sandbox, ['checkout', '-b', 'feature']);
    await writeFile(path.join(sandbox, 'tracked.txt'), 'first implementation\n');
    await git(sandbox, ['commit', '-am', 'implementation']);
    const capture = (directory: string, sequence: number) =>
      checkpointSandboxWorkspace({
        containerManager: createSandboxContainerManager(directory),
        containerId: 'sandbox-1',
        podId: path.basename(tmpRoot),
        worktreePath: host,
        sequence,
      });
    const first = await capture(sandbox, 1);
    expect(first.materialized).toBe(true);
    await git(host, ['push', 'origin', 'HEAD:refs/heads/feature']);
    // Rework captures the stopped old sandbox before creating its replacement.
    // A later wall-clock second must not invent a sibling of the published tip.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const repeated = await capture(sandbox, 2);
    expect(repeated.materialized).toBe(true);
    await git(host, ['push', 'origin', 'HEAD:refs/heads/feature']);
    expect(repeated.snapshotCommit).toBe(first.snapshotCommit);
    await git(tmpRoot, ['clone', '--branch', 'feature', host, resumed]);
    await writeFile(path.join(resumed, 'tracked.txt'), 'reworked implementation\n');
    await git(resumed, ['commit', '-am', 'rework']);
    const third = await capture(resumed, 3);
    expect(third.materialized).toBe(true);
    await git(host, ['push', 'origin', 'HEAD:refs/heads/feature']);
    await git(host, ['merge-base', '--is-ancestor', first.snapshotCommit, third.snapshotCommit]);
  }, 15000);

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

    const containerManager = createSandboxContainerManager(sandbox);

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
    await expect(
      resolveSandboxCheckpointSourceHead(host, path.basename(tmpRoot), result.snapshotCommit),
    ).resolves.toBe(result.sourceHead);
    await expect(
      resolveSandboxCheckpointSourceHead(host, 'different-pod', result.snapshotCommit),
    ).resolves.toBeNull();
    await expect(readFile(path.join(host, 'tracked.txt'), 'utf8')).resolves.toBe(
      'changed in sandbox\n',
    );
    await expect(readFile(path.join(host, 'new.txt'), 'utf8')).resolves.toBe('new sandbox file\n');
  });

  it('materializes committed uncommitted mixed empty and net-zero sandbox snapshots', async () => {
    const cases = [
      {
        name: 'committed',
        mutate: async (sandbox: string) => {
          await writeFile(path.join(sandbox, 'tracked.txt'), 'committed\n');
          await git(sandbox, ['add', 'tracked.txt']);
          await git(sandbox, ['commit', '-m', 'committed change']);
        },
        expected: 'committed\n',
      },
      {
        name: 'uncommitted',
        mutate: async (sandbox: string) => {
          await writeFile(path.join(sandbox, 'tracked.txt'), 'uncommitted\n');
        },
        expected: 'uncommitted\n',
      },
      {
        name: 'mixed',
        mutate: async (sandbox: string) => {
          await writeFile(path.join(sandbox, 'tracked.txt'), 'committed\n');
          await git(sandbox, ['add', 'tracked.txt']);
          await git(sandbox, ['commit', '-m', 'committed portion']);
          await writeFile(path.join(sandbox, 'extra.txt'), 'uncommitted portion\n');
        },
        expected: 'committed\n',
        extra: 'uncommitted portion\n',
      },
      { name: 'empty', mutate: async () => {}, expected: 'base\n' },
      {
        name: 'net-zero',
        mutate: async (sandbox: string) => {
          await writeFile(path.join(sandbox, 'tracked.txt'), 'temporary\n');
          await git(sandbox, ['add', 'tracked.txt']);
          await git(sandbox, ['commit', '-m', 'temporary change']);
          await writeFile(path.join(sandbox, 'tracked.txt'), 'base\n');
          await git(sandbox, ['add', 'tracked.txt']);
          await git(sandbox, ['commit', '-m', 'revert bytes']);
        },
        expected: 'base\n',
      },
    ];

    for (const [index, scenario] of cases.entries()) {
      const root = path.join(tmpRoot, scenario.name);
      const seed = path.join(root, 'seed');
      const host = path.join(root, 'host');
      const sandbox = path.join(root, 'sandbox');
      await mkdir(root, { recursive: true });
      await git(root, ['init', '--initial-branch=main', seed]);
      await writeFile(path.join(seed, 'tracked.txt'), 'base\n');
      await git(seed, ['add', '.']);
      await git(seed, ['commit', '-m', 'base']);
      await git(root, ['clone', '--no-hardlinks', seed, host]);
      await git(root, ['clone', '--no-hardlinks', seed, sandbox]);
      await scenario.mutate(sandbox);

      const result = await checkpointSandboxWorkspace({
        containerManager: createSandboxContainerManager(sandbox),
        containerId: `sandbox-${scenario.name}`,
        podId: `${path.basename(tmpRoot)}-${scenario.name}`,
        worktreePath: host,
        sequence: index + 1,
      });

      expect(result).toMatchObject({ lineageVerified: true, promoted: true, materialized: true });
      await expect(readFile(path.join(host, 'tracked.txt'), 'utf8')).resolves.toBe(
        scenario.expected,
      );
      if (scenario.extra) {
        await expect(readFile(path.join(host, 'extra.txt'), 'utf8')).resolves.toBe(scenario.extra);
      }
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD^{tree}'], {
        cwd: host,
        env: gitEnv,
      });
      expect(stdout.trim()).toBe(result.snapshotTree);
    }
  }, 15_000);

  it('replaces a daemon-authored no-op checkpoint when the sandbox advances from its parent', async () => {
    const seed = path.join(tmpRoot, 'seed');
    const host = path.join(tmpRoot, 'host');
    const sandbox = path.join(tmpRoot, 'sandbox');
    await git(tmpRoot, ['init', '--initial-branch=main', seed]);
    await writeFile(path.join(seed, 'tracked.txt'), 'base\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '-m', 'base']);
    await git(tmpRoot, ['clone', '--no-hardlinks', seed, host]);
    await git(tmpRoot, ['clone', '--no-hardlinks', seed, sandbox]);

    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'autopod sandbox checkpoint'], {
      cwd: host,
      env: {
        ...gitEnv,
        GIT_AUTHOR_NAME: 'Autopod',
        GIT_AUTHOR_EMAIL: 'autopod@localhost',
        GIT_COMMITTER_NAME: 'Autopod',
        GIT_COMMITTER_EMAIL: 'autopod@localhost',
      },
    });
    await writeFile(path.join(sandbox, 'tracked.txt'), 'agent correction\n');
    await git(sandbox, ['add', 'tracked.txt']);
    await git(sandbox, ['commit', '-m', 'agent correction']);

    const containerManager = createSandboxContainerManager(sandbox);

    const result = await checkpointSandboxWorkspace({
      containerManager,
      containerId: 'sandbox-1',
      podId: path.basename(tmpRoot),
      worktreePath: host,
      sequence: 1,
    });

    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({
      lineageVerified: true,
      promoted: true,
      materialized: true,
    });
    await expect(readFile(path.join(host, 'tracked.txt'), 'utf8')).resolves.toBe(
      'agent correction\n',
    );
  });

  it('supersedes a prior content-bearing checkpoint from the same sandbox lineage', async () => {
    const seed = path.join(tmpRoot, 'seed');
    const host = path.join(tmpRoot, 'host');
    const sandbox = path.join(tmpRoot, 'sandbox');
    await git(tmpRoot, ['init', '--initial-branch=main', seed]);
    await writeFile(path.join(seed, 'tracked.txt'), 'base\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '-m', 'base']);
    await git(tmpRoot, ['clone', '--no-hardlinks', seed, host]);
    await git(tmpRoot, ['clone', '--no-hardlinks', seed, sandbox]);

    await writeFile(path.join(sandbox, 'tracked.txt'), 'checkpoint one\n');
    const containerManager = createSandboxContainerManager(sandbox);
    const first = await checkpointSandboxWorkspace({
      containerManager,
      containerId: 'sandbox-1',
      podId: path.basename(tmpRoot),
      worktreePath: host,
      sequence: 1,
    });
    expect(first).toMatchObject({ promoted: true, materialized: true });

    await git(sandbox, ['add', 'tracked.txt']);
    await git(sandbox, ['commit', '-m', 'agent commit']);
    await writeFile(path.join(sandbox, 'tracked.txt'), 'checkpoint two\n');
    const second = await checkpointSandboxWorkspace({
      containerManager,
      containerId: 'sandbox-1',
      podId: path.basename(tmpRoot),
      worktreePath: host,
      sequence: 2,
    });

    expect(second.error).toBeUndefined();
    expect(second).toMatchObject({
      lineageVerified: true,
      promoted: true,
      materialized: true,
    });
    await expect(readFile(path.join(host, 'tracked.txt'), 'utf8')).resolves.toBe(
      'checkpoint two\n',
    );
  });

  it('retains an operator-authored empty commit as a divergence barrier', async () => {
    const seed = path.join(tmpRoot, 'seed');
    const host = path.join(tmpRoot, 'host');
    const sandbox = path.join(tmpRoot, 'sandbox');
    await git(tmpRoot, ['init', '--initial-branch=main', seed]);
    await writeFile(path.join(seed, 'tracked.txt'), 'base\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '-m', 'base']);
    await git(tmpRoot, ['clone', '--no-hardlinks', seed, host]);
    await git(tmpRoot, ['clone', '--no-hardlinks', seed, sandbox]);

    await git(host, ['commit', '--allow-empty', '-m', 'autopod sandbox checkpoint']);
    await writeFile(path.join(sandbox, 'tracked.txt'), 'agent correction\n');
    await git(sandbox, ['add', 'tracked.txt']);
    await git(sandbox, ['commit', '-m', 'agent correction']);

    const result = await checkpointSandboxWorkspace({
      containerManager: createSandboxContainerManager(sandbox),
      containerId: 'sandbox-1',
      podId: path.basename(tmpRoot),
      worktreePath: host,
      sequence: 1,
    });

    expect(result).toMatchObject({
      promoted: false,
      materialized: false,
      error: {
        phase: 'promotion',
        code: 'LINEAGE_CONFLICT',
      },
    });
    await expect(readFile(path.join(host, 'tracked.txt'), 'utf8')).resolves.toBe('base\n');
  });

  it('retains a content-bearing checkpoint lookalike outside the pod quarantine', async () => {
    const seed = path.join(tmpRoot, 'seed');
    const host = path.join(tmpRoot, 'host');
    const sandbox = path.join(tmpRoot, 'sandbox');
    await git(tmpRoot, ['init', '--initial-branch=main', seed]);
    await writeFile(path.join(seed, 'tracked.txt'), 'base\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '-m', 'base']);
    await git(tmpRoot, ['clone', '--no-hardlinks', seed, host]);
    await git(tmpRoot, ['clone', '--no-hardlinks', seed, sandbox]);

    await writeFile(path.join(host, 'tracked.txt'), 'host change\n');
    await git(host, ['add', 'tracked.txt']);
    await execFileAsync('git', ['commit', '-m', 'autopod sandbox checkpoint'], {
      cwd: host,
      env: {
        ...gitEnv,
        GIT_AUTHOR_NAME: 'Autopod',
        GIT_AUTHOR_EMAIL: 'autopod@localhost',
        GIT_COMMITTER_NAME: 'Autopod',
        GIT_COMMITTER_EMAIL: 'autopod@localhost',
      },
    });
    const lookalike = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: host, env: gitEnv })
    ).stdout.trim();
    await expect(
      resolveSandboxCheckpointSourceHead(host, path.basename(tmpRoot), lookalike),
    ).resolves.toBeNull();
    await writeFile(path.join(sandbox, 'tracked.txt'), 'sandbox change\n');
    await git(sandbox, ['add', 'tracked.txt']);
    await git(sandbox, ['commit', '-m', 'agent commit']);

    const result = await checkpointSandboxWorkspace({
      containerManager: createSandboxContainerManager(sandbox),
      containerId: 'sandbox-1',
      podId: path.basename(tmpRoot),
      worktreePath: host,
      sequence: 1,
    });

    expect(result).toMatchObject({
      promoted: false,
      materialized: false,
      error: { code: 'LINEAGE_CONFLICT' },
    });
    await expect(readFile(path.join(host, 'tracked.txt'), 'utf8')).resolves.toBe('host change\n');
  });
});

describe('observeSandboxWorkspace', () => {
  let tmpRoot: string;
  let sandbox: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'autopod-observe-test-'));
    sandbox = path.join(tmpRoot, 'sandbox');
    await mkdir(sandbox);
    await git(sandbox, ['init', '-q', '-b', 'main']);
    await writeFile(path.join(sandbox, 'tracked.txt'), 'base\n');
    await git(sandbox, ['add', '.']);
    await git(sandbox, ['commit', '-q', '-m', 'base']);
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  const observe = () => observeSandboxWorkspace(createSandboxContainerManager(sandbox), 'sandbox');

  it('reports a clean tree as clean', async () => {
    const clean = await observe();
    expect(clean.dirty).toBe(false);
    expect(clean.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('changes the fingerprint when an already-modified tracked file is edited again', async () => {
    await writeFile(path.join(sandbox, 'tracked.txt'), 'first edit\n');
    const first = await observe();
    await writeFile(path.join(sandbox, 'tracked.txt'), 'second edit\n');
    const second = await observe();
    expect(first.dirty).toBe(true);
    expect(second.dirty).toBe(true);
    expect(second.tree).not.toBe(first.tree);
  });

  it('changes the fingerprint when an untracked file is edited again', async () => {
    await writeFile(path.join(sandbox, 'notes.md'), 'draft one\n');
    const first = await observe();
    await writeFile(path.join(sandbox, 'notes.md'), 'draft two\n');
    const second = await observe();
    expect(second.tree).not.toBe(first.tree);
  });

  it('is stable for an unchanged dirty tree and leaves the index and object store alone', async () => {
    await writeFile(path.join(sandbox, 'tracked.txt'), 'edit\n');
    await writeFile(path.join(sandbox, 'notes.md'), 'draft\n');
    const objectsBefore = (
      await execFileAsync('git', ['count-objects', '-v'], { cwd: sandbox, env: gitEnv })
    ).stdout;
    const first = await observe();
    const second = await observe();
    expect(second).toEqual(first);
    const { stdout: staged } = await execFileAsync('git', ['diff', '--cached', '--name-only'], {
      cwd: sandbox,
      env: gitEnv,
    });
    expect(staged.trim()).toBe('');
    const objectsAfter = (
      await execFileAsync('git', ['count-objects', '-v'], { cwd: sandbox, env: gitEnv })
    ).stdout;
    expect(objectsAfter).toBe(objectsBefore);
  });

  it('throws instead of inventing a fingerprint when git fails', async () => {
    await rm(path.join(sandbox, '.git'), { recursive: true, force: true });
    await expect(observe()).rejects.toThrow(/fingerprint failed/);
  });
});
