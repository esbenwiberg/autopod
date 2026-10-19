import type { OperatorActor } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import type {
  ApprovalControlCalls,
  ApprovalControlsCaptured,
  ApproveAllSkippedPod,
} from './approval-contracts.js';
import {
  actorLabel,
  buildValidationWaiver,
  legacyRespondedBy,
  readinessSkipReason,
  taskSummaryWithApprovedFactWaiver,
} from './approval-policy.js';
import type { PodUpdates } from './pod-repository.js';

export function createApprovalControls(captured: ApprovalControlsCaptured) {
  const {
    podRepo,
    resolveApprovalReadiness,
    logger,
    nudgeRepo,
    validationRepo,
    emitActivityStatus,
    escalationRepo,
    transition,
    maybeTriggerDependents,
    refreshReadiness,
  } = captured;

  async function approveAllValidated(
    this: ApprovalControlCalls,
  ): Promise<{ approved: string[]; skipped: ApproveAllSkippedPod[] }> {
    const validated = podRepo.list({ status: 'validated' });
    const approved: string[] = [];
    const skipped: ApproveAllSkippedPod[] = [];
    for (const pod of validated) {
      try {
        const readiness = await resolveApprovalReadiness(pod, { waitForAdvisory: true });
        if (readiness.status !== 'ready') {
          skipped.push({
            podId: pod.id,
            status: readiness.status,
            reason: readinessSkipReason(readiness),
          });
          continue;
        }
        await this.approveSession(pod.id, { automation: true });
        approved.push(pod.id);
      } catch (err) {
        logger.warn({ err, podId: pod.id }, 'Failed to approve pod in bulk');
      }
    }
    return { approved, skipped };
  }

  async function approveFactWaiver(
    this: ApprovalControlCalls,
    podId: string,
    factId: string,
    reason?: string,
    actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
  ): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }> {
    const pod = podRepo.getOrThrow(podId);
    const isSettled = pod.status === 'failed' || pod.status === 'review_required';
    const canRevalidateImmediately =
      isSettled &&
      !nudgeRepo.hasPending(podId) &&
      !podRepo.taskExecutions?.hasUnverifiedTermination(podId);
    const canRecordForActiveRun = pod.status === 'running' || pod.status === 'validating';
    if (!isSettled && !canRecordForActiveRun) {
      throw new AutopodError(
        `Cannot approve fact waiver for pod ${podId} in status ${pod.status} — only running, validating, failed, or review_required pods`,
        'INVALID_STATE',
        409,
      );
    }

    const latestFact = pod.lastValidationResult?.factValidation?.results.find(
      (result) => result.factId === factId,
    );
    const historicalFact = validationRepo
      ? [...validationRepo.getForSession(podId)]
          .reverse()
          .map((validation) =>
            validation.result.factValidation?.results.find((result) => result.factId === factId),
          )
          .find((result) => result !== undefined)
      : undefined;
    // Operator interruption/kick can replace lastValidationResult with a
    // partial snapshot whose fact phase is skipped. The completed attempt is
    // still durable in validation history and remains the waiver authority.
    const fact = latestFact ?? historicalFact;
    if (!fact) {
      throw new AutopodError(
        `Required fact ${factId} was not found in validation results for pod ${podId}`,
        'NOT_FOUND',
        404,
      );
    }
    // A later agent summary can overwrite the decision field even though a
    // completed validation already persisted the human-approved waiver.
    // Re-approving that durable waived result is idempotent: rebuild the
    // decision in the current summary and revalidate the same worktree.
    if (fact.status !== 'pending_human' && fact.status !== 'waived') {
      throw new AutopodError(
        `Required fact ${factId} is ${fact.status ?? (fact.passed ? 'pass' : 'fail')}, not pending_human`,
        'INVALID_STATE',
        409,
      );
    }

    const nextTaskSummary = taskSummaryWithApprovedFactWaiver(pod.taskSummary, fact, reason, actor);
    podRepo.update(podId, { taskSummary: nextTaskSummary });
    emitActivityStatus(
      podId,
      canRevalidateImmediately
        ? `${actorLabel(actor)} approved waiver for required fact ${factId} — revalidating existing worktree`
        : `${actorLabel(actor)} approved waiver for required fact ${factId} — next validation will use the decision`,
    );

    if (!canRevalidateImmediately) {
      return { newCommits: false, result: 'fail' };
    }

    return this.revalidateSession(podId, { force: true });
  }

  async function forceApprove(
    podId: string,
    reason?: string,
    actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
  ): Promise<void> {
    const pod = podRepo.getOrThrow(podId);
    const allowed =
      pod.status === 'failed' ||
      pod.status === 'review_required' ||
      pod.status === 'awaiting_input';
    if (!allowed) {
      throw new AutopodError(
        `Cannot force-approve pod ${podId} in status ${pod.status} — only failed, review_required, or awaiting_input pods`,
        'INVALID_STATE',
        409,
      );
    }
    const note = reason
      ? `[FORCE APPROVED] ${reason}`
      : `[FORCE APPROVED] ${actorLabel(actor)} overrode validation — no further agent run needed`;
    const validationWaiver =
      pod.lastValidationResult?.overall === 'fail'
        ? buildValidationWaiver(pod.lastValidationResult, reason, actor)
        : null;
    const forceApprovalMessage = validationWaiver
      ? `Force approved with validation waiver — failed phases: ${validationWaiver.failedPhases.join(', ') || 'unknown'}`
      : pod.lastValidationResult?.overall === 'pass'
        ? `Force approved — existing validation pass accepted by ${actorLabel(actor)}`
        : `Force approved — validation bypassed by ${actorLabel(actor)}`;
    podRepo.update(podId, {
      lastCorrectionMessage: note,
      ...(validationWaiver ? { validationWaiver } : {}),
    });

    // Resolve any pending escalation so it doesn't dangle in the audit trail
    // and pendingEscalation gets cleared on the transition.
    const updates: Partial<PodUpdates> = {};
    if (pod.pendingEscalation) {
      escalationRepo.update(pod.pendingEscalation.id, {
        respondedAt: new Date().toISOString(),
        respondedBy: legacyRespondedBy(actor),
        actor,
        response: `[force-approve] ${reason ?? `${actorLabel(actor)} override`}`,
      });
      updates.pendingEscalation = null;
    }
    const approvedPod = transition(pod, 'validated', updates);
    emitActivityStatus(podId, forceApprovalMessage);
    logger.info(
      { podId, reason, validationWaiver },
      'Pod force-approved, transitioning to validated',
    );
    maybeTriggerDependents(approvedPod);
  }

  function refreshReadinessAfterQualityScore(podId: string): boolean {
    return refreshReadiness(podId, { advisoryQaInFlight: false });
  }
  return {
    approveAllValidated,
    approveFactWaiver,
    forceApprove,
    refreshReadinessAfterQualityScore,
  };
}
