import { atomicPodChange } from '../db/unit-of-work.js';
import { rewriteHash } from './approval-source-rewrite-repository.js';
import type { PodRepository } from './pod-repository.js';
import { validateTransition } from './state-machine.js';

/** Startup only, before serving controls. Preparing an isolated candidate cannot
 * have sent a merge or changed the original source. Release only the interrupted
 * approval status, never an execution/request hold or a source mutation.
 */
export function reconcileApprovalRewritesOnStartup(pods: PodRepository): string[] {
  const recovered: string[] = [];
  for (const pod of pods.list({ status: 'merging' })) {
    const row = pods.approvalRewrites?.latest(pod);
    if (
      !row ||
      row.activated ||
      row.generation !== pod.lifecycleGeneration ||
      row.binding.worktreePath !== pod.worktreePath ||
      row.binding.containerId !== pod.containerId ||
      row.binding.prUrl !== pod.prUrl ||
      row.binding.validationHash !== rewriteHash(pod.lastValidationResult)
    )
      continue;
    try {
      pods.mergeJournal?.assertPublicationAllowed?.(row.binding.prUrl);
      const merge = pods.mergeJournal?.find(pod);
      if (
        merge &&
        (merge.state === 'admitted' || merge.result?.autoMergeScheduled || merge.state === 'merged')
      )
        continue;
      pods.taskExecutions?.assertCanDelete(pod.id); // Observation only; no resource release.
      pods.validationExecutions?.assertTaskSettled(pod.id);
      pods.deletionOwnership?.assertTaskAvailable(pod.id);
      const changed = atomicPodChange(pods, () => {
        const current = pods.getOrThrow(pod.id);
        if (
          current.status !== 'merging' ||
          current.lifecycleGeneration !== row.generation ||
          current.containerId !== row.binding.containerId ||
          current.worktreePath !== row.binding.worktreePath ||
          current.prUrl !== row.binding.prUrl ||
          rewriteHash(current.lastValidationResult) !== row.binding.validationHash
        )
          return false;
        validateTransition(pod.id, current.status, 'validated');
        pods.update(pod.id, {
          status: 'validated',
          failureReason: `Approval delivery failed. Rewrite ${row.id} preparation was interrupted. Inspect source-recovery; ordinary approval may verify a prepared candidate, but missing preparation evidence cannot be replayed. Original resources retained.`,
        });
        return true;
      });
      if (changed) recovered.push(pod.id);
    } catch {
      // An uncertain execution/merge remains held. Startup is not proof of failure.
    }
  }
  return recovered;
}
