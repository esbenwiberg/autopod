import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  autopodStagingRef,
  pushCommitsToBareViaStagingRef,
  type RunGit,
} from './bare-push.js';

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

async function git(cwd: string, args: string[]) {
  return execFileAsync('git', args, { cwd, env: gitEnv });
}

async function tryGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const r = await execFileAsync('git', args, { cwd, env: gitEnv });
    return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? (err as Error).message,
      exitCode: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

function runGitIn(cwd: string): RunGit {
  return (args) => tryGit(cwd, args);
}

/**
 * Build a fixture that mirrors autopod's actual layout:
 *   - `bare`: shared bare repo with `main` at one commit
 *   - `hostWt`: linked worktree of the bare on branch `feature-x` (autopod's host worktree)
 *   - `container`: a separate working dir on `feature-x` with `.git/objects/info/alternates`
 *     pointing at the bare — mimics the gitlink→real-dir conversion done in
 *     pod-manager when the container starts.
 *
 * The crucial property: the bare has `feature-x` checked out in `hostWt`. Any
 * direct `git push <bare> HEAD` from `container` therefore hits
 * `receive.denyCurrentBranch=refuse`.
 */
async function buildFixture(tmpRoot: string) {
  const bare = path.join(tmpRoot, 'repo.git');
  const hostWt = path.join(tmpRoot, 'host-wt');
  const container = path.join(tmpRoot, 'container');
  const seed = path.join(tmpRoot, 'seed');

  await git(tmpRoot, ['init', '--bare', '--initial-branch=main', bare]);

  await git(tmpRoot, ['clone', bare, seed]);
  await writeFile(path.join(seed, 'a.txt'), 'a\n');
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '-m', 'init']);
  await git(seed, ['push', 'origin', 'HEAD:refs/heads/main']);

  await git(tmpRoot, [
    '--git-dir',
    bare,
    'worktree',
    'add',
    '-b',
    'feature-x',
    hostWt,
    'main',
  ]);

  await mkdir(container);
  await git(container, ['init', '--initial-branch=feature-x']);
  await writeFile(
    path.join(container, '.git', 'objects', 'info', 'alternates'),
    `${path.join(bare, 'objects')}\n`,
  );
  const { stdout: mainTip } = await git(tmpRoot, ['--git-dir', bare, 'rev-parse', 'main']);
  await writeFile(
    path.join(container, '.git', 'refs', 'heads', 'feature-x'),
    mainTip,
  );
  await writeFile(path.join(container, '.git', 'HEAD'), 'ref: refs/heads/feature-x\n');
  // Sync working tree to the branch we just wired up.
  await git(container, ['reset', '--hard', 'feature-x']);

  // Agent's commit inside the container — the thing that needs to land on the host branch.
  await writeFile(path.join(container, 'b.txt'), 'b\n');
  await git(container, ['add', '.']);
  await git(container, ['commit', '-m', 'agent commit']);

  return { bare, hostWt, container };
}

