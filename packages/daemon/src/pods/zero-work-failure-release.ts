import type { EffectiveLaunchConfig, Pod, ProviderAttempt } from '@autopod/shared';
import type { Logger } from 'pino';
import type { EventRepository } from './event-repository.js';
import type { PodRepository } from './pod-repository.js';
import { assessZeroWorkProviderAccountFailure } from './zero-work-failure.js';

export interface ZeroWorkFailureReleaseDependencies {
  podRepo: PodRepository;
  eventRepo?: Pick<EventRepository, 'getForSession'>;
  providerAttemptRepo?: {
    list(podId: string): ProviderAttempt[];
    getActive(podId: string): ProviderAttempt | null;
  };
  launchConfiguration?: { read(podId: string): EffectiveLaunchConfig | null };
  ownsLifecycle(podId: string, generation: number, containerId: string | null): boolean;
  killSidecarsForPod(podId: string, strict?: boolean, assertCurrent?: () => void): Promise<void>;
  cleanupContainer(
    pod: Pod,
    label: string,
    mode: 'kill' | 'stop',
    assertReleaseAllowed: () => void,
    strict: boolean,
  ): Promise<void>;
  destroyPodNetwork(podId: string): Promise<void>;
  emitActivityStatus(podId: string, message: string): void;
  logger: Logger;
}

/**
 * Releases the container, sidecars and per-pod network of a local pod whose agent
 * failed on a provider-account refusal before doing any work, and records its
 * usage as complete at zero. The pod stays `failed` with its worktree, so the
 * operator can repair the account and rework or rerun it.
 *
 * Deliberately narrow: every custody, ownership, active-run or work signal keeps
 * today's retention, and any guard or cleanup error leaves resources in place.
 */
export function createZeroWorkFailureRelease(deps: ZeroWorkFailureReleaseDependencies) {
  const { podRepo, logger } = deps;

  async function releaseZeroWorkFailure(
    podId: string,
    generation: number,
    containerId: string,
  ): Promise<boolean> {
    const pod = podRepo.getOrThrow(podId);
    if (
      pod.status !== 'failed' ||
      pod.executionTarget !== 'local' ||
      pod.containerId !== containerId ||
      !deps.ownsLifecycle(podId, generation, containerId) ||
      deps.launchConfiguration?.read(podId)?.intent === 'goal' ||
      podRepo.hasInfrastructureBlocker?.(podId) ||
      podRepo.retainedCoding?.isOwner(podId) ||
      podRepo.recoveryForks?.child(podId) ||
      podRepo.taskExecutions?.hasActiveRun(podId) ||
      deps.providerAttemptRepo?.getActive(podId)
    )
      return false;
    const assessment = assessZeroWorkProviderAccountFailure(pod, deps);
    if (!assessment.qualifies) {
      logger.debug({ podId, reason: assessment.reason }, 'Failed pod resources retained');
      return false;
    }
    // The provider refused the account before any model turn: zero is the final usage.
    // The qualifying run is always the initial agent attempt (no rework or recovery).
    podRepo.update(podId, {
      tokenTelemetryAccuracy: 'complete',
      ...(pod.phaseTokenUsage === null
        ? { phaseTokenUsage: { agent_initial: { inputTokens: 0, outputTokens: 0 } } }
        : {}),
    });
    const assertUnchanged = () => {
      const current = podRepo.getOrThrow(podId);
      if (
        current.status !== 'failed' ||
        current.lifecycleGeneration !== generation ||
        current.containerId !== containerId
      )
        throw new Error('Failed pod changed before zero-work resource release');
    };
    try {
      await deps.killSidecarsForPod(podId, true, assertUnchanged);
      assertUnchanged();
      await deps.cleanupContainer(
        podRepo.getOrThrow(podId),
        'zero-work-provider-failure',
        'kill',
        assertUnchanged,
        true,
      );
      const released = podRepo.getOrThrow(podId);
      if (released.lifecycleGeneration !== generation || released.containerId !== null)
        return false;
      await deps.destroyPodNetwork(podId);
    } catch (err) {
      logger.warn({ err, podId, containerId }, 'Zero-work failed pod resources retained');
      return false;
    }
    deps.emitActivityStatus(
      podId,
      'No agent work was recorded before the provider account failure; released the container and network. Repair the provider account, then rework or rerun.',
    );
    logger.info({ podId, containerId }, 'Released zero-work failed pod resources');
    return true;
  }

  return { releaseZeroWorkFailure };
}
