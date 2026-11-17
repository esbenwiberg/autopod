import type { ExecutionTarget } from '@autopod/shared';

/** Cloud setup needs round-trip headroom; do not use for agent/validation work. */
export function provisioningExecTimeout(target: ExecutionTarget, localTimeout: number): number {
  return target === 'sandbox' ? Math.max(localTimeout, 60_000) : localTimeout;
}
