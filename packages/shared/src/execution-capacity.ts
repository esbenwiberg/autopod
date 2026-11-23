import type { ExecutionCapacityProbeFailure } from './types/launch-config.js';
import type {
  DockerNetworkCapacityInfrastructureFailure,
  ExecutionCapacityInfrastructureFailure,
} from './types/pod.js';

/** Short operator wording for a failed Docker host-capacity check. */
export function describeExecutionCapacityProbeFailure(
  probe: ExecutionCapacityProbeFailure,
): string {
  return probe.kind === 'timeout'
    ? `timed out after ${probe.durationMs} ms`
    : `failed after ${probe.durationMs} ms: ${probe.message}`;
}

/**
 * The one status line shown (activity feed and `ap status`) while a queued pod waits
 * at the provisioning gate for Docker to report host capacity.
 */
export function describeExecutionCapacityWait(
  failure: Pick<
    ExecutionCapacityInfrastructureFailure,
    'attemptCount' | 'retryNotBefore' | 'probe'
  >,
): string {
  const cause = failure.probe
    ? ` (last check ${describeExecutionCapacityProbeFailure(failure.probe)})`
    : '';
  return `Waiting for Docker host capacity check — retry ${failure.attemptCount} at ${failure.retryNotBefore}${cause}`;
}

export function describeDockerNetworkCapacityWait(
  failure: Pick<
    DockerNetworkCapacityInfrastructureFailure,
    'attemptCount' | 'retryNotBefore' | 'probe'
  >,
): string {
  const probe = failure.probe
    ? ` (Docker host size also unverified: last check ${describeExecutionCapacityProbeFailure(failure.probe)})`
    : '';
  return `Waiting for a free Docker subnet (HOST_NETWORK_CAPACITY) — retry ${failure.attemptCount} at ${failure.retryNotBefore}${probe}`;
}
