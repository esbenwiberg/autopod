import type { RunGit } from './bare-push.js';

export type GraftResult =
  | { ok: true; head: string; committed: boolean }
  | { ok: false; reason: string };

/**
 * Re-parent a host worktree's current tree onto a base commit, preserving the
 * exact working-tree content.
 *
 * This is the recovery primitive for a sandbox host/container HEAD divergence
 * (see `docs/sandbox-rework-reconcile-bug.md`). The daemon's host-side
 * auto-commit can land on a base that isn't a descendant of the container HEAD,
 * so the two HEADs share no ancestry even though the host commit's *tree* is the
 * agent state we want to validate. Grafting keeps that tree but makes it a linear
 * child of `baseCommit` (the container HEAD), so downstream reconcile treats the
 * host as strictly ahead and delivery proceeds instead of the work being stranded.
 *
 * Sequence (all host-side, on the worktree's current branch/HEAD):
 *   1. Verify `baseCommit` is reachable on the host — the caller must have made
 *      the container HEAD available (it usually is, via the sync-back push).
 *   2. `reset --soft <baseCommit>` — move the branch to the base, keep index + tree.
 *   3. If nothing is staged the trees already match → the base commit *is* the
 *      reconciled HEAD; no empty commit is created.
 *   4. Otherwise commit the retained tree as a linear child of the base.
 *
 * Returns `{ ok: false, reason }` rather than throwing so the caller can fall
 * back to the strict divergence guard (quarantine).
 */
export async function graftHostTreeOntoBase(
  hostGit: RunGit,
  baseCommit: string,
): Promise<GraftResult> {
  const present = await hostGit(['cat-file', '-e', `${baseCommit}^{commit}`]);
  if (present.exitCode !== 0) {
    return { ok: false, reason: 'base-missing' };
  }

  const soft = await hostGit(['reset', '--soft', baseCommit]);
  if (soft.exitCode !== 0) {
    return { ok: false, reason: `reset: ${soft.stderr.trim() || 'reset --soft failed'}` };
  }

  const nothingStaged = (await hostGit(['diff', '--cached', '--quiet'])).exitCode === 0;
  if (nothingStaged) {
    // Host tree is identical to the base — the HEADs simply agree now.
    return { ok: true, head: baseCommit, committed: false };
  }

  const commit = await hostGit([
    'commit',
    '--no-verify',
    '-m',
    `autopod: reconcile agent worktree onto container HEAD ${baseCommit.slice(0, 12)}`,
  ]);
  if (commit.exitCode !== 0) {
    return { ok: false, reason: `commit: ${commit.stderr.trim() || 'commit failed'}` };
  }

  const head = await hostGit(['rev-parse', 'HEAD']);
  if (head.exitCode !== 0 || !head.stdout.trim()) {
    return { ok: false, reason: 'rev-parse HEAD failed after graft' };
  }
  return { ok: true, head: head.stdout.trim(), committed: true };
}
