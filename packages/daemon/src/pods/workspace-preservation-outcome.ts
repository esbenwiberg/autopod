import { type Pod, WORKSPACE_PRESERVATION_FAILED } from '@autopod/shared';
import { sanitizeFailureReason } from './completion-diagnostics.js';
import type { PodRepository } from './pod-repository.js';

type PreservationRepo = Pick<PodRepository, 'getOrThrow' | 'update' | 'completionJournal'>;

function isArtifactFinalization(pod: Pod): boolean {
  return pod.options?.output === 'artifact' || pod.completionPolicy === 'accept-findings';
}

/**
 * Record that the worker's container workspace now lives in the host worktree
 * (`Source saved`). The journal phase is kept; only the preservation receipt is
 * added, so artifact/decision routing is unchanged. A previous preservation
 * failure note is cleared because the retained container is no longer the only copy.
 */
export function recordWorkspacePreserved(podRepo: PreservationRepo, pod: Pod): void {
  const journal = podRepo.completionJournal;
  const current = podRepo.getOrThrow(pod.id);
  if (current.lifecycleGeneration === pod.lifecycleGeneration && journal) {
    try {
      let entry = journal.get(current.id, current.lifecycleGeneration);
      // An abnormal exit can end the run before any settlement was journaled.
      // Artifact pods keep their dedicated finalizer as the only settlement owner.
      if (!entry && !isArtifactFinalization(current)) {
        journal.settle(current);
        entry = journal.get(current.id, current.lifecycleGeneration);
      }
      if (entry) journal.mark(current, entry.phase, true);
    } catch {
      // The source is in the host worktree; only the receipt is unavailable, so
      // `Source saved` stays "not verified" rather than claiming a failure.
    }
  }
  const reason = current.failureReason;
  if (reason?.includes(WORKSPACE_PRESERVATION_FAILED)) {
    const cleaned = reason.slice(0, reason.indexOf(WORKSPACE_PRESERVATION_FAILED)).trim();
    podRepo.update(pod.id, { failureReason: cleaned || null });
  }
}

/** Operator-facing explanation and next steps for a retained, unpreserved container. */
export function describeWorkspacePreservationFailure(pod: Pod, error: unknown): string {
  const detail = sanitizeFailureReason(error, WORKSPACE_PRESERVATION_FAILED);
  const container = pod.containerId ? ` ${pod.containerId}` : '';
  return `${detail}. Original container${container} retained — it is the only copy of uncommitted work. Next: ap rework ${pod.id} retries preservation before any teardown and refuses to remove the container if it fails again; or copy /workspace out of the container into the worktree manually; ap kill ${pod.id} discards the unsaved work.`;
}

/**
 * Record a failed preservation on the pod itself so `ap status` shows it beside
 * the failure, without overwriting the original failure reason. Idempotent.
 */
export function recordWorkspacePreservationFailure(
  podRepo: PreservationRepo,
  podId: string,
  error: unknown,
): string {
  const current = podRepo.getOrThrow(podId);
  const note = describeWorkspacePreservationFailure(current, error);
  const base = current.failureReason?.includes(WORKSPACE_PRESERVATION_FAILED)
    ? current.failureReason
        .slice(0, current.failureReason.indexOf(WORKSPACE_PRESERVATION_FAILED))
        .trim()
    : (current.failureReason?.trim() ?? '');
  podRepo.update(podId, { failureReason: base ? `${base} ${note}` : note });
  return note;
}
