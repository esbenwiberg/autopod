import type { OperatorActor, Pod } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import { atomicPodChange } from '../db/unit-of-work.js';
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
    const pendingDecisionId = pod.finalization?.pendingDecisionId;
    // Repair only the legacy split state created by an earlier force-approval.
    // A fresh human override is required; a cached waiver is never itself a reply.
    const repairingDecision =
      pod.status === 'validated' && Boolean(pendingDecisionId) && pod.validationWaiver != null;
    const allowed =
      repairingDecision ||
      pod.status === 'failed' ||
      pod.status === 'review_required' ||
      pod.status === 'awaiting_input';
    if (!allowed) {
      throw new AutopodError(
        `Cannot force-approve pod ${podId} in status ${pod.status} — expected failed, review_required, awaiting_input, or a validated pod with an unresolved waived decision`,
        'INVALID_STATE',
        409,
      );
    }
    let decision = pod.pendingEscalation;
    if (pendingDecisionId && decision?.id !== pendingDecisionId) {
      if (!repairingDecision || decision) {
        throw new AutopodError(
          'The saved question and durable decision disagree; reconcile before overriding validation.',
          'DECISION_RECONCILIATION_REQUIRED',
          409,
        );
      }
      const saved = escalationRepo.getOrThrow(pendingDecisionId);
      if (
        saved.podId !== podId ||
        saved.response?.actor?.type !== 'human' ||
        !saved.response.response.startsWith('[force-approve] ')
      ) {
        throw new AutopodError(
          'The exact prior human validation override could not be verified; decision retained.',
          'DECISION_RECONCILIATION_REQUIRED',
          409,
        );
      }
      decision = {
        id: saved.id,
        podId: saved.podId,
        type: saved.type,
        payload: saved.payload,
        timestamp: saved.createdAt,
        response: null,
      };
    }
    if (decision && decision.podId !== podId) {
      throw new AutopodError(
        'The pending question belongs to another pod; decision retained.',
        'DECISION_RECONCILIATION_REQUIRED',
        409,
      );
    }
    if (decision && (actor.type !== 'human' || !reason?.trim())) {
      throw new AutopodError(
        'Resolving a pending human decision requires an explicit human override and reason.',
        'HUMAN_DECISION_PENDING',
        409,
      );
    }
    // Reconciliation must not erase prior scope restrictions (e.g. PR-only,
    // no merge). Keep the original waiver alongside the fresh human reason.
    const overrideReason = repairingDecision
      ? `${pod.validationWaiver?.reason}\n\nDecision reconciliation: ${reason}`
      : reason;
    const note = overrideReason
      ? `[FORCE APPROVED] ${overrideReason}`
      : `[FORCE APPROVED] ${actorLabel(actor)} overrode validation — no further agent run needed`;
    const validationWaiver =
      pod.lastValidationResult?.overall === 'fail'
        ? buildValidationWaiver(pod.lastValidationResult, overrideReason, actor)
        : null;
    const forceApprovalMessage = validationWaiver
      ? `Force approved with validation waiver — failed phases: ${validationWaiver.failedPhases.join(', ') || 'unknown'}`
      : pod.lastValidationResult?.overall === 'pass'
        ? `Force approved — existing validation pass accepted by ${actorLabel(actor)}`
        : `Force approved — validation bypassed by ${actorLabel(actor)}`;
    const approvedPod = atomicPodChange(podRepo, () => {
      const updates: Partial<PodUpdates> = {
        lastCorrectionMessage: note,
        ...(validationWaiver ? { validationWaiver } : {}),
      };
      if (decision) {
        const response = `[force-approve] ${overrideReason}`;
        // Record the durable receipt before clearing the question, in the same
        // transaction as the waiver and transition. Never enqueue agent guidance.
        podRepo.completionJournal?.recordReply(
          { ...pod, pendingEscalation: decision },
          response,
          actor,
        );
        escalationRepo.update(decision.id, {
          respondedAt: new Date().toISOString(),
          respondedBy: legacyRespondedBy(actor),
          actor,
          response,
        });
        updates.pendingEscalation = null;
      }
      let approved: Pod;
      if (repairingDecision) {
        podRepo.update(podId, updates);
        refreshReadiness(podId);
        approved = podRepo.getOrThrow(podId);
      } else {
        approved = transition(pod, 'validated', updates);
      }
      if (podRepo.hasUnansweredDecision?.(podId)) {
        throw new AutopodError(
          'An unresolved human decision remains; the validation override was not applied.',
          'HUMAN_DECISION_PENDING',
          409,
        );
      }
      return approved;
    });
    emitActivityStatus(podId, forceApprovalMessage);
    logger.info(
      { podId, reason, validationWaiver },
      'Pod force-approved, transitioning to validated',
    );
    if (!repairingDecision) maybeTriggerDependents(approvedPod);
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
