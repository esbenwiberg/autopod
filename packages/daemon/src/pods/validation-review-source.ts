import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import { parseDiffFilePaths } from '../validation/review-context-builder.js';
import { TaskRetryBlockedError } from './task-retry-ledger.js';

/** Read a review packet between source observations. Unbound legacy/dirty
 * inputs can run checks but cannot mint committed-source delivery evidence. */
export async function captureReviewSource(
  manager: Pick<
    WorktreeManager,
    'getDiff' | 'getCommitLog' | 'getChangedPathsAgainstBase' | 'inspectSourceAdoption'
  >,
  worktreePath: string,
  branch: string,
  base: string,
  limit: number | undefined,
  since: string | undefined,
) {
  try {
    const before = await manager.inspectSourceAdoption?.(worktreePath, branch);
    const [diff, commitLog] = await Promise.all([
      manager.getDiff(worktreePath, base, limit, since),
      manager.getCommitLog(worktreePath, base, undefined, since),
    ]);
    const changedPathsAgainstBase = manager.getChangedPathsAgainstBase
      ? await manager.getChangedPathsAgainstBase(worktreePath, base)
      : parseDiffFilePaths(diff);
    const after = await manager.inspectSourceAdoption?.(worktreePath, branch);
    let reviewSource: { head: string; tree: string } | undefined;
    if (before && after) {
      if (
        before.branch !== branch ||
        after.branch !== branch ||
        before.commitSha !== after.commitSha ||
        before.treeSha !== after.treeSha
      )
        throw new Error('Source changed while computing review input');
      if (before.worktreeClean && after.worktreeClean)
        reviewSource = { head: before.commitSha, tree: before.treeSha };
    }
    return { diff, commitLog, changedPathsAgainstBase, reviewSource };
  } catch {
    throw new TaskRetryBlockedError(
      'Review source could not be read consistently. Restore its exact source/ref before retrying; no checks or reviewer approval were produced.',
      'REVIEW_SOURCE_UNAVAILABLE',
    );
  }
}
