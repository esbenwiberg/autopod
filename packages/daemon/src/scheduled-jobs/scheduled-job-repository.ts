import type { ScheduledJob } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface ScheduledJobInsert {
  id: string;
  templateId: string;
  profileName: string;
  cronExpression: string;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastPodId: string | null;
  catchupPending: boolean;
  name: string;
  task: string;
}

export interface ScheduledJobRepository {
  insert(job: ScheduledJobInsert): ScheduledJob;
  getOrThrow(id: string): ScheduledJob;
  list(): ScheduledJob[];
  update(id: string, changes: Partial<ScheduledJob>): ScheduledJob;
  delete(id: string): void;
  listDue(): ScheduledJob[]; // enabled=1, catchup_pending=0, next_run_at <= now()
  listOverdue(): ScheduledJob[]; // enabled=1, catchup_pending=0, next_run_at < now()
  listPendingCatchup(): ScheduledJob[]; // catchup_pending=1
  countActiveSessionsForJob(jobId: string): number;
}

function mapRow(row: Record<string, unknown>): ScheduledJob {
  const templateName = ((row.template_name as string) ?? (row.name as string)) as string;
  const templatePrompt = row.template_prompt as string | Buffer | null | undefined;
  const task = Buffer.isBuffer(templatePrompt)
    ? templatePrompt.toString('utf8')
    : (templatePrompt ??
      (Buffer.isBuffer(row.task) ? (row.task as Buffer).toString('utf8') : (row.task as string)));

  return {
    id: row.id as string,
    name: templateName,
    templateId: row.template_id as string,
    templateName,
    profileName: row.profile_name as string,
    task,
    cronExpression: row.cron_expression as string,
    enabled: Boolean(row.enabled),
    nextRunAt: row.next_run_at as string,
    lastRunAt: (row.last_run_at as string) ?? null,
    lastPodId: (row.last_pod_id as string) ?? null,
    catchupPending: Boolean(row.catchup_pending),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function createScheduledJobRepository(db: Database.Database): ScheduledJobRepository {
  const selectWithTemplate = `
    SELECT
      sj.*,
      t.name AS template_name,
      t.prompt AS template_prompt
    FROM scheduled_jobs sj
    LEFT JOIN scheduled_job_templates t ON t.id = sj.template_id
  `;

  return {
    insert(job: ScheduledJobInsert): ScheduledJob {
      db.prepare(`
        INSERT INTO scheduled_jobs (
          id, name, template_id, profile_name, task, cron_expression, enabled,
          next_run_at, last_run_at, last_pod_id, catchup_pending
        ) VALUES (
          @id, @name, @templateId, @profileName, @task, @cronExpression, @enabled,
          @nextRunAt, @lastRunAt, @lastPodId, @catchupPending
        )
      `).run({
        id: job.id,
        name: job.name,
        templateId: job.templateId,
        profileName: job.profileName,
        task: job.task,
        cronExpression: job.cronExpression,
        enabled: job.enabled ? 1 : 0,
        nextRunAt: job.nextRunAt,
        lastRunAt: job.lastRunAt ?? null,
        lastPodId: job.lastPodId ?? null,
        catchupPending: job.catchupPending ? 1 : 0,
      });
      return this.getOrThrow(job.id);
    },

    getOrThrow(id: string): ScheduledJob {
      const row = db.prepare(`${selectWithTemplate} WHERE sj.id = ?`).get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row) {
        throw new AutopodError(`Scheduled job not found: ${id}`, 'NOT_FOUND', 404);
      }
      return mapRow(row);
    },

    list(): ScheduledJob[] {
      const rows = db.prepare(`${selectWithTemplate} ORDER BY sj.created_at ASC`).all() as Record<
        string,
        unknown
      >[];
      return rows.map(mapRow);
    },

    update(id: string, changes: Partial<ScheduledJob>): ScheduledJob {
      // Ensure job exists
      this.getOrThrow(id);

      const setClauses: string[] = ["updated_at = datetime('now')"];
      const params: Record<string, unknown> = { id };

      if (changes.name !== undefined) {
        setClauses.push('name = @name');
        params.name = changes.name;
      }
      if (changes.templateId !== undefined) {
        setClauses.push('template_id = @templateId');
        params.templateId = changes.templateId;
      }
      if (changes.profileName !== undefined) {
        setClauses.push('profile_name = @profileName');
        params.profileName = changes.profileName;
      }
      if (changes.task !== undefined) {
        setClauses.push('task = @task');
        params.task = changes.task;
      }
      if (changes.cronExpression !== undefined) {
        setClauses.push('cron_expression = @cronExpression');
        params.cronExpression = changes.cronExpression;
      }
      if (changes.enabled !== undefined) {
        setClauses.push('enabled = @enabled');
        params.enabled = changes.enabled ? 1 : 0;
      }
      if (changes.nextRunAt !== undefined) {
        setClauses.push('next_run_at = @nextRunAt');
        params.nextRunAt = changes.nextRunAt;
      }
      if (changes.lastRunAt !== undefined) {
        setClauses.push('last_run_at = @lastRunAt');
        params.lastRunAt = changes.lastRunAt;
      }
      if (changes.lastPodId !== undefined) {
        setClauses.push('last_pod_id = @lastPodId');
        params.lastPodId = changes.lastPodId;
      }
      if (changes.catchupPending !== undefined) {
        setClauses.push('catchup_pending = @catchupPending');
        params.catchupPending = changes.catchupPending ? 1 : 0;
      }

      db.prepare(`UPDATE scheduled_jobs SET ${setClauses.join(', ')} WHERE id = @id`).run(params);
      return this.getOrThrow(id);
    },

    delete(id: string): void {
      this.getOrThrow(id);
      // Nullify scheduled_job_id on pods before deleting to avoid FK constraint violations.
      // Sessions continue running unaffected; job is just disassociated.
      db.prepare('UPDATE pods SET scheduled_job_id = NULL WHERE scheduled_job_id = ?').run(id);
      db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(id);
    },

    listDue(): ScheduledJob[] {
      const rows = db
        .prepare(`
          ${selectWithTemplate}
          WHERE sj.enabled = 1
            AND sj.catchup_pending = 0
            AND datetime(sj.next_run_at) <= datetime('now')
          ORDER BY sj.next_run_at ASC
        `)
        .all() as Record<string, unknown>[];
      return rows.map(mapRow);
    },

    listOverdue(): ScheduledJob[] {
      const rows = db
        .prepare(`
          ${selectWithTemplate}
          WHERE sj.enabled = 1
            AND sj.catchup_pending = 0
            AND datetime(sj.next_run_at) < datetime('now')
          ORDER BY sj.next_run_at ASC
        `)
        .all() as Record<string, unknown>[];
      return rows.map(mapRow);
    },

    listPendingCatchup(): ScheduledJob[] {
      const rows = db
        .prepare(`
          ${selectWithTemplate}
          WHERE sj.catchup_pending = 1
          ORDER BY sj.next_run_at ASC
        `)
        .all() as Record<string, unknown>[];
      return rows.map(mapRow);
    },

    countActiveSessionsForJob(jobId: string): number {
      const row = db
        .prepare(`
          SELECT COUNT(*) as count FROM pods
          WHERE scheduled_job_id = ? AND status NOT IN ('complete', 'failed', 'killed')
        `)
        .get(jobId) as { count: number };
      return row.count;
    },
  };
}
