import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createPodRepository } from './pod-repository.js';
import { createTaskRetryLedger } from './task-retry-ledger.js';

const identity = {
  source: 'a'.repeat(64),
  contract: 'b'.repeat(64),
  commands: 'c'.repeat(64),
  environment: null,
  implementation: null,
};
const binding = 'd'.repeat(64);
function fixture() {
  const db = createTestDb();
  insertTestProfile(db);
  const repo = createPodRepository(db);
  for (const [id, parent] of [
    ['root', null],
    ['fix', 'root'],
    ['rerun', null],
  ] as const)
    repo.insert({
      id,
      profileName: 'test-profile',
      task: 'Validate',
      status: 'running',
      model: 'model',
      runtime: 'codex',
      executionTarget: 'local',
      branch: id,
      userId: 'user',
      maxValidationAttempts: 3,
      skipValidation: false,
      outputMode: 'pr',
      linkedPodId: parent,
    });
  const ledger = repo.taskRetries;
  if (!ledger) throw new Error('Missing ledger');
  return { db, repo, ledger };
}

describe('durable task validation retry admission', () => {
  it('blocks admission and execution when a pending pod question survives with a stale running status', () => {
    const { db, ledger } = fixture();
    try {
      const question = JSON.stringify({
        id: 'drifted-question',
        payload: { question: 'Approve validation?' },
      });
      db.prepare("UPDATE pods SET pending_escalation = ? WHERE id = 'root'").run(question);
      expect(() => ledger.admit('root', 1, identity, binding, [])).toThrow(
        'unanswered human decision',
      );
      expect(ledger.state('root').admissionCount).toBe(0);
      db.prepare("UPDATE pods SET pending_escalation = NULL WHERE id = 'root'").run();
      const admission = ledger.admit('root', 1, identity, binding, []);
      db.prepare("UPDATE pods SET pending_escalation = ? WHERE id = 'root'").run(question);
      expect(() => ledger.start(admission.id)).toThrow('unanswered human decision');
      expect(ledger.state('root').executedCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it('pins backoffs and cumulative budget across disk restart and linked fixes while reruns are distinct', () => {
    const f = fixture();
    const first = f.ledger.admit('root', 1, identity, binding, [0]);
    f.ledger.start(first.id);
    f.ledger.finish(first.id, 'transient', 7);
    const second = f.ledger.admit('fix', 1, identity, binding, [0, 0, 0]);
    f.ledger.start(second.id);
    f.ledger.finish(second.id, 'transient', 9);
    const dir = mkdtempSync(join(tmpdir(), 'retry-ledger-'));
    writeFileSync(join(dir, 'state.db'), f.db.serialize());
    f.db.close();
    const db = new Database(join(dir, 'state.db'));
    try {
      const next = createPodRepository(db).taskRetries;
      expect(next?.state('fix')).toMatchObject({
        backoffsMs: [0],
        admissionCount: 2,
        executedCount: 2,
        transientRetryCount: 1,
        measuredDurationMs: 16,
      });
      expect(() => next?.admit('root', 1, identity, binding, [0, 0, 0])).toThrow('retry budget');
      expect(next?.admit('rerun', 1, identity, binding, [0])).toMatchObject({ retryKind: null });
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('requires known changed conditions or one consumed human authorization after nonretryable failure', () => {
    const { db, ledger } = fixture();
    try {
      const first = ledger.admit('root', 1, identity, binding, [0]);
      ledger.start(first.id);
      ledger.finish(first.id, 'nonretryable', 3);
      expect(() => ledger.admit('fix', 1, identity, binding, [0])).toThrow('Unchanged');
      expect(() =>
        ledger.admit('root', 1, { ...identity, environment: 'e'.repeat(64) }, binding, [0]),
      ).toThrow('Unchanged');
      const human = { type: 'human' as const, userId: 'operator' };
      const grant = ledger.authorize(
        'fix',
        'unique-request',
        'Dependency service repaired externally',
        human,
      );
      expect(ledger.authorize('fix', 'unique-request', grant.reason, human).id).toBe(grant.id);
      expect(() => ledger.authorize('fix', 'unique-request', 'Different decision', human)).toThrow(
        'different authorization',
      );
      expect(() => ledger.admit('fix', 1, identity, 'f'.repeat(64), [0])).toThrow(
        'provider binding',
      );
      const override = ledger.admit('fix', 1, identity, binding, [0]);
      expect(override.retryKind).toBe('override');
      expect(ledger.state('root').authorizations[0]?.usedByAttemptId).toBe(override.id);
      expect(() => ledger.admit('root', 1, identity, binding, [0])).toThrow('already active');
      ledger.start(override.id);
      ledger.finish(override.id, 'nonretryable', 5);
      expect(() => ledger.admit('fix', 1, identity, binding, [0])).toThrow('Unchanged');
      const changed = ledger.admit(
        'root',
        1,
        { ...identity, source: 'e'.repeat(64) },
        binding,
        [0],
      );
      expect(changed.retryKind).toBe('changed_conditions');
      expect(() =>
        db.prepare('UPDATE task_retry_authorizations SET reason = ?').run('rewritten'),
      ).toThrow('immutable');
      expect(() =>
        db.prepare('UPDATE task_retry_attempts SET outcome = ? WHERE id = ?').run('pass', first.id),
      ).toThrow('immutable');
    } finally {
      db.close();
    }
  });
  it('enforces persisted backoff, generation and honest interrupted execution accounting', () => {
    const { db, repo, ledger } = fixture();
    try {
      const first = ledger.admit('root', 1, identity, binding, [60000]);
      ledger.start(first.id);
      ledger.finish(first.id, 'transient', 5);
      const second = ledger.admit('fix', 1, identity, binding, [0]);
      expect(
        Date.parse(second.notBefore) - Date.parse(ledger.state('root').latest?.admittedAt ?? ''),
      ).toBeGreaterThan(59000);
      expect(() => ledger.start(second.id)).toThrow('backoff');
      expect(ledger.recoverInterrupted()).toBe(1);
      expect(ledger.recoverInterrupted()).toBe(0);
      expect(ledger.state('root')).toMatchObject({
        admissionCount: 2,
        executedCount: 1,
        interruptedCount: 1,
        measuredDurationMs: 5,
        latest: { outcome: 'unknown', measuredDurationMs: null },
      });
      expect(() => ledger.admit('root', 1, identity, binding, [0])).toThrow('Unchanged');
      ledger.authorize('root', 'after-interruption', 'Inspected previous interrupted admission', {
        type: 'human',
        userId: 'operator',
      });
      const next = ledger.admit('root', 1, identity, binding, [0]);
      repo.incrementLifecycleGeneration('root');
      expect(() => ledger.start(next.id)).toThrow('stale execution');
      expect(() => ledger.admit('root', 1, identity, binding, [0])).toThrow('Stale lifecycle');
    } finally {
      db.close();
    }
  });
});

it.each([139, 155])(
  'upgrades schema %s on disk without changing legacy evidence and retains retry settlement through reopen',
  (version) => {
    const dir = mkdtempSync(join(tmpdir(), 'retry-upgrade-'));
    const migrations = resolve(import.meta.dirname, '../db/migrations');
    for (const file of readdirSync(migrations))
      if (Number.parseInt(file, 10) <= version)
        copyFileSync(join(migrations, file), join(dir, file));
    const filename = join(dir, 'state.db');
    let db = new Database(filename);
    db.pragma('foreign_keys = ON');
    try {
      runMigrations(db, dir, logger);
      insertTestProfile(db);
      db.prepare(
        `INSERT INTO pods (id,profile_name,task,status,model,runtime,branch,user_id,task_summary) VALUES ('old','test-profile','old','failed','model','codex','branch','operator','malformed-preserve')`,
      ).run();
      runMigrations(db, migrations, logger);
      const repo = createPodRepository(db);
      repo.taskExecutions?.register('old');
      const admission = repo.taskRetries?.admit('old', 1, identity, binding, [0]);
      if (!admission) throw new Error('No admission');
      repo.taskRetries?.start(admission.id);
      db.close();
      db = new Database(filename);
      db.pragma('foreign_keys = ON');
      const recovered = createPodRepository(db).taskRetries;
      expect(recovered?.recoverInterrupted()).toBe(1);
      expect(recovered?.state('old')).toMatchObject({
        executedCount: 1,
        interruptedCount: 1,
        latest: { outcome: 'unknown', measuredDurationMs: null },
      });
      expect(db.prepare('SELECT task_summary FROM pods WHERE id = ?').get('old')).toEqual({
        task_summary: 'malformed-preserve',
      });
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it('does not let retry authorization bypass an unanswered durable human decision', () => {
  const { db, ledger } = fixture();
  try {
    const first = ledger.admit('root', 1, identity, binding, []);
    ledger.start(first.id);
    ledger.finish(first.id, 'nonretryable', 1);
    ledger.authorize('root', 'human-override', 'Allow one validation after reconciliation', {
      type: 'human',
      userId: 'operator',
    });
    db.prepare(
      `INSERT INTO pod_finalizations (pod_id,generation,cycle,phase,pending_decision_id,updated_at) VALUES ('root',1,0,'awaiting_human','question',?)`,
    ).run(new Date().toISOString());
    expect(() => ledger.admit('root', 1, identity, binding, [])).toThrow(
      'unanswered human decision',
    );
    expect(ledger.state('root').authorizations[0]?.usedByAttemptId).toBeNull();
    db.prepare(
      `INSERT INTO completion_decisions (pod_id,decision_id,response,actor,responded_at) VALUES ('root','question','"reply"','{"type":"human","userId":"operator"}',?)`,
    ).run(new Date().toISOString());
    const admission = ledger.admit('root', 1, identity, binding, []);
    db.prepare(
      `INSERT INTO pod_finalizations (pod_id,generation,cycle,phase,pending_decision_id,updated_at) VALUES ('root',1,1,'awaiting_human','later-question',?)`,
    ).run(new Date().toISOString());
    expect(() => ledger.start(admission.id)).toThrow('unanswered human decision');
    expect(ledger.state('root').executedCount).toBe(1);
  } finally {
    db.close();
  }
});

it('persists sandbox startup policy across disk restart and linked fixes independently from validation', () => {
  const f = fixture();
  const startup = createTaskRetryLedger(f.db, 'sandbox_startup');
  const first = startup.admit('root', 1, identity, binding, [0]);
  startup.start(first.id);
  startup.finish(first.id, 'transient', 7);
  const second = startup.admit('fix', 1, identity, binding, [0, 0]);
  startup.start(second.id);
  startup.finish(second.id, 'transient', 9);
  const validation = f.ledger.admit('fix', 1, identity, binding, []);
  f.ledger.start(validation.id);
  f.ledger.finish(validation.id, 'nonretryable', 4);
  const human = { type: 'human' as const, userId: 'operator' };
  const grant = startup.authorize('fix', 'startup-key', 'Sandbox prerequisite inspected', human);
  expect(() => f.ledger.authorize('fix', 'startup-key', grant.reason, human)).toThrow(
    'different authorization',
  );
  expect(f.ledger.state('fix').authorizations).toEqual([]);
  startup.assertCanAdmit('fix', 1, identity, binding, [0]);
  expect(startup.state('fix').admissionCount).toBe(2);
  expect(startup.state('fix').authorizations[0]?.usedByAttemptId).toBeNull();
  const dir = mkdtempSync(join(tmpdir(), 'startup-retry-ledger-'));
  writeFileSync(join(dir, 'state.db'), f.db.serialize());
  f.db.close();
  const db = new Database(join(dir, 'state.db'));
  try {
    const repo = createPodRepository(db);
    const next = repo.sandboxStartupRetries;
    if (!next) throw new Error('Missing startup ledger');
    expect(() => next.assertCanAdmit('root', 1, identity, binding, [0, 0, 0])).toThrow(
      'retry budget exhausted',
    );
    expect(next.state('fix')).toMatchObject({
      backoffsMs: [0],
      executedCount: 2,
      transientRetryCount: 1,
      measuredDurationMs: 16,
    });
    const admitted = next.admit('fix', 1, identity, binding, [0]);
    expect(admitted.retryKind).toBe('override');
    expect(() => repo.taskRetries?.start(admitted.id)).toThrow('already started or settled');
    expect(() => repo.taskRetries?.finish(admitted.id, 'unknown', null)).toThrow(
      'Unknown retry admission',
    );
    expect(repo.taskRetries?.recoverInterrupted()).toBe(0);
    expect(next.recoverInterrupted()).toBe(1);
    expect(next.state('fix')).toMatchObject({
      executedCount: 2,
      interruptedCount: 1,
      measuredDurationMs: 16,
      latest: { outcome: 'unknown', measuredDurationMs: null },
    });
    expect(() => next.admit('fix', 1, identity, binding, [0])).toThrow('Unchanged');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('subtracts recorded legacy sandbox recoveries across the logical task from the initial allowance', () => {
  const { db, repo } = fixture();
  try {
    repo.update('root', { infrastructureRecoveryCount: 1 });
    const startup = createTaskRetryLedger(db, 'sandbox_startup');
    const first = startup.admit('fix', 1, identity, binding, [30000]);
    startup.start(first.id);
    startup.finish(first.id, 'transient', 5);
    expect(startup.state('fix').backoffsMs).toEqual([]);
    repo.update('root', { infrastructureRecoveryCount: 0 });
    expect(() => startup.admit('fix', 1, identity, binding, [0, 0])).toThrow(
      'retry budget exhausted',
    );
  } finally {
    db.close();
  }
});

it('consumes one task-wide Codex recovery allowance even after success and requires a scoped human extension', () => {
  const { db, repo } = fixture();
  try {
    const ledger = repo.codexInterruptionRetries;
    if (!ledger) throw new Error('Missing recovery ledger');
    const first = ledger.admit('root', 1, identity, binding, []);
    ledger.start(first.id);
    ledger.finish(first.id, 'pass', 12);
    expect(() =>
      ledger.admit('fix', 1, { ...identity, source: 'f'.repeat(64) }, binding, [0, 0]),
    ).toThrow('task-wide Codex interruption recovery');
    const actor = { type: 'human' as const, userId: 'operator' };
    const grant = ledger.authorize(
      'fix',
      'extension',
      'Inspected retained work before another recovery',
      actor,
    );
    expect(ledger.authorize('fix', 'extension', grant.reason, actor).id).toBe(grant.id);
    expect(() => ledger.admit('root', 1, identity, binding, [])).toThrow(
      'task-wide Codex interruption recovery',
    );
    expect(() => ledger.admit('fix', 1, identity, 'e'.repeat(64), [])).toThrow('binding changed');
    const next = ledger.admit('fix', 1, identity, binding, []);
    expect(next.retryKind).toBe('override');
    expect(ledger.state('root').authorizations[0]?.usedByAttemptId).toBe(next.id);
    expect(ledger.recoverInterrupted()).toBe(1);
    expect(ledger.state('fix')).toMatchObject({
      admissionCount: 2,
      executedCount: 1,
      measuredDurationMs: 12,
      interruptedCount: 1,
    });
    expect(() => ledger.admit('fix', 1, identity, binding, [])).toThrow(
      'task-wide Codex interruption recovery',
    );
    expect(ledger.admit('rerun', 1, identity, binding, [])).toMatchObject({ retryKind: null });
    expect(repo.taskRetries?.state('fix').admissionCount).toBe(0);
  } finally {
    db.close();
  }
});
