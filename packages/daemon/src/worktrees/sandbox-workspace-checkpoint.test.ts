import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockContainerManager } from '../test-utils/mock-helpers.js';
import {
  checkpointSandboxWorkspace,
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

  it('explicitly recovers a rewritten same-pod history from the recorded start commit', async () => {
    const seed = path.join(tmpRoot, 'seed');
    const host = path.join(tmpRoot, 'host');
    const sandbox = path.join(tmpRoot, 'sandbox');
    await git(tmpRoot, ['init', '--initial-branch=main', seed]);
    await writeFile(path.join(seed, 'tracked.txt'), 'base\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '-m', 'base']);
    const startCommit = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: seed, env: gitEnv })
    ).stdout.trim();
    await git(tmpRoot, ['clone', '--no-hardlinks', seed, host]);
    await git(tmpRoot, ['clone', '--no-hardlinks', seed, sandbox]);

    await writeFile(path.join(sandbox, 'tracked.txt'), 'original history\n');
    await git(sandbox, ['add', 'tracked.txt']);
    await git(sandbox, ['commit', '-m', 'original agent commit']);
    const containerManager = createSandboxContainerManager(sandbox);
    const first = await checkpointSandboxWorkspace({
      containerManager,
      containerId: 'sandbox-1',
      podId: path.basename(tmpRoot),
      worktreePath: host,
      sequence: 1,
    });
    expect(first).toMatchObject({ promoted: true, materialized: true });

    await git(sandbox, ['reset', '--hard', startCommit]);
    await writeFile(path.join(sandbox, 'tracked.txt'), 'clean replacement history\n');
    await git(sandbox, ['add', 'tracked.txt']);
    await git(sandbox, ['commit', '-m', 'replacement agent commit']);
    const replacementCommit = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: sandbox, env: gitEnv })
    ).stdout.trim();
    const rejected = await checkpointSandboxWorkspace({
      containerManager,
      containerId: 'sandbox-1',
      podId: path.basename(tmpRoot),
      worktreePath: host,
      sequence: 2,
      recoveryBaseCommit: replacementCommit,
    });
    expect(rejected.error).toMatchObject({ code: 'LINEAGE_CONFLICT' });

    const recoveryArgs = {
      containerManager,
      containerId: 'sandbox-1',
      podId: path.basename(tmpRoot),
      worktreePath: host,
      sequence: 3,
      recoveryBaseCommit: startCommit,
    };
    const recovered = await checkpointSandboxWorkspace(recoveryArgs);

    expect(recovered.error).toBeUndefined();
    expect(recovered).toMatchObject({
      lineageVerified: true,
      promoted: true,
      materialized: true,
    });
    await expect(readFile(path.join(host, 'tracked.txt'), 'utf8')).resolves.toBe(
      'clean replacement history\n',
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
