import {
  type DockerNetworkCapacityInfrastructureFailure,
  describeDockerNetworkCapacityWait,
  describeExecutionCapacityWait,
  type ExecutionCapacityInfrastructureFailure,
  type Pod,
  type PodInfrastructureFailure,
} from '@autopod/shared';
import type { ExecutionCapacityUnverifiedError } from '../configuration/backend-capabilities.js';
import type { PodRepository } from './pod-repository.js';
import type { ProvisioningCaptured } from './provisioning-ports.js';

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

export function dockerNetworkCapacityWait(
  pod: Pick<Pod, 'infrastructureFailure' | 'lifecycleGeneration'>,
): DockerNetworkCapacityInfrastructureFailure | null {
  const failure = pod.infrastructureFailure;
  return failure?.source === 'docker-network' &&
    failure.lifecycleGeneration === pod.lifecycleGeneration
    ? failure
    : null;
}

/** Docker waits release concurrency and retain their deadline through restart. */
export function createExecutionCapacityRetry(captured: {
  podRepo: Pick<PodRepository, 'update' | 'getOrThrow'>;
  enqueueSession: (podId: string) => void;
  emitActivityStatus: (podId: string, message: string) => void;
  transition: ProvisioningCaptured['transition'];
  now?: () => number;
}) {
  const { podRepo, enqueueSession, emitActivityStatus, transition } = captured;
  const now = captured.now ?? Date.now;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  type Wait = Extract<
    PodInfrastructureFailure,
    { source: 'execution-capacity' | 'docker-network' }
  >;

  function schedule(pod: Pod, failure: Wait, delayMs: number) {
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
      if (current.lifecycleGeneration !== pod.lifecycleGeneration) return;
      const stillWaiting =
        failure.source === 'execution-capacity'
          ? isWaitingForExecutionCapacity(current, failure.retryNotBefore)
          : current.status === 'queued' &&
            dockerNetworkCapacityWait(current)?.retryNotBefore === failure.retryNotBefore;
      if (stillWaiting) enqueueSession(pod.id);
    }, delayMs);
    timer.unref?.();
    timers.set(pod.id, timer);
  }

  function scheduleExecutionCapacityRetry(pod: Pod, error: ExecutionCapacityUnverifiedError): void {
    const network = dockerNetworkCapacityWait(pod);
    if (network) {
      // Preserve the prepared source and subnet retry count if docker info is also slow.
      const delayMs = executionCapacityRetryDelayMs(network.attemptCount);
      const failure = {
        ...network,
        probe: error.hostCapacity.probeFailure ?? null,
        retryNotBefore: new Date(now() + delayMs).toISOString(),
      };
      podRepo.update(pod.id, { infrastructureFailure: failure });
      schedule(pod, failure, delayMs);
      emitActivityStatus(
        pod.id,
        `${describeDockerNetworkCapacityWait(failure)}. Host size must also verify before provisioning.`,
      );
      return;
    }
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
    schedule(pod, failure, delayMs);
    emitActivityStatus(
      pod.id,
      `${describeExecutionCapacityWait(failure)}. No new resources were created; kill the pod to cancel.`,
    );
  }

  function scheduleDockerNetworkCapacityRetry(
    pod: Pod,
    source: { worktreePath: string | null; bareRepoPath: string | null; isRecovery: boolean },
  ): boolean {
    const attemptCount = (dockerNetworkCapacityWait(pod)?.attemptCount ?? 0) + 1;
    // Four automatic retries; each allocation pass still uses Docker's guarded reclaim path.
    if (attemptCount > EXECUTION_CAPACITY_RETRY_BACKOFFS_MS.length) return false;
    const time = now();
    const delayMs = executionCapacityRetryDelayMs(attemptCount);
    const failure: DockerNetworkCapacityInfrastructureFailure = {
      source: 'docker-network',
      code: 'HOST_NETWORK_CAPACITY',
      lifecycleGeneration: pod.lifecycleGeneration,
      isRecovery: source.isRecovery,
      bareRepoPath: source.bareRepoPath,
      probe: null,
      attemptCount,
      recoveryDisposition: 'automatic_retry_scheduled',
      occurredAt: new Date(time).toISOString(),
      retryNotBefore: new Date(time + delayMs).toISOString(),
    };
    transition(pod, 'queued', {
      worktreePath: source.worktreePath,
      infrastructureFailure: failure,
      failureReason: null,
    });
    schedule(pod, failure, delayMs);
    emitActivityStatus(
      pod.id,
      `${describeDockerNetworkCapacityWait(failure)}. Prepared source is retained; kill the pod to cancel.`,
    );
    return true;
  }

  return { scheduleExecutionCapacityRetry, scheduleDockerNetworkCapacityRetry };
}
