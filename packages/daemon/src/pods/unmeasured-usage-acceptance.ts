import { randomUUID } from 'node:crypto';
import { AutopodError } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { ProviderAttemptRepository } from './provider-attempt-repository.js';
import type { PodRepository } from './pod-repository.js';
import { assertTaskExecutionTerminationVerified } from './task-execution-ledger.js';

/** Prefix of the ledger reason this owner decision can reconcile (#646). */
const INCOMPLETE_ACCOUNTING = 'Task token accounting incomplete';

export interface UnmeasuredUsagePrincipal {
  oid: string;
}

export interface UnmeasuredUsageReceipt {
  id: string;
  podId: string;
  providerAttemptOrdinal: number;
  taskId: string;
  acceptedBy: string;
  authorizationBasis: 'pod_owner';
  reason: string;
  priorAccuracy: string;
  recordedInputTokens: number;
  recordedOutputTokens: number;
  recordedCostUsd: number;
  acceptedAt: string;
}

export interface UnmeasuredUsageAcceptanceResult {
  receipt: UnmeasuredUsageReceipt;
  continuation: 'queued' | 'not_applicable' | 'unavailable';
  message?: string;
}

export type UnmeasuredUsageAcceptance = ReturnType<typeof createUnmeasuredUsageAcceptance>;

/**
 * The task owner's audited, non-admin path to continue after a failed provider
 * attempt left the task's token accounting incomplete: record an immutable
 * receipt counting that attempt's usage as unmeasured, mark the pod's accounting
 * reconciled (`repaired`) and, for a provider-limit pause, queue the configured
 * failover. Only the pod owner may decide this; admin/operator roles get no
 * bypass here (they keep the existing repair tools).
 */
export function createUnmeasuredUsageAcceptance(deps: {
  db: Database.Database;
  podRepo: PodRepository;
  providerAttemptRepo: Pick<ProviderAttemptRepository, 'list' | 'getActive'>;
  continueAfterAcceptance?: (
    podId: string,
  ) => Promise<{ continuation: 'queued' | 'not_applicable' | 'unavailable'; message?: string }>;
}) {
  const conflict = (message: string, code = 'UNMEASURED_USAGE_NOT_APPLICABLE') =>
    new AutopodError(message, code, 409);

  const record = deps.db.transaction(
    (
      podId: string,
      input: { reason: string; attemptOrdinal?: number },
      principal: UnmeasuredUsagePrincipal,
    ): UnmeasuredUsageReceipt => {
      const oid = principal.oid?.trim();
      if (!oid) throw new AutopodError('Authenticated pod owner required', 'FORBIDDEN', 403);
      const pod = deps.podRepo.getOrThrow(podId);
      if (pod.userId !== oid)
        throw new AutopodError(
          'Only the pod owner may accept unmeasured usage for this task',
          'FORBIDDEN',
          403,
        );
      const reason = input.reason.trim();
      if (reason.length < 10 || reason.length > 2000)
        throw new AutopodError(
          'A reason of 10 to 2000 characters is required',
          'INVALID_REQUEST',
          400,
        );
      const ledger = deps.podRepo.taskExecutions;
      if (!ledger) throw conflict('Task execution ledger unavailable', 'NOT_SUPPORTED');
      assertTaskExecutionTerminationVerified(ledger, podId);
      if (ledger.hasActiveRun(podId))
        throw conflict('A worker run is still active for this pod', 'TASK_AGENT_RUN_ACTIVE');
      if (deps.providerAttemptRepo.getActive(podId))
        throw conflict('A provider attempt is still active for this pod', 'PROVIDER_ATTEMPT_ACTIVE');
      if (deps.podRepo.hasInfrastructureBlocker?.(podId))
        throw conflict('Infrastructure blocked; resolve the recorded blocker first');
      if (pod.status !== 'paused' && pod.status !== 'failed')
        throw conflict(`Pod is ${pod.status}; only paused or failed pods can be reconciled`);
      if (pod.tokenTelemetryAccuracy !== 'partial')
        throw conflict(`Pod token accounting is already ${pod.tokenTelemetryAccuracy}`);
      const task = ledger.snapshot(podId);
      if (
        task.budgetCheck?.status !== 'unavailable' ||
        !task.budgetCheck.reason.startsWith(INCOMPLETE_ACCOUNTING)
      )
        throw conflict('Task token accounting does not require owner reconciliation');
      const attempt = deps.providerAttemptRepo
        .list(podId)
        .findLast((candidate) => candidate.endedAt !== null);
      if (!attempt) throw conflict('No settled provider attempt to accept');
      if (input.attemptOrdinal !== undefined && input.attemptOrdinal !== attempt.ordinal)
        throw conflict(
          `Only the latest settled provider attempt (#${attempt.ordinal}) can be accepted`,
          'PROVIDER_ATTEMPT_MISMATCH',
        );
      const receipt: UnmeasuredUsageReceipt = {
        id: randomUUID(),
        podId,
        providerAttemptOrdinal: attempt.ordinal,
        taskId: task.taskId,
        acceptedBy: oid,
        authorizationBasis: 'pod_owner',
        reason,
        priorAccuracy: pod.tokenTelemetryAccuracy,
        recordedInputTokens: attempt.inputTokens,
        recordedOutputTokens: attempt.outputTokens,
        recordedCostUsd: attempt.costUsd,
        acceptedAt: new Date().toISOString(),
      };
      try {
        deps.db
          .prepare(`INSERT INTO unmeasured_usage_acceptances (id, pod_id, provider_attempt_ordinal,
            task_id, lifecycle_generation, accepted_by, authorization_basis, reason, prior_accuracy,
            recorded_input_tokens, recorded_output_tokens, recorded_cost_usd, accepted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            receipt.id,
            podId,
            receipt.providerAttemptOrdinal,
            receipt.taskId,
            pod.lifecycleGeneration,
            receipt.acceptedBy,
            receipt.authorizationBasis,
            receipt.reason,
            receipt.priorAccuracy,
            receipt.recordedInputTokens,
            receipt.recordedOutputTokens,
            receipt.recordedCostUsd,
            receipt.acceptedAt,
          );
      } catch (err) {
        if (err instanceof Error && /UNIQUE/.test(err.message))
          throw conflict(
            `Provider attempt #${attempt.ordinal} was already accepted as unmeasured`,
            'UNMEASURED_USAGE_ALREADY_ACCEPTED',
          );
        throw err;
      }
      // Recorded usage is kept as-is; only the accounting state is reconciled.
      deps.podRepo.update(podId, {
        tokenTelemetryAccuracy: 'repaired',
        ...(pod.phaseTokenUsage === null && {
          phaseTokenUsage: {
            agent_initial: { inputTokens: pod.inputTokens, outputTokens: pod.outputTokens },
          },
        }),
      });
      return receipt;
    },
  );

  async function accept(
    podId: string,
    input: { reason: string; attemptOrdinal?: number },
    principal: UnmeasuredUsagePrincipal,
  ): Promise<UnmeasuredUsageAcceptanceResult> {
    const receipt = record(podId, input, principal);
    if (!deps.continueAfterAcceptance) return { receipt, continuation: 'not_applicable' };
    const continued = await deps.continueAfterAcceptance(podId);
    return { receipt, ...continued };
  }

  return { accept };
}
