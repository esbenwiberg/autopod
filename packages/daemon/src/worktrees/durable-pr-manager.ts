import { AutopodError } from '@autopod/shared';
import type { CreatePrConfig, CreatePrResult, PrManager } from '../interfaces/pr-manager.js';
import type { DeliveryLedger } from '../pods/delivery-ledger.js';

/** Serializes locally; SQLite compare-and-set prevents another process from creating again. */
export function createDurablePrManagerFactory(
  ledger: DeliveryLedger,
  factory: (profile: CreatePrConfig['profile']) => PrManager | null,
) {
  const pending = new Map<string, Promise<CreatePrResult>>();
  return (profile: CreatePrConfig['profile']): PrManager | null => {
    const provider = factory(profile);
    if (!provider) return null;
    return {
      createPr(config) {
        const intent = ledger.reserve(config);
        const underway = pending.get(intent.id);
        if (underway) return underway;
        const operation = (async () => {
          const previous = ledger.result(intent.id);
          if (previous) return previous;
          if (!provider.findPr)
            throw new AutopodError(
              'PR provider cannot reconcile delivery identity; no create attempted',
              'DELIVERY_RECONCILIATION_REQUIRED',
              409,
            );
          const found = await provider.findPr(config);
          if (found) {
            if (found.disposition === 'closed')
              throw new AutopodError(
                `Matching PR is closed: ${found.url}. Reconcile it or use a distinct branch for an intentional rerun.`,
                'DELIVERY_RECONCILIATION_REQUIRED',
                409,
              );
            return ledger.record(
              intent.id,
              { url: found.url, usedFallback: false },
              'provider_lookup',
              found.disposition,
            );
          }
          // Absence from a possibly lagging provider list is never proof that an
          // earlier ambiguous request failed. Only a never-started intent may create.
          if (!ledger.claim(intent))
            throw new AutopodError(
              'Delivery needs reconciliation: an earlier create may have succeeded or its lifecycle changed. No duplicate create attempted.',
              'DELIVERY_RECONCILIATION_REQUIRED',
              409,
            );
          try {
            const created = await provider.createPr(config);
            return ledger.record(intent.id, created, 'create_response', 'open');
          } catch (error) {
            ledger.uncertain(intent.id);
            throw error;
          }
        })();
        pending.set(intent.id, operation);
        void operation.finally(() => pending.delete(intent.id)).catch(() => {});
        return operation;
      },
      findPr: provider.findPr?.bind(provider),
      async mergePr(config) {
        const result = await provider.mergePr(config);
        // Preserve confirmed provider disposition before the lifecycle caller
        // continues. Pending/ambiguous requests are not merge observations.
        if (result.merged) ledger.observe(config.prUrl, 'merged');
        return result;
      },
      async getPrStatus(config) {
        const status = await provider.getPrStatus(config);
        ledger.observe(config.prUrl, status.merged ? 'merged' : status.open ? 'open' : 'closed');
        return status;
      },
      replyToReviewFeedback: provider.replyToReviewFeedback?.bind(provider),
    };
  };
}
