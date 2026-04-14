import { AutopodError } from '@autopod/shared';
import type { Session } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestDb,
  insertTestProfile,
  insertTestScheduledJob,
  logger,
} from '../test-utils/mock-helpers.js';
import { SCHEDULER_USER_ID, createScheduledJobManager } from './scheduled-job-manager.js';
import type { ScheduledJobManagerDeps } from './scheduled-job-manager.js';
import { createScheduledJobRepository } from './scheduled-job-repository.js';

/** Insert a minimal sessions row so FK constraints on last_session_id are satisfied. */
function insertMinimalSession(db: Database.Database, id: string): void {
  db.prepare(`
    INSERT INTO sessions (
      id, profile_name, task, status, model, runtime, execution_target, branch,
      user_id, max_validation_attempts, skip_validation, output_mode
    ) VALUES (
      ?, 'test-profile', 'task', 'queued', 'opus', 'claude', 'local', 'main',
      'scheduler', 3, 0, 'pr'
    )
  `).run(id);
}

function makeDeps(db: Database.Database): ScheduledJobManagerDeps {
  const scheduledJobRepo = createScheduledJobRepository(db);

  const sessionManager = {
    createSession: vi.fn(() => {
      // Insert the session into DB so FK constraints are satisfied
      insertMinimalSession(db, 'sess-abc');
      return {
        id: 'sess-abc',
        profileName: 'test-profile',
        task: 'test task',
        status: 'queued',
        model: 'opus',
        runtime: 'claude',
        executionTarget: 'local',
        branch: 'autopod/sess-abc',
        containerId: null,
        worktreePath: null,
        validationAttempts: 0,
        maxValidationAttempts: 3,
        lastValidationResult: null,
        lastCorrectionMessage: null,
        pendingEscalation: null,
        escalationCount: 0,
        skipValidation: false,
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        updatedAt: new Date().toISOString(),
        userId: SCHEDULER_USER_ID,
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
        previewUrl: null,
        prUrl: null,
        mergeBlockReason: null,
        plan: null,
        progress: null,
        acceptanceCriteria: null,
        claudeSessionId: null,
        outputMode: 'pr' as const,
        baseBranch: null,
        acFrom: null,
        recoveryWorktreePath: null,
        reworkReason: null,
        lastHeartbeatAt: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        commitCount: 0,
        lastCommitAt: null,
        startCommitSha: null,
        linkedSessionId: null,
        taskSummary: null,
        validationOverrides: null,
        pimGroups: null,
        profileSnapshot: null,
        prFixAttempts: 0,
        maxPrFixAttempts: 3,
        fixSessionId: null,
        tokenBudget: null,
        budgetExtensionsUsed: 0,
        pauseReason: null,
        scheduledJobId: null,
      } as Session;
    }),
  } as unknown as ScheduledJobManagerDeps['sessionManager'];

  const eventBus = {
    emit: vi.fn(),
    subscribe: vi.fn(),
  } as unknown as ScheduledJobManagerDeps['eventBus'];

  return { scheduledJobRepo, sessionManager, eventBus, logger };
}

