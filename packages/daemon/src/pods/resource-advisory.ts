import type { ValidationResult } from '@autopod/shared';

export function createResourceAdvisoryState() {
  const advisoryRuns = new Map<string, Promise<ValidationResult>>();
  const ADVISORY_QA_MAX_CONCURRENCY = 1;
  let advisoryQaActive = 0;
  const advisoryQaWaiters: Array<() => void> = [];
  function acquireAdvisoryQaSlot(): Promise<void> {
    if (advisoryQaActive < ADVISORY_QA_MAX_CONCURRENCY) {
      advisoryQaActive++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => advisoryQaWaiters.push(resolve));
  }

  function releaseAdvisoryQaSlot(): void {
    const next = advisoryQaWaiters.shift();
    if (next) {
      next();
    } else {
      advisoryQaActive--;
    }
  }
  return { acquireAdvisoryQaSlot, releaseAdvisoryQaSlot, advisoryRuns };
}
import type { Pod } from '@autopod/shared';
import type { ResourceAdvisoryCleanupCaptured } from './resource-contracts.js';

export function createResourceAdvisoryCleanup(captured: ResourceAdvisoryCleanupCaptured) {
  const { assertGuidanceCollected, advisoryRuns, cleanupContainer, emitActivityStatus, logger } =
    captured;

  function cleanupContainerAfterAdvisorySettles(
    pod: Pod,
    label: string,
    mode: 'kill' | 'stop' = 'kill',
    assertReleaseAllowed?: () => void,
  ): Promise<void> {
    assertGuidanceCollected(pod.id);
    const advisoryRun = advisoryRuns.get(pod.id);
    if (!advisoryRun) {
      return cleanupContainer(pod, label, mode, assertReleaseAllowed);
    }

    emitActivityStatus(pod.id, 'Keeping container running until advisory browser QA finishes…');
    void advisoryRun
      .finally(() => cleanupContainer(pod, label, mode, assertReleaseAllowed))
      .catch((err) =>
        logger.warn(
          { err, podId: pod.id, label, mode },
          'Deferred container cleanup after advisory QA failed',
        ),
      );
    return Promise.resolve();
  }
  return { cleanupContainerAfterAdvisorySettles };
}
