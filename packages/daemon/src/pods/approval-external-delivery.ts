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
import type { ExternalDeliverySourceProof } from './external-delivery-repository.js';
import { publicSourceRepository } from './validation-source-evidence.js';

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
    !pod.containerId ||
    podRepo.mergeJournal?.find(pod)
  )
    return false;
  // Local publication-backed merges use the native merge journal owner. The
  // receipt below is reserved for historical missing-publication delivery.
  const publication = podRepo.sourcePublications?.latestConfirmedForMerge?.(pod);
  if (podRepo.sourcePublications?.pending?.(pod))
    mergeReconciliation(
      'An earlier publication remains unconfirmed. Observe that durable operation through source-recovery; a historical delivery receipt cannot settle or replace it.',
    );
  if (pod.executionTarget === 'local' && publication) return false;
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
  if (podRepo.approvalRewrites?.latest(pod))
    mergeReconciliation(
      'The source rewrite owns delivery. Inspect source-recovery; ordinary external observation cannot clear its custody.',
    );
  if (actor.type !== 'human' || !actor.userId.trim())
    mergeReconciliation('An authenticated human must reconcile this externally merged legacy PR.');
  if (!publication && (context.options.reason?.trim().length ?? 0) < 10)
    mergeReconciliation(
      'Historical external delivery requires authenticated human approval with an explicit reason binding this task and retained source. Inspect its immutable validation-source proof first.',
    );
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
  try {
    repository = publicSourceRepository(repository);
  } catch {
    mergeReconciliation('The task repository public identity is unavailable.');
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
  const checked = publication
    ? { head: publication.commitSha, tree: publication.treeSha, validationId: null }
    : podRepo.validationSources?.checked(pod, profile);
  if (!checked || checked.head !== source.commitSha || checked.tree !== source.treeSha)
    mergeReconciliation(
      'No immutable validation-source proof matches the retained commit/tree for this task, generation, target and resource. Inspect source-recovery and the owning validation evidence; a historical publication cannot be backfilled.',
    );
  if (publication)
    assertMergeTarget(target, {
      ...target,
      repository: publication.repository,
      branch: publication.branch,
    });
  if (
    !source.worktreeClean ||
    source.branch !== pod.branch ||
    !sourceCommit(source.treeSha) ||
    !sourceCommit(source.commitSha) ||
    !sourceCommit(status.headSha)
  )
    mergeReconciliation(
      'Retained source identity is unavailable or dirty; retain it for reconciliation.',
    );
  const ancestry =
    source.commitSha === status.headSha
      ? undefined
      : await provider.verifyMergedSourceAncestry?.({
          prUrl: pod.prUrl,
          publishedHeadSha: source.commitSha,
          mergedHeadSha: status.headSha as string,
          expectedTarget: target,
        });
  assertApprovalCurrent(pod);
  if (source.commitSha !== status.headSha) {
    if (
      !ancestry ||
      ancestry.publishedHeadSha !== source.commitSha ||
      ancestry.mergedHeadSha !== status.headSha ||
      !Number.isFinite(Date.parse(ancestry.observedAt))
    )
      mergeReconciliation('The completed PR does not prove inclusion of the retained source.');
    assertMergeTarget(target, ancestry.target);
    const after = await worktreeManager.inspectSource(pod.worktreePath, pod.branch);
    assertApprovalCurrent(pod);
    if (
      !after.worktreeClean ||
      after.branch !== source.branch ||
      after.commitSha !== source.commitSha ||
      after.treeSha !== source.treeSha
    )
      mergeReconciliation('Retained source changed during external delivery observation.');
  }
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
    ...(ancestry ? { mergedHeadSha: ancestry.mergedHeadSha, ancestry } : {}),
    validationTimestamp: pod.lastValidationResult.timestamp,
    observedAt: now,
    recordedAt: now,
    actor,
    reason:
      approvalReason ??
      'Human approval reconciled provider-proven external delivery. Additional commits are not validated by this observation. Reports remain pending; original recovery resources are retained.',
    retainedSandboxId: pod.containerId,
    sandboxStatusAtObservation: sandboxStatus,
    worktreePath: pod.worktreePath,
    reports: 'pending',
  };
  const completed = atomicPodChange(podRepo, () => {
    assertApprovalCurrent(pod);
    podRepo.deletionOwnership?.assertTaskAvailable(podId);
    const sourceProof: ExternalDeliverySourceProof = publication
      ? { publicationId: publication.publicationId, validationId: null }
      : checked.validationId
        ? { publicationId: null, validationId: checked.validationId }
        : mergeReconciliation('Immutable external source evidence reference unavailable.');
    receipts.record(receipt, sourceProof, () => {
      assertApprovalCurrent(pod);
      const proof = publication
        ? podRepo.sourcePublications?.latestConfirmedForMerge?.(pod)
        : podRepo.validationSources?.checked(pod, profile);
      if (
        !proof ||
        ('commitSha' in proof
          ? proof.commitSha !== source.commitSha || proof.treeSha !== source.treeSha
          : proof.head !== source.commitSha || proof.tree !== source.treeSha)
      )
        mergeReconciliation('External delivery source proof changed before settlement.');
    });
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
    `External delivery verified for retained source ${receipt.headSha}${ancestry ? ` in merged source ${ancestry.mergedHeadSha} by provider ancestry` : ''}. Receipt ${receipt.id}. Workspace reports remain pending; original sandbox ${receipt.retainedSandboxId} and worktree are retained, not cleaned up. No merge, push or wakeup was requested.`,
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
