import type { Logger } from 'pino';
import type { MemoryUsageRepository } from './memory-usage-repository.js';
import type { PodRepository } from './pod-repository.js';

export function createAgentActivity(
  deps: { memoryUsageRepo?: Pick<MemoryUsageRepository, 'recordNotReportedForPod'> },
  captured: { podRepo: Pick<PodRepository, 'update'>; logger: Pick<Logger, 'warn'> },
) {
  const { podRepo, logger } = captured;
  const lastEventWriteAt = new Map<string, number>();
  const EVENT_TIMESTAMP_WRITE_THROTTLE_MS = 10_000;

  function bumpActivityTimestamp(podId: string): void {
    const eventNow = Date.now();
    const lastWrite = lastEventWriteAt.get(podId) ?? 0;
    if (eventNow - lastWrite < EVENT_TIMESTAMP_WRITE_THROTTLE_MS) return;
    lastEventWriteAt.set(podId, eventNow);
    try {
      podRepo.update(podId, { lastAgentEventAt: new Date(eventNow).toISOString() });
    } catch (err) {
      logger.warn({ err, podId }, 'Failed to bump lastAgentEventAt');
    }
  }

  function touchHeartbeat(podId: string): void {
    try {
      podRepo.update(podId, { lastHeartbeatAt: new Date().toISOString() });
    } catch {
      // Best-effort — don't crash on heartbeat failures
    }
  }

  function recordNotReportedMemoryUsage(podId: string): void {
    deps.memoryUsageRepo?.recordNotReportedForPod(podId);
  }
  return { lastEventWriteAt, bumpActivityTimestamp, touchHeartbeat, recordNotReportedMemoryUsage };
}