describe('bare push via staging ref', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'autopod-bare-push-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('REGRESSION: direct `git push <bare> HEAD` is rejected by denyCurrentBranch', async () => {
    // The bug we're fixing: every autopod pod's host worktree is a linked
    // worktree of the bare on the pod's branch, so the bare refuses container
    // pushes that would advance that same branch. This proves the fixture
    // faithfully reproduces production behavior.
    const { bare, container } = await buildFixture(tmpRoot);

    const result = await tryGit(container, ['push', bare, 'HEAD']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/refusing to update checked out branch/i);

    // Branch on the bare did NOT advance.
    const { stdout: bareTip } = await git(tmpRoot, [
      '--git-dir',
      bare,
      'rev-parse',
      'feature-x',
    ]);
    const { stdout: mainTip } = await git(tmpRoot, [
      '--git-dir',
      bare,
      'rev-parse',
      'main',
    ]);
    expect(bareTip.trim()).toBe(mainTip.trim());
  });

  it('pushCommitsToBareViaStagingRef advances the bare branch and cleans up the staging ref', async () => {
    const { bare, container } = await buildFixture(tmpRoot);

    const result = await pushCommitsToBareViaStagingRef(
      runGitIn(container),
      bare,
      'pod-abc',
    );

    expect(result).toEqual({ pushed: true });

    const { stdout: containerTip } = await git(container, ['rev-parse', 'HEAD']);
    const { stdout: bareTip } = await git(tmpRoot, [
      '--git-dir',
      bare,
      'rev-parse',
      'feature-x',
    ]);
    expect(bareTip.trim()).toBe(containerTip.trim());

    // Staging ref must not linger.
    const staging = await tryGit(tmpRoot, [
      '--git-dir',
      bare,
      'rev-parse',
      '--verify',
      autopodStagingRef('pod-abc'),
    ]);
    expect(staging.exitCode).not.toBe(0);
  });

  it('rejects a non-fast-forward staging tip without moving the branch', async () => {
    const { bare, container } = await buildFixture(tmpRoot);

    // Diverge the bare's feature-x out from under the container so the
    // container's HEAD is no longer an FF descendant. Do it via a SECOND
    // linked worktree so we don't disturb the first one's HEAD checkout state.
    const otherWt = path.join(tmpRoot, 'other-wt');
    await git(tmpRoot, [
      '--git-dir',
      bare,
      'worktree',
      'add',
      '--force',
      otherWt,
      'feature-x',
    ]);
    await writeFile(path.join(otherWt, 'divergent.txt'), 'divergent\n');
    await git(otherWt, ['add', '.']);
    await git(otherWt, ['commit', '-m', 'divergent commit on bare side']);

    const divergedTipResult = await git(tmpRoot, [
      '--git-dir',
      bare,
      'rev-parse',
      'feature-x',
    ]);
    const divergedTip = divergedTipResult.stdout.trim();

    const result = await pushCommitsToBareViaStagingRef(
      runGitIn(container),
      bare,
      'pod-nonff',
    );

    expect(result.pushed).toBe(false);
    expect(result.reason).toMatch(/non-fast-forward|update-ref/);

    // Branch must not have moved.
    const { stdout: bareTip } = await git(tmpRoot, [
      '--git-dir',
      bare,
      'rev-parse',
      'feature-x',
    ]);
    expect(bareTip.trim()).toBe(divergedTip);

    // Staging ref cleaned up.
    const staging = await tryGit(tmpRoot, [
      '--git-dir',
      bare,
      'rev-parse',
      '--verify',
      autopodStagingRef('pod-nonff'),
    ]);
    expect(staging.exitCode).not.toBe(0);
  });

  it('refuses detached HEAD without leaving a staging ref behind', async () => {
    const { bare, container } = await buildFixture(tmpRoot);
    await git(container, ['checkout', '--detach', 'HEAD']);

    const result = await pushCommitsToBareViaStagingRef(
      runGitIn(container),
      bare,
      'pod-detached',
    );

    expect(result.pushed).toBe(false);
    expect(result.reason).toMatch(/detached/i);

    const staging = await tryGit(tmpRoot, [
      '--git-dir',
      bare,
      'rev-parse',
      '--verify',
      autopodStagingRef('pod-detached'),
    ]);
    expect(staging.exitCode).not.toBe(0);
  });

  it('creates a branch on first push when the bare has no such branch', async () => {
    const { bare, container } = await buildFixture(tmpRoot);

    // Container moves to a brand-new branch the bare has never seen.
    await git(container, ['checkout', '-b', 'feature-fresh']);
    await writeFile(path.join(container, 'c.txt'), 'c\n');
    await git(container, ['add', '.']);
    await git(container, ['commit', '-m', 'fresh-branch commit']);

    const result = await pushCommitsToBareViaStagingRef(
      runGitIn(container),
      bare,
      'pod-fresh',
    );

    expect(result).toEqual({ pushed: true });

    const { stdout: containerTip } = await git(container, ['rev-parse', 'HEAD']);
    const { stdout: bareTip } = await git(tmpRoot, [
      '--git-dir',
      bare,
      'rev-parse',
      'feature-fresh',
    ]);
    expect(bareTip.trim()).toBe(containerTip.trim());
  });
});
