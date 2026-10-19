import type { ResourcePreviewTimersCaptured } from './resource-contracts.js';
import { PREVIEW_AUTO_STOP_MS } from './resource-policy.js';

export function createResourcePreviewTimers(captured: ResourcePreviewTimersCaptured) {
  const { stopSandboxPreviewProxy, containerManagerFactory, logger } = captured;
  const previewTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function clearPreviewTimer(podId: string): void {
    const timer = previewTimers.get(podId);
    if (timer) {
      clearTimeout(timer);
      previewTimers.delete(podId);
    }
  }

  function schedulePreviewAutoStop(
    podId: string,
    containerId: string,
    target: import('@autopod/shared').ExecutionTarget,
  ): void {
    clearPreviewTimer(podId);
    const timer = setTimeout(async () => {
      previewTimers.delete(podId);
      try {
        await stopSandboxPreviewProxy(podId);
        const cm = containerManagerFactory.get(target);
        await cm.stop(containerId);
        logger.info({ podId, containerId }, 'Preview auto-stopped after timeout');
      } catch (err) {
        logger.warn({ err, podId }, 'Failed to auto-stop preview container');
      }
    }, PREVIEW_AUTO_STOP_MS);
    // Unref so the timer doesn't prevent process exit
    timer.unref();
    previewTimers.set(podId, timer);
  }
  return { clearPreviewTimer, schedulePreviewAutoStop };
}
