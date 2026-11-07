import path from 'node:path';
import type { Pod } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import { APPROVAL_SNAPSHOT_EXCLUDES } from './approval-policy.js';
import { collectArtifactSnapshot } from './artifact-preservation.js';
import { verifiedArtifactSnapshotHash } from './artifact-snapshot-receipt.js';
import type { PodRepository } from './pod-repository.js';
import { checkpointError } from './retained-checkpoint-repository.js';

/** Seal coding's real output; this fact is deliberately NOT a checked receipt. */
export async function sealRetainedCodingSource(input: {
  pod: Pod;
  podRepo: PodRepository;
  worktreeManager: WorktreeManager;
  containerManager: ContainerManager;
}) {
  const { pod, podRepo: pods, worktreeManager: worktrees, containerManager: cm } = input;
  const store = pods.retainedCoding ?? checkpointError('Coding ledger unavailable');
  const record = store.assertOwned(pod.id);
  const root =
    pods.retainedCheckpoints?.get(record.id) ?? checkpointError('Original custody unavailable');
  const prepared = root.prepared ?? checkpointError('Selected source missing');
  const worker = record.facts.worker ?? checkpointError('Coding admission missing');
  const candidate = record.facts.candidate ?? checkpointError('Candidate missing');
  const proof =
    record.facts.qualified?.evidence ?? checkpointError('Qualification receipt missing');
  const assertCurrent = () => {
    store.assertCompletedWorker(pod.id);
    const current = pods.getOrThrow(pod.id);
    store.assertOwned(pod.id);
    if (
      current.lifecycleGeneration !== pod.lifecycleGeneration ||
      current.containerId !== candidate.containerId ||
      current.worktreePath !== prepared.worktree ||
      current.launchConfigDigest !== record.binding.executionDigest ||
      current.pendingEscalation ||
      pods.hasUnansweredDecision?.(pod.id) ||
      pods.hasInfrastructureBlocker?.(pod.id) ||
      store.reports(pod.id, root.generation).hash !== record.binding.reportSetHash
    )
      checkpointError('Coding final source owner changed', 'REPAIR_SOURCE_SEAL_FAILED');
    pods.taskExecutions?.assertCanDelete(pod.id);
    pods.validationExecutions?.assertTaskSettled(pod.id);
  };
  assertCurrent();
  if (
    !cm.getResourceKey ||
    !worktrees.inspectSourceAdoption ||
    !worktrees.assertSourceDescendsFrom ||
    !prepared.baseCommitSha
  )
    checkpointError('Exact final source/resource proof unavailable');
  const resourceKey = await cm.getResourceKey(candidate.containerId);
  assertCurrent();
  if (
    resourceKey !== proof.binding.resourceKey ||
    (await cm.getStatus(candidate.containerId)) !== 'running'
  )
    checkpointError('Coding execution resource changed');
  assertCurrent();
  const source = await worktrees.inspectSourceAdoption(prepared.worktree, pod.branch);
  assertCurrent();
  if (!source.worktreeClean || source.branch !== pod.branch)
    checkpointError('Clean committed coding source required');
  await worktrees.assertSourceDescendsFrom(prepared.worktree, prepared.head);
  assertCurrent();
  const artifactRoot = path.join(
    process.env.DATA_DIR ?? path.join(process.cwd(), '.autopod-data'),
    'artifacts',
    pod.id,
  );
  const snapshot = await collectArtifactSnapshot({
    containerManager: cm,
    containerId: candidate.containerId,
    artifactRoot,
    generation: pod.lifecycleGeneration,
    cycle: worker.cycle,
    isCurrent: () => {
      try {
        assertCurrent();
        return true;
      } catch {
        return false;
      }
    },
    excludes: APPROVAL_SNAPSHOT_EXCLUDES,
    wakeupTimeoutMs: 150000,
  });
  assertCurrent();
  const reportsHash = await verifiedArtifactSnapshotHash(
    snapshot,
    artifactRoot,
    pod.lifecycleGeneration,
    worker.cycle,
  );
  assertCurrent();
  const after = await worktrees.inspectSourceAdoption(prepared.worktree, pod.branch);
  assertCurrent();
  if (
    !after.worktreeClean ||
    after.commitSha !== source.commitSha ||
    after.treeSha !== source.treeSha ||
    (await cm.getResourceKey(candidate.containerId)) !== resourceKey
  )
    checkpointError('Final source/resource changed while preserving reports');
  assertCurrent();
  const atomically = pods.atomically ?? checkpointError('Atomic source seal required');
  atomically(() => {
    assertCurrent();
    store.append(record.id, 'final_source', {
      runId: worker.runId,
      generation: pod.lifecycleGeneration,
      cycle: worker.cycle,
      containerId: candidate.containerId,
      resourceKey,
      inputHead: prepared.head,
      head: source.commitSha,
      tree: source.treeSha,
      baseCommitSha: prepared.baseCommitSha!,
      snapshot,
      reportsHash,
      sealedAt: new Date().toISOString(),
    });
    pods.retainedCheckpoints!.append(record.id, 'checking', {
      generation: pod.lifecycleGeneration,
    });
  });
}
