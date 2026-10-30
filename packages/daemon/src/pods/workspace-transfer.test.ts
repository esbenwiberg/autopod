import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockContainerManager, logger } from '../test-utils/mock-helpers.js';
import { shellQuote } from '../util/shell-quote.js';
import { autopodStagingRef } from '../worktrees/bare-push.js';
import {
  WORKSPACE_RUNTIME_CACHE_EXCLUDES,
  WORKSPACE_SYNC_EXCLUDES,
  buildWorkspaceMirrorCopyScript,
} from './workspace-mirror.js';
import { createWorkspaceTransfer } from './workspace-transfer.js';

const run = promisify(execFile);
const temporaryGitDirectories = new Set<string>();

function environment() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@localhost',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@localhost',
  };
}

async function git(cwd: string, args: string[]) {
  return (await run('git', args, { cwd, env: environment(), timeout: 5_000 })).stdout.trim();
}

/** Actual local Git and shell operations; no daemon, Docker or remote repository. */
async function fixture(root: string) {
  const seed = path.join(root, 'seed');
  const bare = path.join(root, 'repo.git');
  const host = path.join(root, 'host');
  const workspace = path.join(root, 'container');
  await git(root, ['init', '--initial-branch=main', seed]);
  await writeFile(path.join(seed, 'tracked.txt'), 'baseline\n');
  await writeFile(path.join(seed, 'removed.txt'), 'remove in worker commit\n');
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-m', 'baseline']);
  await git(root, ['clone', '--bare', seed, bare]);
  await git(root, ['--git-dir', bare, 'worktree', 'add', '-b', 'feature', host, 'main']);
  await git(root, ['clone', '--shared', bare, workspace]);
  await git(workspace, ['checkout', '-b', 'feature', 'main']);
  await writeFile(path.join(workspace, 'committed.txt'), 'worker commit\n');
  await git(workspace, ['rm', 'removed.txt']);
  await git(workspace, ['add', '.']);
  await git(workspace, ['commit', '-m', 'worker commit']);
  await writeFile(path.join(workspace, 'tracked.txt'), 'dirty worker edit\n');
  await writeFile(path.join(workspace, "worker's report.txt"), 'untracked evidence\n');
  await writeFile(path.join(workspace, 'run me.sh'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(workspace, 'run me.sh'), 0o755);
  await symlink("worker's report.txt", path.join(workspace, 'report-link'));
  await symlink('missing-target', path.join(workspace, 'broken-link'));
  for (const name of WORKSPACE_RUNTIME_CACHE_EXCLUDES) {
    await mkdir(path.join(workspace, name));
    await writeFile(path.join(workspace, name, 'platform'), 'container cache');
    await mkdir(path.join(host, name));
    await writeFile(path.join(host, name, 'platform'), 'host cache');
  }
  await writeFile(path.join(host, 'host-only.txt'), 'stale host file');
  await mkdir(path.join(host, '.autopod-sync-stale'));
  await writeFile(path.join(host, '.autopod-sync-stale', 'leftover'), 'stale staging');
  const cm = createMockContainerManager();
  cm.execInContainer = vi.fn(async (_id, command) => {
    // Map only the two private container mount points; execute the original
    // production command/script, with Git's global writes isolated by beforeEach.
    const mapped = command.map((part) =>
      part.replaceAll('/mnt/worktree', host).replaceAll('/workspace', workspace),
    );
    const executable = mapped[0];
    if (!executable) throw new Error('Empty container command');
    try {
      const result = await run(executable, mapped.slice(1), {
        env: environment(),
        timeout: 5_000,
      });
      return { ...result, exitCode: 0 };
    } catch (err) {
      const failure = err as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? String(err),
        exitCode: typeof failure.code === 'number' ? failure.code : 1,
      };
    }
  });
  cm.extractDirectoryFromContainer = vi.fn(async (_id, source, target, excludes = []) => {
    if (source !== '/workspace' && source !== '/workspace/.git') {
      throw new Error('Unexpected archive source');
    }
    if (source === '/workspace/.git') {
      if (
        path.dirname(target) !== os.tmpdir() ||
        !/^autopod-git-\d+$/.test(path.basename(target))
      ) {
        throw new Error('Unexpected temporary Git directory');
      }
      temporaryGitDirectories.add(target);
    }
    const local = source === '/workspace' ? workspace : path.join(workspace, '.git');
    // This adapter exercises transfer orchestration and real files, not Docker tar.
    await cp(local, target, {
      recursive: true,
      preserveTimestamps: true,
      filter: (entry) => entry === local || !excludes.includes(path.basename(entry)),
    });
  });
  return { bare, host, workspace, cm };
}

