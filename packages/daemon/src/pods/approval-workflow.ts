import { AutopodError } from '@autopod/shared';
import type { Pod } from '@autopod/shared';

import type { ApprovalEntryCaptured, ApproveSessionOptions } from './approval-contracts.js';
import { assertApprovalAllowed } from './approval-policy.js';

import { validateTransition } from './state-machine.js';

export function createApprovalWorkflow(captured: ApprovalEntryCaptured) {
  const {
    podRepo,
    resolveApprovalReadiness,
    assertApprovalCurrent,
    logger,
    emitActivityStatus,
    transition,
    persistReadinessApproval,
    cleanupContainerAfterAdvisorySettles,
    eventBus,
    maybeTriggerDependents,
    prepareApprovalDelivery,
    executeApprovalDelivery,
  } = captured;

  const inFlight = new Set<string>();
  async function approveSession(podId: string, options: ApproveSessionOptions = {}): Promise<void> {
    if (inFlight.has(podId)) {
      throw new AutopodError(
        'Approval is already in progress. Wait for its outcome before retrying.',
        'APPROVAL_IN_PROGRESS',
        409,
      );
    }
    inFlight.add(podId);
    try {
      await performApproval(podId, options);
    } finally {
      inFlight.delete(podId);
    }
  }
  async function performApproval(
    podId: string,
    options: ApproveSessionOptions = {},
  ): Promise<void> {
    const actor =
      options.actor ??
      (options.automation
        ? { type: 'automation' as const, id: 'auto-approve' }
        : { type: 'automation' as const, id: 'direct-pod-manager' });
    const pod = podRepo.getOrThrow(podId);
    if (options.publishOnly) {
      const continuation = podRepo.retainedCheckpoints?.latest(podId);
      if (
        actor.type !== 'human' ||
        !actor.userId?.trim() ||
        !continuation?.binding.continuation ||
        continuation.checked?.result.overall !== 'pass' ||
        (pod.options.output ?? 'pr') !== 'pr' ||
        (options.reason?.trim().length ?? 0) < 10
      )
        throw new AutopodError(
          'PR-only publication requires fresh human approval of checked retained source with a reason',
          'PR_PUBLICATION_APPROVAL_REQUIRED',
          409,
        );
    }
    const external = pod.status === 'complete' ? podRepo.externalDeliveries?.get(podId) : null;
    if (
      external &&
      external.generation === pod.lifecycleGeneration &&
      external.prUrl === pod.prUrl &&
      external.retainedSandboxId === pod.containerId &&
      external.worktreePath === pod.worktreePath
    )
      return; // Lost completion replies observe the immutable receipt, never repeat delivery.
    if (pod.completionPolicy === 'accept-findings')
      throw new AutopodError(
        'Use exact-evidence findings acceptance after research is ready',
        'FINDINGS_ACCEPTANCE_REQUIRED',
        409,
      );
    validateTransition(pod.id, pod.status, 'approved');
    emitActivityStatus(podId, 'Preparing approval…');
    const readiness = await resolveApprovalReadiness(pod, { waitForAdvisory: true });
    assertApprovalCurrent(pod);
    const approvalReason = assertApprovalAllowed(podId, readiness, options);
    const prepared = await prepareApprovalDelivery({
      podId,
      options,
      pod,
      readiness,
      actor,
      approvalReason,
    });
    if (prepared.kind === 'halted') return;

    assertApprovalCurrent(pod);
    if (options.publishOnly) {
      if (prepared.recoveredMerge)
        throw new AutopodError(
          'An earlier merge needs its own reconciliation; publication-only does not adopt it',
          'DELIVERY_RECONCILIATION_REQUIRED',
          409,
        );
      // Remain validated throughout, including across a crash. Publication approval
      // must never leave a merging state that startup/polling could interpret as merge authority.
      persistReadinessApproval(
        podId,
        readiness,
        actor,
        `PR publication only. ${approvalReason ?? options.reason}`,
      );
      emitActivityStatus(
        podId,
        'Approved for PR publication only; merge remains a separate human action',
      );
      await executeApprovalDelivery({
        podId,
        options,
        pod,
        mergingAnchor: pod,
        s2: pod,
        ...prepared,
      });
      return;
    }
    emitActivityStatus(podId, 'Approved — merging changes…');
    assertApprovalCurrent(pod);
    const approvedAnchor: Pod = { ...pod, status: 'approved' };
    const mergingAnchor: Pod = { ...pod, status: 'merging' };
    const s1 = transition(pod, 'approved');
    assertApprovalCurrent(approvedAnchor);
    persistReadinessApproval(podId, readiness, actor, approvalReason);
    assertApprovalCurrent(approvedAnchor);
    const s2 = transition(s1, 'merging');
    assertApprovalCurrent(mergingAnchor);
    const executed = await executeApprovalDelivery({
      podId,
      options,
      pod,
      mergingAnchor,
      s2,
      ...prepared,
    });
    if (executed.kind === 'halted') return;

    assertApprovalCurrent(mergingAnchor);
    await cleanupContainerAfterAdvisorySettles(s2, 'approve-complete', 'kill', () =>
      assertApprovalCurrent(mergingAnchor, { allowRemovedContainer: true, allowComplete: true }),
    );
    assertApprovalCurrent(mergingAnchor, { allowRemovedContainer: true });
    const completedPod = transition(s2, 'complete', {
      completedAt: new Date().toISOString(),
      ...(pod.failureReason?.startsWith('Approval delivery failed.')
        ? { failureReason: null }
        : {}),
    });
    assertApprovalCurrent({ ...pod, status: 'complete' }, { allowRemovedContainer: true });

    emitActivityStatus(podId, 'Pod complete');
    assertApprovalCurrent({ ...pod, status: 'complete' }, { allowRemovedContainer: true });
    eventBus.emit({
      type: 'pod.completed',
      timestamp: new Date().toISOString(),
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

    logger.info({ podId, prUrl: pod.prUrl }, 'Pod approved and completed');
    assertApprovalCurrent({ ...pod, status: 'complete' }, { allowRemovedContainer: true });
    maybeTriggerDependents(completedPod);
  }
  return { approveSession };
}
