import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const EMPTY_OID = '0000000000000000000000000000000000000000';

/**
 * Build the per-pod staging ref used to defeat `receive.denyCurrentBranch=refuse`
 * when a container pushes its commits back to the host bare repo.
 *
 * Every autopod pod creates a linked worktree of the bare (via `git worktree add`)
 * on the pod's branch. The bare therefore has that branch checked out in one of
 * its linked worktrees, and a direct `git push <bare> HEAD` from anywhere else is
 * refused with "refusing to update checked out branch". We push to
 * `refs/autopod-incoming/<podId>` first — a namespace no worktree has checked out —
 * and then promote it to the real branch via `update-ref` (which is plumbing and
 * bypasses denyCurrentBranch entirely).
 */
export function autopodStagingRef(podId: string): string {
  return `refs/autopod-incoming/${podId}`;
}

export interface PushResult {
  pushed: boolean;
  /** Failure category — useful when distinguishing push, branch-resolve, and promote errors. */
  reason?: string;
}

export interface RunGitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runs git in whichever environment holds the commits that need to be pushed —
 * `cm.execInContainer(containerId, ['git', '-C', '/workspace', ...args])` for the
 * normal in-container path, or host-side `execFile('git', ['--git-dir', tmp, ...args])`
 * for the archive-API fallback.
 */
export type RunGit = (args: string[]) => Promise<RunGitResult>;

/**
 * Push commits from a git working dir to a bare repo's branch, bypassing
 * `receive.denyCurrentBranch=refuse`.
 *
 * Preserves the fast-forward-only safety of the previous direct push:
 *   - Captures the bare's current branch tip up front.
 *   - Pushes the container's HEAD to a per-pod staging ref.
 *   - Verifies the staging tip descends from the captured tip (FF check).
 *   - Atomically swaps the branch via `update-ref <ref> <new> <expected-old>`,
 *     so a concurrent ref move (e.g. a second sync-back on the same branch)
 *     fails closed rather than clobbering work.
 *   - Cleans up the staging ref on every exit path.
 *
 * Returns `{ pushed: false, reason }` rather than throwing — the call sites
 * already swallow push failures and clamp the deletion guard.
 */
export async function pushCommitsToBareViaStagingRef(
  runGit: RunGit,
  bareRepoPath: string,
  podId: string,
): Promise<PushResult> {
  const stagingRef = autopodStagingRef(podId);
  const cleanupStaging = async () => {
    await execFileAsync('git', ['--git-dir', bareRepoPath, 'update-ref', '-d', stagingRef]).catch(
      () => {},
    );
  };

  const branchResolve = await runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branchResolve.exitCode !== 0 || !branchResolve.stdout.trim()) {
    return {
      pushed: false,
      reason: `resolve-branch: ${branchResolve.stderr.trim() || 'unable to resolve HEAD'}`,
    };
  }
  const branch = branchResolve.stdout.trim();
  if (branch === 'HEAD') {
    return {
      pushed: false,
      reason: 'detached HEAD — refusing to update bare branch from a detached ref',
    };
  }

  let expectedOld = EMPTY_OID;
  try {
    const { stdout } = await execFileAsync('git', [
      '--git-dir',
      bareRepoPath,
      'rev-parse',
      '--verify',
      `refs/heads/${branch}`,
    ]);
    expectedOld = stdout.trim();
  } catch {
    // Branch doesn't exist on the bare yet — first push creates it.
  }

  // Clear any leftover staging ref from a prior sync-back on the same pod so the
  // push starts clean and we don't carry forward an aborted earlier attempt.
  await cleanupStaging();

  const push = await runGit(['push', bareRepoPath, `HEAD:${stagingRef}`]);
  if (push.exitCode !== 0) {
    return { pushed: false, reason: `push: ${push.stderr.trim() || 'non-zero exit'}` };
  }

  if (expectedOld !== EMPTY_OID) {
    try {
      await execFileAsync('git', [
        '--git-dir',
        bareRepoPath,
        'merge-base',
        '--is-ancestor',
        expectedOld,
        stagingRef,
      ]);
    } catch {
      await cleanupStaging();
      return {
        pushed: false,
        reason: `non-fast-forward: staging tip is not a descendant of ${expectedOld.slice(0, 7)}`,
      };
    }
  }

  try {
    await execFileAsync('git', [
      '--git-dir',
      bareRepoPath,
      'update-ref',
      `refs/heads/${branch}`,
      stagingRef,
      expectedOld,
    ]);
  } catch (err) {
    await cleanupStaging();
    return { pushed: false, reason: `update-ref: ${(err as Error).message}` };
  }

  await cleanupStaging();
  return { pushed: true };
}
