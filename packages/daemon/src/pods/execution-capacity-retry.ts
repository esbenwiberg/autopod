import {
  describeExecutionCapacityWait,
  type ExecutionCapacityInfrastructureFailure,
  type Pod,
} from '@autopod/shared';
import type { ExecutionCapacityUnverifiedError } from '../configuration/backend-capabilities.js';
import type { PodRepository } from './pod-repository.js';

/** 30 s, 60 s, 120 s, then every 300 s (#665). */
export const EXECUTION_CAPACITY_RETRY_BACKOFFS_MS = [30_000, 60_000, 120_000, 300_000] as const;

export function executionCapacityRetryDelayMs(attemptCount: number): number {
  const index = Math.min(attemptCount, EXECUTION_CAPACITY_RETRY_BACKOFFS_MS.length) - 1;
  return EXECUTION_CAPACITY_RETRY_BACKOFFS_MS[Math.max(0, index)] ?? 300_000;
}

/** A queued pod is (still) waiting at the provisioning gate for this exact deadline. */
export function isWaitingForExecutionCapacity(
  pod: Pick<Pod, 'status' | 'infrastructureFailure'>,
  retryNotBefore: string,
): boolean {
  return (
    pod.status === 'queued' &&
    pod.infrastructureFailure?.source === 'execution-capacity' &&
    pod.infrastructureFailure.retryNotBefore === retryNotBefore
  );
}

/**
 * The provisioning gate found Docker host capacity unverified before any workspace or
 * container effect. Keep the pod `queued` with a labelled, durable incident, free its
 * concurrency slot and re-enqueue it automatically. Kill remains available throughout.
 */
export function createExecutionCapacityRetry(captured: {
  podRepo: Pick<PodRepository, 'update' | 'getOrThrow'>;
  enqueueSession: (podId: string) => void;
  emitActivityStatus: (podId: string, message: string) => void;
  now?: () => number;
}) {
  const { podRepo, enqueueSession, emitActivityStatus } = captured;
  const now = captured.now ?? Date.now;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleExecutionCapacityRetry(
    pod: Pod,
    error: ExecutionCapacityUnverifiedError,
  ): ExecutionCapacityInfrastructureFailure {
    const previous = pod.infrastructureFailure;
    const attemptCount = previous?.source === 'execution-capacity' ? previous.attemptCount + 1 : 1;
    const delayMs = executionCapacityRetryDelayMs(attemptCount);
    const time = now();
    const occurredAt = new Date(time).toISOString();
    const retryNotBefore = new Date(time + delayMs).toISOString();
    const failure: ExecutionCapacityInfrastructureFailure = {
      source: 'execution-capacity',
      code: 'EXECUTION_CAPACITY_UNVERIFIED',
      probe: error.hostCapacity.probeFailure ?? null,
      diagnostics: error.message,
      attemptCount,
      recoveryDisposition: 'automatic_retry_scheduled',
      occurredAt,
      retryNotBefore,
    };
    podRepo.update(pod.id, { infrastructureFailure: failure, failureReason: null });
    const existing = timers.get(pod.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(pod.id);
      let current: Pod;
      try {
        current = podRepo.getOrThrow(pod.id);
      } catch {
        return;
      }
      if (isWaitingForExecutionCapacity(current, retryNotBefore)) enqueueSession(pod.id);
    }, delayMs);
    timer.unref?.();
    timers.set(pod.id, timer);
    emitActivityStatus(
      pod.id,
      `${describeExecutionCapacityWait(failure)}. No new resources were created; kill the pod to cancel.`,
    );
    return failure;
  }

  return { scheduleExecutionCapacityRetry };
}
