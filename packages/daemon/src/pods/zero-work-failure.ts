import type {
  AgentActivityEvent,
  Pod,
  ProviderAttempt,
  ProviderFailureClassification,
} from '@autopod/shared';
import { providerAccountUnavailableState } from '../runtimes/provider-error-classifier.js';
import type { EventRepository } from './event-repository.js';

/**
 * Failure-reason prefix for runs the provider refused because the account itself
 * is unusable (revoked/expired credentials, exhausted credits). Operators can tell
 * these apart from agent or harness bugs; the worker retry ledger records them as
 * `auth` failures that need repaired credentials before another worker run.
 */
export const PROVIDER_ACCOUNT_UNAVAILABLE = 'Provider account unavailable';

/** Runtime status and the fatal error itself are not agent work. */
const NON_WORK_ACTIVITY = new Set(['status', 'error']);

export type ZeroWorkAssessment = { qualifies: true } | { qualifies: false; reason: string };

/**
 * Durable proof that a failed pod's run ended on a provider-account refusal before
 * the agent did anything: no usage, no agent activity beyond status/error, no source,
 * validation, delivery, escalation or prior recovery evidence. Any missing evidence
 * source or positive signal keeps the pod's current retention behaviour.
 */
export function assessZeroWorkProviderAccountFailure(
  pod: Pod,
  evidence: {
    eventRepo?: Pick<EventRepository, 'getForSession'>;
    providerAttemptRepo?: { list(podId: string): ProviderAttempt[] };
  },
): ZeroWorkAssessment {
  const keep = (reason: string): ZeroWorkAssessment => ({ qualifies: false, reason });
  if (!pod.failureReason?.startsWith(`${PROVIDER_ACCOUNT_UNAVAILABLE}:`))
    return keep('not a provider account failure');
  if (pod.options.agentMode !== 'auto' || pod.skipAgent) return keep('not an agent run');
  if (pod.inputTokens > 0 || pod.outputTokens > 0 || pod.costUsd > 0) return keep('usage recorded');
  if (
    pod.commitCount > 0 ||
    pod.filesChanged > 0 ||
    pod.linesAdded > 0 ||
    pod.linesRemoved > 0 ||
    pod.worktreeCompromised
  )
    return keep('source changes recorded');
  if (
    pod.taskSummary !== null ||
    pod.lastValidationResult !== null ||
    pod.prUrl !== null ||
    pod.escalationCount > 0 ||
    pod.pendingEscalation !== null
  )
    return keep('agent, validation or delivery evidence recorded');
  if (
    pod.reworkCount > 0 ||
    pod.recoveryCount > 0 ||
    pod.infrastructureRecoveryCount > 0 ||
    pod.recoveryWorktreePath !== null ||
    pod.infrastructureFailure !== null
  )
    return keep('prior lifecycle or recovery evidence recorded');
  if (!evidence.providerAttemptRepo) return keep('provider attempt evidence unavailable');
  if (
    evidence.providerAttemptRepo
      .list(pod.id)
      .some((attempt) => attempt.inputTokens > 0 || attempt.outputTokens > 0 || attempt.costUsd > 0)
  )
    return keep('provider attempt usage recorded');
  return assessNoAgentActivity(pod.id, evidence.eventRepo);
}

/** Persisted agent activity beyond runtime status and the fatal error itself is work. */
function assessNoAgentActivity(
  podId: string,
  eventRepo: Pick<EventRepository, 'getForSession'> | undefined,
): ZeroWorkAssessment {
  if (!eventRepo) return { qualifies: false, reason: 'agent activity evidence unavailable' };
  const worked = eventRepo.getForSession(podId, { type: 'pod.agent_activity' }).some((stored) => {
    const activity = (stored.payload as Partial<AgentActivityEvent>).event;
    return !activity || !NON_WORK_ACTIVITY.has(activity.type);
  });
  return worked ? { qualifies: false, reason: 'agent activity recorded' } : { qualifies: true };
}

/**
 * Durable proof that the provider refused the pod's only worker run before it
 * produced any model output or usage, so its token accounting can be settled as
 * measured zero instead of blocking the configured failover (#646).
 *
 * Accuracy is pod-wide, so the whole pod must be provably usage-free: no recorded
 * usage on the pod or any provider attempt, no agent activity beyond status/error,
 * exactly one task run, and unsettled (`partial`) accuracy. The caller separately
 * proves that the closing run observed no usage event, no usage-incomplete error
 * and verified termination. Anything else keeps the budget block.
 */
export function assessPreUsageProviderRefusal(
  pod: Pod,
  classification: ProviderFailureClassification,
  evidence: {
    taskRunCount: number;
    eventRepo?: Pick<EventRepository, 'getForSession'>;
    providerAttemptRepo?: { list(podId: string): ProviderAttempt[] };
  },
): ZeroWorkAssessment {
  const keep = (reason: string): ZeroWorkAssessment => ({ qualifies: false, reason });
  if (!classification.definitive) return keep('provider failure is not definitive');
  const refusal =
    classification.category === 'quota_exhausted' ||
    providerAccountUnavailableState(classification) !== null;
  if (!refusal) return keep('not a provider quota or account refusal');
  if (pod.tokenTelemetryAccuracy !== 'partial') return keep('token accounting already settled');
  if (pod.inputTokens > 0 || pod.outputTokens > 0 || pod.costUsd > 0) return keep('usage recorded');
  if (evidence.taskRunCount !== 1) return keep('more than one worker run recorded for this pod');
  if (!evidence.providerAttemptRepo) return keep('provider attempt evidence unavailable');
  if (
    evidence.providerAttemptRepo
      .list(pod.id)
      .some((attempt) => attempt.inputTokens > 0 || attempt.outputTokens > 0 || attempt.costUsd > 0)
  )
    return keep('provider attempt usage recorded');
  return assessNoAgentActivity(pod.id, evidence.eventRepo);
}
