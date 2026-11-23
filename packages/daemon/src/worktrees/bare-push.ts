import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Derive the bare repo path from an existing worktree via `git rev-parse --git-common-dir`. */
export async function deriveBareRepoPath(worktreePath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
    cwd: worktreePath,
  });
  return path.resolve(worktreePath, stdout.trim());
}

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
  /** Present only when an authorized non-fast-forward rewrite replaced the branch tip. */
  rewrite?: { from: string; to: string; evidence?: unknown };
}

export interface RewriteAuthorizationInput {
  bareRepoPath: string;
  branch: string;
  /** Branch tip captured before the push; the promote is CAS-bound to it. */
  expectedOld: string;
  /** Resolved staging tip that would replace `expectedOld`. */
  candidate: string;
}

export type RewriteAuthorization =
  | { authorized: true; evidence?: unknown }
  | { authorized: false; reason: string };

export interface PushToBareOptions {
  /**
   * Optional authority for a non-fast-forward staging tip. Without it every
   * non-fast-forward is refused (the historical behaviour). When it authorizes,
   * the same CAS `update-ref <branch> <staging> <expectedOld>` promote is used.
   */
  authorizeRewrite?(input: RewriteAuthorizationInput): Promise<RewriteAuthorization>;
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
  assertCurrent: () => void = () => {},
  options: PushToBareOptions = {},
): Promise<PushResult> {
  const owned = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertCurrent();
    const value = await operation();
    assertCurrent();
    return value;
  };
  assertCurrent();
  const stagingRef = autopodStagingRef(podId);
  const cleanupStaging = async () => {
    await owned(() =>
      execFileAsync('git', ['--git-dir', bareRepoPath, 'update-ref', '-d', stagingRef]),
    ).catch(() => {});
  };

  const branchResolve = await owned(() => runGit(['rev-parse', '--abbrev-ref', 'HEAD']));
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
    const { stdout } = await owned(() =>
      execFileAsync('git', [
        '--git-dir',
        bareRepoPath,
        'rev-parse',
        '--verify',
        `refs/heads/${branch}`,
      ]),
    );
    expectedOld = stdout.trim();
  } catch {
    // Branch doesn't exist on the bare yet — first push creates it.
  }

  // Clear any leftover staging ref from a prior sync-back on the same pod so the
  // push starts clean and we don't carry forward an aborted earlier attempt.
  await cleanupStaging();

  const push = await owned(() => runGit(['push', bareRepoPath, `HEAD:${stagingRef}`]));
  if (push.exitCode !== 0) {
    return { pushed: false, reason: `push: ${push.stderr.trim() || 'non-zero exit'}` };
  }

  let rewrite: PushResult['rewrite'];
  if (expectedOld !== EMPTY_OID) {
    try {
      await owned(() =>
        execFileAsync('git', [
          '--git-dir',
          bareRepoPath,
          'merge-base',
          '--is-ancestor',
          expectedOld,
          stagingRef,
        ]),
      );
    } catch {
      const refused = `non-fast-forward: staging tip is not a descendant of ${expectedOld.slice(0, 7)}`;
      if (!options.authorizeRewrite) {
        await cleanupStaging();
        return { pushed: false, reason: refused };
      }
      let candidate: string;
      let authorization: RewriteAuthorization;
      try {
        candidate = (
          await owned(() =>
            execFileAsync('git', ['--git-dir', bareRepoPath, 'rev-parse', '--verify', stagingRef]),
          )
        ).stdout.trim();
        const authorizeRewrite = options.authorizeRewrite;
        authorization = await owned(() =>
          authorizeRewrite({ bareRepoPath, branch, expectedOld, candidate }),
        );
      } catch (err) {
        await cleanupStaging();
        // A superseded owner must surface as such, not as an ordinary refusal.
        assertCurrent();
        return {
          pushed: false,
          reason: `${refused}; rewrite refused: ${(err as Error).message}`,
        };
      }
      if (!authorization.authorized) {
        await cleanupStaging();
        return { pushed: false, reason: `${refused}; rewrite refused: ${authorization.reason}` };
      }
      rewrite = { from: expectedOld, to: candidate, evidence: authorization.evidence };
    }
  }

  try {
    await owned(() =>
      execFileAsync('git', [
        '--git-dir',
        bareRepoPath,
        'update-ref',
        `refs/heads/${branch}`,
        stagingRef,
        expectedOld,
      ]),
    );
  } catch (err) {
    await cleanupStaging();
    return { pushed: false, reason: `update-ref: ${(err as Error).message}` };
  }

  await cleanupStaging();
  return rewrite ? { pushed: true, rewrite } : { pushed: true };
}
