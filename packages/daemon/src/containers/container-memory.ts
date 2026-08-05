/**
 * One place that answers "how much RAM does this pod's container actually get?".
 *
 * The answer differs per execution target, and the difference has bitten us: a
 * profile asking for 10 GB gets 10 GB on `docker` but is silently clamped to the
 * largest Azure Sandboxes tier (4 GB). The clamp then surfaces much later as a
 * native allocation failure inside the agent's own toolchain, where it reads like
 * a code bug rather than an environment ceiling.
 */

import type { ExecutionTarget } from '@autopod/shared';
import { DEFAULT_CONTAINER_MEMORY_GB } from '@autopod/shared';
import {
  MAX_SANDBOX_MEMORY_BYTES,
  SANDBOX_TIER_MEMORY_BYTES,
  pickSandboxTier,
} from './sandbox-api-client.js';

const BYTES_PER_GB = 1024 ** 3;

export interface ResolvedContainerMemory {
  /** GB requested by the profile (or the daemon default when unset). */
  requestedGb: number;
  /**
   * GB the container will actually be given, or `null` when the target imposes
   * no ceiling we can state up front.
   */
  grantedGb: number | null;
  /** True when the target's ceiling is below what was requested. */
  clamped: boolean;
}

/** Largest RAM any sandbox pod can ever get, in GB. */
export const MAX_SANDBOX_MEMORY_GB = MAX_SANDBOX_MEMORY_BYTES / BYTES_PER_GB;

/**
 * Resolve the effective memory ceiling for a pod's container.
 *
 * `docker` honours the request as-is. `sandbox` maps the request onto the
 * smallest published tier that satisfies it, and clamps anything above the
 * largest tier down to that tier's ceiling.
 */
export function resolveContainerMemory(
  containerMemoryGb: number | null | undefined,
  executionTarget: ExecutionTarget,
): ResolvedContainerMemory {
  const requestedGb = containerMemoryGb ?? DEFAULT_CONTAINER_MEMORY_GB;

  if (executionTarget !== 'sandbox') {
    return { requestedGb, grantedGb: requestedGb > 0 ? requestedGb : null, clamped: false };
  }

  // A non-positive request carries no hint, so the manager falls back to its
  // configured default tier — which this module cannot see. Report the platform
  // ceiling, the one thing that is true regardless of which tier is chosen.
  if (requestedGb <= 0) {
    return { requestedGb, grantedGb: MAX_SANDBOX_MEMORY_GB, clamped: false };
  }

  const tier = pickSandboxTier(requestedGb * BYTES_PER_GB, 'L');
  const grantedGb = SANDBOX_TIER_MEMORY_BYTES[tier] / BYTES_PER_GB;
  return { requestedGb, grantedGb, clamped: grantedGb < requestedGb };
}
