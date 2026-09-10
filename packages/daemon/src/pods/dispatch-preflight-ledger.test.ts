import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { type NewPod, createPodRepository } from './pod-repository.js';

const base = 'a'.repeat(40);
const repository = 'https://github.com/org/repo';
const request = (id: string, changes: Partial<NewPod> = {}): NewPod => ({
  id,
  profileName: 'test-profile',
  task: 'Implement the specified change',
  status: 'queued',
  model: 'model',
  runtime: 'codex',
  executionTarget: 'local',
  branch: id,
  userId: 'operator',
  maxValidationAttempts: 3,
  skipValidation: false,
  outputMode: 'pr',
  ...changes,
});
function fixture() {
  const db = createTestDb();
  insertTestProfile(db);
  const repo = createPodRepository(db);
  const ledger = repo.dispatchPreflight;
  if (!ledger) throw new Error('Missing dispatch ledger');
  return { db, repo, ledger };
}

describe('dispatch admission against immutable execution evidence', () => {
  it('serializes equivalent queued work, exempts linked rework, and requires an audited distinct rerun', () => {
    const { db, repo, ledger } = fixture();
    try {
      repo.insert(request('first'));
      repo.insert(request('second'));
      expect(ledger.inspect('second', 1, repository, 'main', base)).toMatchObject({
        status: 'review_required',
        conflicts: [{ podId: 'first', evidence: 'legacy_request' }],
      });
      const first = ledger.inspect('first', 1, repository, 'main', base);
      expect(first.status).toBe('admitted');
      repo.insert(request('fix', { linkedPodId: 'first' }));
      expect(ledger.inspect('fix', 1, repository, 'main', base).status).toBe('admitted');
      repo.insert(
        request('rerun', {
          rerunRequestHash: 'a'.repeat(64),
          intentionalRerun: {
            requestKey: 'explicit-rerun-1',
            ofPodId: 'first',
            reason: 'Repeat after requirements review',
          },
        }),
      );
      const rerun = ledger.inspect('rerun', 1, repository, 'main', base);
      expect(rerun).toMatchObject({
        status: 'admitted',
        rerun: { ofPodId: 'first', actor: { type: 'human', userId: 'operator' } },
      });
      expect(rerun.executionId).not.toBe(first.executionId);
      expect(rerun.taskId).not.toBe(first.taskId);
      expect(() =>
        db.prepare("UPDATE execution_rerun_intents SET reason = 'changed'").run(),
      ).toThrow('immutable');
      expect(() =>
        db.prepare("UPDATE execution_dispatch_preflights SET status = 'admitted'").run(),
      ).toThrow('immutable');
    } finally {
      db.close();
    }
  });
  it('retains evidence across disk restart and deletion without attributing it to a missing current execution', () => {
    const f = fixture();
    f.repo.insert(request('first'));
    const first = f.ledger.inspect('first', 1, repository, 'main', base);
    f.repo.insert(request('second'));
    f.repo.delete('first');
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-restart-'));
    writeFileSync(join(dir, 'state.db'), f.db.serialize());
    f.db.close();
    const db = new Database(join(dir, 'state.db'));
    try {
      const ledger = createPodRepository(db).dispatchPreflight;
      expect(ledger?.latest('first')).toBeNull();
      expect(ledger?.inspect('second', 1, repository, 'main', base)).toMatchObject({
        status: 'review_required',
        conflicts: [
          { executionId: first.executionId, status: 'deleted', evidence: 'dispatch_receipt' },
        ],
      });
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('freezes queued repository and base, rejects drift, and keeps independent repositories distinct', () => {
    const { db, repo, ledger } = fixture();
    try {
      repo.insert(request('first'));
      db.prepare(
        "UPDATE profiles SET repo_url = 'https://github.com/elsewhere/repo', default_branch = 'next'",
      ).run();
      expect(() =>
        ledger.inspect('first', 1, 'https://github.com/elsewhere/repo', 'next', base),
      ).toThrow('binding changed');
      expect(ledger.inspect('first', 1, repository, 'main', base).status).toBe('admitted');
      repo.insert(request('independent'));
      expect(
        ledger.inspect('independent', 1, 'https://github.com/elsewhere/repo', 'next', base).status,
      ).toBe('admitted');
      expect(() =>
        repo.insert(
          request('invalid', {
            rerunRequestHash: 'a'.repeat(64),
            intentionalRerun: { requestKey: 'explicit-rerun-1', ofPodId: 'first', reason: '' },
          }),
        ),
      ).toThrow('human reason');
      expect(() => repo.getOrThrow('invalid')).toThrow('not found');
      expect(
        db.prepare("SELECT * FROM logical_tasks WHERE root_pod_id = 'invalid'").get(),
      ).toBeUndefined();
      expect(() => ledger.inspect('first', 2, repository, 'main', base)).toThrow('Stale');
      expect(() => ledger.inspect('first', 1, repository, 'main', 'a'.repeat(41))).toThrow(
        'SHA unavailable',
      );
    } finally {
      db.close();
    }
  });
  it('does not accept malformed legacy contracts or an unknown historical repository as current evidence', () => {
    const { db, repo, ledger } = fixture();
    try {
      repo.insert(request('first'));
      repo.insert(request('second'));
      db.prepare(
        "DELETE FROM execution_dispatch_bindings WHERE execution_id = (SELECT execution_id FROM task_executions WHERE pod_id = 'first')",
      ).run();
      db.prepare(
        "UPDATE pods SET base_branch = 'main', profile_snapshot = NULL WHERE id = 'first'",
      ).run();
      expect(() => ledger.inspect('second', 1, repository, 'main', base)).toThrow(
        'Historical repository binding',
      );
      db.prepare(
        "UPDATE pods SET profile_snapshot = ?, contract = 'bad-json' WHERE id = 'first'",
      ).run(JSON.stringify({ repoUrl: repository }));
      expect(() => ledger.inspect('second', 1, repository, 'main', base)).toThrow(
        'contract is unreadable',
      );
      expect(ledger.latest('second')).toBeNull();
    } finally {
      db.close();
    }
  });
  it('ignores terminal work outside the seven-day window but retains older active work', () => {
    const { db, repo, ledger } = fixture();
    try {
      repo.insert(request('first', { status: 'complete' }));
      db.prepare("UPDATE pods SET created_at = '2020-01-01T00:00:00Z' WHERE id = 'first'").run();
      repo.insert(request('second'));
      expect(ledger.inspect('second', 1, repository, 'main', base).status).toBe('admitted');
      db.prepare("UPDATE pods SET status = 'running' WHERE id = 'first'").run();
      expect(ledger.inspect('second', 1, repository, 'main', base)).toMatchObject({
        status: 'review_required',
        conflicts: [{ podId: 'first' }],
      });
    } finally {
      db.close();
    }
  });
});

it.each([139, 156])('upgrades schema %s and preserves unknown legacy evidence', (version) => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-upgrade-'));
  const migrations = resolve(import.meta.dirname, '../db/migrations');
  for (const file of readdirSync(migrations))
    if (Number.parseInt(file, 10) <= version) copyFileSync(join(migrations, file), join(dir, file));
  const db = new Database(join(dir, 'state.db'));
  db.pragma('foreign_keys = ON');
  try {
    runMigrations(db, dir, logger);
    insertTestProfile(db);
    db.prepare(
      "INSERT INTO pods (id,profile_name,task,status,model,runtime,branch,user_id,task_summary) VALUES ('old','test-profile','old','failed','model','codex','branch','operator','malformed-preserve')",
    ).run();
    runMigrations(db, migrations, logger);
    expect(createPodRepository(db).dispatchPreflight?.latest('old')).toBeNull();
    expect(db.prepare("SELECT task_summary FROM pods WHERE id = 'old'").get()).toEqual({
      task_summary: 'malformed-preserve',
    });
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
