import type { PimActivation, PimEligibility, PimSelection } from '@autopod/shared';
import { configurationError } from '../configuration/configuration-store.js';
import type { PimActivationRepository } from './activation-repository.js';
import type { PimEligibilityService } from './eligibility-service.js';
import { pimDurationMinutes } from './policy-reader.js';

export interface PimProviderActivation {
  requestId: string | null;
  assignmentId: string | null;
  status: 'pending' | 'active' | 'failed' | 'uncertain' | 'expired';
  expiresAt: string | null;
}
export interface PimActivationProvider {
  existing(eligibility: PimEligibility): Promise<PimProviderActivation | null>;
  submit(
    eligibility: PimEligibility,
    selection: PimSelection,
    requestId: string,
  ): Promise<PimProviderActivation>;
  reconcile(eligibility: PimEligibility, requestId: string): Promise<PimProviderActivation>;
}

/** Selection and discovery never activate. Only this explicitly requested, policy-checked path does. */
export function createPimActivationService(
  repository: PimActivationRepository,
  eligibility: PimEligibilityService,
  provider: PimActivationProvider,
  now: () => number = Date.now,
) {
  function record(
    id: string,
    result: PimProviderActivation,
    ownership: PimActivation['ownership'],
  ): PimActivation {
    return repository.observe(id, {
      status: result.status,
      providerRequestId: result.requestId,
      providerAssignmentId: result.assignmentId,
      expiresAt: result.expiresAt,
      ownership,
      reason:
        result.status === 'pending'
          ? 'Provider approval or activation is pending'
          : result.status === 'uncertain'
            ? 'Provider activation outcome requires reconciliation'
            : null,
    });
  }
  return {
    async request(
      podId: string,
      requestId: string,
      selection: PimSelection,
      assertAuthorized: () => void,
    ): Promise<PimActivation> {
      const scopedResult = (activation: PimActivation): PimActivation =>
        activation.status === 'active' && !repository.usable(podId, requestId)
          ? {
              ...activation,
              status: 'expired',
              reason:
                'This pod activation lease expired or was released; a new request is required',
            }
          : activation;
      assertAuthorized();
      const exact = await eligibility.selected(selection);
      const minutes = pimDurationMinutes(selection.duration);
      if (exact.maximumDurationMinutes === null || minutes > exact.maximumDurationMinutes)
        configurationError(
          'Selected PIM duration exceeds the readable provider policy',
          'PIM_DURATION_UNAVAILABLE',
          403,
        );
      if (exact.expiresAt && now() + minutes * 60_000 > Date.parse(exact.expiresAt))
        configurationError(
          'Selected PIM duration exceeds this eligibility lifetime',
          'PIM_ELIGIBILITY_EXPIRING',
          403,
        );
      assertAuthorized();
      let activation = repository.reserve(podId, requestId, selection, exact);
      if (activation.status === 'reserved') {
        const existing = await provider.existing(exact);
        assertAuthorized();
        // Claim atomically even when reusing provider access; concurrent callers share one record.
        if (!repository.claim(activation.id)) return scopedResult(repository.get(activation.id));
        if (existing?.status === 'active')
          return scopedResult(record(activation.id, existing, 'pre-existing'));
        try {
          assertAuthorized();
          const result = await provider.submit(exact, selection, activation.id);
          return scopedResult(
            record(
              activation.id,
              result,
              result.status === 'uncertain' ? 'unconfirmed' : 'autopod',
            ),
          );
        } catch {
          // The daemon cannot infer a failed activation from a lost response. Never resend automatically.
          return repository.observe(activation.id, {
            status: 'uncertain',
            providerRequestId: activation.id,
            providerAssignmentId: null,
            ownership: 'unconfirmed',
            expiresAt: null,
            reason:
              'Activation response was not recorded; reconcile before requesting another activation',
          });
        }
      }
      if (
        (activation.status === 'pending' ||
          activation.status === 'uncertain' ||
          activation.status === 'active') &&
        activation.providerRequestId
      ) {
        const result = await provider.reconcile(exact, activation.providerRequestId);
        assertAuthorized();
        activation = record(activation.id, result, activation.ownership);
      } else if (activation.status === 'active' && activation.ownership === 'pre-existing') {
        const existing = await provider.existing(exact);
        assertAuthorized();
        activation = record(
          activation.id,
          existing ?? { status: 'expired', requestId: null, assignmentId: null, expiresAt: null },
          'pre-existing',
        );
      }
      return scopedResult(activation);
    },
    release(podId: string): void {
      repository.release(podId);
      // Let provider expiry end access. Never revoke pre-existing or uncertain activations; even
      // an owned activation can have users outside AutoPod that the daemon cannot establish.
    },
  };
}
