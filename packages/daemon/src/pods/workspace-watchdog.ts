import type { PodStatus } from '@autopod/shared';
import { reconcileLocalSessions } from './local-reconciler.js';
import type {
  WorkspaceWatchdogCalls,
  WorkspaceWatchdogCaptured,
  WorkspaceWatchdogLiveDependencies,
} from './workspace-contracts.js';

export function createWorkspaceWatchdog(
  deps: WorkspaceWatchdogLiveDependencies,
  captured: WorkspaceWatchdogCaptured,
) {
  const {
    logger,
    podRepo,
    stopSandboxPreviewProxy,
    containerManagerFactory,
    transition,
    emitActivityStatus,
    eventBus,
    enqueueSession,
    validationRepo,
  } = captured;
  let stuckPodWatchdog: ReturnType<typeof setInterval> | null = null;
  let unsubscribeWakeRecovery: (() => void) | null = null;
  function startStuckPodWatchdog(
    this: WorkspaceWatchdogCalls,
    options?: { intervalMs?: number; thresholdMs?: number },
  ): void {
    if (stuckPodWatchdog) return; // idempotent
    const intervalMs = options?.intervalMs ?? 60_000;
    const thresholdMs =
      options?.thresholdMs ??
      (process.env.AUTOPOD_STUCK_RUNNING_THRESHOLD_MS
        ? Number(process.env.AUTOPOD_STUCK_RUNNING_THRESHOLD_MS)
        : 30 * 60 * 1_000);

    const WAKE_GRACE_MS = 60_000;
    let lastWakeAt: number | null = null;

    const tick = async (): Promise<void> => {
      try {
        const sinceWakeMs = lastWakeAt !== null ? Date.now() - lastWakeAt : null;
        if (sinceWakeMs !== null && sinceWakeMs < WAKE_GRACE_MS) {
          logger.debug({ sinceWakeMs }, 'Watchdog: skipping tick during wake grace window');
          return;
        }
        const running = podRepo.list({ status: 'running' as PodStatus });
        const now = Date.now();
        for (const pod of running) {
          // Workspace (interactive) pods have no agent by design — the human
          // drives the container directly. They will never emit agent events,
          // so silence-based timeout cannot apply.
          if (pod.options?.agentMode === 'interactive') continue;
          // Reference is the most recent of (lastAgentEventAt, lastHeartbeatAt,
          // startedAt) — all are real liveness signals scoped to the current run.
          // MCP tools can legitimately stay open while validation runs without
          // producing an agent-stream event, so their heartbeat must defer the
          // watchdog just like an agent event does.
          // `startedAt` is reset on every transition into provisioning, so it
          // acts as a freshness floor that prevents a stale `lastAgentEventAt`
          // or `lastHeartbeatAt` (from a prior life of the same pod, e.g. across
          // recovery) from dragging the reference back across the threshold.
          // Fall back to updatedAt/createdAt only when all primary signals
          // are missing (pods predating the migration that added these fields).
          const primary = [pod.lastAgentEventAt, pod.lastHeartbeatAt, pod.startedAt]
            .filter((t): t is string => typeof t === 'string')
            .map((t) => new Date(t).getTime())
            .filter((ms) => !Number.isNaN(ms));
          let refMs: number;
          if (primary.length > 0) {
            refMs = Math.max(...primary);
          } else {
            const fallback = pod.updatedAt ?? pod.createdAt;
            refMs = new Date(fallback).getTime();
            if (Number.isNaN(refMs)) continue;
          }
          const ageMs = now - refMs;
          if (ageMs < thresholdMs) continue;

          logger.warn(
            { podId: pod.id, ageMs, thresholdMs },
            'Watchdog: running pod has gone silent — transitioning to failed',
          );
          if (pod.containerId) {
            try {
              await stopSandboxPreviewProxy(pod.id);
              const cm = containerManagerFactory.get(pod.executionTarget);
              await cm.stop(pod.containerId);
            } catch (err) {
              logger.warn({ err, podId: pod.id }, 'Watchdog: failed to stop container');
            }
          }
          try {
            const fresh = podRepo.getOrThrow(pod.id);
            if (fresh.status !== 'running') continue; // raced with another transition
            transition(fresh, 'failed', { completedAt: new Date(now).toISOString() });
            emitActivityStatus(pod.id, 'Watchdog: no agent activity — pod auto-failed');
          } catch (err) {
            logger.warn({ err, podId: pod.id }, 'Watchdog: transition to failed failed');
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Stuck-pod watchdog tick failed');
      }
    };

    stuckPodWatchdog = setInterval(() => {
      void tick();
    }, intervalMs);
    logger.info({ intervalMs, thresholdMs }, 'Stuck-pod watchdog started');

    // Wake-recovery: subscribe to host.resumed, reconcile local pods, then re-publish
    // a richer event (with reconciledPodIds) for the desktop banner.
    // De-dupe by source timestamp so the re-published event doesn't trigger a second
    // reconcile (even when 0 pods are recovered and reconciledPodIds:[] is ambiguous).
    // Bounded at 256 entries — one per wake event — resets on overflow.
    const processedWakeTimestamps = new Set<string>();
    unsubscribeWakeRecovery = eventBus.subscribe((event) => {
      if (event.type !== 'host.resumed') return;
      // Update before the dedupe check so every host.resumed (including the
      // re-published completed event) refreshes the grace window.
      lastWakeAt = Date.now();
      if (processedWakeTimestamps.has(event.timestamp)) return;
      if (processedWakeTimestamps.size >= 256) processedWakeTimestamps.clear();
      processedWakeTimestamps.add(event.timestamp);

      const { sleptMs, detector, timestamp } = event;
      logger.info({ sleptMs, detector }, 'Host wake detected — reconciling local sessions');

      void (async () => {
        try {
          const result = await reconcileLocalSessions({
            podRepo,
            readNativeGoal: deps.launchConfiguration?.goals?.get,
            finishCancelledGoal: (id) => this.killSession(id),
            eventBus,
            containerManager: containerManagerFactory.get('local'),
            enqueueSession,
            validationRepo,
            cleanupPodResources: (id) => this.cleanupPodResourcesForRecovery(id),
            logger,
            trigger: 'wake',
          });
          logger.info(
            { recovered: result.recovered, killed: result.killed, sleptMs },
            'Wake reconcile complete',
          );
          // Re-publish with reconciledPodIds populated so the desktop banner shows counts.
          // Use the original timestamp so the processedWakeTimestamps guard suppresses the
          // subscriber from firing again (handles the 0-recovered edge case).
          eventBus.emit({
            type: 'host.resumed',
            timestamp,
            sleptMs,
            detector,
            reconciledPodIds: result.recovered,
          });
        } catch (err) {
          logger.error({ err, sleptMs }, 'Wake reconcile failed');
        }
      })();
    });
  }

  function stopStuckPodWatchdog(): void {
    if (stuckPodWatchdog) {
      clearInterval(stuckPodWatchdog);
      stuckPodWatchdog = null;
    }
    if (unsubscribeWakeRecovery) {
      unsubscribeWakeRecovery();
      unsubscribeWakeRecovery = null;
    }
  }
  return { startStuckPodWatchdog, stopStuckPodWatchdog };
}
