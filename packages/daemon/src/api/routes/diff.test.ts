import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerManager } from '../../interfaces/container-manager.js';
import type { WorktreeManager } from '../../interfaces/worktree-manager.js';
import type { ContainerManagerFactory, PodManager } from '../../pods/pod-manager.js';
import type { ProfileStore } from '../../profiles/index.js';
import { errorHandler } from '../error-handler.js';
import { diffRoutes } from './diff.js';

function makePodManager(podOverrides: Record<string, unknown> = {}): PodManager {
  return {
    getSession: vi.fn().mockReturnValue({
      id: 'pod-1',
      profileName: 'p',
      executionTarget: 'docker',
      containerId: 'c1',
      worktreePath: '/host/worktree',
      startCommitSha: 'start-sha',
      baseBranch: 'main',
      ...podOverrides,
    }),
  } as unknown as PodManager;
}

function makeContainerFactory(cm: ContainerManager): ContainerManagerFactory {
  return {
    get: vi.fn().mockReturnValue(cm),
  } as unknown as ContainerManagerFactory;
}

function makeProfileStore(): ProfileStore {
  return { get: vi.fn().mockReturnValue({ defaultBranch: 'main' }) } as unknown as ProfileStore;
}

describe('diff route', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    app.setErrorHandler(errorHandler);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns parsed files + stats from the container diff', async () => {
    const sample =
      'diff --git a/src/foo.ts b/src/foo.ts\n' +
      '--- a/src/foo.ts\n' +
      '+++ b/src/foo.ts\n' +
      '@@ -1,2 +1,3 @@\n' +
      ' line1\n' +
      '+added\n' +
      '-removed\n';
    const cm = {
      execInContainer: vi.fn().mockImplementation((_id, cmd: string[]) => {
        if (cmd[0] === 'git' && cmd[1] === 'diff' && cmd.includes('start-sha')) {
          return Promise.resolve({ stdout: sample, stderr: '', exitCode: 0 });
        }
        if (cmd[0] === 'git' && cmd[1] === 'diff' && cmd.includes('HEAD')) {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        if (cmd[0] === 'git' && cmd[1] === 'log') {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        return Promise.resolve({ stdout: '', stderr: 'unexpected', exitCode: 1 });
      }),
    } as unknown as ContainerManager;

    diffRoutes(app, makePodManager(), makeContainerFactory(cm), makeProfileStore());
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/pods/pod-1/diff' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { files: unknown[]; stats: { changed: number } };
    expect(body.files).toHaveLength(1);
    expect(body.stats).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(body.previewFiles).toEqual([]);
    expect(body.commits).toEqual([]);
  });

  it('returns untracked preview and commit groups separately from the canonical diff', async () => {
    const canonical =
      'diff --git a/src/foo.ts b/src/foo.ts\n' +
      '--- a/src/foo.ts\n' +
      '+++ b/src/foo.ts\n' +
      '@@ -1 +1 @@\n' +
      '-old\n' +
      '+new\n';
    const untracked =
      'diff --git a/src/new.ts b/src/new.ts\n' +
      'new file mode 100644\n' +
      '--- /dev/null\n' +
      '+++ b/src/new.ts\n' +
      '@@ -0,0 +1 @@\n' +
      '+export const value = 1;\n';
    const calls: string[][] = [];
    const cm = {
      execInContainer: vi.fn().mockImplementation((_id, cmd: string[]) => {
        calls.push(cmd);
        if (cmd[0] === 'git' && cmd[1] === 'diff' && cmd.includes('start-sha')) {
          return Promise.resolve({ stdout: canonical, stderr: '', exitCode: 0 });
        }
        if (cmd[0] === 'git' && cmd[1] === 'diff' && cmd.includes('HEAD')) {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        if (cmd[0] === 'git' && cmd[1] === 'ls-files') {
          return Promise.resolve({ stdout: 'src/new.ts\0', stderr: '', exitCode: 0 });
        }
        if (cmd[0] === 'stat') {
          return Promise.resolve({ stdout: '24\n', stderr: '', exitCode: 0 });
        }
        if (cmd[0] === 'git' && cmd[1] === 'diff' && cmd.includes('--no-index')) {
          return Promise.resolve({ stdout: untracked, stderr: '', exitCode: 1 });
        }
        if (cmd[0] === 'git' && cmd[1] === 'log') {
          return Promise.resolve({
            stdout: [
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              'aaaaaaaa',
              '2026-05-20T10:00:00Z',
              'feat: add thing',
              '\x1e',
            ].join('\0'),
            stderr: '',
            exitCode: 0,
          });
        }
        if (cmd[0] === 'git' && cmd[1] === 'show') {
          return Promise.resolve({ stdout: canonical, stderr: '', exitCode: 0 });
        }
        return Promise.resolve({ stdout: '', stderr: 'unexpected', exitCode: 1 });
      }),
    } as unknown as ContainerManager;

    diffRoutes(app, makePodManager(), makeContainerFactory(cm), makeProfileStore());
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/pods/pod-1/diff' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      files: { path: string }[];
      previewFiles: { path: string }[];
      commits: { shortSha: string; files: { path: string }[] }[];
    };
    expect(body.files.map((f) => f.path)).toEqual(['src/foo.ts']);
    expect(body.previewFiles.map((f) => f.path)).toEqual(['src/new.ts']);
    expect(body.commits).toHaveLength(1);
    expect(body.commits[0]?.shortSha).toBe('aaaaaaaa');
    expect(body.commits[0]?.files.map((f) => f.path)).toEqual(['src/foo.ts']);
    expect(calls.some((cmd) => cmd[1] === 'merge-base')).toBe(false);
  });

  // Regression: previously tryWorktreeDiff (and tryContainerDiff) ran
  // `git diff base HEAD` followed by `git diff HEAD` and concatenated the two,
  // producing duplicate `diff --git` blocks for any file that was committed
  // AND modified in the worktree. The unified single-ref `git diff <base>`
  // path yields one block per file.
  it('does not double-count a file that is committed-then-modified', async () => {
    const wtDiff =
      'diff --git a/src/foo.ts b/src/foo.ts\n' +
      '--- a/src/foo.ts\n' +
      '+++ b/src/foo.ts\n' +
      '@@ -1,2 +1,3 @@\n' +
      ' line1\n' +
      '+committed-and-modified\n';
    const wm = {
      getDiff: vi.fn().mockResolvedValue(wtDiff),
    } as unknown as WorktreeManager;

    diffRoutes(
      app,
      makePodManager({ containerId: null }),
      makeContainerFactory({} as ContainerManager),
      makeProfileStore(),
      wm,
    );
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/pods/pod-1/diff' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { files: { path: string }[] };
    expect(body.files).toHaveLength(1);
    expect(body.files[0]?.path).toBe('src/foo.ts');
  });

  it('falls back to the pushed branch diff after the local worktree is gone', async () => {
    const branchDiff =
      'diff --git a/src/memory.ts b/src/memory.ts\n' +
      '--- a/src/memory.ts\n' +
      '+++ b/src/memory.ts\n' +
      '@@ -1 +1,2 @@\n' +
      ' export const existing = true;\n' +
      '+export const selected = true;\n';
    const wm = {
      getDiff: vi.fn().mockResolvedValue(''),
      getBranchDiff: vi.fn().mockResolvedValue(branchDiff),
    } as unknown as WorktreeManager;
    const profileStore = {
      get: vi.fn().mockReturnValue({
        repoUrl: 'https://github.com/acme/project.git',
        defaultBranch: 'main',
        prProvider: 'github',
        githubPat: 'ghp_test',
        adoPat: null,
      }),
    } as unknown as ProfileStore;

    diffRoutes(
      app,
      makePodManager({
        containerId: null,
        worktreePath: null,
        branch: 'autopod/safe-marten',
      }),
      makeContainerFactory({} as ContainerManager),
      profileStore,
      wm,
    );
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/pods/pod-1/diff' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { files: { path: string }[]; stats: { changed: number } };
    expect(body.files.map((f) => f.path)).toEqual(['src/memory.ts']);
    expect(body.stats).toEqual({ added: 1, removed: 0, changed: 1 });
    expect(wm.getBranchDiff).toHaveBeenCalledWith({
      repoUrl: 'https://github.com/acme/project.git',
      branch: 'autopod/safe-marten',
      baseBranch: 'main',
      pat: 'ghp_test',
      startCommitSha: 'start-sha',
    });
  });

  it('returns empty files + zero stats when there is nothing to diff', async () => {
    diffRoutes(
      app,
      makePodManager({ containerId: null, worktreePath: null }),
      makeContainerFactory({} as ContainerManager),
      makeProfileStore(),
    );
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/pods/pod-1/diff' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      files: [],
      stats: { added: 0, removed: 0, changed: 0 },
      previewFiles: [],
      previewStats: { added: 0, removed: 0, changed: 0 },
      uncommittedFiles: [],
      uncommittedStats: { added: 0, removed: 0, changed: 0 },
      commits: [],
      commitGroupingUnavailableReason:
        'commit grouping unavailable from container and host worktree',
    });
  });
});
