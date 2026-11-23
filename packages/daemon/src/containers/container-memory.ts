/**
 * One place that answers "how much RAM does this pod's container actually get?".
 *
 * The answer differs per execution target. `docker` honours the requested size
 * as-is (falling back to the generic daemon default). Azure Sandboxes sell fixed
 * bundles (`sandbox-tiers.ts`): a request maps onto a bundle, an omitted size uses
 * the daemon's configured default bundle, and an unsupported size is refused
 * before allocation rather than clamped.
 */

import type { ExecutionTarget } from '@autopod/shared';
import { DEFAULT_CONTAINER_MEMORY_GB } from '@autopod/shared';
import {
  DEFAULT_SANDBOX_TIER,
  resolveSandboxTier,
  type SandboxResourceTier,
  sandboxTierLabel,
  sandboxTierMemoryBytes,
} from './sandbox-tiers.js';

const BYTES_PER_GB = 1024 ** 3;

/**
 * Memory request to hand to a container manager.
 *
 * An explicit value — including one frozen in a launch — is always used as-is
 * and never reinterpreted as omitted. Only a genuinely omitted sandbox size is
 * left unset, so the sandbox manager resolves its configured default bundle
 * instead of the generic Docker default (10 GiB), which would otherwise select
 * a larger, more expensive bundle nobody asked for.
 */
export function containerMemoryRequestBytes(
  containerMemoryGb: number | null | undefined,
  executionTarget: ExecutionTarget,
): number | undefined {
  if (containerMemoryGb !== null && containerMemoryGb !== undefined)
    return containerMemoryGb * BYTES_PER_GB;
  if (executionTarget === 'sandbox') return undefined;
  return DEFAULT_CONTAINER_MEMORY_GB * BYTES_PER_GB;
}

export interface ResolvedContainerMemory {
  /** GB requested, or `null` when a sandbox size was omitted (configured default applies). */
  requestedGb: number | null;
  /** GB the container will be given, or `null` when it cannot be stated up front. */
  grantedGb: number | null;
  /** Sandbox bundle, when known. */
  sandboxTier: SandboxResourceTier | null;
  /** Human-readable sandbox bundle, e.g. `XL · 4 vCPU · 8 GiB RAM · 80 GiB disk`. */
  bundleLabel: string | null;
  /** True when a sandbox request is not an offered bundle and will be refused. */
  unsupported: boolean;
}

/** Resolve the effective memory for a pod's container, without contacting any backend. */
export function resolveContainerMemory(
  containerMemoryGb: number | null | undefined,
  executionTarget: ExecutionTarget,
): ResolvedContainerMemory {
  if (executionTarget !== 'sandbox') {
    const requestedGb = containerMemoryGb ?? DEFAULT_CONTAINER_MEMORY_GB;
    return {
      requestedGb,
      grantedGb: requestedGb > 0 ? requestedGb : null,
      sandboxTier: null,
      bundleLabel: null,
      unsupported: false,
    };
  }
  const requestBytes = containerMemoryRequestBytes(containerMemoryGb, executionTarget);
  if (requestBytes === undefined || requestBytes <= 0) {
    // The configured default lives on the sandbox manager; do not guess a number.
    return {
      requestedGb: null,
      grantedGb: null,
      sandboxTier: null,
      bundleLabel: null,
      unsupported: false,
    };
  }
  const requestedGb = requestBytes / BYTES_PER_GB;
  try {
    // Non-empty requests never consult the default tier.
    const tier = resolveSandboxTier(requestBytes, DEFAULT_SANDBOX_TIER);
    return {
      requestedGb,
      grantedGb: sandboxTierMemoryBytes(tier) / BYTES_PER_GB,
      sandboxTier: tier,
      bundleLabel: sandboxTierLabel(tier),
      unsupported: false,
    };
  } catch {
    return {
      requestedGb,
      grantedGb: null,
      sandboxTier: null,
      bundleLabel: null,
      unsupported: true,
    };
  }
}
