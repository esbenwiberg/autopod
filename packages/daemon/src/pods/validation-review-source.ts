import { AutopodError, type Pod } from '@autopod/shared';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import { parseDiffFilePaths } from '../validation/review-context-builder.js';
import { isAutoCommitIgnoreReason } from '../worktrees/source-adoption-git.js';
import { TaskRetryBlockedError } from './task-retry-ledger.js';

export interface ReviewSourceChanges {
  untracked: string[];
  changed: string[];
}

export const REVIEW_SOURCE_DIRTY = 'REVIEW_SOURCE_DIRTY';
const DIRTY_REASON_PREFIX = 'Review source has uncommitted files';
const MAX_SUMMARY_GROUPS = 3;
const MAX_FEEDBACK_PATHS = 30;
const SOURCE_CHANGED = 'Source changed while computing review input';

function displayPath(value: string, max = 200): string {
  // Paths come from the worker's workspace: strip control characters and bound
  // length before they reach activity, failure reasons or agent prompts.
  const cleaned = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? '?' : character;
  }).join('');
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function summarizeGroup(label: string, paths: string[]): string | null {
  if (paths.length === 0) return null;
  const groups = new Map<string, number>();
  for (const entry of paths) {
    const slash = entry.indexOf('/');
    const key = slash === -1 ? '' : entry.slice(0, slash);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const parts = ordered.slice(0, MAX_SUMMARY_GROUPS).map(([group, count]) => {
    const noun = count === 1 ? 'path' : 'paths';
    return group ? `${count} ${noun} under ${displayPath(group, 60)}/` : `${count} ${noun} at root`;
  });
  const rest = ordered.length - MAX_SUMMARY_GROUPS;
  if (rest > 0) parts.push(`${rest} more location${rest === 1 ? '' : 's'}`);
  return `${label}: ${parts.join(', ')}`;
}

/** Sanitized, directory-level description suitable for status and logs. */
export function summarizeReviewSourceChanges(changes: ReviewSourceChanges): string {
  return (
    [summarizeGroup('untracked', changes.untracked), summarizeGroup('uncommitted', changes.changed)]
      .filter(Boolean)
      .join('; ') || 'uncommitted changes'
  );
}

/** The worktree is otherwise readable but holds bytes outside its committed source. */
export class ReviewSourceDirtyError extends TaskRetryBlockedError {
  readonly summary: string;
  constructor(readonly changes: ReviewSourceChanges) {
    const summary = summarizeReviewSourceChanges(changes);
    super(
      `${DIRTY_REASON_PREFIX} (${summary}). Request rework so the agent commits what belongs to the change and removes the rest; no checks or reviewer approval were produced.`,
      REVIEW_SOURCE_DIRTY,
    );
    this.summary = summary;
  }
}

export function isReviewSourceDirtyReason(reason: string | null | undefined): boolean {
  return reason?.startsWith(DIRTY_REASON_PREFIX) ?? false;
}

/** Explain the existing recovery path without admitting a retry. */
export function dirtyReviewSourceRecoveryHint(pod: Pod | undefined): string | undefined {
  if (
    pod?.worktreePath &&
    !pod.worktreeCompromised &&
    ((pod.status === 'review_required' && isReviewSourceDirtyReason(pod.failureReason)) ||
      (pod.status === 'failed' && isAutoCommitIgnoreReason(pod.failureReason)))
  )
    return `Finalization could not verify committed source. To ask the agent to inspect and clean the preserved worktree, run ap rework ${pod.id}. Normal rework eligibility and retry permissions still apply.`;
  return undefined;
}

function listPaths(paths: string[]): string[] {
  const shown = paths.slice(0, MAX_FEEDBACK_PATHS).map((entry) => `- \`${displayPath(entry)}\``);
  if (paths.length > MAX_FEEDBACK_PATHS)
    shown.push(`- …and ${paths.length - MAX_FEEDBACK_PATHS} more`);
  return shown;
}

/** Agent-facing correction naming the exact paths the host observed. */
export function buildDirtySourceCorrection(changes: ReviewSourceChanges): string {
  return [
    '## Workspace not clean — validation did not run',
    '',
    'Autopod reads your change from committed source only. Its copy of your workspace still contains files that are not committed, so no checks or review ran.',
    '',
    ...(changes.untracked.length > 0
      ? ['Untracked paths:', ...listPaths(changes.untracked), '']
      : []),
    ...(changes.changed.length > 0
      ? ['Uncommitted changes to tracked paths:', ...listPaths(changes.changed), '']
      : []),
    'For each path: commit it if it belongs to this change; otherwise delete it. Keep scratch notes outside `/workspace` (for example under `/tmp`).',
    "`.git/info/exclude` inside this container is not shared with Autopod's host copy, so excluding a path there does not hide it.",
    'Then finish as before. Validation reruns automatically.',
  ].join('\n');
}

function sanitizedCause(error: unknown): string {
  // Source-adoption guards use fixed, path-free messages. Raw Git/exec errors
  // can echo paths or credentials, so only their category is recorded.
  if (error instanceof AutopodError && error.code === 'SOURCE_ADOPTION_BLOCKED')
    return error.message;
  if (error instanceof Error && error.message === SOURCE_CHANGED) return SOURCE_CHANGED;
  return 'Git source observation failed';
}

type ReviewSourceManager = Pick<
  WorktreeManager,
  | 'getDiff'
  | 'getCommitLog'
  | 'getChangedPathsAgainstBase'
  | 'inspectSourceAdoption'
  | 'inspectSourcePreservation'
>;

async function dirtyChanges(
  manager: ReviewSourceManager,
  worktreePath: string,
  branch: string,
): Promise<ReviewSourceChanges | null> {
  if (!manager.inspectSourcePreservation) return null;
  try {
    const observed = await manager.inspectSourcePreservation(worktreePath, branch);
    if (observed.branch !== branch || observed.worktreeClean) return null;
    return observed.changes ?? { untracked: [], changed: [] };
  } catch {
    return null;
  }
}

/** Read a review packet between strict clean source observations. A dirty
 * worktree fails with its sanitized paths so the worker or operator can clean
 * it; other failures retain a path-free cause. Neither runs checks. */
export async function captureReviewSource(
  manager: ReviewSourceManager,
  worktreePath: string,
  branch: string,
  base: string,
  limit: number | undefined,
  since: string | undefined,
  log?: { warn(details: object, message: string): void },
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
        throw new Error(SOURCE_CHANGED);
      if (before.worktreeClean && after.worktreeClean)
        reviewSource = { head: before.commitSha, tree: before.treeSha };
    }
    return { diff, commitLog, changedPathsAgainstBase, reviewSource };
  } catch (error) {
    const changes = await dirtyChanges(manager, worktreePath, branch);
    if (changes) {
      const dirty = new ReviewSourceDirtyError(changes);
      log?.warn(
        { worktreePath, code: REVIEW_SOURCE_DIRTY, summary: dirty.summary },
        'Review source is dirty',
      );
      throw dirty;
    }
    const cause = sanitizedCause(error);
    log?.warn(
      { worktreePath, code: 'REVIEW_SOURCE_UNAVAILABLE', cause },
      'Review source could not be read consistently',
    );
    throw new TaskRetryBlockedError(
      `Review source could not be read consistently (${cause}). Restore its exact source/ref before retrying; no checks or reviewer approval were produced.`,
      'REVIEW_SOURCE_UNAVAILABLE',
    );
  }
}
