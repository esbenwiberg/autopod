import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import {
  DIFF_EXCLUDE_PATHSPECS,
  stripModeOnlyChanges,
  truncateDiffAtFileBoundary,
} from '../worktrees/diff-utils.js';

export type DiffSource = 'container' | 'worktree' | 'none';

export interface PodDiffSlice {
  containerId: string | null;
  worktreePath: string | null;
  startCommitSha: string | null;
}

export interface ComputePodDiffOpts {
  pod: PodDiffSlice;
  defaultBranch: string;
  containerManager?: ContainerManager;
  worktreeManager?: WorktreeManager;
  maxLength?: number;
  logger?: Logger;
}

export interface PodDiffResult {
  diff: string;
  source: DiffSource;
}

/**
 * Compute the cumulative diff of an agent's work since `startCommitSha`.
 *
 * Strategy:
 *   1. If the container is running, exec `git diff <startCommitSha>` inside it.
 *      The container holds the agent's commits in /workspace/.git long before
 *      `syncWorkspaceBack()` mirrors them to the host, so the in-container view
 *      is always fresh — host worktree is not.
 *   2. Fall back to the host worktree only when the container is gone or the
 *      in-container exec fails.
 *
 * Mirrors the strategy used by /pods/:id/diff (routes/diff.ts) so live tools
 * and the desktop diff view see the same bytes.
 */
export async function computePodDiff(opts: ComputePodDiffOpts): Promise<PodDiffResult> {
  const { pod, defaultBranch, containerManager, worktreeManager, maxLength, logger } = opts;

  if (pod.containerId && containerManager) {
    const containerDiff = await tryContainerDiff(
      containerManager,
      pod.containerId,
      pod.startCommitSha,
      defaultBranch,
      logger,
    );
    if (containerDiff !== null) {
      return {
        diff: finalizeDiff(containerDiff, maxLength),
        source: 'container',
      };
    }
  }

  if (pod.worktreePath && worktreeManager) {
    const worktreeDiff = await worktreeManager
      .getDiff(pod.worktreePath, defaultBranch, maxLength, pod.startCommitSha ?? undefined)
      .catch((err) => {
        logger?.warn({ err }, 'computePodDiff: host worktree fallback failed');
        return '';
      });
    return { diff: worktreeDiff, source: worktreeDiff ? 'worktree' : 'none' };
  }

  return { diff: '', source: 'none' };
}

async function tryContainerDiff(
  cm: ContainerManager,
  containerId: string,
  startCommitSha: string | null,
  defaultBranch: string,
  logger?: Logger,
): Promise<string | null> {
  const workDir = '/workspace';
  try {
    const base = await resolveContainerBase(cm, containerId, startCommitSha, defaultBranch);
    if (!base) return null;

    // Single-ref `git diff <base>` folds committed + uncommitted into one net
    // delta — same approach as LocalWorktreeManager.getDiff. See the inline
    // comment there for why double-ref `git diff base HEAD` would double-count
    // files committed-then-modified.
    const result = await cm.execInContainer(
      containerId,
      ['git', 'diff', base, ...DIFF_EXCLUDE_PATHSPECS, '--no-color'],
      { cwd: workDir, timeout: 30_000 },
    );
    if (result.exitCode !== 0) {
      logger?.warn(
        { exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) },
        'computePodDiff: in-container git diff failed',
      );
      return null;
    }
    return result.stdout;
  } catch (err) {
    logger?.warn({ err }, 'computePodDiff: in-container git diff threw');
    return null;
  }
}

async function resolveContainerBase(
  cm: ContainerManager,
  containerId: string,
  startCommitSha: string | null,
  defaultBranch: string,
): Promise<string | undefined> {
  if (startCommitSha) return startCommitSha;
  const workDir = '/workspace';
  for (const ref of [defaultBranch, `origin/${defaultBranch}`]) {
    try {
      const result = await cm.execInContainer(containerId, ['git', 'merge-base', 'HEAD', ref], {
        cwd: workDir,
        timeout: 10_000,
      });
      if (result.exitCode === 0 && result.stdout.trim()) {
        return result.stdout.trim();
      }
    } catch {
      // Try next ref form
    }
  }
  return undefined;
}

function finalizeDiff(rawDiff: string, maxLength?: number): string {
  const stripped = stripModeOnlyChanges(rawDiff);
  if (maxLength === undefined) return stripped;
  return truncateDiffAtFileBoundary(stripped, maxLength);
}

export interface DiffScopeStats {
  filesReviewed: number;
  linesAdded: number;
  linesRemoved: number;
}

/** Compute coarse +/- and file counts from a unified diff. Used to echo scope back to agents. */
export function summarizeDiff(diff: string): DiffScopeStats {
  if (!diff.trim()) return { filesReviewed: 0, linesAdded: 0, linesRemoved: 0 };
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) linesAdded++;
    else if (line.startsWith('-')) linesRemoved++;
  }
  const filesReviewed = (diff.match(/^diff --git /gm) ?? []).length;
  return { filesReviewed, linesAdded, linesRemoved };
}
