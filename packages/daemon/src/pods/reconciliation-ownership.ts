import type { PodRepository } from './pod-repository.js';

/** Restart/wake is not evidence that a saved worker or cleanup request has stopped. */
export function retainUnresolvedReconciliation(
  podId: string,
  podRepo: PodRepository,
  trigger: 'restart' | 'wake' = 'restart',
): boolean {
  try {
    if (!podRepo.taskExecutions || !podRepo.deletionOwnership)
      throw new Error('Ownership evidence unavailable');
    podRepo.taskExecutions.assertCanDelete(podId);
    podRepo.deletionOwnership.assertTaskAvailable(podId);
    return false;
  } catch {
    // A failed ownership read is also not permission to replace resources. Do not
    // report the pod killed if even this bounded diagnostic cannot be persisted.
    try {
      podRepo.update(podId, {
        lastRecoveryTrigger: trigger,
        lastCorrectionMessage:
          'Recovery paused: task execution or cleanup ownership remains unresolved. Source and resources are retained. Verify the original execution/resource identity and observed termination before retrying; restart or elapsed time is not proof.',
      });
    } catch {
      // Keep the resource untouched even when the database cannot accept a hint.
    }
    return true;
  }
}