async function sourceIdentity(workspace: string) {
  return {
    head: await git(workspace, ['rev-parse', 'HEAD']),
    status: await git(workspace, ['status', '--porcelain']),
    index: createHash('sha256')
      .update(await readFile(path.join(workspace, '.git/index')))
      .digest('hex'),
    tracked: await readFile(path.join(workspace, 'tracked.txt'), 'utf8'),
    report: await readFile(path.join(workspace, "worker's report.txt"), 'utf8'),
  };
}

async function assertPublished(f: Awaited<ReturnType<typeof fixture>>, podId: string) {
  expect(await git(f.host, ['rev-parse', 'HEAD'])).toBe(
    await git(f.workspace, ['rev-parse', 'HEAD']),
  );
  expect(await git(f.host, ['diff', '--cached', '--name-only'])).toBe('');
  expect(await readFile(path.join(f.host, 'committed.txt'), 'utf8')).toBe('worker commit\n');
  expect(await readFile(path.join(f.host, 'tracked.txt'), 'utf8')).toBe('dirty worker edit\n');
  expect(await readFile(path.join(f.host, "worker's report.txt"), 'utf8')).toBe(
    'untracked evidence\n',
  );
  expect(await git(f.host, ['diff', '--name-only'])).toBe('tracked.txt');
  await expect(
    git(f.host, ['--git-dir', f.bare, 'rev-parse', '--verify', autopodStagingRef(podId)]),
  ).rejects.toThrow();
}

