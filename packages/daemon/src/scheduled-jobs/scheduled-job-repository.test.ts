import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  insertTestProfile,
  insertTestScheduledJob,
} from '../test-utils/mock-helpers.js';
import { createScheduledJobRepository } from './scheduled-job-repository.js';

describe('ScheduledJobRepository', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertTestProfile(db);
  });

  it('insert and getOrThrow roundtrip', () => {
    const repo = createScheduledJobRepository(db);
    const job = insertTestScheduledJob(db);

    const fetched = repo.getOrThrow(job.id);
    expect(fetched.id).toBe(job.id);
    expect(fetched.name).toBe(job.name);
    expect(fetched.profileName).toBe('test-profile');
    expect(fetched.enabled).toBe(true);
    expect(fetched.catchupPending).toBe(false);
    expect(fetched.createdAt).toBeTruthy();
    expect(fetched.updatedAt).toBeTruthy();
  });

  it('getOrThrow throws 404 for unknown id', () => {
    const repo = createScheduledJobRepository(db);
    expect(() => repo.getOrThrow('no-such-id')).toThrow();
  });

  it('list returns all jobs', () => {
    const repo = createScheduledJobRepository(db);
    insertTestScheduledJob(db, { id: 'job-1', name: 'Job 1' });
    insertTestScheduledJob(db, { id: 'job-2', name: 'Job 2' });
    const jobs = repo.list();
    expect(jobs).toHaveLength(2);
  });

  it('update changes fields and bumps updatedAt', () => {
    const repo = createScheduledJobRepository(db);
    const job = insertTestScheduledJob(db);

    const updated = repo.update(job.id, { name: 'Updated Name', enabled: false });
    expect(updated.name).toBe('Updated Name');
    expect(updated.enabled).toBe(false);
  });

  it('delete removes the job', () => {
    const repo = createScheduledJobRepository(db);
    const job = insertTestScheduledJob(db);
    repo.delete(job.id);
    expect(() => repo.getOrThrow(job.id)).toThrow();
  });

  it('delete nullifies scheduled_job_id on sessions before removing', () => {
    const repo = createScheduledJobRepository(db);
    const job = insertTestScheduledJob(db);

    // Insert a session linked to this job
    db.prepare(`
      INSERT INTO sessions (
        id, profile_name, task, status, model, runtime, execution_target, branch,
        user_id, max_validation_attempts, skip_validation, acceptance_criteria,
        output_mode, scheduled_job_id
      ) VALUES (
        'linked-sess', 'test-profile', 'task', 'killed', 'opus', 'claude', 'local', 'main',
        'user-1', 3, 0, NULL, 'pr', ?
      )
    `).run(job.id);

    // Delete should not throw despite FK constraint
    expect(() => repo.delete(job.id)).not.toThrow();
    expect(() => repo.getOrThrow(job.id)).toThrow();

    // Session should still exist but scheduled_job_id should be null
    const sess = db
      .prepare('SELECT scheduled_job_id FROM sessions WHERE id = ?')
      .get('linked-sess') as { scheduled_job_id: string | null };
    expect(sess.scheduled_job_id).toBeNull();
  });

  it('listDue returns jobs with next_run_at <= now', () => {
    const repo = createScheduledJobRepository(db);
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    const futureDate = new Date(Date.now() + 60_000).toISOString();

    insertTestScheduledJob(db, { id: 'past-job', nextRunAt: pastDate });
    insertTestScheduledJob(db, { id: 'future-job', nextRunAt: futureDate });

    const due = repo.listDue();
    expect(due.map((j) => j.id)).toContain('past-job');
    expect(due.map((j) => j.id)).not.toContain('future-job');
  });

  it('listDue excludes disabled jobs', () => {
    const repo = createScheduledJobRepository(db);
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    insertTestScheduledJob(db, { id: 'disabled-past', nextRunAt: pastDate, enabled: false });

    const due = repo.listDue();
    expect(due.map((j) => j.id)).not.toContain('disabled-past');
  });

  it('listDue excludes jobs with catchup_pending=true', () => {
    const repo = createScheduledJobRepository(db);
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    insertTestScheduledJob(db, {
      id: 'catchup-pending',
      nextRunAt: pastDate,
      catchupPending: true,
    });

    const due = repo.listDue();
    expect(due.map((j) => j.id)).not.toContain('catchup-pending');
  });

  it('listOverdue returns jobs strictly in the past', () => {
    const repo = createScheduledJobRepository(db);
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    const futureDate = new Date(Date.now() + 60_000).toISOString();

    insertTestScheduledJob(db, { id: 'overdue-job', nextRunAt: pastDate });
    insertTestScheduledJob(db, { id: 'future-job', nextRunAt: futureDate });

    const overdue = repo.listOverdue();
    expect(overdue.map((j) => j.id)).toContain('overdue-job');
    expect(overdue.map((j) => j.id)).not.toContain('future-job');
  });

  it('listPendingCatchup returns only catchup_pending jobs', () => {
    const repo = createScheduledJobRepository(db);
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    insertTestScheduledJob(db, { id: 'pending', nextRunAt: pastDate, catchupPending: true });
    insertTestScheduledJob(db, { id: 'not-pending', nextRunAt: pastDate, catchupPending: false });

    const pending = repo.listPendingCatchup();
    expect(pending.map((j) => j.id)).toContain('pending');
    expect(pending.map((j) => j.id)).not.toContain('not-pending');
  });

  it('countActiveSessionsForJob counts non-terminal sessions', () => {
    const repo = createScheduledJobRepository(db);
    const job = insertTestScheduledJob(db);

    // Insert a running session linked to this job
    db.prepare(`
      INSERT INTO sessions (
        id, profile_name, task, status, model, runtime, execution_target, branch,
        user_id, max_validation_attempts, skip_validation, acceptance_criteria,
        output_mode, scheduled_job_id
      ) VALUES (
        'sess-1', 'test-profile', 'task', 'running', 'opus', 'claude', 'local', 'main',
        'user-1', 3, 0, NULL, 'pr', ?
      )
    `).run(job.id);

    // Insert a complete session linked to this job
    db.prepare(`
      INSERT INTO sessions (
        id, profile_name, task, status, model, runtime, execution_target, branch,
        user_id, max_validation_attempts, skip_validation, acceptance_criteria,
        output_mode, scheduled_job_id
      ) VALUES (
        'sess-2', 'test-profile', 'task', 'complete', 'opus', 'claude', 'local', 'main',
        'user-1', 3, 0, NULL, 'pr', ?
      )
    `).run(job.id);

    expect(repo.countActiveSessionsForJob(job.id)).toBe(1);
  });

  it('countActiveSessionsForJob returns 0 when no active sessions', () => {
    const repo = createScheduledJobRepository(db);
    const job = insertTestScheduledJob(db);
    expect(repo.countActiveSessionsForJob(job.id)).toBe(0);
  });
});
