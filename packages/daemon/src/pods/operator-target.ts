import { createHash } from 'node:crypto';
import { AutopodError, type OperatorTarget, type Pod } from '@autopod/shared';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function operatorTarget(pod: Pod): OperatorTarget {
  // Exclude noisy activity/token counters and readiness refresh timestamps.
  // Include the full pending question and recorded validation candidate/evidence.
  const identity = {
    version: 1,
    id: pod.id,
    generation: pod.lifecycleGeneration,
    status: pod.status,
    branch: pod.branch,
    baseBranch: pod.baseBranch,
    prUrl: pod.prUrl,
    containerId: pod.containerId,
    worktreePath: pod.worktreePath,
    executionTarget: pod.executionTarget,
    launchConfigDigest: pod.launchConfigDigest,
    pauseReason: pod.pauseReason,
    pendingEscalation: pod.pendingEscalation,
    finalization: pod.finalization,
    validationAttempts: pod.validationAttempts,
    lastValidationResult: pod.lastValidationResult,
    validationOverrides: pod.validationOverrides,
    infrastructureFailure: pod.infrastructureFailure,
    options: pod.options,
  };
  return {
    version: 1,
    podId: pod.id,
    lifecycleGeneration: pod.lifecycleGeneration,
    status: pod.status,
    expectedTarget: createHash('sha256')
      .update(JSON.stringify(canonical(identity)))
      .digest('hex'),
    escalationId: pod.pendingEscalation?.id ?? null,
    escalationType: pod.pendingEscalation?.type ?? null,
    pendingEscalation: pod.pendingEscalation,
    validation: pod.lastValidationResult
      ? {
          attempt: pod.lastValidationResult.attempt,
          timestamp: pod.lastValidationResult.timestamp,
          overall: pod.lastValidationResult.overall,
          taskReview: pod.lastValidationResult.taskReview,
        }
      : null,
    readiness: pod.readinessReview
      ? {
          status: pod.readinessReview.status,
          summary: pod.readinessReview.summary,
        }
      : null,
    prUrl: pod.prUrl,
  };
}
export function assertOperatorTarget(pod: Pod, expected?: string): void {
  if (expected === undefined) return;
  if (!/^[a-f0-9]{64}$/.test(expected) || operatorTarget(pod).expectedTarget !== expected)
    throw new AutopodError(
      'Observed question/candidate changed; inspect the exact current target before deciding again.',
      'STALE_OPERATOR_TARGET',
      409,
    );
}
export function assertDelegableReply(pod: Pod): void {
  const e = pod.pendingEscalation;
  if (
    e &&
    (['action_approval', 'validation_override', 'request_credential'].includes(e.type) ||
      (e.type === 'ask_human' && 'kind' in e.payload && e.payload.kind === 'decision'))
  )
    throw new AutopodError(
      'This backend gate requires an explicit human decision; automation cannot answer it.',
      'HUMAN_DECISION_REQUIRED',
      409,
    );
}
