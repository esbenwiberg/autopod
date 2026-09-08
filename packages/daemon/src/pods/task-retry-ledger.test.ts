import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createPodRepository } from './pod-repository.js';
import { createTaskExecutionLedger } from './task-execution-ledger.js';
import { createTaskRetryLedger } from './task-retry-ledger.js';
import { unavailableWorkerInputs, workerBindingHash } from './worker-retry-history.js';

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

it.each(['auth', 'unknown', null, 'initialization'])(
  'retains legacy worker failure %s and one scoped authorization across deletion and disk reopen',
  (category) => {
    const { db, repo } = fixture();
    const bound = { runtime: 'codex', model: 'model', providerAccountId: null };
    const run = repo.taskExecutions?.beginRun('root', 1, 1, bound);
    if (!run) throw new Error('Missing run');
    repo.taskExecutions?.finishRun(run, 'failed', category);
    repo.delete('root');
    const dir = mkdtempSync(join(tmpdir(), 'worker-auth-retry-'));
    const file = join(dir, 'state.db');
    writeFileSync(file, db.serialize());
    db.close();
    const reopened = new Database(file);
    try {
      reopened.pragma('foreign_keys = ON');
      const next = createPodRepository(reopened);
      const ledger = next.workerRetries;
      if (!ledger) throw new Error('Missing worker retries');
      const state = ledger.state('fix');
      expect(state).toMatchObject({
        stage: 'worker',
        admissionCount: 1,
        executedCount: category === 'auth' ? 1 : 0,
        latest: {
          id: run,
          outcome: category === 'auth' ? 'nonretryable' : 'unknown',
          measuredDurationMs: null,
          identity: unavailableWorkerInputs,
        },
      });
      expect(ledger.state('fix')).toEqual(state);
      expect(() =>
        ledger.assertCanAdmit('fix', 1, unavailableWorkerInputs, workerBindingHash(bound), []),
      ).toThrow(/authentication|nonretryable/);
      const grant = ledger.authorize(
        'fix',
        'repair-auth',
        'Credentials repaired; permit one retry',
        {
          type: 'human',
          userId: 'operator',
        },
      );
      expect(() =>
        ledger.assertCanAdmit(
          'fix',
          1,
          unavailableWorkerInputs,
          workerBindingHash({ ...bound, model: 'other' }),
          [],
        ),
      ).toThrow(/binding changed/);
      expect(ledger.state('fix').authorizations[0]?.usedByAttemptId).toBeNull();
      const admitted = reopened.transaction(() => {
        const id = next.taskExecutions?.beginRun('fix', 1, 1, bound);
        if (!id) throw new Error('Missing run');
        const value = ledger.admit(
          'fix',
          1,
          unavailableWorkerInputs,
          workerBindingHash(bound),
          [],
          id,
        );
        ledger.start(id);
        return value;
      })();
      expect(admitted.retryKind).toBe('override');
      expect(ledger.state('fix').authorizations).toContainEqual(
        expect.objectContaining({ id: grant.id, usedByAttemptId: admitted.id }),
      );
      next.taskExecutions?.finishRun(admitted.id, 'failed', 'auth');
      ledger.finish(admitted.id, 'nonretryable', 10);
      expect(() =>
        ledger.assertCanAdmit('fix', 1, unavailableWorkerInputs, workerBindingHash(bound), []),
      ).toThrow(/authentication|nonretryable/);
      expect(ledger.state('rerun').admissionCount).toBe(0);
      expect(
        reopened
          .prepare('SELECT failure_category FROM task_history_task_agent_runs WHERE id = ?')
          .get(run),
      ).toEqual({ failure_category: category });
      expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(reopened.pragma('foreign_key_check')).toEqual([]);
    } finally {
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it('rolls back a worker retry authorization use when initialization fails', () => {
  const { db, repo } = fixture();
  try {
    const bound = { runtime: 'codex', model: 'model', providerAccountId: null };
    const failed = repo.taskExecutions?.beginRun('root', 1, 1, bound);
    if (!failed || !repo.workerRetries) throw new Error('Missing worker ledger');
    repo.taskExecutions?.finishRun(failed, 'failed', 'auth');
    const ledger = repo.workerRetries;
    ledger.authorize('fix', 'initialization-fault', 'Credential repair checked', {
      type: 'human',
      userId: 'operator',
    });
    expect(() =>
      db.transaction(() => {
        const run = repo.taskExecutions?.beginRun('fix', 1, 1, bound);
        ledger.admit('fix', 1, unavailableWorkerInputs, workerBindingHash(bound), [], run);
        throw new Error('provider initialization failed');
      })(),
    ).toThrow('provider initialization failed');
    expect(ledger.state('fix').admissionCount).toBe(1);
    expect(ledger.state('fix').authorizations[0]?.usedByAttemptId).toBeNull();
    expect(repo.taskExecutions?.snapshot('fix').agentRunCount).toBe(1);
  } finally {
    db.close();
  }
});

it('does not claim legacy worker reservations executed without terminal execution evidence', () => {
  const { db, repo } = fixture();
  try {
    const bound = { runtime: 'codex', model: 'model', providerAccountId: null };
    const run = repo.taskExecutions?.beginRun('root', 1, 1, bound);
    if (!run || !repo.workerRetries) throw new Error('Missing worker ledger');
    repo.taskExecutions?.finishRun(run, 'failed', 'initialization');
    expect(repo.workerRetries.state('fix')).toMatchObject({
      admissionCount: 1,
      executedCount: 0,
      authorizationRequired: true,
      retryFailure: 'unknown',
      latest: { outcome: 'unknown', startedAt: null, measuredDurationMs: null },
    });
  } finally {
    db.close();
  }
});

it.each([{ backoffs: [] }, { backoffs: [0] }])(
  'preserves frozen worker transient allowance $backoffs across disk reopen and deletion',
  ({ backoffs }) => {
    const { db, repo } = fixture();
    const bound = { runtime: 'codex', model: 'model', providerAccountId: null };
    const run = repo.taskExecutions?.beginRun('root', 1, 1, bound);
    if (!run || !repo.workerRetries) throw new Error('Missing worker ledger');
    repo.workerRetries.admit(
      'root',
      1,
      unavailableWorkerInputs,
      workerBindingHash(bound),
      backoffs,
      run,
    );
    repo.workerRetries.start(run);
    repo.taskExecutions?.finishRun(run, 'failed', 'transient');
    repo.workerRetries.finish(run, 'transient', 10);
    if (backoffs.length) {
      const next = repo.taskExecutions?.beginRun('fix', 1, 1, bound);
      if (!next) throw new Error('Missing retry run');
      repo.workerRetries.admit(
        'fix',
        1,
        unavailableWorkerInputs,
        workerBindingHash(bound),
        [0, 0],
        next,
      );
      repo.workerRetries.start(next);
      repo.taskExecutions?.finishRun(next, 'failed', 'provider_unavailable');
      repo.workerRetries.finish(next, 'transient', 15);
    }
    repo.delete('root');
    const dir = mkdtempSync(join(tmpdir(), 'worker-transient-retry-'));
    const file = join(dir, 'state.db');
    writeFileSync(file, db.serialize());
    db.close();
    const reopened = new Database(file);
    try {
      reopened.pragma('foreign_keys = ON');
      const next = createPodRepository(reopened);
      const ledger = next.workerRetries;
      if (!ledger) throw new Error('Missing worker retries');
      expect(ledger.state('fix')).toMatchObject({
        backoffsMs: backoffs,
        transientRetryCount: backoffs.length,
        admissionCount: 1 + backoffs.length,
        executedCount: 1 + backoffs.length,
        authorizationRequired: true,
        retryFailure: 'transient',
      });
      expect(() =>
        ledger.assertCanAdmit(
          'fix',
          1,
          unavailableWorkerInputs,
          workerBindingHash(bound),
          [0, 0, 0],
        ),
      ).toThrow('budget exhausted');
      ledger.authorize('fix', 'one-retry', 'Provider checked', {
        type: 'human',
        userId: 'operator',
      });
      expect(() =>
        ledger.assertCanAdmit(
          'fix',
          1,
          unavailableWorkerInputs,
          workerBindingHash({ ...bound, providerAccountId: 'other-account' }),
          [0, 0],
        ),
      ).toThrow('binding changed');
      expect(ledger.state('fix').authorizations[0]?.usedByAttemptId).toBeNull();
      expect(ledger.state('rerun').admissionCount).toBe(0);
      expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it('does not mint a new worker allowance for legacy transient history without a persisted policy', () => {
  const { db, repo } = fixture();
  try {
    const bound = { runtime: 'codex', model: 'model', providerAccountId: null };
    const run = repo.taskExecutions?.beginRun('root', 1, 1, bound);
    if (!run || !repo.workerRetries) throw new Error('Missing worker ledger');
    repo.taskExecutions?.finishRun(run, 'failed', 'transient');
    const ledger = repo.workerRetries;
    expect(ledger.state('fix')).toMatchObject({
      backoffsMs: null,
      admissionCount: 1,
      retryFailure: 'transient',
      authorizationRequired: true,
    });
    expect(() =>
      ledger.assertCanAdmit(
        'fix',
        1,
        unavailableWorkerInputs,
        workerBindingHash(bound),
        [1000, 5000],
      ),
    ).toThrow('budget exhausted');
    ledger.authorize('fix', 'legacy-worker', 'Inspect legacy task before one retry', {
      type: 'human',
      userId: 'operator',
    });
    const next = repo.taskExecutions?.beginRun('fix', 1, 1, bound);
    if (!next) throw new Error('Missing retry run');
    expect(
      ledger.admit('fix', 1, unavailableWorkerInputs, workerBindingHash(bound), [1000, 5000], next)
        .retryKind,
    ).toBe('override');
    expect(ledger.state('fix').backoffsMs).toEqual([]);
  } finally {
    db.close();
  }
});

it('scopes worker provider reconciliation to its exact target and preserves it across reopen', () => {
  const { db, repo } = fixture();
  const original = { runtime: 'codex', model: 'model', providerAccountId: 'original' };
  const target = { runtime: 'claude', model: 'other-model', providerAccountId: 'selected' };
  const failed = repo.taskExecutions?.beginRun('root', 1, 1, original);
  if (!failed || !repo.workerRetries) throw new Error('Missing worker retries');
  repo.taskExecutions?.finishRun(failed, 'failed', 'auth');
  const ledger = repo.workerRetries;
  const actor = { type: 'human' as const, userId: 'operator' };
  const generic = ledger.authorize('fix', 'generic-retry', 'Retry original provider', actor);
  expect(() =>
    ledger.assertCanAdmit('fix', 1, unavailableWorkerInputs, workerBindingHash(target), []),
  ).toThrow('binding changed');
  const scoped = ledger.authorize(
    'fix',
    'target-recovery',
    'Use the selected provider',
    actor,
    workerBindingHash(target),
  );
  expect(
    ledger.authorize(
      'fix',
      'target-recovery',
      'Use the selected provider',
      actor,
      workerBindingHash(target),
    ).id,
  ).toBe(scoped.id);
  expect(() =>
    ledger.authorize(
      'fix',
      'target-recovery',
      'Use the selected provider',
      actor,
      workerBindingHash(original),
    ),
  ).toThrow('different authorization');
  expect(() =>
    ledger.assertCanAdmit(
      'fix',
      1,
      unavailableWorkerInputs,
      workerBindingHash({ ...target, model: 'third-model' }),
      [],
    ),
  ).toThrow('binding changed');
  // Simulate an older daemon selecting this grant without understanding its new target column.
  expect(() =>
    db.transaction(() => {
      db.prepare(`INSERT INTO task_retry_attempts(id,task_id,pod_id,execution_id,generation,stage,identity,binding_hash,retry_kind,previous_failure_id,admitted_at,not_before)
      SELECT 'old-daemon-retry',task_id,'fix',?,1,'worker',identity,binding_hash,'override',id,admitted_at,not_before
      FROM task_retry_attempts WHERE id = ?`).run(
        repo.taskExecutions?.snapshot('fix').executionId,
        failed,
      );
      db.prepare(
        'INSERT INTO task_retry_authorization_uses(authorization_id,attempt_id) VALUES (?,?)',
      ).run(scoped.id, 'old-daemon-retry');
    })(),
  ).toThrow('target binding or scope mismatch');
  expect(ledger.state('fix').admissionCount).toBe(1);
  repo.delete('root');
  const dir = mkdtempSync(join(tmpdir(), 'worker-binding-retry-'));
  const file = join(dir, 'state.db');
  writeFileSync(file, db.serialize());
  db.close();
  const reopened = new Database(file);
  try {
    const next = createPodRepository(reopened);
    const retries = next.workerRetries;
    if (!retries) throw new Error('Missing worker retries');
    const id = next.taskExecutions?.beginRun('fix', 1, 1, target);
    if (!id) throw new Error('Missing worker run');
    expect(
      retries.admit('fix', 1, unavailableWorkerInputs, workerBindingHash(target), [], id).retryKind,
    ).toBe('override');
    retries.start(id);
    next.taskExecutions?.finishRun(id, 'failed', 'auth');
    retries.finish(id, 'nonretryable', 5);
    const grants = retries.state('fix').authorizations;
    expect(grants.find((g) => g.id === scoped.id)?.usedByAttemptId).toBe(id);
    expect(grants.find((g) => g.id === generic.id)?.usedByAttemptId).toBeNull();
    expect(() =>
      retries.assertCanAdmit('fix', 1, unavailableWorkerInputs, workerBindingHash(target), []),
    ).toThrow('authentication');
    expect(() =>
      reopened
        .prepare('UPDATE task_retry_authorizations SET target_binding_hash = ? WHERE id = ?')
        .run(workerBindingHash(original), scoped.id),
    ).toThrow('immutable');
    expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok');
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('upgrades schema 177 without broadening an existing worker permission', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-binding-upgrade-'));
  const migrations = resolve(import.meta.dirname, '../db/migrations');
  for (const file of readdirSync(migrations))
    if (Number.parseInt(file, 10) <= 177) copyFileSync(join(migrations, file), join(dir, file));
  const db = new Database(join(dir, 'state.db'));
  try {
    db.pragma('foreign_keys = ON');
    runMigrations(db, dir, logger);
    insertTestProfile(db);
    db.prepare(
      "INSERT INTO pods(id,profile_name,task,status,model,runtime,branch,user_id,max_validation_attempts,skip_validation,output_mode) VALUES ('root','test-profile','Retain old permission','running','model','codex','root','operator',3,0,'pr')",
    ).run();
    const executions = createTaskExecutionLedger(db);
    executions.register('root');
    const bound = { runtime: 'codex', model: 'model', providerAccountId: null };
    const run = executions.beginRun('root', 1, 1, bound);
    if (!run) throw new Error('Missing worker ledger');
    executions.finishRun(run, 'failed', 'auth');
    // Build the exact old-schema row without calling a newer ledger writer.
    db.prepare(`INSERT INTO task_retry_attempts(id,task_id,pod_id,execution_id,generation,stage,identity,binding_hash,admitted_at,not_before,started_at,ended_at,outcome,measured_duration_ms)
      SELECT r.id,e.task_id,r.pod_id,e.execution_id,r.generation,'worker',?,?,r.started_at,r.started_at,r.started_at,r.ended_at,'nonretryable',11
      FROM task_agent_runs r JOIN task_executions e ON e.pod_id=r.pod_id WHERE r.id=?`).run(
      JSON.stringify(unavailableWorkerInputs),
      workerBindingHash(bound),
      run,
    );
    const actor = { type: 'human' as const, userId: 'operator' };
    const taskId = executions.snapshot('root').taskId;
    db.prepare(`INSERT INTO task_retry_authorizations(id,request_key,task_id,pod_id,stage,failure_id,actor,reason,created_at)
      VALUES ('legacy','legacy-key',?,'root','worker',?,?,'Retry original provider','2026-09-08T10:00:00Z')`).run(
      taskId,
      run,
      JSON.stringify(actor),
    );
    const before = db.prepare('SELECT * FROM task_retry_authorizations').get();
    const failures = db.prepare('SELECT * FROM task_retry_attempts').all() as Array<
      Record<string, unknown>
    >;
    runMigrations(db, migrations, logger);
    expect(db.prepare('SELECT * FROM task_retry_authorizations').get()).toEqual({
      ...(before as object),
      target_binding_hash: null,
    });
    expect(db.prepare('SELECT * FROM task_retry_attempts').all()).toEqual(
      failures.map((row) => ({ ...row, provider_retry_not_before: null })),
    );
    const ledger = createPodRepository(db).workerRetries;
    if (!ledger) throw new Error('Missing upgraded worker ledger');
    expect(ledger.authorize('root', 'legacy-key', 'Retry original provider', actor)).toMatchObject({
      id: 'legacy',
    });
    ledger.assertCanAdmit('root', 1, unavailableWorkerInputs, workerBindingHash(bound), []);
    expect(() =>
      ledger.assertCanAdmit(
        'root',
        1,
        unavailableWorkerInputs,
        workerBindingHash({ ...bound, model: 'other' }),
        [],
      ),
    ).toThrow('binding changed');
    expect(() =>
      ledger.authorize(
        'root',
        'legacy-key',
        'Retry original provider',
        actor,
        workerBindingHash({ ...bound, model: 'other' }),
      ),
    ).toThrow('different authorization');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('retains provider cooldowns through deletion and disk reopen without consuming early permission', () => {
  const { db, repo } = fixture();
  const bound = { runtime: 'codex', model: 'model', providerAccountId: null };
  const deadline = new Date(Date.now() + 3_600_000).toISOString();
  const run = repo.taskExecutions?.beginRun('root', 1, 1, bound);
  const ledger = repo.workerRetries;
  if (!run || !ledger) throw new Error('Missing worker ledger');
  ledger.admit('root', 1, unavailableWorkerInputs, workerBindingHash(bound), [0], run);
  ledger.start(run);
  repo.taskExecutions?.finishRun(run, 'failed', 'transient');
  ledger.finish(run, 'transient', 10, deadline);
  const grant = ledger.authorize(
    'fix',
    'after-provider-cooldown',
    'Inspect throttling before retry',
    { type: 'human', userId: 'operator' },
  );
  expect(() =>
    ledger.assertCanAdmit('fix', 1, unavailableWorkerInputs, workerBindingHash(bound), [0]),
  ).toThrow('Provider retry cooldown');
  expect(ledger.state('fix').authorizations[0]?.usedByAttemptId).toBeNull();
  expect(() =>
    db
      .prepare(`INSERT INTO task_retry_attempts(id,task_id,pod_id,execution_id,generation,stage,identity,binding_hash,retry_kind,previous_failure_id,admitted_at,not_before)
    SELECT 'older-daemon',task_id,pod_id,execution_id,generation,stage,identity,binding_hash,'override',id,admitted_at,admitted_at FROM task_retry_attempts WHERE id=?`)
      .run(run),
  ).toThrow('deadline cannot be bypassed');
  repo.delete('root');
  const dir = mkdtempSync(join(tmpdir(), 'provider-cooldown-'));
  const file = join(dir, 'state.db');
  writeFileSync(file, db.serialize());
  db.close();
  const reopened = new Database(file);
  try {
    const next = createPodRepository(reopened);
    const retries = next.workerRetries;
    if (!retries) throw new Error('Missing retries');
    expect(retries.state('fix').latest?.providerRetryNotBefore).toBe(deadline);
    expect(() =>
      retries.assertCanAdmit('fix', 1, unavailableWorkerInputs, workerBindingHash(bound), [0]),
    ).toThrow('Provider retry cooldown');
    // A different explicitly authorized provider does not inherit another account's cooldown.
    const target = { ...bound, providerAccountId: 'selected-other-account' };
    retries.authorize(
      'fix',
      'different-provider-cooldown',
      'Explicitly selected different provider account',
      { type: 'human', userId: 'operator' },
      workerBindingHash(target),
    );
    expect(() =>
      retries.assertCanAdmit('fix', 1, unavailableWorkerInputs, workerBindingHash(target), [0]),
    ).not.toThrow();
    expect(
      retries.state('fix').authorizations.find((a) => a.id === grant.id)?.usedByAttemptId,
    ).toBeNull();
    expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(reopened.pragma('foreign_key_check')).toEqual([]);
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('upgrades schema 178 without inventing provider deadlines for older worker evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-deadline-upgrade-'));
  const migrations = resolve(import.meta.dirname, '../db/migrations');
  for (const file of readdirSync(migrations))
    if (Number.parseInt(file, 10) <= 178) copyFileSync(join(migrations, file), join(dir, file));
  const file = join(dir, 'state.db');
  const db = new Database(file);
  try {
    db.pragma('foreign_keys = ON');
    runMigrations(db, dir, logger);
    insertTestProfile(db);
    db.prepare(
      "INSERT INTO pods(id,profile_name,task,status,model,runtime,branch,user_id) VALUES ('legacy','test-profile','Retain deadline uncertainty','failed','model','codex','legacy','operator')",
    ).run();
    const executions = createTaskExecutionLedger(db);
    executions.register('legacy');
    const run = executions.beginRun('legacy', 1, 1, {
      runtime: 'codex',
      model: 'model',
      providerAccountId: null,
    });
    if (!run) throw new Error('Missing run');
    executions.finishRun(run, 'failed', 'transient');
    createTaskRetryLedger(db, 'worker').state('legacy');
    const before = db.prepare('SELECT * FROM task_retry_attempts WHERE id=?').get(run) as Record<
      string,
      unknown
    >;
    runMigrations(db, migrations, logger);
    expect(db.prepare('SELECT * FROM task_retry_attempts WHERE id=?').get(run)).toEqual({
      ...before,
      provider_retry_not_before: null,
    });
    expect(
      createPodRepository(db).workerRetries?.state('legacy').latest?.providerRetryNotBefore,
    ).toBeNull();
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('carries a provider deadline through an unstarted retry without refunding the task allowance', () => {
  const { db, repo } = fixture();
  try {
    const bound = { runtime: 'codex', model: 'model', providerAccountId: null };
    const ledger = repo.workerRetries;
    const run = repo.taskExecutions?.beginRun('root', 1, 1, bound);
    if (!ledger || !run) throw new Error('Missing worker ledger');
    const deadline = new Date(Date.now() + 10000).toISOString();
    ledger.admit('root', 1, unavailableWorkerInputs, workerBindingHash(bound), [0], run);
    ledger.start(run);
    repo.taskExecutions?.finishRun(run, 'failed', 'transient');
    ledger.finish(run, 'transient', 10, deadline);
    const next = repo.taskExecutions?.beginRun('fix', 1, 1, bound);
    if (!next) throw new Error('Missing next run');
    expect(
      ledger.admit('fix', 1, unavailableWorkerInputs, workerBindingHash(bound), [0], next),
    ).toMatchObject({
      notBefore: deadline,
      providerRetryNotBefore: deadline,
      retryKind: 'transient',
    });
    expect(() => ledger.start(next)).toThrow('backoff');
    expect(() =>
      db
        .prepare('UPDATE task_retry_attempts SET provider_retry_not_before=NULL WHERE id=?')
        .run(next),
    ).toThrow('cannot be shortened');
    repo.taskExecutions?.finishRun(next, 'failed', 'initialization');
    ledger.finish(next, 'unknown', null);
    expect(ledger.state('fix')).toMatchObject({
      admissionCount: 2,
      executedCount: 1,
      transientRetryCount: 1,
      retryFailure: 'transient',
      latest: { providerRetryNotBefore: deadline, startedAt: null },
    });
    expect(() =>
      ledger.assertCanAdmit('fix', 1, unavailableWorkerInputs, workerBindingHash(bound), [0, 0]),
    ).toThrow('budget exhausted');
    ledger.authorize('fix', 'after-unstarted-cooldown', 'Inspect initialization before one retry', {
      type: 'human',
      userId: 'operator',
    });
    const retry = repo.taskExecutions?.beginRun('fix', 1, 2, bound);
    if (!retry) throw new Error('Missing authorized retry');
    expect(
      ledger.admit('fix', 1, unavailableWorkerInputs, workerBindingHash(bound), [0], retry),
    ).toMatchObject({
      notBefore: deadline,
      providerRetryNotBefore: deadline,
      retryKind: 'override',
    });
    expect(() => ledger.start(retry)).toThrow('backoff');
    expect(ledger.state('fix').executedCount).toBe(1);
  } finally {
    db.close();
  }
});
