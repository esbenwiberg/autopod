import { AutopodError, generateId } from '@autopod/shared';
import type {
  CreateScheduledJobRequest,
  CreateScheduledJobTemplateRequest,
  Pod,
  ScheduledJob,
  ScheduledJobTemplate,
  UpdateScheduledJobRequest,
  UpdateScheduledJobTemplateRequest,
} from '@autopod/shared';
import cronParser from 'cron-parser';
import type { Logger } from 'pino';
import type { EventBus } from '../pods/event-bus.js';
import type { PodManager } from '../pods/pod-manager.js';
import type { ScheduledJobRepository } from './scheduled-job-repository.js';
import type { ScheduledJobTemplateRepository } from './scheduled-job-template-repository.js';

// cron-parser is CommonJS — use default import then destructure
const { parseExpression } = cronParser;

export const SCHEDULER_USER_ID = 'scheduler';

export interface ScheduledJobManagerDeps {
  scheduledJobRepo: ScheduledJobRepository;
  scheduledJobTemplateRepo: ScheduledJobTemplateRepository;
  podManager: PodManager;
  eventBus: EventBus;
  logger: Logger;
}

export interface ScheduledJobManager {
  createTemplate(req: CreateScheduledJobTemplateRequest): ScheduledJobTemplate;
  listTemplates(): ScheduledJobTemplate[];
  getTemplate(id: string): ScheduledJobTemplate;
  updateTemplate(id: string, req: UpdateScheduledJobTemplateRequest): ScheduledJobTemplate;
  deleteTemplate(id: string): void;
  create(req: CreateScheduledJobRequest): ScheduledJob;
  list(): ScheduledJob[];
  get(id: string): ScheduledJob;
  update(id: string, req: UpdateScheduledJobRequest): ScheduledJob;
  delete(id: string): void;
  runCatchup(id: string): Promise<Pod>;
  skipCatchup(id: string): void;
  trigger(id: string): Promise<Pod>;
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
  const { scheduledJobRepo, scheduledJobTemplateRepo, podManager, eventBus, logger } = deps;

  async function fireJob(job: ScheduledJob): Promise<Pod> {
    return podManager.createSession(
      {
        profileName: job.profileName,
        task: job.task,
        scheduledJobId: job.id,
      },
      SCHEDULER_USER_ID,
    );
  }

