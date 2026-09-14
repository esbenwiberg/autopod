import type { EffectiveLaunchConfig, PimSelection, Pod } from '@autopod/shared';
import { configurationError } from '../configuration/configuration-store.js';
import { type PimActivationRepository, pimAssignmentKey } from './activation-repository.js';
import type { createPimActivationService } from './activation-service.js';

export interface PimPodLifecycle {
  startup(podId: string, config: EffectiveLaunchConfig): Promise<void>;
  release(podId: string): void;
}
/** Startup selections are explicit activation authority; configuration previews never call this. */
export function createPimPodLifecycle(deps: {
  readPod(podId: string): Pod;
  readSnapshot(podId: string): EffectiveLaunchConfig | null;
  assertAllowed(selection: PimSelection): void;
  activation: ReturnType<typeof createPimActivationService>;
  repository: PimActivationRepository;
}): PimPodLifecycle {
  return {
    async startup(podId, config) {
      const initialGeneration = deps.readPod(podId).lifecycleGeneration;
      const assertCurrent = (selection: PimSelection) => {
        const pod = deps.readPod(podId);
        const saved = deps.readSnapshot(podId);
        if (
          pod.lifecycleGeneration !== initialGeneration ||
          !['queued', 'handoff', 'provisioning'].includes(pod.status) ||
          pod.launchConfigDigest !== config.digest ||
          saved?.digest !== config.digest ||
          !saved.pim.some(
            (entry) =>
              entry.timing === 'startup' && pimAssignmentKey(entry) === pimAssignmentKey(selection),
          )
        )
          configurationError('PIM startup authority changed', 'PIM_STARTUP_SUPERSEDED', 409);
        deps.assertAllowed(selection);
      };
      for (const selection of config.pim.filter((entry) => entry.timing === 'startup')) {
        assertCurrent(selection);
        // Same pod/selection retries reconcile the original request; they cannot duplicate activation.
        const requestId = `startup-${initialGeneration}-${pimAssignmentKey(selection)}`;
        const result = await deps.activation.request(podId, requestId, selection, () =>
          assertCurrent(selection),
        );
        assertCurrent(selection);
        if (result.status !== 'active' || !deps.repository.usable(podId, requestId))
          configurationError(
            `Startup access for ${selection.displayName} is ${result.status}. Reconcile access before resuming the pod.`,
            'PIM_STARTUP_NOT_ACTIVE',
            409,
          );
      }
    },
    release: deps.activation.release,
  };
}
