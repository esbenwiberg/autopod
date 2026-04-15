import { AutopodError, generateId } from '@autopod/shared';
import type {
  CreateScheduledJobRequest,
  ScheduledJob,
  Session,
  UpdateScheduledJobRequest,
} from '@autopod/shared';
import cronParser from 'cron-parser';
import type { Logger } from 'pino';
import type { EventBus } from '../sessions/event-bus.js';
import type { SessionManager } from '../sessions/session-manager.js';
import type { ScheduledJobRepository } from './scheduled-job-repository.js';

// cron-parser is CommonJS — use default import then destructure
const { parseExpression } = cronParser;

export const SCHEDULER_USER_ID = 'scheduler';

export interface ScheduledJobManagerDeps {
  scheduledJobRepo: ScheduledJobRepository;
  sessionManager: SessionManager;
  eventBus: EventBus;
  logger: Logger;
}

export interface ScheduledJobManager {
  create(req: CreateScheduledJobRequest): ScheduledJob;
  list(): ScheduledJob[];
  get(id: string): ScheduledJob;
  update(id: string, req: UpdateScheduledJobRequest): ScheduledJob;
  delete(id: string): void;
  runCatchup(id: string): Promise<Session>;
  skipCatchup(id: string): void;
  trigger(id: string): Promise<Session>;
  reconcileMissedJobs(): void;
  tick(): Promise<void>;
}

function computeNextRunAt(cronExpression: string): string {
  const interval = parseExpression(cronExpression);
  return interval.next().toISOString();
}

function validateCronExpression(cronExpression: string): void {
  try {
    parseExpression(cronExpression);
  } catch {
    throw new AutopodError(`Invalid cron expression: "${cronExpression}"`, 'INVALID_INPUT', 400);
  }
}

export function createScheduledJobManager(deps: ScheduledJobManagerDeps): ScheduledJobManager {
  const { scheduledJobRepo, sessionManager, eventBus, logger } = deps;

  async function fireJob(job: ScheduledJob): Promise<Session> {
    return sessionManager.createSession(
      {
        profileName: job.profileName,
        task: job.task,
        scheduledJobId: job.id,
      },
      SCHEDULER_USER_ID,
    );
  }

  return {
    create(req: CreateScheduledJobRequest): ScheduledJob {
      validateCronExpression(req.cronExpression);
      const nextRunAt = computeNextRunAt(req.cronExpression);
      const id = generateId();

      return scheduledJobRepo.insert({
        id,
        name: req.name,
        profileName: req.profileName,
        task: req.task,
        cronExpression: req.cronExpression,
        enabled: req.enabled ?? true,
        nextRunAt,
        lastRunAt: null,
        lastSessionId: null,
        catchupPending: false,
      });
    },

    list(): ScheduledJob[] {
      return scheduledJobRepo.list();
    },

    get(id: string): ScheduledJob {
      return scheduledJobRepo.getOrThrow(id);
    },

    update(id: string, req: UpdateScheduledJobRequest): ScheduledJob {
      const job = scheduledJobRepo.getOrThrow(id);
      const changes: Partial<ScheduledJob> = {};

      if (req.name !== undefined) changes.name = req.name;
      if (req.task !== undefined) changes.task = req.task;
      if (req.enabled !== undefined) changes.enabled = req.enabled;

      if (req.cronExpression !== undefined) {
        validateCronExpression(req.cronExpression);
        changes.cronExpression = req.cronExpression;
        // Only recompute nextRunAt if cron changed
        if (req.cronExpression !== job.cronExpression) {
          changes.nextRunAt = computeNextRunAt(req.cronExpression);
        }
      }

      return scheduledJobRepo.update(id, changes);
    },

    delete(id: string): void {
      // repository.delete() calls getOrThrow internally — no need to call it twice
      scheduledJobRepo.delete(id);
    },

    async runCatchup(id: string): Promise<Session> {
      const job = scheduledJobRepo.getOrThrow(id);

      if (!job.catchupPending) {
        throw new AutopodError(`Job "${id}" does not have a pending catch-up`, 'CONFLICT', 409);
      }

      const activeCount = scheduledJobRepo.countActiveSessionsForJob(id);
      if (activeCount > 0) {
        throw new AutopodError(
          `Job "${id}" has an active session — cannot run catch-up until it completes`,
          'ACTIVE_SESSION',
          400,
        );
      }

      const session = await fireJob(job);
      const now = new Date().toISOString();

      scheduledJobRepo.update(id, {
        catchupPending: false,
        lastRunAt: now,
        lastSessionId: session.id,
        nextRunAt: computeNextRunAt(job.cronExpression),
      });

      return session;
    },

    skipCatchup(id: string): void {
      const job = scheduledJobRepo.getOrThrow(id);

      if (!job.catchupPending) {
        throw new AutopodError(`Job "${id}" does not have a pending catch-up`, 'CONFLICT', 409);
      }

      scheduledJobRepo.update(id, {
        catchupPending: false,
        nextRunAt: computeNextRunAt(job.cronExpression),
      });
    },

    async trigger(id: string): Promise<Session> {
      const job = scheduledJobRepo.getOrThrow(id);

      const activeCount = scheduledJobRepo.countActiveSessionsForJob(id);
      if (activeCount > 0) {
        throw new AutopodError(
          `Job "${id}" has an active session — cannot trigger until it completes`,
          'ACTIVE_SESSION',
          400,
        );
      }

      const session = await fireJob(job);
      const now = new Date().toISOString();

      scheduledJobRepo.update(id, {
        lastRunAt: now,
        lastSessionId: session.id,
        nextRunAt: computeNextRunAt(job.cronExpression),
      });

      eventBus.emit({
        type: 'scheduled_job.fired',
        timestamp: now,
        jobId: job.id,
        jobName: job.name,
        sessionId: session.id,
      });

      return session;
    },

    reconcileMissedJobs(): void {
      const overdue = scheduledJobRepo.listOverdue();
      let count = 0;

      for (const job of overdue) {
        try {
          scheduledJobRepo.update(job.id, { catchupPending: true });
          eventBus.emit({
            type: 'scheduled_job.catchup_requested',
            timestamp: new Date().toISOString(),
            jobId: job.id,
            jobName: job.name,
            lastRunAt: job.lastRunAt,
          });
          count++;
        } catch (err) {
          logger.error({ err, jobId: job.id }, 'Failed to mark job for catch-up');
        }
      }

      if (count > 0) {
        logger.info({ count }, 'Marked scheduled jobs for catch-up');
      }
    },

    async tick(): Promise<void> {
      const due = scheduledJobRepo.listDue();

      for (const job of due) {
        try {
          const activeCount = scheduledJobRepo.countActiveSessionsForJob(job.id);
          if (activeCount > 0) {
            logger.debug({ jobId: job.id }, 'Skipping scheduled job fire — active session exists');
            continue;
          }

          const session = await fireJob(job);
          const now = new Date().toISOString();

          scheduledJobRepo.update(job.id, {
            lastRunAt: now,
            lastSessionId: session.id,
            nextRunAt: computeNextRunAt(job.cronExpression),
          });

          eventBus.emit({
            type: 'scheduled_job.fired',
            timestamp: now,
            jobId: job.id,
            jobName: job.name,
            sessionId: session.id,
          });

          logger.info({ jobId: job.id, sessionId: session.id }, 'Scheduled job fired');
        } catch (err) {
          logger.error({ err, jobId: job.id }, 'Scheduled job tick error — continuing');
        }
      }
    },
  };
}
