/**
 * Publishing validation screenshots for PR review.
 *
 * Screenshots used to be committed straight onto the pod's branch so GitHub
 * would render them inline in the PR body. That injects a file the agent never
 * wrote into the reviewed change, and repo-level provenance gates reject it —
 * a capsule-gated repo failed every pod on a trailing
 * `chore: add validation screenshots` commit that fell outside the sealed
 * commit range.
 *
 * They now go to a dedicated ref instead. The PR body still gets working image
 * URLs, and the reviewed branch contains only the agent's work.
 */

import type { Logger } from 'pino';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';

/** Worktree-relative directory the Playwright script writes screenshots into. */
export const SCREENSHOT_ARTIFACT_PATH = '.autopod/screenshots';

/**
 * Ref carrying one pod's validation screenshots. Namespaced so an operator can
 * prune the whole set when the branch list gets noisy — these refs are not
 * garbage-collected, deliberately: a merged PR keeps rendering its screenshots.
 */
export function screenshotArtifactBranch(podId: string): string {
  return `autopod/screenshots/${podId}`;
}

export interface PublishScreenshotArtifactsDeps {
  worktreeManager: WorktreeManager;
  logger: Logger;
  podId: string;
  worktreePath: string;
  /** Explicit PAT — the manager's cache may be cold after a daemon restart. */
  pat?: string;
}

/**
 * Push this pod's screenshots to their artifact ref.
 *
 * Returns the branch name when the push succeeded, or `null` when there was
 * nothing to publish, the push failed, or the manager has no artifact-ref
 * support (e.g. a non-git backend). Callers must treat `null` as "omit the
 * screenshots section" rather than building URLs against a ref that does not
 * exist — dead image links are worse than no images.
 */
export async function publishScreenshotArtifacts(
  deps: PublishScreenshotArtifactsDeps,
): Promise<string | null> {
  const { worktreeManager, logger, podId, worktreePath, pat } = deps;
  if (!worktreeManager.pushArtifactBranch) return null;

  const branch = screenshotArtifactBranch(podId);
  const pushed = await worktreeManager.pushArtifactBranch({
    worktreePath,
    paths: [SCREENSHOT_ARTIFACT_PATH],
    branch,
    commitMessage: `chore: validation screenshots for pod ${podId}`,
    pat,
  });
  if (!pushed) {
    logger.info(
      { podId, branch },
      'No screenshot artifacts published — omitting screenshots from the PR body',
    );
    return null;
  }
  return branch;
}
