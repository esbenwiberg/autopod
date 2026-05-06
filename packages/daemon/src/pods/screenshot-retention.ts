import type { Logger } from 'pino';
import type { PodRepository } from './pod-repository.js';
import type { ScreenshotStore } from './screenshot-store.js';

export interface ScreenshotRetentionOptions {
  retentionDays: number;
  sweepIntervalMs: number;
  podRepository: PodRepository;
  screenshotStore: ScreenshotStore;
  logger: Logger;
}

export class ScreenshotRetention {
  private readonly opts: ScreenshotRetentionOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Reference to the currently in-flight sweep. Guards against double-fire when an
   * interval tick fires while the previous sweep is still awaiting disk I/O. */
  private sweepPromise: Promise<{ scanned: number; deleted: number }> | null = null;

  constructor(opts: ScreenshotRetentionOptions) {
    this.opts = opts;
  }

  /**
   * Begin the periodic sweep. Runs `sweepOnce()` immediately, then every
   * `sweepIntervalMs`. Calling `start()` more than once is a no-op — the second
   * call is silently ignored, not stacked. Callers must ensure they only call
   * `start()` once, or call `stop()` before re-starting.
   */
  start(): void {
    if (this.timer !== null) return; // idempotent — do not stack timers
    void this.runSweep(); // immediate first sweep (non-blocking)
    this.timer = setInterval(() => void this.runSweep(), this.opts.sweepIntervalMs);
  }

  /** Clear the periodic timer. Idempotent — safe to call even if never started. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run one sweep synchronously through all eligible pods. */
  async sweepOnce(): Promise<{ scanned: number; deleted: number }> {
    const { retentionDays, podRepository, screenshotStore, logger } = this.opts;

    // Boundary-inclusive: sweep pods whose completed_at is exactly retentionDays old.
    // Using <= (not <) means a pod that completed exactly N days ago IS swept — this
    // prevents an off-by-one where pods linger for one extra sweep cycle.
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const cutoffIso = new Date(cutoffMs).toISOString();

    const pods = podRepository.listTerminalPodsCompletedBefore(cutoffIso);
    let deleted = 0;

    for (const pod of pods) {
      logger.debug(
        { podId: pod.id, completedAt: pod.completedAt },
        'screenshot-retention: deleting screenshots for stale pod',
      );
      try {
        await screenshotStore.delete(pod.id);
        deleted++;
      } catch (err) {
        // A failed delete must NOT abort the sweep — log and continue so the
        // remaining pods are still processed.
        logger.error(
          { err, podId: pod.id },
          'screenshot-retention: failed to delete screenshots, continuing sweep',
        );
      }
    }

    logger.info(
      { scanned: pods.length, deleted, cutoffIso, retentionDays },
      'screenshot-retention: sweep complete',
    );

    return { scanned: pods.length, deleted };
  }

  /**
   * Internal runner that guards against concurrent overlapping sweeps. If a
   * sweep is already in-flight when the interval fires, the new tick is
   * discarded rather than stacked.
   */
  private async runSweep(): Promise<void> {
    if (this.sweepPromise !== null) return; // previous sweep still running — skip

    this.sweepPromise = this.sweepOnce();
    try {
      await this.sweepPromise;
    } catch (err) {
      this.opts.logger.error({ err }, 'screenshot-retention: unexpected error during sweep');
    } finally {
      this.sweepPromise = null;
    }
  }
}
