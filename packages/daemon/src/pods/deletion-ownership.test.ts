import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { createTestContext, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createPodManager } from './pod-manager.js';
import { createPodRepository } from './pod-repository.js';

it('rejects a second controller cleanup while the original deletion request remains unresolved', async () => {
  const ctx = createTestContext();
  const firstManager = createPodManager(ctx.deps);
  const secondManager = createPodManager({ ...ctx.deps, podRepo: createPodRepository(ctx.db) });
  const pod = firstManager.createSession(
    { profileName: 'test-profile', task: 'Retain cleanup ownership' },
    'operator',
  );
  ctx.podRepo.update(pod.id, {
    status: 'failed',
    containerId: 'owned-container',
    worktreePath: '/tmp/owned-source',
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(ctx.containerManager.kill)
    .mockImplementationOnce(() => pending)
    .mockResolvedValue(undefined);
  const first = firstManager.deleteSession(pod.id).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await vi.waitFor(() => expect(ctx.containerManager.kill).toHaveBeenCalledOnce());
    const second = await secondManager.deleteSession(pod.id).then(
      () => null,
      (error: unknown) => error,
    );
    expect(second).toMatchObject({ code: 'POD_DELETE_CLEANUP_UNVERIFIED' });
    expect(ctx.containerManager.kill).toHaveBeenCalledOnce();
    expect(ctx.worktreeManager.cleanup).not.toHaveBeenCalled();
    expect(ctx.podRepo.getOrThrow(pod.id).worktreePath).toBe('/tmp/owned-source');
    release();
    expect(await first).toBeNull();
  } finally {
    release();
    await first;
    ctx.db.close();
  }
});

it('keeps a timed-out call exclusive until settlement and reuses its late successful step', async () => {
  vi.useFakeTimers();
  const ctx = createTestContext();
  const manager = createPodManager(ctx.deps);
  const pod = manager.createSession(
    { profileName: 'test-profile', task: 'Preserve late cleanup' },
    'operator',
  );
  ctx.podRepo.update(pod.id, {
    status: 'failed',
    runtime: 'copilot',
    containerId: 'owned',
    worktreePath: '/tmp/owned',
  });
  let release = () => {};
  vi.mocked(ctx.containerManager.kill).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const result = manager.deleteSession(pod.id).catch((error: unknown) => error);
  try {
    await vi.advanceTimersByTimeAsync(25001);
    expect(await result).toMatchObject({ code: 'POD_DELETE_CLEANUP_UNVERIFIED' });
    const other = createPodManager({ ...ctx.deps, podRepo: createPodRepository(ctx.db) });
    await expect(other.deleteSession(pod.id)).rejects.toMatchObject({
      code: 'POD_DELETE_CLEANUP_UNVERIFIED',
    });
    expect(() => ctx.podRepo.incrementLifecycleGeneration(pod.id)).toThrow(
      'cleanup ownership is unresolved',
    );
    expect(() =>
      ctx.db.prepare("UPDATE pods SET container_id='different' WHERE id=?").run(pod.id),
    ).toThrow('cleanup ownership is unresolved');
    expect(() =>
      ctx.podRepo.taskExecutions?.beginRun(pod.id, pod.lifecycleGeneration, 1, {
        runtime: pod.runtime,
        model: pod.model,
        providerAccountId: null,
      }),
    ).toThrow('cleanup ownership is unresolved');
    expect(ctx.worktreeManager.cleanup).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(0);
    await other.deleteSession(pod.id);
    expect(ctx.containerManager.kill).toHaveBeenCalledOnce();
    expect(ctx.worktreeManager.cleanup).toHaveBeenCalledOnce();
    expect(ctx.db.prepare('SELECT count(*) AS count FROM deletion_cleanup_steps').get()).toEqual({
      count: 7,
    });
    expect(
      ctx.db
        .prepare('SELECT count(*) AS count FROM deletion_cleanup_attempts WHERE settled_at IS NULL')
        .get(),
    ).toEqual({ count: 0 });
  } finally {
    release();
    await result;
    vi.useRealTimers();
    ctx.db.close();
  }
});

it.each(['worktree', 'archive'] as const)(
  'reopens a settled %s failure and resumes only unfinished cleanup',
  async (fault) => {
    const ctx = createTestContext();
    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Reopen cleanup' },
      'operator',
    );
    ctx.podRepo.update(pod.id, {
      status: 'failed',
      runtime: 'copilot',
      containerId: 'owned',
      worktreePath: '/tmp/owned',
    });
    if (fault === 'worktree')
      vi.mocked(ctx.worktreeManager.cleanup).mockRejectedValueOnce(
        new Error('transport unavailable'),
      );
    else
      ctx.db.exec(
        "CREATE TRIGGER fail_archive BEFORE INSERT ON task_history_deletions BEGIN SELECT RAISE(ABORT,'fixture archive failure'); END",
      );
    await expect(manager.deleteSession(pod.id)).rejects.toThrow();
    expect(ctx.db.prepare('SELECT completed_at FROM deletion_cleanup_intents').get()).toEqual({
      completed_at: null,
    });
    const dir = mkdtempSync(join(tmpdir(), 'deletion-reopen-'));
    const file = join(dir, 'state.db');
    writeFileSync(file, ctx.db.serialize());
    const reopened = new Database(file);
    try {
      reopened.pragma('foreign_keys = ON');
      if (fault === 'archive') reopened.exec('DROP TRIGGER fail_archive');
      vi.mocked(ctx.containerManager.kill).mockRejectedValue(
        new Error('completed container step must not run again'),
      );
      const repo = createPodRepository(reopened);
      const other = createPodManager({ ...ctx.deps, podRepo: repo });
      await other.deleteSession(pod.id);
      expect(ctx.containerManager.kill).toHaveBeenCalledOnce();
      expect(ctx.worktreeManager.cleanup).toHaveBeenCalledTimes(fault === 'worktree' ? 2 : 1);
      expect(
        reopened.prepare('SELECT count(*) AS count FROM retained_pods WHERE id=?').get(pod.id),
      ).toEqual({ count: 1 });
      expect(() =>
        reopened.prepare("UPDATE deletion_cleanup_steps SET name='network'").run(),
      ).toThrow('immutable');
      expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(reopened.pragma('foreign_key_check')).toEqual([]);
    } finally {
      reopened.close();
      ctx.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it('upgrades schema 181 and keeps abandoned ownership fenced across disk reopen and elapsed time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deletion-upgrade-'));
  const migrations = resolve(import.meta.dirname, '../db/migrations');
  const file = join(dir, 'state.db');
  let db = new Database(file);
  try {
    for (const name of readdirSync(migrations))
      if (Number.parseInt(name, 10) <= 181) copyFileSync(join(migrations, name), join(dir, name));
    runMigrations(db, dir, logger);
    insertTestProfile(db);
    db.prepare(
      "INSERT INTO pods(id,profile_name,task,status,model,runtime,branch,user_id) VALUES ('old','test-profile','Retain abandoned cleanup','failed','model','copilot','old','operator')",
    ).run();
    const before = db.prepare("SELECT * FROM pods WHERE id='old'").get();
    runMigrations(db, migrations, logger);
    expect(db.prepare("SELECT * FROM pods WHERE id='old'").get()).toEqual(before);
    const repo = createPodRepository(db);
    repo.taskExecutions?.register('old');
    repo.deletionOwnership?.acquire('old', 'null');
    db.close();
    db = new Database(file);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01'));
    const next = createPodRepository(db);
    expect(() => next.deletionOwnership?.acquire('old', 'null')).toThrow(
      'cleanup ownership is unresolved',
    );
    expect(() => next.delete('old')).toThrow('cleanup is incomplete');
    expect(() =>
      db
        .prepare("UPDATE pods SET lifecycle_generation=lifecycle_generation+1 WHERE id='old'")
        .run(),
    ).toThrow('cleanup ownership is unresolved');
    expect(db.prepare('SELECT count(*) AS count FROM task_history_deletions').get()).toEqual({
      count: 0,
    });
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    vi.useRealTimers();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('atomically rejects cleanup admission when a task worker already owns execution', () => {
  const ctx = createTestContext();
  try {
    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Preserve worker' },
      'operator',
    );
    ctx.podRepo.update(pod.id, { status: 'failed' });
    ctx.podRepo.taskExecutions?.beginRun(pod.id, pod.lifecycleGeneration, 1, {
      runtime: pod.runtime,
      model: pod.model,
      providerAccountId: null,
    });
    expect(() => ctx.podRepo.deletionOwnership?.acquire(pod.id, 'configuration')).toThrow(
      'cleanup ownership is unresolved',
    );
    expect(() =>
      ctx.db
        .prepare(`INSERT INTO deletion_cleanup_intents(id,pod_id,task_id,identity,created_at)
      SELECT 'old-writer',pod_id,task_id,'{}','2026-09-08' FROM task_executions WHERE pod_id=?`)
        .run(pod.id),
    ).toThrow('settled task execution ownership');
    expect(ctx.db.prepare('SELECT count(*) AS count FROM deletion_cleanup_intents').get()).toEqual({
      count: 0,
    });
    expect(ctx.podRepo.taskExecutions?.hasActiveRun(pod.id)).toBe(true);
  } finally {
    ctx.db.close();
  }
});