describe('workspace transfer material boundary', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'autopod-transfer-')));
    vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'global.gitconfig'));
    vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const directory of temporaryGitDirectories) {
      await rm(directory, { recursive: true, force: true });
    }
    temporaryGitDirectories.clear();
    await rm(root, { recursive: true, force: true });
  });

  it('publishes real commits and mirrors dirty files without replacing host Git or caches', async () => {
    const f = await fixture(root);
    const before = await sourceIdentity(f.workspace);
    const gitlink = await readFile(path.join(f.host, '.git'), 'utf8');
    const transfer = createWorkspaceTransfer({ logger, captureAuthority: () => () => {} });

    await expect(
      transfer.syncWorkspaceBack('container', f.host, f.cm, 'pod-mirror'),
    ).resolves.toEqual({ pushed: true });

    await assertPublished(f, 'pod-mirror');
    expect(await readFile(path.join(f.host, '.git'), 'utf8')).toBe(gitlink);
    await expect(lstat(path.join(f.host, 'removed.txt'))).rejects.toThrow();
    await expect(lstat(path.join(f.host, 'host-only.txt'))).rejects.toThrow();
    expect(await readlink(path.join(f.host, 'report-link'))).toBe("worker's report.txt");
    expect(await readlink(path.join(f.host, 'broken-link'))).toBe('missing-target');
    expect((await lstat(path.join(f.host, 'run me.sh'))).mode & 0o777).toBe(0o755);
    for (const name of WORKSPACE_RUNTIME_CACHE_EXCLUDES) {
      expect(await readFile(path.join(f.host, name, 'platform'), 'utf8')).toBe('host cache');
    }
    expect((await readdir(f.host)).filter((name) => name.startsWith('.autopod-'))).toEqual([]);
    expect(await sourceIdentity(f.workspace)).toEqual(before);
    expect(f.cm.extractDirectoryFromContainer).not.toHaveBeenCalled();
    expect(await readFile(path.join(root, 'global.gitconfig'), 'utf8')).toContain(f.bare);
  });

  it('cannot redirect publication using mismatched alternates, while preserving dirty files', async () => {
    const f = await fixture(root);
    const unrelated = path.join(root, 'unrelated.git');
    await git(root, ['clone', '--bare', f.bare, unrelated]);
    const before = await git(root, ['--git-dir', unrelated, 'show-ref']);
    const originalTip = await git(f.host, ['rev-parse', 'HEAD']);
    await writeFile(
      path.join(f.workspace, '.git/objects/info/alternates'),
      `${unrelated}/objects\n`,
    );
    const source = await sourceIdentity(f.workspace);

    await expect(
      createWorkspaceTransfer({ logger, captureAuthority: () => () => {} }).syncWorkspaceBack(
        'container',
        f.host,
        f.cm,
        'pod-mismatch',
      ),
    ).resolves.toEqual({ pushed: false });

    expect(await git(root, ['--git-dir', unrelated, 'show-ref'])).toBe(before);
    expect(await git(f.host, ['rev-parse', 'HEAD'])).toBe(originalTip);
    expect(await readFile(path.join(f.host, 'tracked.txt'), 'utf8')).toBe('dirty worker edit\n');
    expect(
      vi.mocked(f.cm.execInContainer).mock.calls.some(([, command]) => command.includes('push')),
    ).toBe(false);
    expect(await sourceIdentity(f.workspace)).toEqual(source);
  });

  it('leaves host files intact when staging fails before overlay and archives also fail', async () => {
    const f = await fixture(root);
    await writeFile(path.join(f.workspace, '.git/objects/info/alternates'), '');
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    await writeFile(path.join(bin, 'cp'), '#!/bin/sh\nexit 9\n');
    await chmod(path.join(bin, 'cp'), 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    const archiveError = new Error('archive unavailable');
    vi.mocked(f.cm.extractDirectoryFromContainer).mockRejectedValue(archiveError);
    const gitlink = await readFile(path.join(f.host, '.git'), 'utf8');

    await expect(
      createWorkspaceTransfer({ logger, captureAuthority: () => () => {} }).syncWorkspaceBack(
        'container',
        f.host,
        f.cm,
        'pod-stage',
      ),
    ).rejects.toBe(archiveError);

    expect(await readFile(path.join(f.host, 'tracked.txt'), 'utf8')).toBe('baseline\n');
    expect(await readFile(path.join(f.host, 'removed.txt'), 'utf8')).toBe(
      'remove in worker commit\n',
    );
    expect(await readFile(path.join(f.host, 'host-only.txt'), 'utf8')).toBe('stale host file');
    expect(await readFile(path.join(f.host, '.git'), 'utf8')).toBe(gitlink);
    expect((await readdir(f.host)).filter((name) => name.startsWith('.autopod-'))).toEqual([]);
    expect(f.cm.extractDirectoryFromContainer).toHaveBeenCalledOnce();
  });

  it.each(['local', 'sandbox'] as const)(
    'recovers real Git through the %s archive route and removes temporary Git',
    async (target) => {
      const f = await fixture(root);
      const before = await sourceIdentity(f.workspace);
      const gitlink = await readFile(path.join(f.host, '.git'), 'utf8');
      vi.mocked(f.cm.execInContainer).mockRejectedValue(new Error('exec unavailable'));

      await expect(
        createWorkspaceTransfer({ logger, captureAuthority: () => () => {} }).syncWorkspaceBack(
          'container',
          f.host,
          f.cm,
          'pod-archive',
          target,
        ),
      ).resolves.toEqual({ pushed: true });

      await assertPublished(f, 'pod-archive');
      const calls = vi.mocked(f.cm.extractDirectoryFromContainer).mock.calls;
      expect(calls.map(([, source]) => source)).toEqual(['/workspace', '/workspace/.git']);
      const temporaryGit = calls[1]?.[2];
      expect(temporaryGit).toMatch(/autopod-git-\d+$/);
      await expect(lstat(temporaryGit ?? '')).rejects.toThrow();
      expect(await readFile(path.join(f.host, '.git'), 'utf8')).toBe(gitlink);
      expect(await sourceIdentity(f.workspace)).toEqual(before);
      if (target === 'sandbox') expect(f.cm.execInContainer).not.toHaveBeenCalled();
    },
  );

  it('retains archived files and removes temporary Git when detached publication is refused', async () => {
    const f = await fixture(root);
    await git(f.workspace, ['checkout', '--detach', 'HEAD']);
    const originalTip = await git(f.host, ['rev-parse', 'HEAD']);
    vi.mocked(f.cm.execInContainer).mockRejectedValue(new Error('exec unavailable'));

    await expect(
      createWorkspaceTransfer({ logger, captureAuthority: () => () => {} }).syncWorkspaceBack(
        'container',
        f.host,
        f.cm,
        'pod-detached',
      ),
    ).resolves.toEqual({ pushed: false });

    expect(await readFile(path.join(f.host, 'tracked.txt'), 'utf8')).toBe('dirty worker edit\n');
    expect(await git(f.host, ['rev-parse', 'HEAD'])).toBe(originalTip);
    const temporaryGit = vi.mocked(f.cm.extractDirectoryFromContainer).mock.calls[1]?.[2];
    expect(temporaryGit).toMatch(/autopod-git-\d+$/);
    await expect(lstat(temporaryGit ?? '')).rejects.toThrow();
  });

  it('repopulates real files and refreshes the index during live recovery', async () => {
    const f = await fixture(root);
    const before = await sourceIdentity(f.workspace);
    await rm(path.join(f.host, 'tracked.txt'));

    await expect(
      createWorkspaceTransfer({
        logger,
        captureAuthority: () => () => {},
      }).recoverWorktreeFromContainer('container', f.host, f.cm, 'pod-live'),
    ).resolves.toBe(true);

    await assertPublished(f, 'pod-live');
    expect(
      vi.mocked(f.cm.extractDirectoryFromContainer).mock.calls.map(([, source]) => source),
    ).toEqual(['/workspace']);
    expect(await sourceIdentity(f.workspace)).toEqual(before);
  });

  it.each(['provisioning', 'sync'] as const)(
    'executes shared mirror quoting and %s Git exclusions',
    async (mode) => {
      const source = path.join(root, "worker's source");
      const target = path.join(root, "host's destination");
      await mkdir(path.join(source, '.git'), { recursive: true });
      await mkdir(path.join(source, 'node_modules'));
      await mkdir(target);
      await writeFile(path.join(source, '.git/HEAD'), 'source Git');
      await writeFile(path.join(source, 'node_modules/platform'), 'container cache');
      await writeFile(path.join(source, "file's name.txt"), 'copied');
      const excludes =
        mode === 'provisioning' ? WORKSPACE_RUNTIME_CACHE_EXCLUDES : WORKSPACE_SYNC_EXCLUDES;
      const script = buildWorkspaceMirrorCopyScript(source, shellQuote(target), excludes);

      await run('sh', ['-ceu', script], { env: environment(), timeout: 5_000 });

      expect(await readFile(path.join(target, "file's name.txt"), 'utf8')).toBe('copied');
      await expect(lstat(path.join(target, 'node_modules'))).rejects.toThrow();
      if (mode === 'provisioning')
        expect(await readFile(path.join(target, '.git/HEAD'), 'utf8')).toBe('source Git');
      else await expect(lstat(path.join(target, '.git'))).rejects.toThrow();
    },
  );
});
