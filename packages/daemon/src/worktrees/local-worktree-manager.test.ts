import type { ChildProcess } from 'node:child_process';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonGitHubAuth } from '../github/daemon-github-auth.js';
import {
  DeletionGuardError,
  GitCredentialError,
  LocalWorktreeManager,
  classifyGitError,
  truncateDiffAtFileBoundary,
} from './local-worktree-manager.js';

const logger = pino({ level: 'silent' });

function fakeGitHubAuth(token = 'daemon-gh-token'): DaemonGitHubAuth {
  return {
    async resolveCredential() {
      return { token, username: 'x-access-token' };
    },
    async getStatus() {
      return { available: true, login: 'autopod-dev', setup: 'setup gh auth' };
    },
  };
}

// ---------------------------------------------------------------------------
// Hoist mock fns so they're available inside vi.mock factories
// ---------------------------------------------------------------------------

const { execFileMock, fsMkdirMock, fsRmMock, fsReadFileMock, fsWriteFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  fsMkdirMock: vi.fn().mockResolvedValue(undefined),
  fsRmMock: vi.fn().mockResolvedValue(undefined),
  fsReadFileMock: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  fsWriteFileMock: vi.fn().mockResolvedValue(undefined),
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
      readFile: fsReadFileMock,
      writeFile: fsWriteFileMock,
    },
    mkdir: fsMkdirMock,
    rm: fsRmMock,
    access: vi.fn().mockResolvedValue(undefined),
    readFile: fsReadFileMock,
    writeFile: fsWriteFileMock,
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
    fsReadFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    fsWriteFileMock.mockResolvedValue(undefined);
    manager = new LocalWorktreeManager({
      cacheDir,
      worktreeDir,
      logger,
      githubAuth: fakeGitHubAuth(),
    });
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

    it('ignores mode-only chmod sections when stat reports +0/-0 files', async () => {
      const modeOnlyDiff = [
        'diff --git a/.githooks/commit-msg b/.githooks/commit-msg',
        'old mode 100755',
        'new mode 100644',
        'diff --git a/.githooks/pre-commit b/.githooks/pre-commit',
        'old mode 100755',
        'new mode 100644',
        '',
      ].join('\n');

      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('merge-base')) {
            cb(null, { stdout: 'abc1234\n', stderr: '' });
          } else if (cmd.includes('diff --stat abc1234 HEAD')) {
            cb(null, {
              stdout:
                ' .githooks/commit-msg | 0\n .githooks/pre-commit | 0\n 2 files changed, 0 insertions(+), 0 deletions(-)',
              stderr: '',
            });
          } else if (cmd.includes('diff --no-color abc1234 HEAD')) {
            cb(null, { stdout: modeOnlyDiff, stderr: '' });
          } else if (cmd.includes('diff --stat HEAD')) {
            cb(null, { stdout: '', stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      const result = await manager.getDiffStats('/tmp/worktree/sess', 'main');
      expect(result).toEqual({ filesChanged: 0, linesAdded: 0, linesRemoved: 0 });
    });

    it('passes exclude pathspecs to stat diffs', async () => {
      const capturedArgs: string[][] = [];
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          capturedArgs.push([...args]);
          if (args.join(' ').includes('merge-base')) {
            cb(null, { stdout: 'abc1234\n', stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      await manager.getDiffStats('/tmp/worktree/sess', 'main');

      const statDiffs = capturedArgs.filter((a) => a[0] === 'diff' && a.includes('--stat'));
      expect(statDiffs).toHaveLength(2);
      for (const args of statDiffs) {
        expect(args).toContain(':(exclude).serena');
        expect(args).toContain(':(exclude).serena/**');
        expect(args).toContain(':(exclude).roslyn-codelens');
        expect(args).toContain(':(exclude).roslyn-codelens/**');
      }
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
  // hasChangesAgainstBase
  // -------------------------------------------------------------------------

  describe('hasChangesAgainstBase', () => {
    it('returns false when the worktree matches its base', async () => {
      setupExecFileMock({
        'merge-base HEAD main': { stdout: 'abc1234\n' },
        'diff --quiet abc1234': { stdout: '' },
      });

      const result = await manager.hasChangesAgainstBase('/tmp/worktree/sess', 'main');

      expect(result).toBe(false);
    });

    it('returns true when git diff reports changes', async () => {
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('merge-base HEAD main')) {
            cb(null, { stdout: 'abc1234\n', stderr: '' });
          } else if (cmd.includes('diff --quiet abc1234')) {
            cb(Object.assign(new Error('diff found changes'), { code: 1 }), {
              stdout: '',
              stderr: '',
            });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      const result = await manager.hasChangesAgainstBase('/tmp/worktree/sess', 'main');

      expect(result).toBe(true);
    });

    it('throws when the base cannot be resolved', async () => {
      execFileMock.mockImplementation(
        (_file: string, _args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          cb(new Error('missing ref'), { stdout: '', stderr: '' });
          return {} as ChildProcess;
        },
      );

      await expect(manager.hasChangesAgainstBase('/tmp/worktree/sess', 'main')).rejects.toThrow(
        "Could not resolve merge-base for 'main'",
      );
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

    it('uses a single working-tree-vs-base diff so committed and uncommitted changes fold into one net delta', async () => {
      // Regression: the previous implementation ran `git diff base HEAD` and
      // `git diff HEAD` separately and concatenated the output. When the same
      // file was touched by both a commit and the working tree (e.g. agent
      // committed an addition then `rm`'d it without committing the deletion),
      // the diff text contained two file sections — added + deleted — and AI
      // reviewers latched onto the first hunk and flagged scope creep even
      // when the net delta was zero.
      const netDiff =
        'diff --git a/foo.ts b/foo.ts\n+committed\n' +
        'diff --git a/bar.ts b/bar.ts\n+uncommitted\n';
      const diffCallArgs: string[][] = [];
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('merge-base')) {
            cb(null, { stdout: 'abc1234\n', stderr: '' });
          } else if (args[0] === 'diff') {
            diffCallArgs.push([...args]);
            cb(null, { stdout: netDiff, stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      const result = await manager.getDiff('/tmp/worktree/sess', 'main');
      expect(result).toBe(netDiff);
      // Exactly one diff invocation, single-arg form (working tree vs base).
      expect(diffCallArgs).toHaveLength(1);
      // The diff command must NOT pass HEAD as a second positional ref —
      // that's the two-arg form that produces the double-counted output.
      const positional = diffCallArgs[0]?.filter((a) => !a.startsWith(':(exclude)')) ?? [];
      expect(positional).toEqual(['diff', 'abc1234']);
    });

    it('cancels file added in commit and removed in working tree (the AADGroups regression)', async () => {
      // End-to-end shape of the screenshot-#4 bug. The workspace handoff
      // committed `AADGroups.cs` (the warm-image leak), then the agent rm'd
      // the file in the working tree without committing the deletion. The
      // single-arg `git diff <base>` collapses this to an empty net delta —
      // exactly what `git diff main..HEAD` would show after the deletion
      // commit lands.
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('merge-base')) {
            cb(null, { stdout: 'base-sha\n', stderr: '' });
          } else if (args[0] === 'diff') {
            // Working-tree-vs-base sees no AADGroups.cs in either tree — the
            // file was added then removed within the [base, working tree] range
            // and git folds those into nothing.
            cb(null, { stdout: '', stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      const result = await manager.getDiff('/tmp/worktree/sess', 'main', undefined, 'base-sha');
      expect(result).toBe('');
      expect(result).not.toContain('AADGroups');
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
        expect(args).toContain(':(exclude).serena');
        expect(args).toContain(':(exclude).serena/**');
        expect(args).toContain(':(exclude).roslyn-codelens');
        expect(args).toContain(':(exclude).roslyn-codelens/**');
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
      // git add -A, diff --cached --quiet, mode-only scan, deletion guard, commit
      expect(execFileMock).toHaveBeenCalledTimes(5);
    });

    it('returns false when working tree is clean', async () => {
      setupExecFileMock({}); // All commands succeed (including diff --cached --quiet)

      const result = await manager.commitPendingChanges('/tmp/worktree/sess', 'test commit');
      expect(result).toBe(false);
      // Only git add -A and diff --cached --quiet (no commit, no deletion check)
      expect(execFileMock).toHaveBeenCalledTimes(2);
    });

    it('discards mode-only staged changes and skips the auto-commit when nothing remains', async () => {
      const modeOnlyDiff = [
        'diff --git a/.githooks/pre-commit b/.githooks/pre-commit',
        'old mode 100755',
        'new mode 100644',
        '',
      ].join('\n');
      let restoredModeOnlyPath = false;
      const calls: string[][] = [];

      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          calls.push([...args]);
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('diff --cached --quiet')) {
            if (restoredModeOnlyPath) {
              cb(null, { stdout: '', stderr: '' });
            } else {
              cb(new Error('changes exist'), { stdout: '', stderr: '' });
            }
          } else if (cmd.includes('diff --cached --no-color')) {
            cb(null, { stdout: modeOnlyDiff, stderr: '' });
          } else if (args[0] === 'checkout') {
            restoredModeOnlyPath = true;
            cb(null, { stdout: '', stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      const result = await manager.commitPendingChanges('/tmp/worktree/sess', 'test commit');

      expect(result).toBe(false);
      expect(calls).toContainEqual(['checkout', 'HEAD', '--', '.githooks/pre-commit']);
      expect(calls.some((args) => args[0] === 'commit')).toBe(false);
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
  // stageAllChanges — excludePaths interaction with .gitignore
  //
  // Regression: `git add -A -- . :(exclude)X` exits 1 with "paths are ignored"
  // when X is in .gitignore (git treats the explicit pathspec mention as a
  // user request to add the ignored path). We pre-filter via `check-ignore`
  // and drop excludes that gitignore already covers.
  // -------------------------------------------------------------------------

  describe('stageAllChanges excludePaths filtering', () => {
    /**
     * Capture the args passed to `git add -A`, simulating a configurable
     * check-ignore response per path. Returns the captured add args (or null
     * if `git add` wasn't called) so the test can assert which excludes
     * survived filtering.
     */
    function setupAddCapture(ignoredPaths: ReadonlySet<string>) {
      let addArgs: string[] | null = null;
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          if (args[0] === 'check-ignore') {
            // -q on, last arg is the path
            const p = args[args.length - 1];
            if (ignoredPaths.has(p)) {
              cb(null, { stdout: '', stderr: '' });
            } else {
              cb(Object.assign(new Error('not ignored'), { code: 1 }), {
                stdout: '',
                stderr: '',
              });
            }
          } else if (args[0] === 'add') {
            addArgs = args;
            cb(null, { stdout: '', stderr: '' });
          } else if (args.join(' ').includes('diff --cached --quiet')) {
            // Pretend nothing was staged so commitPendingChanges short-circuits.
            cb(null, { stdout: '', stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );
      return () => addArgs;
    }

    it('drops exclude paths that gitignore already covers', async () => {
      const getAddArgs = setupAddCapture(new Set(['.serena']));

      await manager.commitPendingChanges('/tmp/wt', 'msg', {
        excludePaths: ['.serena', '.roslyn-codelens'],
      });

      const addArgs = getAddArgs();
      expect(addArgs).not.toBeNull();
      expect(addArgs).not.toContain(':(exclude).serena');
      expect(addArgs).toContain(':(exclude).roslyn-codelens');
    });

    it('omits the pathspec block entirely when every exclude is gitignored', async () => {
      const getAddArgs = setupAddCapture(new Set(['.serena', '.roslyn-codelens']));

      await manager.commitPendingChanges('/tmp/wt', 'msg', {
        excludePaths: ['.serena', '.roslyn-codelens'],
      });

      const addArgs = getAddArgs();
      expect(addArgs).toEqual(['add', '-A']);
    });

    it('keeps every exclude when none are gitignored', async () => {
      const getAddArgs = setupAddCapture(new Set());

      await manager.commitPendingChanges('/tmp/wt', 'msg', {
        excludePaths: ['.serena', '.roslyn-codelens'],
      });

      const addArgs = getAddArgs();
      expect(addArgs).toContain(':(exclude).serena');
      expect(addArgs).toContain(':(exclude).roslyn-codelens');
      expect(addArgs).toContain('.');
    });
  });

  // -------------------------------------------------------------------------
  // mergeBranch — guard propagation
  // -------------------------------------------------------------------------

  describe('restoreFromHead', () => {
    /**
     * Mock `git status --porcelain=v1 -z` with the supplied porcelain records.
     * Each record is a literal `XY path` string (no NUL — we add the
     * separator). All other git commands return success with empty output, so
     * tests can assert what `restoreFromHead` does with the status output
     * without wiring up every command individually.
     */
    function mockStatusPorcelain(records: string[]) {
      const stdout = records.map((r) => `${r}\0`).join('');
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('status --porcelain=v1 -z')) {
            cb(null, { stdout, stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );
    }

    it('restores the working tree when every change is an unstaged deletion', async () => {
      mockStatusPorcelain([' D README.md', ' D src/index.ts', ' D docs/decisions/ADR-001-foo.md']);

      const result = await manager.restoreFromHead('/tmp/worktree/sess');

      expect(result.restored).toBe(true);
      expect(result.restoredCount).toBe(3);
      expect(result.reason).toContain('3 deleted files');

      // The actual restore: `git checkout -- .` must have been issued.
      const calls = execFileMock.mock.calls.map((c) => (c[1] as string[]).join(' '));
      expect(calls).toContain('checkout -- .');
    });

    it('refuses when any modified files are present', async () => {
      mockStatusPorcelain([' M src/touched.ts', ' D src/deleted.ts']);

      const result = await manager.restoreFromHead('/tmp/worktree/sess');

      expect(result.restored).toBe(false);
      expect(result.restoredCount).toBe(0);
      expect(result.reason).toMatch(/Refusing to restore/);
      expect(result.blockers).toEqual([{ status: 'M', path: 'src/touched.ts' }]);

      // Critical: must NOT have run checkout — that would silently lose the modification.
      const calls = execFileMock.mock.calls.map((c) => (c[1] as string[]).join(' '));
      expect(calls).not.toContain('checkout -- .');
    });

    it('refuses when staged changes are present', async () => {
      mockStatusPorcelain(['M  src/staged.ts']);

      const result = await manager.restoreFromHead('/tmp/worktree/sess');

      expect(result.restored).toBe(false);
      expect(result.reason).toMatch(/Refusing to restore/);
      expect(result.blockers).toEqual([{ status: 'M', path: 'src/staged.ts' }]);
    });

    it('explicit recovery refreshes a stale index and restores tracked modifications', async () => {
      mockStatusSequence(
        ['D  .changes/fix.md', ' M Client/sheet-js-fix/bin/xlsx.njs', ' D src/deleted.ts'],
        [' M Client/sheet-js-fix/bin/xlsx.njs', ' D src/deleted.ts'],
      );

      const result = await manager.restoreFromHead('/tmp/worktree/sess', {
        allowTrackedModifications: true,
      });

      expect(result.restored).toBe(true);
      expect(result.restoredCount).toBe(2);
      expect(result.reason).toContain('2 tracked files');

      const calls = execFileMock.mock.calls.map((c) => (c[1] as string[]).join(' '));
      expect(calls).toContain('reset --mixed HEAD');
      expect(calls).toContain('checkout -- .');
    });

    it('refuses when untracked files are present', async () => {
      mockStatusPorcelain(['?? new-file.txt', ' D src/deleted.ts']);

      const result = await manager.restoreFromHead('/tmp/worktree/sess');

      expect(result.restored).toBe(false);
      expect(result.reason).toMatch(/Refusing to restore/);
      expect(result.blockers).toEqual([{ status: '??', path: 'new-file.txt' }]);
    });

    it('treats a clean working tree as restored (nothing to do, no compromise)', async () => {
      mockStatusPorcelain([]);

      const result = await manager.restoreFromHead('/tmp/worktree/sess');

      // Clean tree = matches HEAD = caller can safely clear worktreeCompromised.
      // Returning false here would trap users who manually fixed the dirty state.
      expect(result.restored).toBe(true);
      expect(result.restoredCount).toBe(0);
      expect(result.reason).toMatch(/matches HEAD/i);
    });

    it('handles a single-file deletion correctly (singular phrasing)', async () => {
      mockStatusPorcelain([' D only-one.ts']);

      const result = await manager.restoreFromHead('/tmp/worktree/sess');

      expect(result.restored).toBe(true);
      expect(result.restoredCount).toBe(1);
      expect(result.reason).toContain('1 deleted file from HEAD');
    });

    /**
     * Mock `git status --porcelain=v1 -z` so the first invocation returns
     * `firstRecords`, every subsequent invocation returns `restRecords`.
     * Used to exercise the .gitignore pre-restore path: the worktree state
     * changes between the first status pass and the second one.
     */
    function mockStatusSequence(firstRecords: string[], restRecords: string[]) {
      const firstStdout = firstRecords.map((r) => `${r}\0`).join('');
      const restStdout = restRecords.map((r) => `${r}\0`).join('');
      let statusCalls = 0;
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('status --porcelain=v1 -z')) {
            const stdout = statusCalls === 0 ? firstStdout : restStdout;
            statusCalls += 1;
            cb(null, { stdout, stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );
    }

    it('pre-restores deleted .gitignore files so wiped ignore rules do not poison the blocker check', async () => {
      // Simulates the laptop-sleep-killed-sync-back failure mode: the working
      // tree was wiped, including .gitignore, so previously-ignored build
      // artifacts (Client/.env, node_modules, obj/, bin/) flip from "ignored"
      // to "??" and look like real new untracked work.
      mockStatusSequence(
        [
          ' D .gitignore',
          ' D src/index.ts',
          ' D README.md',
          '?? Client/.env',
          '?? Client/node_modules/',
          '?? Domain/bin/',
          '?? Domain/obj/',
        ],
        // After .gitignore is restored from the index, the previously-poisoned
        // ?? entries become ignored and drop out — only the real deletions remain.
        [' D src/index.ts', ' D README.md'],
      );

      const result = await manager.restoreFromHead('/tmp/worktree/sess');

      expect(result.restored).toBe(true);
      // 2 deletions remain after the gitignore-targeted pre-restore.
      expect(result.restoredCount).toBe(2);

      const calls = execFileMock.mock.calls.map((c) => (c[1] as string[]).join(' '));
      // Pre-restore: .gitignore restored from index before the second status pass.
      expect(calls).toContain('checkout -- .gitignore');
      // Final restore: catches the remaining HEAD-tracked deletions.
      expect(calls).toContain('checkout -- .');
    });

    it('removes leftover Autopod sync staging dirs before deciding whether restore is safe', async () => {
      mockStatusSequence(
        [' D src/index.ts', '?? .autopod-sync-spatial-meerkat-1234/'],
        [' D src/index.ts'],
      );

      const result = await manager.restoreFromHead('/tmp/worktree/sess');

      expect(result.restored).toBe(true);
      expect(result.restoredCount).toBe(1);
      expect(fsRmMock).toHaveBeenCalledWith(
        '/tmp/worktree/sess/.autopod-sync-spatial-meerkat-1234',
        {
          recursive: true,
          force: true,
        },
      );

      const calls = execFileMock.mock.calls.map((c) => (c[1] as string[]).join(' '));
      expect(calls).toContain('checkout -- .');
    });

    it('returns success without the final checkout when restoring .gitignore alone leaves a clean tree', async () => {
      // Edge case: the only deletion HEAD-tracked was .gitignore, and every
      // other dirty entry was a previously-ignored artifact unmasked by it.
      mockStatusSequence(
        [' D .gitignore', '?? node_modules/', '?? .env', '?? dist/'],
        [], // tree clean after gitignore returns
      );

      const result = await manager.restoreFromHead('/tmp/worktree/sess');

      expect(result.restored).toBe(true);
      expect(result.restoredCount).toBe(1);
      expect(result.reason).toMatch(/\.gitignore/);

      const calls = execFileMock.mock.calls.map((c) => (c[1] as string[]).join(' '));
      expect(calls).toContain('checkout -- .gitignore');
      // No remaining deletions, so the broad final checkout must NOT run.
      expect(calls).not.toContain('checkout -- .');
    });

    it('still refuses if blockers remain after the .gitignore pre-restore (real untracked work present)', async () => {
      // The agent genuinely created a new file that is not in .gitignore — even
      // after the ignore rules come back, it remains untracked and is real work.
      mockStatusSequence(
        [' D .gitignore', '?? legitimate-new-file.ts', '?? node_modules/'],
        [' D .gitignore', '?? legitimate-new-file.ts'],
      );

      const result = await manager.restoreFromHead('/tmp/worktree/sess');

      expect(result.restored).toBe(false);
      expect(result.reason).toMatch(/Refusing to restore/);
      expect(result.reason).toContain('legitimate-new-file.ts');
      // Sample reflects the post-pre-restore state, not the noisy original.
      expect(result.reason).not.toContain('node_modules');

      const calls = execFileMock.mock.calls.map((c) => (c[1] as string[]).join(' '));
      // Pre-restore was attempted; final broad checkout must NOT run on refusal.
      expect(calls).toContain('checkout -- .gitignore');
      expect(calls).not.toContain('checkout -- .');
    });

    it('skips the .gitignore pre-restore when there are no blockers to begin with', async () => {
      // `.gitignore` is among the deletions but nothing else is dirty — the
      // standard restore handles it. No need to do an extra checkout pass.
      mockStatusPorcelain([' D .gitignore', ' D src/index.ts']);

      const result = await manager.restoreFromHead('/tmp/worktree/sess');

      expect(result.restored).toBe(true);
      expect(result.restoredCount).toBe(2);

      const calls = execFileMock.mock.calls.map((c) => (c[1] as string[]).join(' '));
      // Targeted pre-restore must NOT fire — would be redundant work.
      expect(calls).not.toContain('checkout -- .gitignore');
      expect(calls).toContain('checkout -- .');
    });

    it('matches subdirectory .gitignore files, not just the repo-root one', async () => {
      mockStatusSequence(
        [' D packages/foo/.gitignore', '?? packages/foo/dist/'],
        [], // both fixed by restoring the nested .gitignore
      );

      const result = await manager.restoreFromHead('/tmp/worktree/sess');

      expect(result.restored).toBe(true);
      const calls = execFileMock.mock.calls.map((c) => (c[1] as string[]).join(' '));
      expect(calls).toContain('checkout -- packages/foo/.gitignore');
    });
  });

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
          } else if (cmd.includes('remote get-url origin')) {
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
      expect(pushCall).toEqual([
        'push',
        '--no-verify',
        'https://github.com/org/repo.git',
        'HEAD:refs/heads/feat/security',
      ]);
    });
  });

  describe('ensureRemoteBranch', () => {
    it('skips pushing when the branch already exists on origin', async () => {
      const calls: string[][] = [];
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          calls.push(args);
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('rev-parse --git-common-dir')) {
            cb(null, { stdout: '/tmp/test-cache/org_repo.git\n', stderr: '' });
          } else if (cmd.includes('remote get-url origin')) {
            cb(null, { stdout: 'https://dev.azure.com/org/project/_git/repo\n', stderr: '' });
          } else {
            cb(null, { stdout: 'abc123\trefs/heads/feature/base\n', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      const result = await manager.ensureRemoteBranch({
        worktreePath: '/tmp/worktree/sess',
        branch: 'feature/base',
        pat: 'ado-pat',
      });

      expect(result).toEqual({ branch: 'feature/base', created: false });
      expect(calls.some((args) => args[0] === 'push')).toBe(false);
    });

    it('pushes the local branch ref when origin is missing the branch', async () => {
      const calls: string[][] = [];
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          calls.push(args);
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('rev-parse --git-common-dir')) {
            cb(null, { stdout: '/tmp/test-cache/org_repo.git\n', stderr: '' });
          } else if (cmd.includes('remote get-url origin')) {
            cb(null, { stdout: 'https://dev.azure.com/org/project/_git/repo\n', stderr: '' });
          } else if (cmd.includes('ls-remote')) {
            cb(Object.assign(new Error('no matching refs'), { code: 2 }), {
              stdout: '',
              stderr: '',
            });
          } else if (cmd.includes('rev-parse --verify refs/heads/feature/base')) {
            cb(null, { stdout: 'abc123\n', stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      const result = await manager.ensureRemoteBranch({
        worktreePath: '/tmp/worktree/sess',
        branch: 'feature/base',
        sourceRef: 'refs/heads/feature/base',
        pat: 'ado-pat',
      });

      const pushCall = calls.find((args) => args[0] === 'push');
      expect(result).toEqual({ branch: 'feature/base', created: true });
      expect(pushCall).toEqual([
        'push',
        '--no-verify',
        'https://dev.azure.com/org/project/_git/repo',
        'refs/heads/feature/base:refs/heads/feature/base',
      ]);
    });
  });

  describe('pullBranch', () => {
    it('uses daemon GitHub auth instead of an explicit legacy profile PAT', async () => {
      manager = new LocalWorktreeManager({
        cacheDir,
        worktreeDir,
        logger,
        githubAuth: fakeGitHubAuth(),
      });
      const calls: string[][] = [];
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          calls.push(args);
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd === 'rev-parse HEAD') {
            cb(null, { stdout: 'abc123\n', stderr: '' });
          } else if (cmd.includes('rev-parse --git-common-dir')) {
            cb(null, { stdout: '/tmp/test-cache/org_repo.git\n', stderr: '' });
          } else if (cmd.includes('remote get-url origin')) {
            cb(null, { stdout: 'https://github.com/org/repo.git\n', stderr: '' });
          } else if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
            cb(null, { stdout: 'feat/security\n', stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      await manager.pullBranch('/tmp/worktree/sess', 'profile-pat');

      const fetchCall = calls.find((args) => args[0] === 'fetch');
      expect(fetchCall).toEqual(['fetch', 'https://github.com/org/repo.git', 'feat/security']);
    });
  });

  // -------------------------------------------------------------------------
  // mergeBranch — explicit refspec + branch guard (fix 1.3)
  // -------------------------------------------------------------------------

  describe('mergeBranch explicit refspec', () => {
    it('rejects missing daemon GitHub auth before committing pending changes', async () => {
      manager = new LocalWorktreeManager({ cacheDir, worktreeDir, logger });
      const calls: string[][] = [];
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          calls.push(args);
          const cb = resolveCallback(arg3, arg4);
          if (args.join(' ') === 'rev-parse --git-common-dir') {
            cb(null, { stdout: '/tmp/test-cache/org_repo.git\n', stderr: '' });
          } else if (args.join(' ') === 'remote get-url origin') {
            cb(null, { stdout: 'https://github.com/org/repo.git\n', stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      await expect(
        manager.mergeBranch({
          worktreePath: '/tmp/worktree/sess',
          targetBranch: 'feat/security',
          commitMessage: 'chore: should not be committed',
          pat: 'ignored-legacy-profile-pat',
        }),
      ).rejects.toThrow('sudo -u <daemon-user> gh auth login');

      expect(calls.map((args) => args[0])).toEqual(['rev-parse', 'remote']);
    });

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

    it('pushes with no-verify and explicit HEAD refspec when branch matches', async () => {
      const calls: string[][] = [];
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          calls.push(args);
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('diff --cached --quiet')) {
            cb(null, { stdout: '', stderr: '' });
          } else if (cmd.includes('rev-parse HEAD')) {
            cb(null, { stdout: 'abc1234\n', stderr: '' });
          } else if (cmd.includes('remote get-url origin')) {
            cb(null, { stdout: 'https://github.com/org/repo.git\n', stderr: '' });
          } else if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
            cb(null, { stdout: 'feat/security\n', stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      await manager.mergeBranch({
        worktreePath: '/tmp/worktree/sess',
        targetBranch: 'feat/security',
      });

      const pushCall = calls.find((args) => args[0] === 'push');
      expect(pushCall).toEqual([
        'push',
        '--no-verify',
        'https://github.com/org/repo.git',
        'HEAD:refs/heads/feat/security',
      ]);
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

  // Per-repo serialization is now provided by `KeyedPromiseQueue`; see
  // `src/util/keyed-promise-queue.test.ts` for the equivalent coverage.

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
    it('fails before any git or filesystem work when daemon GitHub auth is not configured', async () => {
      manager = new LocalWorktreeManager({ cacheDir, worktreeDir, logger });

      await expect(
        manager.create({
          repoUrl: 'https://github.com/org/repo.git',
          branch: 'feat/no-auth',
          baseBranch: 'main',
          pat: 'ignored-legacy-profile-pat',
        }),
      ).rejects.toThrow('sudo -u <daemon-user> gh auth login');

      expect(execFileMock).not.toHaveBeenCalled();
      expect(fsMkdirMock).not.toHaveBeenCalled();
      expect(fsRmMock).not.toHaveBeenCalled();
    });

    it('keeps concurrent ADO credentials scoped to their own git invocations', async () => {
      const authorizationHeaders: string[] = [];
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const options = arg3 as { env?: Record<string, string> };
          if (args[0] === 'clone' && options.env?.GIT_CONFIG_VALUE_2) {
            authorizationHeaders.push(options.env.GIT_CONFIG_VALUE_2);
          }
          const cb = resolveCallback(arg3, arg4);
          if (args.join(' ').includes('rev-parse --git-dir')) {
            cb(new Error('no repo'), { stdout: '', stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      await Promise.all([
        manager.create({
          repoUrl: 'https://dev.azure.com/org/project/_git/repo',
          branch: 'feat/one',
          baseBranch: 'main',
          pat: 'ado-token-one',
        }),
        manager.create({
          repoUrl: 'https://dev.azure.com/org/project/_git/repo',
          branch: 'feat/two',
          baseBranch: 'main',
          pat: 'ado-token-two',
        }),
      ]);

      const decodedCredentials = authorizationHeaders.map((header) =>
        Buffer.from(header.replace('Authorization: Basic ', ''), 'base64').toString('utf8'),
      );
      expect(decodedCredentials).toEqual([
        'x-access-token:ado-token-one',
        'x-access-token:ado-token-two',
      ]);
    });

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

    it('injects daemon GitHub credential into clone URL but resets origin to clean URL', async () => {
      manager = new LocalWorktreeManager({
        cacheDir,
        worktreeDir,
        logger,
        githubAuth: fakeGitHubAuth(),
      });
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
      expect(cloneCmd).not.toContain('daemon-gh-token');
      expect(cloneCmd).not.toContain('super-secret-token');
      const cloneCall = execFileMock.mock.calls.find((c: string[][]) => c[1]?.includes('clone'));
      expect(cloneCall?.[2]).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({
            GIT_CONFIG_KEY_2: 'http.https://github.com/.extraheader',
            GIT_CONFIG_VALUE_2: expect.stringMatching(/^Authorization: Basic /),
          }),
        }),
      );

      const setUrlCmd = cmds.find((c: string) => c.includes('remote set-url'));
      expect(setUrlCmd).toBeDefined();
      expect(setUrlCmd).not.toContain('super-secret-token');
      expect(setUrlCmd).not.toContain('daemon-gh-token');
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

    it('appends .mcp.json to per-worktree info/exclude after worktree add', async () => {
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('rev-parse --git-dir')) {
            cb(null, { stdout: '.', stderr: '' });
          } else if (cmd === 'rev-parse --git-path info/exclude') {
            cb(null, { stdout: '.git/worktrees/feat_excludes/info/exclude\n', stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      await manager.create({
        repoUrl: 'https://github.com/org/repo.git',
        branch: 'feat/excludes',
        baseBranch: 'main',
      });

      const writeCalls = fsWriteFileMock.mock.calls;
      const excludeWrite = writeCalls.find((c) =>
        String(c[0]).endsWith('worktrees/feat_excludes/info/exclude'),
      );
      expect(excludeWrite).toBeDefined();
      expect(String(excludeWrite?.[1])).toContain('.mcp.json');
      // The Pi handoff mirror is excluded from the host-side auto-commit here.
      expect(String(excludeWrite?.[1])).toContain('.autopod/pi-handoff.md');
    });

    it('does not duplicate excludes when info/exclude already lists them', async () => {
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('rev-parse --git-dir')) {
            cb(null, { stdout: '.', stderr: '' });
          } else if (cmd === 'rev-parse --git-path info/exclude') {
            cb(null, { stdout: '.git/info/exclude\n', stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );
      fsReadFileMock.mockResolvedValueOnce('# pre-existing\n.mcp.json\n.autopod/pi-handoff.md\n');

      await manager.create({
        repoUrl: 'https://github.com/org/repo.git',
        branch: 'feat/dedupe',
        baseBranch: 'main',
      });

      // Both already listed → no write needed
      expect(fsWriteFileMock).not.toHaveBeenCalled();
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

    it('throws when a distinct startBranch is unresolvable — no fallback to base/default', async () => {
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('rev-parse --git-dir')) {
            cb(null, { stdout: '.', stderr: '' });
          } else if (cmd.includes('fetch') && cmd.includes('pi/gone')) {
            cb(new Error("fatal: couldn't find remote ref"));
          } else if (cmd.includes('rev-parse --verify refs/heads/pi/gone')) {
            cb(new Error('fatal: Needed a single revision'));
          } else {
            // baseBranch (main) resolves fine — proving there is no silent
            // fallback to it (or the profile default) when startBranch is missing.
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      await expect(
        manager.create({
          repoUrl: 'https://github.com/org/repo.git',
          branch: 'autopod/new-pod',
          baseBranch: 'main',
          startBranch: 'pi/gone',
        }),
      ).rejects.toThrow('startBranch "pi/gone" not found on remote or locally');
    });

    it('does not retain a legacy GitHub profile PAT in the ADO credential cache', async () => {
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
      expect([...patCache.values()]).not.toContain('cached-pat');
    });

    it('returns the resolved HEAD SHA so callers can persist startCommitSha before container start', async () => {
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('rev-parse --git-dir')) {
            cb(null, { stdout: '.', stderr: '' });
          } else if (cmd === 'rev-parse HEAD') {
            cb(null, { stdout: 'feedface1234567890abcdef1234567890abcdef\n', stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      const result = await manager.create({
        repoUrl: 'https://github.com/org/repo.git',
        branch: 'feat/sha-capture',
        baseBranch: 'main',
      });

      expect(result.startCommitSha).toBe('feedface1234567890abcdef1234567890abcdef');
    });

    it('returns empty startCommitSha when HEAD resolution fails — caller will fall back to in-container poller', async () => {
      execFileMock.mockImplementation(
        (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
          const cb = resolveCallback(arg3, arg4);
          const cmd = args.join(' ');
          if (cmd.includes('rev-parse --git-dir')) {
            cb(null, { stdout: '.', stderr: '' });
          } else if (cmd === 'rev-parse HEAD') {
            cb(new Error('fatal: ambiguous argument HEAD'));
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
          return {} as ChildProcess;
        },
      );

      const result = await manager.create({
        repoUrl: 'https://github.com/org/repo.git',
        branch: 'feat/sha-fail',
        baseBranch: 'main',
      });

      expect(result.startCommitSha).toBe('');
      expect(result.worktreePath).toContain('feat_sha-fail');
    });
  });
});

describe('LocalWorktreeManager.rebaseOntoBase', () => {
  let manager: LocalWorktreeManager;

  beforeEach(() => {
    vi.clearAllMocks();
    fsMkdirMock.mockResolvedValue(undefined);
    fsRmMock.mockResolvedValue(undefined);
    fsReadFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    fsWriteFileMock.mockResolvedValue(undefined);
    manager = new LocalWorktreeManager({
      cacheDir: '/tmp/test-cache',
      worktreeDir: '/tmp/test-worktrees',
      logger,
      githubAuth: fakeGitHubAuth(),
    });
  });

  /**
   * Drives the execFile mock with a per-test handler. The handler receives the
   * git command (joined args) and returns either an exec result, an error, or
   * undefined to fall back to a default empty stdout response.
   */
  function withGitHandler(
    handler: (cmd: string) => { stdout?: string; stderr?: string; error?: Error } | undefined,
  ) {
    execFileMock.mockImplementation(
      (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
        const cb = resolveCallback(arg3, arg4);
        const cmd = args.join(' ');
        const resp = handler(cmd) ?? { stdout: '' };
        if (resp.error) {
          cb(resp.error, { stdout: '', stderr: resp.stderr ?? '' });
        } else {
          cb(null, { stdout: resp.stdout ?? '', stderr: resp.stderr ?? '' });
        }
        return {} as ChildProcess;
      },
    );
  }

  it('returns alreadyUpToDate=true when origin/<base> is an ancestor of HEAD', async () => {
    withGitHandler((cmd) => {
      if (cmd.startsWith('rev-parse --git-common-dir')) return { stdout: '/tmp/bare/r.git\n' };
      if (cmd.startsWith('remote get-url origin'))
        return { stdout: 'https://github.com/o/r.git\n' };
      if (cmd.startsWith('fetch ')) return { stdout: '' };
      if (cmd.startsWith('merge-base --is-ancestor')) return { stdout: '' };
      // Reject anything else so an unexpected git call is loud
      return { error: new Error(`unexpected git ${cmd}`) };
    });

    const result = await manager.rebaseOntoBase({
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
    });

    expect(result).toEqual({ alreadyUpToDate: true, rebased: true, conflicts: [] });
  });

  it('returns rebased=true after a clean rebase', async () => {
    withGitHandler((cmd) => {
      if (cmd.startsWith('rev-parse --git-common-dir')) return { stdout: '/tmp/bare/r.git\n' };
      if (cmd.startsWith('remote get-url origin'))
        return { stdout: 'https://github.com/o/r.git\n' };
      if (cmd.startsWith('fetch ')) return { stdout: '' };
      if (cmd.startsWith('merge-base --is-ancestor'))
        return { error: new Error('not an ancestor') };
      if (cmd.startsWith('rebase ')) return { stdout: '' };
      return { error: new Error(`unexpected git ${cmd}`) };
    });

    const result = await manager.rebaseOntoBase({
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
    });

    expect(result).toEqual({ alreadyUpToDate: false, rebased: true, conflicts: [] });
  });

  it('aborts and returns conflicts when the rebase fails', async () => {
    let rebaseAborted = false;
    withGitHandler((cmd) => {
      if (cmd.startsWith('rev-parse --git-common-dir')) return { stdout: '/tmp/bare/r.git\n' };
      if (cmd.startsWith('remote get-url origin'))
        return { stdout: 'https://github.com/o/r.git\n' };
      if (cmd.startsWith('fetch ')) return { stdout: '' };
      if (cmd.startsWith('merge-base --is-ancestor'))
        return { error: new Error('not an ancestor') };
      if (cmd === 'rebase refs/remotes/origin/main')
        return { error: new Error('CONFLICT (content): merge conflict in src/foo.ts') };
      if (cmd.startsWith('diff --name-only --diff-filter=U'))
        return { stdout: 'src/foo.ts\nsrc/bar.ts\n' };
      if (cmd.startsWith('rebase --abort')) {
        rebaseAborted = true;
        return { stdout: '' };
      }
      return { error: new Error(`unexpected git ${cmd}`) };
    });

    const result = await manager.rebaseOntoBase({
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
    });

    expect(result.rebased).toBe(false);
    expect(result.alreadyUpToDate).toBe(false);
    expect(result.conflicts).toEqual(['src/foo.ts', 'src/bar.ts']);
    expect(rebaseAborted).toBe(true);
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

describe('classifyGitError', () => {
  function makeGitError(message: string, stderr: string, cmd = 'git push origin main'): Error {
    return Object.assign(new Error(message), { stderr, cmd });
  }

  it('wraps GitHub 403 "Permission denied" as GitCredentialError(github)', () => {
    const err = makeGitError(
      'Command failed: git push',
      'remote: Permission to esbenwiberg/autopod.git denied to esbenwiberg.\nfatal: unable to access ...: The requested URL returned error: 403',
      'git push https://github.com/esbenwiberg/autopod.git HEAD:main',
    );
    const out = classifyGitError(err, 'push');
    expect(out).toBeInstanceOf(GitCredentialError);
    const credErr = out as GitCredentialError;
    expect(credErr.service).toBe('github');
    expect(credErr.op).toBe('push');
    expect(credErr.stderr).toContain('Permission to esbenwiberg/autopod.git denied');
  });

  it('infers ado when stderr contains TF401019', () => {
    const err = makeGitError(
      'Command failed: git push',
      'remote: TF401019: The Git repository ... access denied.',
      'git push https://dev.azure.com/contoso/_git/repo HEAD:main',
    );
    const out = classifyGitError(err, 'push');
    expect(out).toBeInstanceOf(GitCredentialError);
    expect((out as GitCredentialError).service).toBe('ado');
  });

  it('infers ado from dev.azure.com remote even with generic 401 wording', () => {
    const err = makeGitError(
      'Command failed: git push',
      'fatal: Authentication failed for https://dev.azure.com/contoso/_git/repo',
      'git push https://dev.azure.com/contoso/_git/repo HEAD:main',
    );
    const out = classifyGitError(err, 'push');
    expect(out).toBeInstanceOf(GitCredentialError);
    expect((out as GitCredentialError).service).toBe('ado');
  });

  it('infers ado from visualstudio.com remote', () => {
    const err = makeGitError(
      'Command failed: git push',
      'fatal: Authentication failed',
      'git push https://contoso.visualstudio.com/_git/repo HEAD:main',
    );
    const out = classifyGitError(err, 'push');
    expect(out).toBeInstanceOf(GitCredentialError);
    expect((out as GitCredentialError).service).toBe('ado');
  });

  it('matches "could not read Username" (terminal prompts disabled)', () => {
    const err = makeGitError(
      'Command failed: git push',
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    );
    const out = classifyGitError(err, 'push');
    expect(out).toBeInstanceOf(GitCredentialError);
    expect((out as GitCredentialError).service).toBe('github');
  });

  it('matches bare "401" status code', () => {
    const err = makeGitError(
      'Command failed: git push',
      'fatal: unable to access: The requested URL returned error: 401',
    );
    const out = classifyGitError(err, 'push');
    expect(out).toBeInstanceOf(GitCredentialError);
  });

  it('returns the original error untouched for non-credential failures', () => {
    const err = makeGitError(
      'Command failed: git push',
      'fatal: not a git repository (or any of the parent directories): .git',
    );
    const out = classifyGitError(err, 'push');
    expect(out).toBe(err);
    expect(out).not.toBeInstanceOf(GitCredentialError);
  });

  it('returns the original error for merge conflicts (no auth wording)', () => {
    const err = makeGitError(
      'Command failed: git merge',
      'CONFLICT (content): Merge conflict in foo.ts\nAutomatic merge failed; fix conflicts and then commit the result.',
    );
    const out = classifyGitError(err, 'push');
    expect(out).toBe(err);
  });

  it('returns non-Error inputs untouched', () => {
    expect(classifyGitError('string error', 'push')).toBe('string error');
    expect(classifyGitError(null, 'push')).toBeNull();
    expect(classifyGitError(undefined, 'push')).toBeUndefined();
  });

  it('handles errors missing stderr/cmd fields (matches on message only)', () => {
    const bareErr = new Error('fatal: Authentication failed for https://github.com/foo/bar.git');
    const out = classifyGitError(bareErr, 'push');
    expect(out).toBeInstanceOf(GitCredentialError);
    expect((out as GitCredentialError).service).toBe('github');
  });

  it('truncates very long stderr to 500 chars', () => {
    const longStderr = `remote: Permission to foo/bar denied to baz.\n${'x'.repeat(2000)}`;
    const err = makeGitError('Command failed', longStderr);
    const out = classifyGitError(err, 'push') as GitCredentialError;
    expect(out.stderr.length).toBe(500);
  });

  it('preserves the original stack', () => {
    const err = makeGitError('Command failed', 'remote: Permission to a/b denied to c');
    const originalStack = err.stack;
    const out = classifyGitError(err, 'push') as GitCredentialError;
    expect(out.stack).toBe(originalStack);
  });

  it('records the op in the wrapped error', () => {
    const err = makeGitError('Command failed', 'fatal: Authentication failed');
    expect((classifyGitError(err, 'push') as GitCredentialError).op).toBe('push');
    expect((classifyGitError(err, 'fetch') as GitCredentialError).op).toBe('fetch');
    expect((classifyGitError(err, 'clone') as GitCredentialError).op).toBe('clone');
  });
});
