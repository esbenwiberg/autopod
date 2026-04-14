import type { Logger } from 'pino';
import type { ScheduledJobManager } from './scheduled-job-manager.js';

export interface ScheduledJobScheduler {
  start(): void;
  stop(): void;
}

export function createScheduledJobScheduler(
  manager: ScheduledJobManager,
  logger: Logger,
): ScheduledJobScheduler {
  let interval: ReturnType<typeof setInterval> | null = null;

  return {
    start(): void {
      manager.reconcileMissedJobs();

      interval = setInterval(async () => {
        try {
          await manager.tick();
        } catch (err) {
          logger.error({ err }, 'Scheduled job tick failed');
        }
      }, 60_000);

      // Don't block process exit
      interval.unref();

      logger.info('Scheduled job scheduler started');
    },

    stop(): void {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}
