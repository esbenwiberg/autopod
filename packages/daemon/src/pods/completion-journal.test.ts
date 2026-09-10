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
  it('cannot hide an unanswered earlier cycle behind a new admission', () => {
    const db = createTestDb();
    try {
      insertPod(db);
      const repo = createPodRepository(db);
      const pod = repo.getOrThrow('settled');
      repo.completionJournal?.settle(pod, 'Report retained');
      // Model legacy drift: a later empty cycle and missing pod pointer must
      // not erase the earlier journal's unanswered decision.
      db.prepare(
        "UPDATE pods SET status = 'running', pending_escalation = NULL WHERE id = 'settled'",
      ).run();
      db.prepare(
        "INSERT INTO pod_finalizations(pod_id,generation,cycle,phase,updated_at) VALUES ('settled',1,2,'running','2026-09-07T10:00:00Z')",
      ).run();
      expect(() => repo.completionJournal?.begin(repo.getOrThrow('settled'))).toThrow(
        'unanswered human decision',
      );
      expect(db.prepare('SELECT COUNT(*) AS count FROM pod_finalizations').get()).toEqual({
        count: 2,
      });
      expect(
        db
          .prepare('SELECT pending_decision_id AS decision FROM pod_finalizations WHERE cycle = 1')
          .get(),
      ).toEqual({ decision: 'decision' });
    } finally {
      db.close();
    }
  });

  it('retains settlement and an unanswered decision across a real database close/reopen', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'completion-journal-'));
    const source = createTestDb();
    insertPod(source);
    source
      .prepare(
        "INSERT INTO escalations(id,pod_id,type,payload) VALUES ('decision','settled','ask_human','{}')",
      )
      .run();
    const repo = createPodRepository(source);
    const pod = repo.getOrThrow('settled');
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
      const decisionContext = restarted.completionJournal?.recoveryContext(restored);
      expect(decisionContext).toContain('Select finding A');
      expect(decisionContext).toContain('Select findings');
      expect(decisionContext).toContain('decision');
      expect(restarted.completionJournal?.replyWatermark(restored.id)).toBe(0);
      const firstDecision = reopened.prepare('SELECT * FROM completion_decisions').get();
      const firstEscalation = reopened.prepare('SELECT response FROM escalations').get();
      restarted.completionJournal?.recordReply(restored, 'Select finding A', {
        type: 'human',
        userId: 'another-reviewer',
      });
      expect(reopened.prepare('SELECT * FROM completion_decisions').get()).toEqual(firstDecision);
      expect(reopened.prepare('SELECT response FROM escalations').get()).toEqual(firstEscalation);

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

  it('refuses escaped decision context larger than its bound without discarding the stored reply', () => {
    const db = createTestDb();
    try {
      insertPod(db);
      const repo = createPodRepository(db);
      const pod = repo.getOrThrow('settled');
      const response = '\u0000'.repeat(20_000);
      repo.completionJournal?.recordReply(pod, response, { type: 'human', userId: 'reviewer' });
      expect(() => repo.completionJournal?.recoveryContext(pod)).toThrow('safe continuation bound');
      expect(db.prepare('SELECT response FROM completion_decisions').get()).toEqual({ response });
    } finally {
      db.close();
    }
  });

  it('upgrades legacy decision history with a conservative event-order fence and retains it across reopen', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'decision-upgrade-'));
    const migrations = path.resolve(import.meta.dirname, '../db/migrations');
    for (const file of readdirSync(migrations)) {
      if (Number.parseInt(file, 10) <= 171)
        copyFileSync(path.join(migrations, file), path.join(dir, file));
    }
    const filename = path.join(dir, 'legacy.db');
    let db = new Database(filename);
    try {
      runMigrations(db, dir, logger);
      insertPod(db);
      db.exec(`INSERT INTO completion_decisions(pod_id,decision_id,response,actor,responded_at)
        VALUES ('settled','old-answer','Keep report only','{"type":"human","userId":"reviewer"}','2026-01-01');
        INSERT INTO events(pod_id,type,payload) VALUES ('settled','pod.agent_activity','{}');`);
      const watermark = (db.prepare('SELECT MAX(id) AS id FROM events').get() as { id: number }).id;
      runMigrations(db, migrations, logger);
      db.close();
      db = new Database(filename);
      const repo = createPodRepository(db);
      expect(repo.completionJournal?.replyWatermark('settled')).toBe(watermark);
      expect(repo.completionJournal?.recoveryContext(repo.getOrThrow('settled'))).toContain(
        'Keep report only',
      );
      expect(db.prepare('SELECT generation, question FROM completion_decisions').get()).toEqual({
        generation: null,
        question: null,
      });
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
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
