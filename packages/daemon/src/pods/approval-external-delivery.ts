import { randomUUID } from 'node:crypto';
import type { ExternalDeliveryReceipt, Pod } from '@autopod/shared';
import { atomicPodChange } from '../db/unit-of-work.js';
import {
  assertMergeTarget,
  mergeReconciliation,
  sourceCommit,
} from '../worktrees/merge-source-identity.js';
import type { ApprovalDeliveryPreparationCaptured } from './approval-contracts.js';
import type { ApprovalPreparationContext } from './delivery-contracts.js';
import { withExternalDeliveryReadiness } from './external-delivery-readiness.js';

/** Observe an already completed legacy PR. Never send a push/merge/resume/delete. */
export async function reconcileExternalApproval(
  captured: ApprovalDeliveryPreparationCaptured,
  context: ApprovalPreparationContext,
): Promise<boolean> {
  const { pod, podId, actor, approvalReason, readiness } = context;
  const {
    podRepo,
    assertApprovalCurrent,
    executionForPod,
    worktreeManager,
    prManagerFactory,
    transition,
    persistReadinessApproval,
    emitActivityStatus,
    eventBus,
    maybeTriggerDependents,
  } = captured;
  if (
    !pod.prUrl ||
    pod.options.output !== 'pr' ||
    pod.options.agentMode !== 'auto' ||
    pod.executionTarget !== 'sandbox' ||
    !pod.containerId ||
    podRepo.mergeJournal?.find(pod)
  )
    return false;
  const profile = executionForPod(pod);
  const provider = prManagerFactory?.(profile);
  if (!provider)
    mergeReconciliation('The PR provider is unavailable; no sandbox wakeup was attempted.');
  const status = await provider.getPrStatus({
    prUrl: pod.prUrl,
    worktreePath: pod.worktreePath ?? undefined,
  });
  assertApprovalCurrent(pod);
  if (!status.merged) {
    if (!status.open) mergeReconciliation('The existing PR is closed without a merge.');
    return false;
  }
  if (actor.type !== 'human' || !actor.userId.trim())
    mergeReconciliation('An authenticated human must reconcile this externally merged legacy PR.');
  const receipts = podRepo.externalDeliveries;
  if (pod.worktreeCompromised || !pod.worktreePath || !worktreeManager.inspectSource || !receipts)
    mergeReconciliation('Retained local source cannot be verified for the external merge.');
  if (pod.lastValidationResult?.overall !== 'pass' || !pod.lastValidationResult.timestamp)
    mergeReconciliation(
      'External delivery observation does not waive missing or failed validation.',
    );
  let repository = profile.repoUrl;
  if (!repository) mergeReconciliation('The task repository is unavailable.');
  // Old ADO URLs can carry a username. Strip auth from recorded/public identity,
  // never from a diagnostic string. Target comparison still validates host/path.
  if (!repository.startsWith('git@github.com:')) {
    try {
      const url = new URL(repository);
      url.username = '';
      url.password = '';
      repository = url.toString();
    } catch {
      mergeReconciliation('The task repository public identity is unavailable.');
    }
  }
  const baseBranch = pod.baseBranch ?? profile.defaultBranch;
  if (!status.sourceTarget || !pod.branch || !baseBranch)
    mergeReconciliation('The provider did not return exact repository/source/base identity.');
  const target = { repository, branch: pod.branch, baseBranch };
  assertMergeTarget(target, status.sourceTarget);
  const sandboxStatus = await captured.containerManagerFactory
    .get(pod.executionTarget)
    .getStatus(pod.containerId);
  assertApprovalCurrent(pod);
  if (sandboxStatus !== 'running' && sandboxStatus !== 'stopped')
    mergeReconciliation('The original sandbox recovery resource could not be confirmed present.');
  const source = await worktreeManager.inspectSource(pod.worktreePath, pod.branch);
  assertApprovalCurrent(pod);
  if (
    !source.worktreeClean ||
    source.branch !== pod.branch ||
    !sourceCommit(source.treeSha) ||
    !sourceCommit(status.headSha) ||
    source.commitSha !== status.headSha
  )
    mergeReconciliation(
      'Retained source does not exactly match the completed PR. No ancestry or checkpoint exemption was inferred.',
    );
  const now = new Date().toISOString();
  const receipt: ExternalDeliveryReceipt = {
    id: randomUUID(),
    podId,
    generation: pod.lifecycleGeneration,
    prUrl: pod.prUrl,
    repository,
    branch: pod.branch,
    baseBranch: target.baseBranch,
    headSha: source.commitSha,
    treeSha: source.treeSha,
    validationTimestamp: pod.lastValidationResult.timestamp,
    observedAt: now,
    recordedAt: now,
    actor,
    reason:
      approvalReason ??
      'Human approval reconciled a provider-confirmed external merge. Reports remain pending; original recovery resources are retained.',
    retainedSandboxId: pod.containerId,
    sandboxStatusAtObservation: sandboxStatus,
    worktreePath: pod.worktreePath,
    reports: 'pending',
  };
  const completed = atomicPodChange(podRepo, () => {
    assertApprovalCurrent(pod);
    podRepo.deletionOwnership?.assertTaskAvailable(podId);
    receipts.record(receipt);
    const approved = transition(pod, 'approved');
    persistReadinessApproval(podId, readiness, actor, approvalReason);
    const currentReview = podRepo.getOrThrow(podId).readinessReview;
    if (!currentReview) throw new Error('Readiness approval evidence unavailable');
    podRepo.update(podId, {
      readinessReview: withExternalDeliveryReadiness(currentReview, receipt),
    });
    const merging = transition(approved, 'merging');
    return transition(merging, 'complete', {
      completedAt: now,
      failureReason: null,
      mergeBlockReason: null,
    });
  });
  const anchor: Pod = { ...pod, status: 'complete' };
  assertApprovalCurrent(anchor);
  emitActivityStatus(
    podId,
    `External delivery verified at exact source ${receipt.headSha}. Receipt ${receipt.id}. Workspace reports remain pending; original sandbox ${receipt.retainedSandboxId} and worktree are retained, not cleaned up. No merge, push or wakeup was requested.`,
  );
  eventBus.emit({
    type: 'pod.completed',
    timestamp: now,
    podId,
    finalStatus: 'complete',
    summary: {
      id: podId,
      profileName: pod.profileName,
      task: pod.task,
      status: 'complete',
      model: pod.model,
      runtime: pod.runtime,
      duration: pod.startedAt ? Date.now() - new Date(pod.startedAt).getTime() : null,
      filesChanged: pod.filesChanged,
      createdAt: pod.createdAt,
    },
  });
  assertApprovalCurrent(anchor);
  maybeTriggerDependents(completed);
  return true;
}
