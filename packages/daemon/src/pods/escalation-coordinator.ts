import { isDeepStrictEqual } from 'node:util';
import {
  AutopodError,
  EscalationNotFoundError,
  type EscalationRequest,
  type OperatorActor,
  type Pod,
} from '@autopod/shared';
import { atomicPodChange } from '../db/unit-of-work.js';
import type { EscalationRepository } from './escalation-repository.js';
import type { PodRepository } from './pod-repository.js';

/** The durable question and its actionable pod state must commit together. */
export function persistEscalation(
  pods: PodRepository,
  escalations: EscalationRepository,
  request: EscalationRequest,
  publishPendingState: () => void,
): void {
  atomicPodChange(pods, () => {
    const pod = pods.getOrThrow(request.podId);
    const blocking = [
      'ask_human',
      'report_blocker',
      'action_approval',
      'request_credential',
      'validation_override',
    ].includes(request.type);
    let existing: ReturnType<EscalationRepository['getOrThrow']> | undefined;
    try {
      existing = escalations.getOrThrow(request.id);
    } catch (error) {
      if (!(error instanceof EscalationNotFoundError)) throw error;
    }
    if (existing) {
      if (
        existing.podId !== request.podId ||
        existing.type !== request.type ||
        !isDeepStrictEqual(existing.payload, request.payload)
      )
        throw new AutopodError(
          'This decision ID already has different content.',
          'ESCALATION_ID_CONFLICT',
          409,
        );
      if (!existing.response && blocking && pod.pendingEscalation?.id !== request.id)
        throw new AutopodError(
          'Stored unanswered decision needs operator reconciliation before it can be resumed.',
          'ESCALATION_RECONCILIATION_REQUIRED',
          409,
        );
      return;
    }
    if (blocking && pod.pendingEscalation && pod.pendingEscalation.id !== request.id)
      throw new AutopodError(
        'Pod already has an unanswered decision. Resolve that question before requesting another.',
        'ESCALATION_ALREADY_PENDING',
        409,
      );
    if (blocking && !['running', 'queued', 'validating'].includes(pod.status))
      throw new AutopodError(
        'A new unanswered decision cannot be attached in the current pod state.',
        'ESCALATION_STATE_CONFLICT',
        409,
      );
    escalations.insert(request);
    publishPendingState();
    const current = pods.getOrThrow(request.podId);
    if (
      blocking &&
      (current.status !== 'awaiting_input' || current.pendingEscalation?.id !== request.id)
    )
      throw new AutopodError(
        'Question could not be made actionable in this pod state.',
        'ESCALATION_STATE_CONFLICT',
        409,
      );
  });
}

/** Receipt first, guarded state change second; a failed guard rolls both back. */
export function persistCompletionReply(
  pods: PodRepository,
  pod: Pod,
  message: string,
  actor: OperatorActor,
  transitionAfterReply: () => void,
): void {
  atomicPodChange(pods, () => {
    pods.completionJournal?.recordReply(pod, message, actor);
    transitionAfterReply();
  });
}