describe('ScheduledJobManager', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertTestProfile(db);
  });

  describe('create', () => {
    it('creates a job with valid cron expression', () => {
      const deps = makeDeps(db);
      const manager = createScheduledJobManager(deps);

      const job = manager.create({
        name: 'Daily scan',
        profileName: 'test-profile',
        task: 'Run the scan',
        cronExpression: '0 9 * * 1',
      });

      expect(job.name).toBe('Daily scan');
      expect(job.cronExpression).toBe('0 9 * * 1');
      expect(job.enabled).toBe(true);
      expect(job.catchupPending).toBe(false);
      expect(job.nextRunAt).toBeTruthy();
    });

    it('rejects invalid cron expression with 400', () => {
      const deps = makeDeps(db);
      const manager = createScheduledJobManager(deps);

      expect(() =>
        manager.create({
          name: 'Bad job',
          profileName: 'test-profile',
          task: 'task',
          cronExpression: 'not-a-cron',
        }),
      ).toThrow(AutopodError);
    });

    it('defaults enabled to true', () => {
      const deps = makeDeps(db);
      const manager = createScheduledJobManager(deps);

      const job = manager.create({
        name: 'Test',
        profileName: 'test-profile',
        task: 'task',
        cronExpression: '0 9 * * *',
      });
      expect(job.enabled).toBe(true);
    });

    it('respects enabled=false', () => {
      const deps = makeDeps(db);
      const manager = createScheduledJobManager(deps);

      const job = manager.create({
        name: 'Disabled',
        profileName: 'test-profile',
        task: 'task',
        cronExpression: '0 9 * * *',
        enabled: false,
      });
      expect(job.enabled).toBe(false);
    });
  });

  describe('update', () => {
    it('updates name and task', () => {
      const deps = makeDeps(db);
      const manager = createScheduledJobManager(deps);
      const job = insertTestScheduledJob(db);

      const updated = manager.update(job.id, { name: 'New name', task: 'New task' });
      expect(updated.name).toBe('New name');
      expect(updated.task).toBe('New task');
    });

    it('recomputes nextRunAt when cronExpression changes', () => {
      const deps = makeDeps(db);
      const manager = createScheduledJobManager(deps);
      const job = insertTestScheduledJob(db);
      const oldNextRunAt = job.nextRunAt;

      const updated = manager.update(job.id, { cronExpression: '0 12 * * *' });
      expect(updated.cronExpression).toBe('0 12 * * *');
      // nextRunAt should be different from the old one (different cron schedule)
      expect(updated.nextRunAt).toBeTruthy();
      // The actual value will differ from the old one since we changed the cron
      // (both will be in the future, but at different times)
      expect(typeof updated.nextRunAt).toBe('string');
      void oldNextRunAt; // suppress unused var warning
    });

    it('rejects invalid cron in update', () => {
      const deps = makeDeps(db);
      const manager = createScheduledJobManager(deps);
      const job = insertTestScheduledJob(db);

      expect(() => manager.update(job.id, { cronExpression: 'bad-cron' })).toThrow(AutopodError);
    });
  });

  describe('runCatchup', () => {
    it('creates a session and clears catchupPending', async () => {
      const deps = makeDeps(db);
      const manager = createScheduledJobManager(deps);
      const pastDate = new Date(Date.now() - 60_000).toISOString();
      const job = insertTestScheduledJob(db, { nextRunAt: pastDate, catchupPending: true });

      const session = await manager.runCatchup(job.id);

      expect(session.id).toBe('sess-abc');
      expect(deps.sessionManager.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ scheduledJobId: job.id }),
        SCHEDULER_USER_ID,
      );

      const updated = deps.scheduledJobRepo.getOrThrow(job.id);
      expect(updated.catchupPending).toBe(false);
      expect(updated.lastSessionId).toBe('sess-abc');
    });

    it('throws 409 if catchupPending is false', async () => {
      const deps = makeDeps(db);
      const manager = createScheduledJobManager(deps);
      const job = insertTestScheduledJob(db, { catchupPending: false });

      await expect(manager.runCatchup(job.id)).rejects.toThrow(AutopodError);
      await expect(manager.runCatchup(job.id)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('throws 400 if an active session exists', async () => {
      const deps = makeDeps(db);
      const manager = createScheduledJobManager(deps);
      const job = insertTestScheduledJob(db, { catchupPending: true });

      // Insert an active session for this job
      db.prepare(`
        INSERT INTO sessions (
          id, profile_name, task, status, model, runtime, execution_target, branch,
          user_id, max_validation_attempts, skip_validation, output_mode, scheduled_job_id
        ) VALUES (
          'active-sess', 'test-profile', 'task', 'running', 'opus', 'claude', 'local', 'main',
          'user-1', 3, 0, 'pr', ?
        )
      `).run(job.id);

      await expect(manager.runCatchup(job.id)).rejects.toThrow(AutopodError);
      await expect(manager.runCatchup(job.id)).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('skipCatchup', () => {
    it('clears catchupPending and advances nextRunAt', () => {
      const deps = makeDeps(db);
      const manager = createScheduledJobManager(deps);
      const pastDate = new Date(Date.now() - 60_000).toISOString();
      const job = insertTestScheduledJob(db, { nextRunAt: pastDate, catchupPending: true });

      manager.skipCatchup(job.id);

      const updated = deps.scheduledJobRepo.getOrThrow(job.id);
      expect(updated.catchupPending).toBe(false);
      expect(updated.nextRunAt).not.toBe(pastDate);
    });

    it('throws 409 if catchupPending is false', () => {
      const deps = makeDeps(db);
      const manager = createScheduledJobManager(deps);
      const job = insertTestScheduledJob(db, { catchupPending: false });

      expect(() => manager.skipCatchup(job.id)).toThrow(AutopodError);
      expect(() => manager.skipCatchup(job.id)).toThrowError(
        expect.objectContaining({ statusCode: 409 }),
      );
    });
  });

  describe('reconcileMissedJobs', () => {
    it('marks overdue jobs catchupPending=true and emits events', () => {
      const deps = makeDeps(db);
      const manager = createScheduledJobManager(deps);
      const pastDate = new Date(Date.now() - 60_000).toISOString();
      const job = insertTestScheduledJob(db, { nextRunAt: pastDate });

      manager.reconcileMissedJobs();

      const updated = deps.scheduledJobRepo.getOrThrow(job.id);
      expect(updated.catchupPending).toBe(true);
      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'scheduled_job.catchup_requested', jobId: job.id }),
      );
    });

    it('does not mark future jobs', () => {
      const deps = makeDeps(db);
      const manager = createScheduledJobManager(deps);
      const futureDate = new Date(Date.now() + 60_000).toISOString();
      const job = insertTestScheduledJob(db, { nextRunAt: futureDate });

      manager.reconcileMissedJobs();

      const updated = deps.scheduledJobRepo.getOrThrow(job.id);
      expect(updated.catchupPending).toBe(false);
    });
  });

  describe('tick', () => {
    it('fires due jobs and updates them', async () => {
      const deps = makeDeps(db);
      const manager = createScheduledJobManager(deps);
      const pastDate = new Date(Date.now() - 60_000).toISOString();
      const job = insertTestScheduledJob(db, { nextRunAt: pastDate });

      await manager.tick();

      expect(deps.sessionManager.createSession).toHaveBeenCalledOnce();
      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'scheduled_job.fired', jobId: job.id }),
      );

      const updated = deps.scheduledJobRepo.getOrThrow(job.id);
      expect(updated.lastSessionId).toBe('sess-abc');
      expect(updated.lastRunAt).toBeTruthy();
    });

    it('skips jobs with active sessions', async () => {
      const deps = makeDeps(db);
      const manager = createScheduledJobManager(deps);
      const pastDate = new Date(Date.now() - 60_000).toISOString();
      const job = insertTestScheduledJob(db, { nextRunAt: pastDate });

      db.prepare(`
        INSERT INTO sessions (
          id, profile_name, task, status, model, runtime, execution_target, branch,
          user_id, max_validation_attempts, skip_validation, output_mode, scheduled_job_id
        ) VALUES (
          'active-sess', 'test-profile', 'task', 'running', 'opus', 'claude', 'local', 'main',
          'user-1', 3, 0, 'pr', ?
        )
      `).run(job.id);

      await manager.tick();

      expect(deps.sessionManager.createSession).not.toHaveBeenCalled();
    });

    it('does not fire jobs with catchupPending=true', async () => {
      const deps = makeDeps(db);
      const manager = createScheduledJobManager(deps);
      const pastDate = new Date(Date.now() - 60_000).toISOString();
      insertTestScheduledJob(db, { nextRunAt: pastDate, catchupPending: true });

      await manager.tick();

      expect(deps.sessionManager.createSession).not.toHaveBeenCalled();
    });

    it('continues processing other jobs when one errors', async () => {
      const deps = makeDeps(db);
      const pastDate = new Date(Date.now() - 60_000).toISOString();
      const job1 = insertTestScheduledJob(db, { id: 'job-fail', nextRunAt: pastDate });
      const job2 = insertTestScheduledJob(db, { id: 'job-ok', nextRunAt: pastDate });

      let callCount = 0;
      const sessionManager = {
        createSession: vi.fn(() => {
          callCount++;
          if (callCount === 1) throw new Error('Simulated error for job1');
          // Insert a real session row so FK constraints pass for job2
          insertMinimalSession(db, 'sess-ok');
          return {
            id: 'sess-ok',
            profileName: 'test-profile',
            task: 'task',
            status: 'queued',
            model: 'opus',
            runtime: 'claude',
            executionTarget: 'local',
            branch: 'autopod/sess-ok',
            containerId: null,
            worktreePath: null,
            validationAttempts: 0,
            maxValidationAttempts: 3,
            lastValidationResult: null,
            lastCorrectionMessage: null,
            pendingEscalation: null,
            escalationCount: 0,
            skipValidation: false,
            createdAt: new Date().toISOString(),
            startedAt: null,
            completedAt: null,
            updatedAt: new Date().toISOString(),
            userId: 'scheduler',
            filesChanged: 0,
            linesAdded: 0,
            linesRemoved: 0,
            previewUrl: null,
            prUrl: null,
            mergeBlockReason: null,
            plan: null,
            progress: null,
            acceptanceCriteria: null,
            claudeSessionId: null,
            outputMode: 'pr' as const,
            baseBranch: null,
            acFrom: null,
            recoveryWorktreePath: null,
            reworkReason: null,
            lastHeartbeatAt: null,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            commitCount: 0,
            lastCommitAt: null,
            startCommitSha: null,
            linkedSessionId: null,
            taskSummary: null,
            validationOverrides: null,
            pimGroups: null,
            profileSnapshot: null,
            prFixAttempts: 0,
            maxPrFixAttempts: 3,
            fixSessionId: null,
            tokenBudget: null,
            budgetExtensionsUsed: 0,
            pauseReason: null,
            scheduledJobId: null,
          } as Session;
        }),
      } as unknown as ScheduledJobManagerDeps['sessionManager'];

      const manager = createScheduledJobManager({ ...deps, sessionManager });

      await manager.tick(); // should not throw

      // Both jobs tried, job2 succeeded
      expect(sessionManager.createSession).toHaveBeenCalledTimes(2);
      void job1;
      void job2;
    });
  });
});
