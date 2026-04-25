import type { ChildProcess } from 'node:child_process';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeletionGuardError,
  LocalWorktreeManager,
  truncateDiffAtFileBoundary,
} from './local-worktree-manager.js';

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
      expect(result).toBe('https://x-access-token:mytoken@github.com/org/repo.git');
    });

    it('replaces existing userinfo before injecting', () => {
      const result = (
        manager as unknown as { injectPat: (url: string, pat: string) => string }
      ).injectPat('https://old-token@github.com/org/repo.git', 'new-token');
      expect(result).toBe('https://x-access-token:new-token@github.com/org/repo.git');
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
    it('returns committed diff stats when baseBranch is provided and working tree is clean', async () => {
      let callCount = 0;
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('merge-base')) {
            cb(null, { stdout: 'abc1234\n', stderr: '' });
          } else if (cmd.includes('diff --stat')) {
            callCount++;
            // First call: committed diff (merge-base..HEAD)
            // Second call: uncommitted diff (HEAD)
            if (callCount === 1) {
              cb(null, {
                stdout: ' 3 files changed, 15 insertions(+), 5 deletions(-)',
                stderr: '',
              });
            } else {
              cb(null, { stdout: '', stderr: '' });
            }
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      const result = await manager.getDiffStats('/tmp/worktree/sess', 'main');
      expect(result).toEqual({ filesChanged: 3, linesAdded: 15, linesRemoved: 5 });
    });

    it('combines committed and uncommitted changes when both exist', async () => {
      let callCount = 0;
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('merge-base')) {
            cb(null, { stdout: 'abc1234\n', stderr: '' });
          } else if (cmd.includes('diff --stat')) {
            callCount++;
            if (callCount === 1) {
              // Committed: 2 files
              cb(null, {
                stdout: ' 2 files changed, 10 insertions(+), 3 deletions(-)',
                stderr: '',
              });
            } else {
              // Uncommitted: 1 more file
              cb(null, { stdout: ' 1 file changed, 5 insertions(+), 2 deletions(-)', stderr: '' });
            }
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

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

    it('truncates diff at file boundaries when too long', async () => {
      // Two file hunks — first fits in 60 chars, second should be omitted
      const hunk1 = 'diff --git a/small.ts b/small.ts\n+small change\n';
      const hunk2 = `diff --git a/big.ts b/big.ts\n+${'x'.repeat(200)}\n`;
      setupExecFileMock({
        'merge-base': { stdout: 'abc1234\n' },
        'diff abc1234': { stdout: hunk1 + hunk2 },
      });

      const result = await manager.getDiff('/tmp/worktree/sess', 'main', 60);
      expect(result).toContain(hunk1);
      expect(result).toContain('⚠ DIFF TRUNCATED');
      expect(result).toContain('big.ts');
      expect(result).not.toContain('x'.repeat(200));
    });

    it('combines committed and uncommitted diffs', async () => {
      const committedDiff = 'diff --git a/foo.ts b/foo.ts\n+committed\n';
      const uncommittedDiff = 'diff --git a/bar.ts b/bar.ts\n+uncommitted\n';
      let diffCallCount = 0;
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('merge-base')) {
            cb(null, { stdout: 'abc1234\n', stderr: '' });
          } else if (cmd.includes('diff')) {
            diffCallCount++;
            if (diffCallCount === 1) {
              cb(null, { stdout: committedDiff, stderr: '' });
            } else {
              cb(null, { stdout: uncommittedDiff, stderr: '' });
            }
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      const result = await manager.getDiff('/tmp/worktree/sess', 'main');
      expect(result).toBe(`${committedDiff}\n${uncommittedDiff}`);
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

    it('passes exclude pathspecs to git diff', async () => {
      const capturedArgs: string[][] = [];
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          capturedArgs.push([...args]);
          if (args.join(' ').includes('merge-base')) {
            cb(null, { stdout: 'abc1234\n', stderr: '' });
          } else {
            cb(null, { stdout: 'diff --git a/foo.ts b/foo.ts\n+line\n', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      await manager.getDiff('/tmp/worktree/sess', 'main');

      const diffCalls = capturedArgs.filter((a) => a[0] === 'diff');
      expect(diffCalls.length).toBeGreaterThan(0);
      for (const args of diffCalls) {
        expect(args).toContain(':(exclude)pnpm-lock.yaml');
        expect(args).toContain(':(exclude)go.sum');
        expect(args).toContain(':(exclude)*.min.js');
      }
    });
  });

  // -------------------------------------------------------------------------
  // commitPendingChanges
  // -------------------------------------------------------------------------

  describe('commitPendingChanges', () => {
    /** Mock that simulates staged changes with a given number of deleted files. */
    function mockWithDeletions(deletionCount: number) {
      const deletedFiles = Array.from({ length: deletionCount }, (_, i) => `src/file${i}.ts`);
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('diff --cached --quiet')) {
            cb(new Error('changes exist'), { stdout: '', stderr: '' });
          } else if (cmd.includes('diff --cached --diff-filter=D --name-only')) {
            cb(null, { stdout: deletedFiles.join('\n'), stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );
    }

    it('commits when there are staged changes with no deletions', async () => {
      mockWithDeletions(0);

      const result = await manager.commitPendingChanges('/tmp/worktree/sess', 'test commit');
      expect(result).toBe(true);
      // git add -A, diff --cached --quiet, diff --cached --diff-filter=D, commit
      expect(execFileMock).toHaveBeenCalledTimes(4);
    });

    it('returns false when working tree is clean', async () => {
      setupExecFileMock({}); // All commands succeed (including diff --cached --quiet)

      const result = await manager.commitPendingChanges('/tmp/worktree/sess', 'test commit');
      expect(result).toBe(false);
      // Only git add -A and diff --cached --quiet (no commit, no deletion check)
      expect(execFileMock).toHaveBeenCalledTimes(2);
    });

    it('allows deletions under the default threshold', async () => {
      mockWithDeletions(5);

      const result = await manager.commitPendingChanges('/tmp/worktree/sess', 'test commit');
      expect(result).toBe(true);
    });

    it('aborts when deletions exceed the default threshold', async () => {
      mockWithDeletions(150);

      await expect(
        manager.commitPendingChanges('/tmp/worktree/sess', 'test commit'),
      ).rejects.toThrow('150 files staged for deletion exceeds threshold of 100');

      // Verify git reset HEAD was called to unstage
      const resetCall = execFileMock.mock.calls.find(
        (call: unknown[]) => Array.isArray(call[1]) && (call[1] as string[]).includes('reset'),
      );
      expect(resetCall).toBeDefined();
    });

    it('respects custom maxDeletions option', async () => {
      mockWithDeletions(11);

      await expect(
        manager.commitPendingChanges('/tmp/worktree/sess', 'test commit', { maxDeletions: 10 }),
      ).rejects.toThrow('11 files staged for deletion exceeds threshold of 10');
    });

    it('blocks any deletion when maxDeletions is 0', async () => {
      mockWithDeletions(1);

      await expect(
        manager.commitPendingChanges('/tmp/worktree/sess', 'test commit', { maxDeletions: 0 }),
      ).rejects.toThrow('1 files staged for deletion exceeds threshold of 0');
    });

    it('allows exactly maxDeletions files', async () => {
      mockWithDeletions(100);

      const result = await manager.commitPendingChanges('/tmp/worktree/sess', 'test commit');
      expect(result).toBe(true);
    });

    it('throws a typed DeletionGuardError with count + threshold', async () => {
      mockWithDeletions(7);

      try {
        await manager.commitPendingChanges('/tmp/worktree/sess', 'test', { maxDeletions: 3 });
        expect.fail('commitPendingChanges should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(DeletionGuardError);
        const guard = err as DeletionGuardError;
        expect(guard.deletionCount).toBe(7);
        expect(guard.threshold).toBe(3);
      }
    });
  });

  // -------------------------------------------------------------------------
  // mergeBranch — guard propagation
  // -------------------------------------------------------------------------

  describe('mergeBranch deletion guard', () => {
    /**
     * Mock git state for mergeBranch:
     * - rev-parse reports HEAD short sha (so the "no commits" early-exit doesn't trigger)
     * - `diff --cached --quiet` exits non-zero (changes staged)
     * - `diff --cached --diff-filter=D --name-only` lists N deleted files
     */
    function mockMergeWithDeletions(deletionCount: number) {
      const deletedFiles = Array.from({ length: deletionCount }, (_, i) => `src/f${i}.ts`);
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('diff --cached --quiet')) {
            cb(new Error('changes exist'), { stdout: '', stderr: '' });
          } else if (cmd.includes('diff --cached --diff-filter=D --name-only')) {
            cb(null, { stdout: deletedFiles.join('\n'), stderr: '' });
          } else if (cmd.startsWith('rev-parse')) {
            cb(null, { stdout: 'abc1234', stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );
    }

    it('passes maxDeletions: 0 through to the internal auto-commit', async () => {
      mockMergeWithDeletions(1);

      await expect(
        manager.mergeBranch({
          worktreePath: '/tmp/worktree/sess',
          targetBranch: 'feat/x',
          maxDeletions: 0,
        }),
      ).rejects.toBeInstanceOf(DeletionGuardError);
    });

    it('uses default threshold 100 when maxDeletions is omitted', async () => {
      mockMergeWithDeletions(150);

      await expect(
        manager.mergeBranch({
          worktreePath: '/tmp/worktree/sess',
          targetBranch: 'feat/x',
        }),
      ).rejects.toThrow('150 files staged for deletion exceeds threshold of 100');
    });

    it('allows deletions under a custom threshold', async () => {
      mockMergeWithDeletions(40);

      // Won't throw the guard; may fail later (push, etc.) — we only assert the guard passes.
      try {
        await manager.mergeBranch({
          worktreePath: '/tmp/worktree/sess',
          targetBranch: 'feat/x',
          maxDeletions: 100,
        });
      } catch (err) {
        expect(err).not.toBeInstanceOf(DeletionGuardError);
      }
    });
  });

  // -------------------------------------------------------------------------
  // pushBranch — explicit refspec + branch guard (fix 1.3)
  // -------------------------------------------------------------------------

  describe('pushBranch', () => {
    it('rejects when HEAD is on a different branch than expectedBranch', async () => {
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
            cb(null, { stdout: 'main\n', stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      await expect(manager.pushBranch('/tmp/worktree/sess', 'feat/security')).rejects.toThrow(
        "Expected HEAD to be on branch 'feat/security' but it is on 'main'",
      );
    });

    it('pushes with explicit HEAD:refs/heads/<branch> refspec when branch matches', async () => {
      const pushedArgs: string[][] = [];
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
            cb(null, { stdout: 'feat/security\n', stderr: '' });
          } else if (cmd.includes('rev-parse --git-common-dir')) {
            cb(null, { stdout: '.git\n', stderr: '' });
          } else if (cmd.includes('config --get remote.origin.url')) {
            cb(null, { stdout: 'https://github.com/org/repo.git\n', stderr: '' });
          } else {
            pushedArgs.push(args);
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      await manager.pushBranch('/tmp/worktree/sess', 'feat/security');

      const pushCall = pushedArgs.find((a) => a.includes('push'));
      expect(pushCall).toBeDefined();
      expect(pushCall).toContain('HEAD:refs/heads/feat/security');
    });
  });

  // -------------------------------------------------------------------------
  // mergeBranch — explicit refspec + branch guard (fix 1.3)
  // -------------------------------------------------------------------------

  describe('mergeBranch explicit refspec', () => {
    it('rejects when HEAD is on a different branch than targetBranch', async () => {
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('diff --cached --quiet')) {
            // nothing staged → early exit from commitPendingChanges, falls through to push
            cb(null, { stdout: '', stderr: '' });
          } else if (cmd.includes('rev-parse HEAD')) {
            cb(null, { stdout: 'abc1234\n', stderr: '' });
          } else if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
            cb(null, { stdout: 'main\n', stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      await expect(
        manager.mergeBranch({ worktreePath: '/tmp/worktree/sess', targetBranch: 'feat/security' }),
      ).rejects.toThrow("Expected HEAD to be on branch 'feat/security' but it is on 'main'");
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
            cb(new Error("fatal: couldn't find remote ref"));
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
        branch: 'autopod/forked-pod',
        baseBranch: 'autopod/parent-branch',
      });

      const cmds = execFileMock.mock.calls.map((c: string[][]) => c[1]?.join(' ') ?? '');
      const worktreeAddCmd = cmds.find((c: string) => c.includes('worktree add'));
      expect(worktreeAddCmd).toBeDefined();
      // Should use the local ref, not refs/remotes/origin/...
      expect(worktreeAddCmd).toContain('refs/heads/autopod/parent-branch');
      expect(result.worktreePath).toContain('autopod_forked-pod');
    });

    it('throws when baseBranch not found on remote or locally', async () => {
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('rev-parse --git-dir')) {
            cb(null, { stdout: '.', stderr: '' });
          } else if (cmd.includes('fetch') && cmd.includes('gone-branch')) {
            cb(new Error("fatal: couldn't find remote ref"));
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
          branch: 'autopod/new-pod',
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

describe('truncateDiffAtFileBoundary', () => {
  const h1 = 'diff --git a/a.ts b/a.ts\n+line\n';
  const h2 = `diff --git a/b.ts b/b.ts\n+${'x'.repeat(200)}\n`;
  const h3 = 'diff --git a/c.ts b/c.ts\n+other\n';

  it('returns diff unchanged when under limit', () => {
    const diff = h1 + h3;
    expect(truncateDiffAtFileBoundary(diff, 10_000)).toBe(diff);
  });

  it('includes complete files up to the limit', () => {
    const diff = h1 + h2 + h3;
    const result = truncateDiffAtFileBoundary(diff, h1.length + 50);
    expect(result).toContain(h1);
    expect(result).not.toContain('x'.repeat(200));
    expect(result).toContain('⚠ DIFF TRUNCATED');
    expect(result).toContain('b.ts');
    expect(result).toContain('c.ts');
  });

  it('lists all omitted file names', () => {
    const diff = h1 + h2 + h3;
    const result = truncateDiffAtFileBoundary(diff, h1.length + 5);
    expect(result).toContain('2 files omitted');
    expect(result).toContain('b.ts');
    expect(result).toContain('c.ts');
  });

  it('instructs reviewer to use read_file tools', () => {
    const result = truncateDiffAtFileBoundary(h1 + h2, h1.length + 5);
    expect(result).toContain('read_file');
  });
});
