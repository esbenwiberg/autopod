import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createPodRepository } from './pod-repository.js';

// Exercise the actual SQLite triggers; fake JS clocks cannot control SQLite's clock.
describe('pod active state time', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    insertTestProfile(db, { name: 'test-app' });
    db.prepare(`INSERT INTO pods (id, profile_name, task, status, model, runtime,
      branch, user_id) VALUES ('timed', 'test-app', 'work', 'queued', 'test', 'claude', 'work', 'user')`).run();
  });
  afterEach(() => db.close());

  const transition = (db: Database.Database, status: string) =>
    db.prepare("UPDATE pods SET status = ? WHERE id = 'timed'").run(status);
  const elapsedInterval = (db: Database.Database, seconds: number) =>
    db
      .prepare(`UPDATE pod_active_time SET active_since = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
      WHERE pod_id = 'timed'`)
      .run(`-${seconds} seconds`);

  it('excludes queue, pause, human, approval and merge waits across retries', () => {
    const repo = createPodRepository(db);
    expect(repo.getActiveTimeForDisplay?.('timed')).toEqual({ elapsedMs: 0, activeSince: null });
    transition(db, 'running');
    elapsedInterval(db, 120);
    transition(db, 'paused');
    expect(repo.getActiveTimeForDisplay?.('timed')?.elapsedMs).toBeCloseTo(120_000, -2);
    for (const state of ['awaiting_input', 'validated', 'approved', 'merging', 'merge_pending']) {
      transition(db, state);
      expect(repo.getActiveTimeForDisplay?.('timed')?.activeSince).toBeNull();
      expect(repo.getActiveTimeForDisplay?.('timed')?.elapsedMs).toBeCloseTo(120_000, -2);
    }
    transition(db, 'validating');
    elapsedInterval(db, 60);
    transition(db, 'running');
    elapsedInterval(db, 30);
    transition(db, 'complete');
    const time = repo.getActiveTimeForDisplay?.('timed');
    expect(time?.elapsedMs).toBeCloseTo(210_000, -2);
    expect(time?.activeSince).toBeNull();
    expect(repo.listCompactForDisplay?.()[0]?.activeTime).toEqual(time);
    db.prepare("UPDATE pods SET updated_at = '2099-01-01' WHERE id = 'timed'").run();
    expect(repo.getActiveTimeForDisplay?.('timed')).toEqual(time);
  });

  it('does not reset on repeated status or heartbeat writes, and rolls back atomically', () => {
    transition(db, 'running');
    elapsedInterval(db, 60);
    const repo = createPodRepository(db);
    const before = repo.getActiveTimeForDisplay?.('timed');
    transition(db, 'running');
    db.prepare("UPDATE pods SET last_heartbeat_at = '2026-01-01' WHERE id = 'timed'").run();
    expect(repo.getActiveTimeForDisplay?.('timed')).toEqual(before);
    expect(() =>
      db.transaction(() => {
        transition(db, 'failed');
        throw new Error('rollback');
      })(),
    ).toThrow('rollback');
    expect(repo.getActiveTimeForDisplay?.('timed')).toEqual(before);
  });

  it('never invents legacy coverage and cascades live-ledger deletion', () => {
    db.prepare("DELETE FROM pod_active_time WHERE pod_id = 'timed'").run();
    transition(db, 'running');
    transition(db, 'complete');
    const repo = createPodRepository(db);
    expect(repo.getActiveTimeForDisplay?.('timed')).toBeNull();
    expect(repo.listCompactForDisplay?.()[0]?.activeTime).toBeNull();
    db.prepare("INSERT INTO pod_active_time (pod_id) VALUES ('timed')").run();
    repo.delete('timed');
    expect(repo.getActiveTimeForDisplay?.('timed')).toBeNull();
  });
});
