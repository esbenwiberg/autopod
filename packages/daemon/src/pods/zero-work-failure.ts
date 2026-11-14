import type { AgentActivityEvent, Pod, ProviderAttempt } from '@autopod/shared';
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
  if (!evidence.eventRepo) return keep('agent activity evidence unavailable');
  const worked = evidence.eventRepo
    .getForSession(pod.id, { type: 'pod.agent_activity' })
    .some((stored) => {
      const activity = (stored.payload as Partial<AgentActivityEvent>).event;
      return !activity || !NON_WORK_ACTIVITY.has(activity.type);
    });
  if (worked) return keep('agent activity recorded');
  return { qualifies: true };
}
