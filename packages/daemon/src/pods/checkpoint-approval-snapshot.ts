import type { Pod } from '@autopod/shared';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import { inspectCheckpointSource } from '../worktrees/checkpoint-source-identity.js';
import { verifyArtifactSnapshot } from './artifact-snapshot-receipt.js';
import type { PodRepository } from './pod-repository.js';
import { checkpointError, checkpointHash } from './retained-checkpoint-repository.js';

/** Reuse only the exact new-execution receipt; this never substitutes the original's reports. */
export async function verifiedCheckpointApprovalSnapshot(input: {
  pod: Pod;
  podRepo: PodRepository;
  worktreeManager: WorktreeManager;
  artifactRoot: string;
  assertCurrent(): void;
}): Promise<string | null> {
  const { pod, podRepo, worktreeManager, artifactRoot, assertCurrent } = input;
  const recovery = podRepo.retainedCheckpoints?.latest(pod.id);
  if (!recovery?.checked || recovery.activated?.generation !== pod.lifecycleGeneration) return null;
  const saved = recovery.checked.snapshot;
  const prepared = recovery.prepared;
  // An explicit later validation/source edit must collect its own new reports.
  if (!saved || recovery.checked.resultHash !== checkpointHash(pod.lastValidationResult))
    return null;
  if (
    !prepared ||
    saved.containerId !== pod.containerId ||
    saved.path !== pod.artifactsPath ||
    saved.cycle !== (pod.finalization?.cycle ?? 0) ||
    pod.worktreePath !== prepared.worktree ||
    pod.branch !== recovery.binding.branch ||
    !worktreeManager.inspectSourceAdoption
  )
    checkpointError(
      'Saved checkpoint reports no longer match this execution',
      'CHECKPOINT_REPORTS_UNVERIFIED',
    );
  await inspectCheckpointSource({
    podId: pod.id,
    worktreePath: prepared.worktree,
    branch: pod.branch,
    head: recovery.infrastructure?.candidate?.head ?? recovery.selected?.head ?? prepared.head,
    tree: recovery.infrastructure?.candidate?.tree ?? recovery.selected?.tree ?? prepared.tree,
    worktreeManager,
    assertCurrent,
  });
  await verifyArtifactSnapshot(saved.path, artifactRoot, pod.lifecycleGeneration, saved.cycle);
  assertCurrent();
  return saved.path;
}
