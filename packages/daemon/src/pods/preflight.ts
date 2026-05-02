import type { Pod, PreflightConflict } from '@autopod/shared';
import { findGlobOverlaps } from './glob-overlap.js';
import { isTerminalState } from './state-machine.js';

export type { PreflightConflict };

export interface PreflightCandidate {
  /** Touches list of the pod being created. Empty/missing → preflight is a no-op. */
  touches: readonly string[];
  /** Repo URL the new pod targets. Pods on different repos can't conflict. */
  repoUrl: string | null;
  /** Base branch the new pod targets. Pods on different bases can't conflict. */
  baseBranch: string;
}

/**
 * Compute preflight conflicts between a candidate pod and the set of in-flight
 * pods. Pure function: caller supplies the candidates and the existing-pod
 * list; we don't read from the database here.
 *
 * Filters applied (in this order, cheapest first):
 *   1. New pod has no `touches` → no signal, return empty (zero false positives).
 *   2. Existing pod is in a terminal state → can't conflict.
 *   3. Existing pod has no `touches` → can't compare → skip.
 *   4. Different repo OR different base branch → can't conflict.
 *   5. Glob-prefix overlap detection on the `touches` arrays.
 *
 * The `repoUrl` per existing pod is resolved by the caller (the `Pod` row
 * doesn't carry `repoUrl` directly — it's on the profile). We pass it in so
 * this function stays pure and testable.
 */
export function findPreflightConflicts(
  candidate: PreflightCandidate,
  existingPods: ReadonlyArray<{ pod: Pod; repoUrl: string | null }>,
): PreflightConflict[] {
  if (candidate.touches.length === 0) return [];

  const conflicts: PreflightConflict[] = [];
  for (const { pod, repoUrl } of existingPods) {
    if (isTerminalState(pod.status)) continue;
    if (!pod.touches || pod.touches.length === 0) continue;
    if (repoUrl !== candidate.repoUrl) continue;

    // The pod row's baseBranch may be null when the profile default is in
    // effect — caller is responsible for filtering by base before passing in,
    // but defend against missing data here too.
    const podBase = pod.baseBranch ?? candidate.baseBranch;
    if (podBase !== candidate.baseBranch) continue;

    const overlaps = findGlobOverlaps(candidate.touches, pod.touches);
    if (overlaps.length === 0) continue;

    conflicts.push({
      conflictingPodId: pod.id,
      conflictingPodTask: pod.task,
      conflictingPodStatus: pod.status,
      overlappingGlobs: overlaps,
    });
  }
  return conflicts;
}
