import type { Pod } from '@autopod/shared';
import type { FixProviderLiveDependencies } from './fix-contracts.js';
export function createFixProviderBinding(deps: FixProviderLiveDependencies) {
  function providerBindingForFixPod(
    source: Pod,
  ): Pick<Pod, 'providerAccountIdSnapshot' | 'providerIdSnapshot'> {
    const latestAttempt = deps.providerAttemptRepo?.list(source.id).at(-1);
    const canReconcileMissingProvider =
      source.providerIdSnapshot === null &&
      latestAttempt !== undefined &&
      latestAttempt.runtime === source.runtime &&
      latestAttempt.model === source.model &&
      (source.providerAccountIdSnapshot === null ||
        source.providerAccountIdSnapshot === latestAttempt.providerAccountId);
    if (canReconcileMissingProvider) {
      return {
        providerAccountIdSnapshot: latestAttempt.providerAccountId,
        providerIdSnapshot: latestAttempt.provider,
      };
    }
    return {
      providerAccountIdSnapshot: source.providerAccountIdSnapshot,
      providerIdSnapshot: source.providerIdSnapshot,
    };
  }
  return { providerBindingForFixPod };
}
