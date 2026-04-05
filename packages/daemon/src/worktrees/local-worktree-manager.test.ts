import type { ChildProcess } from 'node:child_process';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalWorktreeManager } from './local-worktree-manager.js';

const logger = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// Hoist mock fns so they're available inside vi.mock factories
// ---------------------------------------------------------------------------

const { execFileMock, fsMkdirMock, fsRmMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  fsMkdirMock: vi.fn().mockResolvedValue(undefined),
  fsRmMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFile: execFileMock };
});

vi.mock('node:fs/promises', async () => {
  return {
    default: {
      mkdir: fsMkdirMock,
      rm: fsRmMock,
      access: vi.fn().mockResolvedValue(undefined),
    },
    mkdir: fsMkdirMock,
    rm: fsRmMock,
    access: vi.fn().mockResolvedValue(undefined),
  };
});

// ---------------------------------------------------------------------------
// Callback type for execFile-like functions
// ---------------------------------------------------------------------------

type ExecCallback = (error: Error | null, result: unknown, stderr?: string) => void;

/**
 * Resolve the callback from execFile arguments.
 * execFile can be called as:
 *   execFile(file, args, callback)          — 3 args
 *   execFile(file, args, options, callback) — 4 args
 */
function resolveCallback(arg3: unknown, arg4: unknown): ExecCallback {
  if (typeof arg4 === 'function') return arg4 as ExecCallback;
  if (typeof arg3 === 'function') return arg3 as ExecCallback;
  throw new Error('No callback found in execFile arguments');
}

// ---------------------------------------------------------------------------
// Helper: configure execFileMock to respond based on command content
// ---------------------------------------------------------------------------