  return {
    createTemplate(req: CreateScheduledJobTemplateRequest): ScheduledJobTemplate {
      return scheduledJobTemplateRepo.insert({
        id: generateId(),
        name: req.name,
        prompt: req.prompt,
      });
    },

    listTemplates(): ScheduledJobTemplate[] {
      return scheduledJobTemplateRepo.list();
    },

    getTemplate(id: string): ScheduledJobTemplate {
      return scheduledJobTemplateRepo.getOrThrow(id);
    },

    updateTemplate(id: string, req: UpdateScheduledJobTemplateRequest): ScheduledJobTemplate {
      return scheduledJobTemplateRepo.update(id, req);
    },

    deleteTemplate(id: string): void {
      scheduledJobTemplateRepo.delete(id);
    },

    create(req: CreateScheduledJobRequest): ScheduledJob {
      validateCronExpression(req.cronExpression);
      const nextRunAt = computeNextRunAt(req.cronExpression);
      const id = generateId();
      const template =
        req.templateId !== undefined
          ? scheduledJobTemplateRepo.getOrThrow(req.templateId)
          : createLegacyTemplate(req);

      return scheduledJobRepo.insert({
        id,
        name: template.name,
        templateId: template.id,
        profileName: req.profileName,
        task: template.prompt,
        cronExpression: req.cronExpression,
        enabled: req.enabled ?? true,
        nextRunAt,
        lastRunAt: null,
        lastPodId: null,
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
      let template =
        req.templateId !== undefined
          ? scheduledJobTemplateRepo.getOrThrow(req.templateId)
          : scheduledJobTemplateRepo.getOrThrow(job.templateId);

      if (req.name !== undefined || req.task !== undefined) {
        template = scheduledJobTemplateRepo.update(template.id, {
          name: req.name,
          prompt: req.task,
        });
      }

      if (req.templateId !== undefined) {
        changes.templateId = template.id;
        changes.name = template.name;
        changes.task = template.prompt;
      } else if (req.name !== undefined || req.task !== undefined) {
        changes.name = template.name;
        changes.task = template.prompt;
      }

      if (req.profileName !== undefined) changes.profileName = req.profileName;
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

    async runCatchup(id: string): Promise<Pod> {
      const job = scheduledJobRepo.getOrThrow(id);

      if (!job.catchupPending) {
        throw new AutopodError(`Job "${id}" does not have a pending catch-up`, 'CONFLICT', 409);
      }

      const activeCount = scheduledJobRepo.countActiveSessionsForJob(id);
      if (activeCount > 0) {
        throw new AutopodError(
          `Job "${id}" has an active pod — cannot run catch-up until it completes`,
          'ACTIVE_SESSION',
          400,
        );
      }

      const pod = await fireJob(job);
      const now = new Date().toISOString();

      scheduledJobRepo.update(id, {
        catchupPending: false,
        lastRunAt: now,
        lastPodId: pod.id,
        nextRunAt: computeNextRunAt(job.cronExpression),
      });

      return pod;
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

    async trigger(id: string): Promise<Pod> {
      const job = scheduledJobRepo.getOrThrow(id);

      const activeCount = scheduledJobRepo.countActiveSessionsForJob(id);
      if (activeCount > 0) {
        throw new AutopodError(
          `Job "${id}" has an active pod — cannot trigger until it completes`,
          'ACTIVE_SESSION',
          400,
        );
      }

      const pod = await fireJob(job);
      const now = new Date().toISOString();

      scheduledJobRepo.update(id, {
        lastRunAt: now,
        lastPodId: pod.id,
        nextRunAt: computeNextRunAt(job.cronExpression),
      });

      eventBus.emit({
        type: 'scheduled_job.fired',
        timestamp: now,
        jobId: job.id,
        jobName: job.name,
        podId: pod.id,
      });

      return pod;
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
            logger.debug({ jobId: job.id }, 'Skipping scheduled job fire — active pod exists');
            continue;
          }

          const pod = await fireJob(job);
          const now = new Date().toISOString();

          scheduledJobRepo.update(job.id, {
            lastRunAt: now,
            lastPodId: pod.id,
            nextRunAt: computeNextRunAt(job.cronExpression),
          });

          eventBus.emit({
            type: 'scheduled_job.fired',
            timestamp: now,
            jobId: job.id,
            jobName: job.name,
            podId: pod.id,
          });

          logger.info({ jobId: job.id, podId: pod.id }, 'Scheduled job fired');
        } catch (err) {
          logger.error({ err, jobId: job.id }, 'Scheduled job tick error — continuing');
        }
      }
    },
  };

  function createLegacyTemplate(req: CreateScheduledJobRequest): ScheduledJobTemplate {
    if (!req.name || !req.task) {
      throw new AutopodError(
        'templateId is required unless legacy name and task are provided',
        'INVALID_INPUT',
        400,
      );
    }

    return scheduledJobTemplateRepo.insert({
      id: generateId(),
      name: uniqueLegacyTemplateName(req.name),
      prompt: req.task,
    });
  }

  function uniqueLegacyTemplateName(name: string): string {
    const existing = new Set(
      scheduledJobTemplateRepo.list().map((template) => template.name.toLowerCase()),
    );
    if (!existing.has(name.toLowerCase())) return name;

    for (let i = 2; i < 10_000; i++) {
      const candidate = `${name} (${i})`;
      if (!existing.has(candidate.toLowerCase())) return candidate;
    }

    return `${name} (${generateId()})`;
  }
}
