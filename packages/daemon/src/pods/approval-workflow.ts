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