function setupExecFileMock(
  responses: Record<string, { stdout?: string; stderr?: string; error?: Error }>,
) {
  execFileMock.mockImplementation(
    (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
      const cb = resolveCallback(arg3, arg4);
      const cmd = args.join(' ');
      const key = Object.keys(responses).find((k) => cmd.includes(k));
      const resp = key ? responses[key] : undefined;

      if (resp?.error) {
        cb(resp.error, { stdout: '', stderr: resp.stderr ?? '' });
      } else {
        cb(null, { stdout: resp?.stdout ?? '', stderr: resp?.stderr ?? '' });
      }
      return {} as ChildProcess;
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LocalWorktreeManager', () => {
  let manager: LocalWorktreeManager;
  const cacheDir = '/tmp/test-cache';
  const worktreeDir = '/tmp/test-worktrees';

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply default implementations after clear
    fsMkdirMock.mockResolvedValue(undefined);
    fsRmMock.mockResolvedValue(undefined);
    manager = new LocalWorktreeManager({ cacheDir, worktreeDir, logger });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // sanitizeRepoUrl (private)
  // -------------------------------------------------------------------------

  describe('sanitizeRepoUrl', () => {
    it('converts a GitHub URL to a safe cache key', () => {
      const result = (
        manager as unknown as { sanitizeRepoUrl: (url: string) => string }
      ).sanitizeRepoUrl('https://github.com/org/repo.git');
      expect(result).toBe('github.com_org_repo');
    });

    it('handles URLs without .git suffix', () => {
      const result = (
        manager as unknown as { sanitizeRepoUrl: (url: string) => string }
      ).sanitizeRepoUrl('https://github.com/org/repo');
      expect(result).toBe('github.com_org_repo');
    });

    it('handles ADO URLs with colons and slashes', () => {
      const result = (
        manager as unknown as { sanitizeRepoUrl: (url: string) => string }
      ).sanitizeRepoUrl('https://dev.azure.com/myorg/myproject/_git/myrepo');
      expect(result).toBe('dev.azure.com_myorg_myproject__git_myrepo');
    });
  });

  // -------------------------------------------------------------------------
  // injectPat (private)
  // -------------------------------------------------------------------------

  describe('injectPat', () => {
    it('injects PAT into https URL', () => {
      const result = (
        manager as unknown as { injectPat: (url: string, pat: string) => string }
      ).injectPat('https://github.com/org/repo.git', 'mytoken');
      expect(result).toBe('https://:mytoken@github.com/org/repo.git');
    });

    it('replaces existing userinfo before injecting', () => {
      const result = (
        manager as unknown as { injectPat: (url: string, pat: string) => string }
      ).injectPat('https://old-token@github.com/org/repo.git', 'new-token');
      expect(result).toBe('https://:new-token@github.com/org/repo.git');
    });
  });

  // -------------------------------------------------------------------------
  // parseDiffStats (private)
  // -------------------------------------------------------------------------

  describe('parseDiffStats', () => {
    it('parses standard git diff --stat output', () => {
      const output =
        ' src/foo.ts | 10 ++++++----\n 1 file changed, 6 insertions(+), 4 deletions(-)';
      const result = (
        manager as unknown as { parseDiffStats: (output: string) => object }
      ).parseDiffStats(output);
      expect(result).toEqual({ filesChanged: 1, linesAdded: 6, linesRemoved: 4 });
    });

    it('parses multi-file output', () => {
      const output = [
        ' src/a.ts | 5 +++++',
        ' src/b.ts | 3 ---',
        ' 2 files changed, 5 insertions(+), 3 deletions(-)',
      ].join('\n');
      const result = (
        manager as unknown as { parseDiffStats: (output: string) => object }
      ).parseDiffStats(output);
      expect(result).toEqual({ filesChanged: 2, linesAdded: 5, linesRemoved: 3 });
    });

    it('returns zeros for empty output', () => {
      const result = (
        manager as unknown as { parseDiffStats: (output: string) => object }
      ).parseDiffStats('');
      expect(result).toEqual({ filesChanged: 0, linesAdded: 0, linesRemoved: 0 });
    });

    it('handles output with only insertions', () => {
      const output = ' 1 file changed, 10 insertions(+)';
      const result = (
        manager as unknown as { parseDiffStats: (output: string) => object }
      ).parseDiffStats(output);
      expect(result).toEqual({ filesChanged: 1, linesAdded: 10, linesRemoved: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // getDiffStats
  // -------------------------------------------------------------------------

  describe('getDiffStats', () => {
    it('returns diff stats using merge-base when baseBranch is provided', async () => {
      setupExecFileMock({
        'merge-base': { stdout: 'abc1234\n' },
        'diff --stat': { stdout: ' 3 files changed, 15 insertions(+), 5 deletions(-)' },
      });

      const result = await manager.getDiffStats('/tmp/worktree/sess', 'main');
      expect(result).toEqual({ filesChanged: 3, linesAdded: 15, linesRemoved: 5 });
    });

    it('falls back to git diff HEAD when no baseBranch is provided', async () => {
      setupExecFileMock({
        'diff --stat HEAD': { stdout: ' 1 file changed, 2 insertions(+)' },
      });

      const result = await manager.getDiffStats('/tmp/worktree/sess');
      expect(result).toEqual({ filesChanged: 1, linesAdded: 2, linesRemoved: 0 });
    });

    it('returns zeros when git diff fails', async () => {
      execFileMock.mockImplementation(
        (_file: string, _args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          cb(new Error('not a git repo'), '', '');
          return {} as ChildProcess;
        },
      );

      const result = await manager.getDiffStats('/not/a/repo');
      expect(result).toEqual({ filesChanged: 0, linesAdded: 0, linesRemoved: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // getDiff
  // -------------------------------------------------------------------------

  describe('getDiff', () => {
    it('returns the diff string up to maxLength', async () => {
      const diffContent = 'diff --git a/foo.ts b/foo.ts\n+added line\n';
      setupExecFileMock({
        'merge-base': { stdout: 'abc1234\n' },
        'diff abc1234': { stdout: diffContent },
      });

      const result = await manager.getDiff('/tmp/worktree/sess', 'main');
      expect(result).toBe(diffContent);
    });

    it('truncates diff to maxLength', async () => {
      const longDiff = 'x'.repeat(100);
      setupExecFileMock({
        'merge-base': { stdout: 'abc1234\n' },
        'diff abc1234': { stdout: longDiff },
      });

      const result = await manager.getDiff('/tmp/worktree/sess', 'main', 10);
      expect(result).toBe('x'.repeat(10));
    });

    it('returns empty string on error', async () => {
      execFileMock.mockImplementation(
        (_file: string, _args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          cb(new Error('git error'), '', '');
          return {} as ChildProcess;
        },
      );

      const result = await manager.getDiff('/not/a/repo', 'main');
      expect(result).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // getCommitLog
  // -------------------------------------------------------------------------

  describe('getCommitLog', () => {
    it('returns trimmed commit log', async () => {
      setupExecFileMock({
        log: { stdout: 'abc1234 feat: add feature\n\ndef5678 fix: edge case\n' },
      });

      const result = await manager.getCommitLog('/tmp/worktree/sess', 'main');
      expect(result).toBe('abc1234 feat: add feature\n\ndef5678 fix: edge case');
    });

    it('returns empty string when git log fails', async () => {
      execFileMock.mockImplementation(
        (_file: string, _args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          cb(new Error('not a repo'), '', '');
          return {} as ChildProcess;
        },
      );

      const result = await manager.getCommitLog('/bad/path', 'main');
      expect(result).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // commitFiles
  // -------------------------------------------------------------------------

  describe('commitFiles', () => {
    it('is a no-op when paths is empty', async () => {
      await manager.commitFiles('/tmp/worktree', [], 'empty commit');
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('stages and commits specified files when there are staged changes', async () => {
      let callIdx = 0;
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          callIdx++;
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('diff --cached --quiet')) {
            // Exit 1 = there are staged changes
            cb(new Error('exit 1'), '', '');
          } else {
            cb(null, '', '');
          }
          return {} as ChildProcess;
        },
      );

      await manager.commitFiles('/tmp/worktree', ['src/foo.ts'], 'test: add tests');
      expect(execFileMock).toHaveBeenCalled();
    });

    it('skips commit when nothing is staged', async () => {
      setupExecFileMock({
        'diff --cached --quiet': { stdout: '' }, // exit 0 = nothing staged
      });

      await manager.commitFiles('/tmp/worktree', ['src/foo.ts'], 'test: nothing');
      // Should have called git add and git diff --cached but NOT git commit
      const commitCalls = execFileMock.mock.calls.filter((c: string[][]) =>
        c[1]?.join(' ').includes('commit'),
      );
      expect(commitCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // withRepoLock (private) — concurrency behaviour
  // -------------------------------------------------------------------------

  describe('withRepoLock', () => {
    it('serializes concurrent operations on the same key', async () => {
      const order: number[] = [];

      const run = (id: number, delay: number) =>
        (
          manager as unknown as {
            withRepoLock: (key: string, fn: () => Promise<void>) => Promise<void>;
          }
        ).withRepoLock('same-key', async () => {
          order.push(id);
          await new Promise((r) => setTimeout(r, delay));
          order.push(-id);
        });

      await Promise.all([run(1, 20), run(2, 5)]);

      expect(order).toEqual([1, -1, 2, -2]);
    });

    it('runs operations on different keys concurrently', async () => {
      const started: string[] = [];
      const finished: string[] = [];

      const run = (key: string, delay: number) =>
        (
          manager as unknown as {
            withRepoLock: (key: string, fn: () => Promise<void>) => Promise<void>;
          }
        ).withRepoLock(key, async () => {
          started.push(key);
          await new Promise((r) => setTimeout(r, delay));
          finished.push(key);
        });

      await Promise.all([run('repo-a', 20), run('repo-b', 5)]);

      expect(started).toContain('repo-a');
      expect(started).toContain('repo-b');
      expect(finished[0]).toBe('repo-b');
    });
  });

  // -------------------------------------------------------------------------
  // cleanup
  // -------------------------------------------------------------------------

  describe('cleanup', () => {
    it('calls git worktree remove and prune', async () => {
      setupExecFileMock({
        'rev-parse --git-common-dir': { stdout: '/tmp/bare-repo.git\n' },
        'worktree remove': { stdout: '' },
        'worktree prune': { stdout: '' },
      });

      await manager.cleanup('/tmp/worktrees/my-branch');

      const cmds = execFileMock.mock.calls.map((c: string[][]) => c[1]?.join(' ') ?? '');
      expect(cmds.some((c: string) => c.includes('worktree remove'))).toBe(true);
      expect(cmds.some((c: string) => c.includes('worktree prune'))).toBe(true);
    });

    it('falls back to fs.rm when git worktree remove fails', async () => {
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('rev-parse --git-common-dir')) {
            cb(null, { stdout: '/tmp/bare.git\n', stderr: '' });
          } else if (cmd.includes('worktree remove')) {
            cb(new Error('already removed'));
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      await manager.cleanup('/tmp/worktrees/old-branch');

      expect(fsRmMock).toHaveBeenCalledWith(
        '/tmp/worktrees/old-branch',
        expect.objectContaining({ recursive: true, force: true }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // create — bare repo clone + worktree add flow
  // -------------------------------------------------------------------------

  describe('create', () => {
    it('clones bare repo and creates worktree when repo does not exist', async () => {
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('rev-parse --git-dir')) {
            cb(new Error('not a git repo'), '', '');
          } else {
            cb(null, '', '');
          }
          return {} as ChildProcess;
        },
      );

      const result = await manager.create({
        repoUrl: 'https://github.com/org/repo.git',
        branch: 'feat/my-feature',
        baseBranch: 'main',
      });

      const cmds = execFileMock.mock.calls.map((c: string[][]) => c[1]?.join(' ') ?? '');
      expect(cmds.some((c: string) => c.includes('clone --bare'))).toBe(true);
      expect(cmds.some((c: string) => c.includes('remote set-url'))).toBe(true);
      expect(cmds.some((c: string) => c.includes('worktree add'))).toBe(true);
      expect(result.worktreePath).toContain('feat_my-feature');
      expect(result.bareRepoPath).toContain('github.com_org_repo.git');
    });

    it('skips clone when bare repo already exists', async () => {
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('rev-parse --git-dir')) {
            cb(null, { stdout: '.', stderr: '' }); // repo valid
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      await manager.create({
        repoUrl: 'https://github.com/org/repo.git',
        branch: 'feat/existing',
        baseBranch: 'main',
      });

      const cmds = execFileMock.mock.calls.map((c: string[][]) => c[1]?.join(' ') ?? '');
      expect(cmds.some((c: string) => c.includes('clone --bare'))).toBe(false);
    });

    it('injects PAT into clone URL but resets origin to clean URL', async () => {
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('rev-parse --git-dir')) {
            cb(new Error('no repo'));
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      await manager.create({
        repoUrl: 'https://github.com/org/repo.git',
        branch: 'feat/secret',
        baseBranch: 'main',
        pat: 'super-secret-token',
      });

      const cmds = execFileMock.mock.calls.map((c: string[][]) => c[1]?.join(' ') ?? '');

      const cloneCmd = cmds.find((c: string) => c.includes('clone --bare'));
      expect(cloneCmd).toBeDefined();
      expect(cloneCmd).toContain('super-secret-token');

      const setUrlCmd = cmds.find((c: string) => c.includes('remote set-url'));
      expect(setUrlCmd).toBeDefined();
      expect(setUrlCmd).not.toContain('super-secret-token');
    });

    it('falls back to local baseBranch ref when remote fetch fails (fork scenario)', async () => {
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('rev-parse --git-dir')) {
            cb(null, { stdout: '.', stderr: '' }); // bare repo exists
          } else if (cmd.includes('fetch')) {
            // All remote fetches fail — neither parent nor fork branch pushed
            cb(new Error('fatal: couldn\'t find remote ref'));
          } else if (cmd.includes('rev-parse --verify refs/heads/autopod/parent-branch')) {
            // But it exists locally in the bare repo
            cb(null, { stdout: 'abc1234\n', stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      const result = await manager.create({
        repoUrl: 'https://github.com/org/repo.git',
        branch: 'autopod/forked-session',
        baseBranch: 'autopod/parent-branch',
      });

      const cmds = execFileMock.mock.calls.map((c: string[][]) => c[1]?.join(' ') ?? '');
      const worktreeAddCmd = cmds.find((c: string) => c.includes('worktree add'));
      expect(worktreeAddCmd).toBeDefined();
      // Should use the local ref, not refs/remotes/origin/...
      expect(worktreeAddCmd).toContain('refs/heads/autopod/parent-branch');
      expect(result.worktreePath).toContain('autopod_forked-session');
    });

    it('throws when baseBranch not found on remote or locally', async () => {
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('rev-parse --git-dir')) {
            cb(null, { stdout: '.', stderr: '' });
          } else if (cmd.includes('fetch') && cmd.includes('gone-branch')) {
            cb(new Error('fatal: couldn\'t find remote ref'));
          } else if (cmd.includes('rev-parse --verify refs/heads/gone-branch')) {
            cb(new Error('fatal: Needed a single revision'));
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      await expect(
        manager.create({
          repoUrl: 'https://github.com/org/repo.git',
          branch: 'autopod/new-session',
          baseBranch: 'gone-branch',
        }),
      ).rejects.toThrow('baseBranch "gone-branch" not found on remote or locally');
    });

    it('stores PAT in cache for later push operations', async () => {
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('rev-parse --git-dir')) {
            cb(new Error('no repo'));
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      await manager.create({
        repoUrl: 'https://github.com/org/repo.git',
        branch: 'feat/pat-cache',
        baseBranch: 'main',
        pat: 'cached-pat',
      });

      const patCache = (manager as unknown as { patCache: Map<string, string> }).patCache as Map<
        string,
        string
      >;
      expect([...patCache.values()]).toContain('cached-pat');
    });
  });
});
