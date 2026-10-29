import type { Pod } from '@autopod/shared';
import type {
  ResourceCleanupCaptured,
  ResourceCleanupLiveDependencies,
} from './resource-contracts.js';
import { CONTAINER_CLEANUP_TIMEOUT_MS } from './resource-policy.js';

export function createResourceCleanup(
  deps: ResourceCleanupLiveDependencies,
  captured: ResourceCleanupCaptured,
) {
  const {
    podRepo,
    logger,
    ownsLifecycle,
    stopSandboxPreviewProxy,
    stopHaproxyDenyReceiver,
    containerManagerFactory,
    forgetMaxCredentialLineage,
  } = captured;

  async function cleanupContainer(
    pod: Pod,
    label: string,
    mode: 'kill' | 'stop' = 'kill',
    assertReleaseAllowed?: () => void,
  ): Promise<void> {
    assertReleaseAllowed?.();
    const targetContainerId = pod.containerId;
    if (!targetContainerId) {
      if (
        mode === 'kill' &&
        podRepo.getOrThrow(pod.id).lifecycleGeneration === pod.lifecycleGeneration
      )
        deps.launchConfiguration?.pim?.release(pod.id);
      return;
    }
    podRepo.sourceAdoptions?.assertReleasable(targetContainerId);
    podRepo.sandboxWakeups?.assertReleasable(targetContainerId);
    if (mode === 'kill') podRepo.externalDeliveries?.assertReleasable(targetContainerId);
    logger.info(
      { podId: pod.id, containerId: targetContainerId, generation: pod.lifecycleGeneration },
      'Cleaning lifecycle container by captured identity',
    );
    const ownsSharedResources = ownsLifecycle(pod.id, pod.lifecycleGeneration, targetContainerId);
    if (ownsSharedResources) await stopSandboxPreviewProxy(pod.id);
    assertReleaseAllowed?.();
    if (ownsSharedResources && mode === 'kill' && deps.beforeContainerCleanup) {
      let extractionTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        deps
          .beforeContainerCleanup(pod.id)
          .catch((err) =>
            logger.warn({ err, podId: pod.id, label }, 'Pre-cleanup memory extraction failed'),
          )
          .finally(() => {
            if (extractionTimer) clearTimeout(extractionTimer);
          }),
        new Promise<void>((resolve) => {
          extractionTimer = setTimeout(() => {
            logger.warn(
              { podId: pod.id, label, timeoutMs: 20_000 },
              'Pre-cleanup memory extraction timed out — continuing container cleanup',
            );
            resolve();
          }, 20_000);
        }),
      ]);
    }
    assertReleaseAllowed?.();
    // Stop denial receiver before killing/stopping the container so the
    // long-running socat exec gets a clean shutdown signal.
    if (ownsSharedResources) await stopHaproxyDenyReceiver(pod.id);
    assertReleaseAllowed?.();
    const cm = containerManagerFactory.get(pod.executionTarget);
    if (mode === 'kill') podRepo.externalDeliveries?.assertReleasable(targetContainerId);
    podRepo.sandboxWakeups?.assertReleasable(targetContainerId);
    podRepo.sourceAdoptions?.assertReleasable(targetContainerId);
    const op = mode === 'kill' ? cm.kill(targetContainerId) : cm.stop(targetContainerId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deleted = await Promise.race([
      op
        .then(() => true)
        .catch((err) => {
          logger.warn({ err, podId: pod.id, label, mode }, `${label}: container ${mode} failed`);
          return false;
        })
        .finally(() => {
          if (timer) clearTimeout(timer);
        }),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          logger.warn(
            { podId: pod.id, label, mode, timeoutMs: CONTAINER_CLEANUP_TIMEOUT_MS },
            `${label}: container ${mode} timed out — proceeding without waiting`,
          );
          resolve(false);
        }, CONTAINER_CLEANUP_TIMEOUT_MS);
      }),
    ]);
    assertReleaseAllowed?.();
    if (mode === 'kill' && deleted && pod.executionTarget === 'sandbox') {
      const current = podRepo.getOrThrow(pod.id);
      if (
        current.lifecycleGeneration === pod.lifecycleGeneration &&
        current.containerId === targetContainerId
      ) {
        podRepo.update(pod.id, { containerId: null });
      }
    }
    if (mode === 'kill' && ownsSharedResources) {
      deps.launchConfiguration?.pim?.release(pod.id);
      forgetMaxCredentialLineage(pod.id);
    }
  }
  return { cleanupContainer };
}
