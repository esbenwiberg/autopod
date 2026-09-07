import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createPodRepository } from './pod-repository.js';

function insertPod(db: Database.Database) {
  insertTestProfile(db);
  db.prepare(`INSERT INTO pods (id, profile_name, task, status, model, runtime, branch, user_id)
    VALUES ('settled', 'test-profile', 'collect', 'awaiting_input', 'gpt-5.6-sol', 'codex', 'branch', 'user')`).run();
  db.prepare('UPDATE pods SET pending_escalation = ? WHERE id = ?').run(
    JSON.stringify({
      id: 'decision',
      podId: 'settled',
      type: 'ask_human',
      payload: { question: 'Select findings' },
    }),
    'settled',
  );
}

describe('durable completion journal', () => {
  it('retains settlement and an unanswered decision across a real database close/reopen', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'completion-journal-'));
    const source = createTestDb();
    insertPod(source);
    const repo = createPodRepository(source);
    const pod = repo.getOrThrow('settled');
    repo.completionJournal?.begin(pod);
    repo.completionJournal?.settle(pod, 'Report collected');
    repo.completionJournal?.mark(pod, 'awaiting_human', true);
    const before = repo.getOrThrow('settled').finalization;
    const filename = path.join(dir, 'restored.db');
    writeFileSync(filename, source.serialize());
    source.close();
    const reopened = new Database(filename);
    try {
      const restarted = createPodRepository(reopened);
      const restored = restarted.getOrThrow('settled');
      expect(restored.finalization).toEqual(before);
      restarted.completionJournal?.settle(restored, 'Duplicate must not overwrite report');
      restarted.completionJournal?.mark(restored, 'finished');
      expect(restarted.getOrThrow('settled').finalization).toEqual(before);
      restarted.completionJournal?.recordReply(restored, 'Select finding A', {
        type: 'human',
        userId: 'reviewer',
      });
      expect(restarted.getOrThrow('settled').finalization?.pendingDecisionId).toBeNull();
      expect(() =>
        restarted.completionJournal?.recordReply(restored, 'Select finding B', {
          type: 'human',
          userId: 'other',
        }),
      ).toThrow('different durable response');
      restarted.incrementLifecycleGeneration(restored.id);
      expect(() => restarted.completionJournal?.settle(restored)).toThrow('Stale lifecycle');
      expect(restarted.getOrThrow('settled').finalization).toBeNull();
    } finally {
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([139, 141])(
    'upgrades an existing schema %s database without losing its unanswered decision',
    (version) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'completion-upgrade-'));
      const migrations = path.resolve(import.meta.dirname, '../db/migrations');
      for (const file of readdirSync(migrations)) {
        if (Number.parseInt(file, 10) <= version)
          copyFileSync(path.join(migrations, file), path.join(dir, file));
      }
      const db = new Database(':memory:');
      try {
        runMigrations(db, dir, logger);
        insertPod(db);
        runMigrations(db, migrations, logger);
        const repo = createPodRepository(db);
        const pod = repo.getOrThrow('settled');
        expect(pod.pendingEscalation?.id).toBe('decision');
        expect(pod.status).toBe('awaiting_input');
        repo.completionJournal?.settle(pod, 'Retained report');
        expect(repo.getOrThrow('settled').finalization?.phase).toBe('awaiting_human');
        expect(db.pragma('foreign_key_check')).toEqual([]);
        expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
