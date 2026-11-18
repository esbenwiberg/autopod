import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyValidationRecoverySource } from '../pods/validation-recovery-reports.js';
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
    // Bound transient Git/filesystem teardown contention, not the assertions.
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  async function rewrittenSource() {
    const seed = path.join(tmpRoot, 'seed');
    const host = path.join(tmpRoot, 'host');
    const sandbox = path.join(tmpRoot, 'sandbox');
    await git(tmpRoot, ['init', '--initial-branch=main', seed]);
    await writeFile(path.join(seed, 'tracked.txt'), 'base\n');
    await writeFile(path.join(seed, '.gitignore'), 'ignored-report.txt\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '-m', 'base']);
    const base = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: seed })).stdout.trim();
    await git(tmpRoot, ['clone', '--no-hardlinks', seed, host]);
    await git(tmpRoot, ['clone', '--no-hardlinks', seed, sandbox]);
    await writeFile(path.join(sandbox, 'tracked.txt'), 'implementation\n');
    await git(sandbox, ['commit', '-am', 'draft implementation']);
    const cm = createSandboxContainerManager(sandbox);
    const args = {
      assertCurrent: () => {},
      containerManager: cm,
      containerId: 'sandbox-1',
      podId: path.basename(tmpRoot),
      worktreePath: host,
    };
    const first = await checkpointSandboxWorkspace({ ...args, sequence: 1 });
    expect(first.materialized).toBe(true);
    // Autosquash/amend keeps the task base but replaces the captured source commit.
    await git(sandbox, ['commit', '--amend', '-m', 'final implementation']);
    await writeFile(path.join(sandbox, 'new.txt'), 'final correction\n');
    return { host, sandbox, base, first, args };
  }

  it('recovers an owned unpublished history rewrite while retaining both exact checkpoints', async () => {
    const f = await rewrittenSource();
    await writeFile(path.join(f.host, 'ignored-report.txt'), 'retained host report\n');
    await mkdir(path.join(f.host, 'reports'));
    await writeFile(path.join(f.host, 'reports/retained.log'), 'retained directory report\n');
    await writeFile(path.join(f.host, '.git/info/exclude'), 'reports\n');
    await mkdir(path.join(f.sandbox, 'reports'));
    await writeFile(path.join(f.sandbox, 'reports/new.txt'), 'new tracked report\n');
    await writeFile(path.join(f.sandbox, 'reports/ø.txt'), 'valid UTF-8 path\n');
    const guestHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: f.sandbox }))
      .stdout;
    const guestStatus = (await execFileAsync('git', ['status', '--porcelain'], { cwd: f.sandbox }))
      .stdout;
    const result = await checkpointSandboxWorkspace({
      ...f.args,
      sequence: 2,
      unpublishedSourceBase: f.base,
    });
    expect(result).toMatchObject({
      promoted: true,
      materialized: true,
      rewrittenFrom: {
        checkpoint: f.first.snapshotCommit,
        sourceHead: f.first.sourceHead,
        base: f.base,
      },
    });
    expect(result.error).toBeUndefined();
    expect(
      (
        await execFileAsync('git', ['rev-parse', f.first.quarantineRef], { cwd: f.host })
      ).stdout.trim(),
    ).toBe(f.first.snapshotCommit);
    expect(
      (
        await execFileAsync('git', ['rev-parse', result.quarantineRef], { cwd: f.host })
      ).stdout.trim(),
    ).toBe(result.snapshotCommit);
    expect(await readFile(path.join(f.host, 'new.txt'), 'utf8')).toBe('final correction\n');
    expect(await readFile(path.join(f.host, 'ignored-report.txt'), 'utf8')).toBe(
      'retained host report\n',
    );
    expect(await readFile(path.join(f.host, 'reports/retained.log'), 'utf8')).toBe(
      'retained directory report\n',
    );
    expect(await readFile(path.join(f.host, 'reports/new.txt'), 'utf8')).toBe(
      'new tracked report\n',
    );
    expect((await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: f.sandbox })).stdout).toBe(
      guestHead,
    );
    expect((await execFileAsync('git', ['status', '--porcelain'], { cwd: f.sandbox })).stdout).toBe(
      guestStatus,
    );
    await expect(
      resolveSandboxCheckpointSourceHead(f.host, f.args.podId, result.snapshotCommit),
    ).resolves.toBe(result.sourceHead);
  });

  it.each([
    'no-base',
    'missing-base',
    'wrong-base',
    'foreign-checkpoint',
    'host-commit',
    'dirty-host',
    'untracked-host',
    'ignored-collision',
    'ignored-rename-collision',
    'ignored-symlink-ancestor',
    'ignored-dangling-ancestor',
    'ignored-nonutf8-collision',
    'ignored-bom-collision',
    'replace-ancestry',
    'grafted-ancestry',
  ])('refuses rewrite recovery for %s without changing either source', async (scenario) => {
    const f = await rewrittenSource();
    let base: string | undefined = f.base;
    if (scenario === 'no-base') base = undefined;
    if (scenario === 'missing-base') base = 'a'.repeat(40);
    if (
      scenario === 'wrong-base' ||
      scenario === 'replace-ancestry' ||
      scenario === 'grafted-ancestry'
    )
      base = f.first.sourceHead;
    if (scenario === 'replace-ancestry' || scenario === 'grafted-ancestry') {
      const imported = await checkpointSandboxWorkspace({ ...f.args, sequence: 2 });
      expect(imported).toMatchObject({ hostImported: true, promoted: false });
    }
    if (scenario === 'replace-ancestry') {
      const rewritten = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: f.sandbox })
      ).stdout.trim();
      await git(f.host, ['replace', f.first.sourceHead, rewritten]);
    }
    if (scenario === 'grafted-ancestry') {
      const rewritten = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: f.sandbox })
      ).stdout.trim();
      await writeFile(
        path.join(f.host, '.git/info/grafts'),
        `${rewritten} ${f.first.sourceHead}\n`,
      );
    }
    if (scenario === 'foreign-checkpoint') {
      await git(f.host, [
        'update-ref',
        'refs/autopod-quarantine/another-pod/1',
        f.first.snapshotCommit,
      ]);
      await git(f.host, ['update-ref', '-d', f.first.quarantineRef]);
    }
    if (scenario === 'host-commit')
      await git(f.host, ['commit', '--allow-empty', '-m', 'operator work']);
    if (scenario === 'dirty-host')
      await writeFile(path.join(f.host, 'tracked.txt'), 'operator work\n');
    if (scenario === 'untracked-host')
      await writeFile(path.join(f.host, 'operator.txt'), 'operator notes\n');
    if (scenario === 'ignored-collision') {
      await writeFile(path.join(f.host, '.git/info/exclude'), 'new.txt\n');
      await writeFile(path.join(f.host, 'new.txt'), 'retained ignored report\n');
    }
    if (scenario === 'ignored-bom-collision') {
      await rm(path.join(f.sandbox, 'new.txt'));
      await writeFile(path.join(f.host, '.git/info/exclude'), '*\n');
      await writeFile(path.join(f.host, '\uFEFFnew.txt'), 'retained BOM-path report\n');
      await writeFile(path.join(f.sandbox, '\uFEFFnew.txt'), 'new tracked BOM-path content\n');
    }
    if (scenario === 'ignored-nonutf8-collision') {
      await mkdir(path.join(f.host, 'reports'));
      await mkdir(path.join(f.sandbox, 'reports'));
      await writeFile(path.join(f.host, '.git/info/exclude'), 'reports\n');
      for (const [root, contents] of [
        [f.host, 'retained byte-path report\n'],
        [f.sandbox, 'new tracked byte-path content\n'],
      ] as const) {
        const file = Buffer.concat([
          Buffer.from(`${root}/reports/`),
          Buffer.from([0xff]),
          Buffer.from('.txt'),
        ]);
        await writeFile(file, contents);
      }
    }
    if (scenario === 'ignored-symlink-ancestor' || scenario === 'ignored-dangling-ancestor') {
      const outside = path.join(tmpRoot, 'outside');
      if (scenario === 'ignored-symlink-ancestor') await mkdir(outside);
      await symlink(outside, path.join(f.host, 'reports'), 'dir');
      await writeFile(path.join(f.host, '.git/info/exclude'), 'reports\n');
      await mkdir(path.join(f.sandbox, 'reports'));
      await writeFile(path.join(f.sandbox, 'reports/new.txt'), 'new tracked content\n');
    }
    if (scenario === 'ignored-rename-collision') {
      await git(f.sandbox, ['mv', 'tracked.txt', 'renamed.txt']);
      await writeFile(path.join(f.host, '.git/info/exclude'), 'renamed.txt\n');
      await writeFile(path.join(f.host, 'renamed.txt'), 'retained rename report\n');
    }
    const before = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: f.host })).stdout;
    const status = (await execFileAsync('git', ['status', '--porcelain'], { cwd: f.host })).stdout;
    const result = await checkpointSandboxWorkspace({
      ...f.args,
      sequence: scenario === 'replace-ancestry' || scenario === 'grafted-ancestry' ? 3 : 2,
      unpublishedSourceBase: base,
    });
    expect(result).toMatchObject({ promoted: false, materialized: false });
    expect((await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: f.host })).stdout).toBe(
      before,
    );
    expect((await execFileAsync('git', ['status', '--porcelain'], { cwd: f.host })).stdout).toBe(
      status,
    );
    if (scenario === 'dirty-host')
      expect(await readFile(path.join(f.host, 'tracked.txt'), 'utf8')).toBe('operator work\n');
    if (scenario === 'ignored-collision')
      expect(await readFile(path.join(f.host, 'new.txt'), 'utf8')).toBe(
        'retained ignored report\n',
      );
    if (scenario === 'ignored-rename-collision')
      expect(await readFile(path.join(f.host, 'renamed.txt'), 'utf8')).toBe(
        'retained rename report\n',
      );
    if (scenario === 'ignored-bom-collision')
      expect(await readFile(path.join(f.host, '\uFEFFnew.txt'), 'utf8')).toBe(
        'retained BOM-path report\n',
      );
    if (scenario === 'ignored-nonutf8-collision') {
      const file = Buffer.concat([
        Buffer.from(`${f.host}/reports/`),
        Buffer.from([0xff]),
        Buffer.from('.txt'),
      ]);
      expect(await readFile(file, 'utf8')).toBe('retained byte-path report\n');
    }
    if (scenario === 'ignored-symlink-ancestor' || scenario === 'ignored-dangling-ancestor') {
      expect((await lstat(path.join(f.host, 'reports'))).isSymbolicLink()).toBe(true);
      expect(await readlink(path.join(f.host, 'reports'))).toBe(path.join(tmpRoot, 'outside'));
    }
  });

  it('retains physical host source and ignored reports if authority is lost after guest export before promotion', async () => {
    const seed = path.join(tmpRoot, 'seed');
    const host = path.join(tmpRoot, 'host');
    const sandbox = path.join(tmpRoot, 'guest');
    await git(tmpRoot, ['init', '--initial-branch=main', seed]);
    await writeFile(path.join(seed, 'tracked.txt'), 'original source');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '-m', 'original']);
    await git(tmpRoot, ['clone', '--no-hardlinks', seed, host]);
    await git(tmpRoot, ['clone', '--no-hardlinks', seed, sandbox]);
    await writeFile(path.join(host, 'ignored-report.txt'), 'original host report');
    await writeFile(path.join(sandbox, 'ignored-report.txt'), 'original guest report');
    await writeFile(path.join(sandbox, 'tracked.txt'), 'new source bytes');
    const before = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: host })).stdout;
    const cm = createSandboxContainerManager(sandbox);
    let held = false;
    const read = vi.mocked(cm.readFileBinary).getMockImplementation();
    if (!read) throw new Error('Missing physical guest file reader');
    vi.mocked(cm.readFileBinary).mockImplementation(async (...args) => {
      const bytes = await read(...args);
      held = true;
      return bytes;
    });
    const result = await checkpointSandboxWorkspace({
      containerManager: cm,
      containerId: 'guest',
      podId: path.basename(tmpRoot),
      worktreePath: host,
      sequence: 1,
      assertCurrent: () => {
        if (held) throw new Error('Validation dispatch now unresolved');
      },
    });
    expect(result.promoted).toBe(false);
    expect(result.materialized).toBe(false);
    expect((await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: host })).stdout).toBe(before);
    expect(await readFile(path.join(host, 'tracked.txt'), 'utf8')).toBe('original source');
    expect(await readFile(path.join(host, 'ignored-report.txt'), 'utf8')).toBe(
      'original host report',
    );
    expect(await readFile(path.join(sandbox, 'ignored-report.txt'), 'utf8')).toBe(
      'original guest report',
    );
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
        assertCurrent: () => {},
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
      assertCurrent: () => {},
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
    await expect(
      verifyValidationRecoverySource(host, path.basename(tmpRoot), result.snapshotCommit),
    ).resolves.toBeUndefined();
    await expect(
      verifyValidationRecoverySource(host, 'different-pod', result.snapshotCommit),
    ).rejects.toMatchObject({ code: 'VALIDATION_SOURCE_PRESERVATION_REQUIRED' });
    await expect(readFile(path.join(host, 'tracked.txt'), 'utf8')).resolves.toBe(
      'changed in sandbox\n',
    );
    await expect(readFile(path.join(host, 'new.txt'), 'utf8')).resolves.toBe('new sandbox file\n');
    await writeFile(path.join(host, 'tracked.txt'), 'unexpected host mutation\n');
    await expect(
      verifyValidationRecoverySource(host, path.basename(tmpRoot), result.snapshotCommit),
    ).rejects.toMatchObject({ code: 'VALIDATION_SOURCE_PRESERVATION_REQUIRED' });
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
        assertCurrent: () => {},
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
      assertCurrent: () => {},
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
      assertCurrent: () => {},
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
      assertCurrent: () => {},
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
      assertCurrent: () => {},
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
      assertCurrent: () => {},
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

  const observe = () =>
    observeSandboxWorkspace(createSandboxContainerManager(sandbox), 'sandbox', () => {});

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
