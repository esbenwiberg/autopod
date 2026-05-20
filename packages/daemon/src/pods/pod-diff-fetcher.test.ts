import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import {
  computePodCommitDiffs,
  computePodDiff,
  computePodUncommittedDiff,
  computePodUntrackedPreview,
  summarizeDiff,
} from './pod-diff-fetcher.js';

const logger = pino({ level: 'silent' });

function makeContainerManager(
  execImpl: (cmd: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
): ContainerManager {
  return {
    execInContainer: vi.fn().mockImplementation((_id, cmd) => execImpl(cmd)),
  } as unknown as ContainerManager;
}

function makeWorktreeManager(getDiffImpl: () => Promise<string> | string): WorktreeManager {
  return {
    getDiff: vi.fn().mockImplementation(async () => getDiffImpl()),
  } as unknown as WorktreeManager;
}

const SAMPLE_DIFF =
  'diff --git a/src/foo.ts b/src/foo.ts\n' +
  'index abc..def 100644\n' +
  '--- a/src/foo.ts\n' +
  '+++ b/src/foo.ts\n' +
  '@@ -1,2 +1,3 @@\n' +
  ' line1\n' +
  '+added line\n' +
  '-removed line\n';

describe('computePodDiff', () => {
  it('reads the diff from inside the container when one is running', async () => {
    const calls: string[][] = [];
    const containerManager = makeContainerManager(async (cmd) => {
      calls.push(cmd);
      if (cmd[0] === 'git' && cmd[1] === 'diff') {
        expect(cmd).toContain('start-sha');
        return { stdout: SAMPLE_DIFF, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 1 };
    });
    const worktreeManager = makeWorktreeManager(async () => 'WORKTREE-SHOULD-NOT-BE-USED');

    const result = await computePodDiff({
      pod: {
        containerId: 'c1',
        worktreePath: '/host/worktree',
        startCommitSha: 'start-sha',
      },
      defaultBranch: 'main',
      containerManager,
      worktreeManager,
      logger,
    });

    expect(result.source).toBe('container');
    expect(result.diff).toContain('+added line');
    expect(worktreeManager.getDiff).not.toHaveBeenCalled();
    expect(calls.some((cmd) => cmd[1] === 'merge-base')).toBe(false);
    const diffCall = calls.find((cmd) => cmd[1] === 'diff');
    expect(diffCall).toBeDefined();
    if (!diffCall) throw new Error('expected git diff call');
    expect(diffCall.indexOf('--no-color')).toBeLessThan(diffCall.indexOf('start-sha'));
  });

  it('falls back to merge-base when startCommitSha is null', async () => {
    const calls: string[][] = [];
    const containerManager = makeContainerManager(async (cmd) => {
      calls.push(cmd);
      if (cmd[0] === 'git' && cmd[1] === 'merge-base') {
        return { stdout: 'merge-base-sha\n', stderr: '', exitCode: 0 };
      }
      if (cmd[0] === 'git' && cmd[1] === 'diff') {
        expect(cmd).toContain('merge-base-sha');
        return { stdout: SAMPLE_DIFF, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 1 };
    });

    const result = await computePodDiff({
      pod: { containerId: 'c1', worktreePath: null, startCommitSha: null },
      defaultBranch: 'main',
      containerManager,
      logger,
    });

    expect(result.source).toBe('container');
    expect(result.diff).toContain('+added line');
    const mergeBaseCalls = calls.filter((c) => c[1] === 'merge-base');
    expect(mergeBaseCalls.length).toBeGreaterThan(0);
  });

  it('falls back to the host worktree when the in-container exec fails', async () => {
    const containerManager = makeContainerManager(async () => ({
      stdout: '',
      stderr: 'fatal: not a git repository',
      exitCode: 128,
    }));
    const worktreeManager = makeWorktreeManager(() => SAMPLE_DIFF);

    const result = await computePodDiff({
      pod: {
        containerId: 'c1',
        worktreePath: '/host/worktree',
        startCommitSha: 'start-sha',
      },
      defaultBranch: 'main',
      containerManager,
      worktreeManager,
      logger,
    });

    expect(result.source).toBe('worktree');
    expect(result.diff).toContain('+added line');
    expect(worktreeManager.getDiff).toHaveBeenCalledWith(
      '/host/worktree',
      'main',
      undefined,
      'start-sha',
    );
  });

  it('falls back to host worktree when no container is running', async () => {
    const worktreeManager = makeWorktreeManager(() => SAMPLE_DIFF);

    const result = await computePodDiff({
      pod: {
        containerId: null,
        worktreePath: '/host/worktree',
        startCommitSha: 'start-sha',
      },
      defaultBranch: 'main',
      worktreeManager,
      logger,
    });

    expect(result.source).toBe('worktree');
    expect(result.diff).toContain('+added line');
  });

  it('returns empty diff with source=none when neither container nor worktree is available', async () => {
    const result = await computePodDiff({
      pod: { containerId: null, worktreePath: null, startCommitSha: null },
      defaultBranch: 'main',
      logger,
    });

    expect(result.source).toBe('none');
    expect(result.diff).toBe('');
  });

  it('strips mode-only diff sections', async () => {
    const modeOnly = 'diff --git a/x b/x\nold mode 100644\nnew mode 100755\n';
    const realDiff = `${modeOnly}diff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-old\n+new\n`;
    const containerManager = makeContainerManager(async (cmd) => {
      if (cmd[1] === 'diff') return { stdout: realDiff, stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 1 };
    });

    const result = await computePodDiff({
      pod: { containerId: 'c1', worktreePath: null, startCommitSha: 'sha' },
      defaultBranch: 'main',
      containerManager,
      logger,
    });

    expect(result.diff).not.toContain('a/x b/x');
    expect(result.diff).toContain('a/y b/y');
  });
});

describe('computePodUncommittedDiff', () => {
  it('reads tracked dirty changes against HEAD without consulting the base branch', async () => {
    const calls: string[][] = [];
    const containerManager = makeContainerManager(async (cmd) => {
      calls.push(cmd);
      if (cmd[0] === 'git' && cmd[1] === 'diff' && cmd.includes('HEAD')) {
        return { stdout: SAMPLE_DIFF, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    });

    const result = await computePodUncommittedDiff({
      pod: { containerId: 'c1', worktreePath: null, startCommitSha: 'start-sha' },
      defaultBranch: 'main',
      containerManager,
      logger,
    });

    expect(result.source).toBe('container');
    expect(result.diff).toContain('+added line');
    expect(calls.some((cmd) => cmd[1] === 'merge-base')).toBe(false);
    const diffCall = calls.find((cmd) => cmd[1] === 'diff');
    expect(diffCall).toBeDefined();
    if (!diffCall) throw new Error('expected git diff call');
    expect(diffCall.indexOf('--no-color')).toBeLessThan(diffCall.indexOf('HEAD'));
  });
});

describe('computePodUntrackedPreview', () => {
  it('returns a separate preview diff for untracked files in the live container', async () => {
    const untrackedDiff =
      'diff --git a/src/new.ts b/src/new.ts\n' +
      'new file mode 100644\n' +
      '--- /dev/null\n' +
      '+++ b/src/new.ts\n' +
      '@@ -0,0 +1 @@\n' +
      '+export const value = 1;\n';
    const containerManager = makeContainerManager(async (cmd) => {
      if (cmd[1] === 'ls-files') {
        return { stdout: 'src/new.ts\0', stderr: '', exitCode: 0 };
      }
      if (cmd[0] === 'stat') {
        return { stdout: '23\n', stderr: '', exitCode: 0 };
      }
      if (cmd[1] === 'diff' && cmd.includes('--no-index')) {
        return { stdout: untrackedDiff, stderr: '', exitCode: 1 };
      }
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    });

    const result = await computePodUntrackedPreview({
      pod: { containerId: 'c1', worktreePath: null, startCommitSha: 'start-sha' },
      defaultBranch: 'main',
      containerManager,
      logger,
    });

    expect(result.source).toBe('container');
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      path: 'src/new.ts',
      status: 'added',
    });
    expect(result.files[0]?.diff).toContain('+export const value = 1;');
  });

  it('omits oversized untracked file contents from the preview', async () => {
    const containerManager = makeContainerManager(async (cmd) => {
      if (cmd[1] === 'ls-files') {
        return { stdout: 'big.log\0', stderr: '', exitCode: 0 };
      }
      if (cmd[0] === 'stat') {
        return { stdout: '999999\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    });

    const result = await computePodUntrackedPreview({
      pod: { containerId: 'c1', worktreePath: null, startCommitSha: 'start-sha' },
      defaultBranch: 'main',
      containerManager,
      logger,
    });

    expect(result.files[0]?.path).toBe('big.log');
    expect(result.files[0]?.truncated).toBe(true);
    expect(result.files[0]?.note).toContain('omitted from preview');
  });
});

describe('computePodCommitDiffs', () => {
  it('refuses commit grouping without startCommitSha instead of falling back to merge-base', async () => {
    const containerManager = makeContainerManager(async () => {
      throw new Error('should not call container');
    });

    const result = await computePodCommitDiffs({
      pod: { containerId: 'c1', worktreePath: null, startCommitSha: null },
      defaultBranch: 'main',
      containerManager,
      logger,
    });

    expect(result.source).toBe('none');
    expect(result.commits).toEqual([]);
    expect(result.unavailableReason).toContain('startCommitSha');
  });

  it('groups committed work using startCommitSha..HEAD without consulting the base branch', async () => {
    const calls: string[][] = [];
    const containerManager = makeContainerManager(async (cmd) => {
      calls.push(cmd);
      if (cmd[1] === 'log') {
        expect(cmd).toContain('start-sha..HEAD');
        return {
          stdout: [
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'aaaaaaaa',
            '2026-05-20T10:00:00Z',
            'feat: add thing',
            'body text\x1e',
          ].join('\0'),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd[1] === 'show') {
        expect(cmd).toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
        return { stdout: SAMPLE_DIFF, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    });

    const result = await computePodCommitDiffs({
      pod: { containerId: 'c1', worktreePath: '/host/worktree', startCommitSha: 'start-sha' },
      defaultBranch: 'main',
      containerManager,
      logger,
    });

    expect(result.source).toBe('container');
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0]).toMatchObject({
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shortSha: 'aaaaaaaa',
      subject: 'feat: add thing',
      body: 'body text',
    });
    expect(result.commits[0]?.diff).toContain('+added line');
    expect(calls.some((cmd) => cmd[1] === 'merge-base')).toBe(false);
  });
});

describe('summarizeDiff', () => {
  it('counts files, additions, and deletions', () => {
    const stats = summarizeDiff(SAMPLE_DIFF);
    expect(stats.filesReviewed).toBe(1);
    expect(stats.linesAdded).toBe(1);
    expect(stats.linesRemoved).toBe(1);
  });

  it('ignores +++ / --- header lines', () => {
    const stats = summarizeDiff(SAMPLE_DIFF);
    // The diff has one '+++ b/' and one '--- a/' header — those must NOT be
    // double-counted as content additions/removals.
    expect(stats.linesAdded).toBe(1);
    expect(stats.linesRemoved).toBe(1);
  });

  it('returns zeros for an empty diff', () => {
    expect(summarizeDiff('')).toEqual({ filesReviewed: 0, linesAdded: 0, linesRemoved: 0 });
    expect(summarizeDiff('   \n  ')).toEqual({
      filesReviewed: 0,
      linesAdded: 0,
      linesRemoved: 0,
    });
  });

  it('counts multiple files in one diff', () => {
    const multi =
      'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n' +
      'diff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-x\n+y\n';
    expect(summarizeDiff(multi).filesReviewed).toBe(2);
  });
});
