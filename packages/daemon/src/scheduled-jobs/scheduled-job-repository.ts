import type { ScheduledJob } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface ScheduledJobRepository {
  insert(job: Omit<ScheduledJob, 'createdAt' | 'updatedAt'>): ScheduledJob;
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
  return {
    id: row.id as string,
    name: row.name as string,
    profileName: row.profile_name as string,
    task: row.task as string,
    cronExpression: row.cron_expression as string,
    enabled: Boolean(row.enabled),
    nextRunAt: row.next_run_at as string,
    lastRunAt: (row.last_run_at as string) ?? null,
    lastSessionId: (row.last_session_id as string) ?? null,
    catchupPending: Boolean(row.catchup_pending),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function createScheduledJobRepository(db: Database.Database): ScheduledJobRepository {
  return {
    insert(job: Omit<ScheduledJob, 'createdAt' | 'updatedAt'>): ScheduledJob {
      db.prepare(`
        INSERT INTO scheduled_jobs (
          id, name, profile_name, task, cron_expression, enabled,
          next_run_at, last_run_at, last_session_id, catchup_pending
        ) VALUES (
          @id, @name, @profileName, @task, @cronExpression, @enabled,
          @nextRunAt, @lastRunAt, @lastSessionId, @catchupPending
        )
      `).run({
        id: job.id,
        name: job.name,
        profileName: job.profileName,
        task: job.task,
        cronExpression: job.cronExpression,
        enabled: job.enabled ? 1 : 0,
        nextRunAt: job.nextRunAt,
        lastRunAt: job.lastRunAt ?? null,
        lastSessionId: job.lastSessionId ?? null,
        catchupPending: job.catchupPending ? 1 : 0,
      });
      return this.getOrThrow(job.id);
    },

    getOrThrow(id: string): ScheduledJob {
      const row = db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row) {
        throw new AutopodError(`Scheduled job not found: ${id}`, 'NOT_FOUND', 404);
      }
      return mapRow(row);
    },

    list(): ScheduledJob[] {
      const rows = db
        .prepare('SELECT * FROM scheduled_jobs ORDER BY created_at ASC')
        .all() as Record<string, unknown>[];
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
      if (changes.lastSessionId !== undefined) {
        setClauses.push('last_session_id = @lastSessionId');
        params.lastSessionId = changes.lastSessionId;
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
      // Nullify scheduled_job_id on sessions before deleting to avoid FK constraint violations.
      // Sessions continue running unaffected; job is just disassociated.
      db.prepare('UPDATE sessions SET scheduled_job_id = NULL WHERE scheduled_job_id = ?').run(id);
      db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(id);
    },

    listDue(): ScheduledJob[] {
      const rows = db
        .prepare(`
          SELECT * FROM scheduled_jobs
          WHERE enabled = 1 AND catchup_pending = 0 AND datetime(next_run_at) <= datetime('now')
          ORDER BY next_run_at ASC
        `)
        .all() as Record<string, unknown>[];
      return rows.map(mapRow);
    },

    listOverdue(): ScheduledJob[] {
      const rows = db
        .prepare(`
          SELECT * FROM scheduled_jobs
          WHERE enabled = 1 AND catchup_pending = 0 AND datetime(next_run_at) < datetime('now')
          ORDER BY next_run_at ASC
        `)
        .all() as Record<string, unknown>[];
      return rows.map(mapRow);
    },

    listPendingCatchup(): ScheduledJob[] {
      const rows = db
        .prepare('SELECT * FROM scheduled_jobs WHERE catchup_pending = 1 ORDER BY next_run_at ASC')
        .all() as Record<string, unknown>[];
      return rows.map(mapRow);
    },

    countActiveSessionsForJob(jobId: string): number {
      const row = db
        .prepare(`
          SELECT COUNT(*) as count FROM sessions
          WHERE scheduled_job_id = ? AND status NOT IN ('complete', 'failed', 'killed')
        `)
        .get(jobId) as { count: number };
      return row.count;
    },
  };
}
