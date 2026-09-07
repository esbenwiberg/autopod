import { randomUUID } from 'node:crypto';
import {
  AutopodError,
  type OperatorActor,
  type TaskRetryAttempt,
  type TaskRetryAuthorization,
  type TaskRetryIdentity,
  type TaskRetryOutcome,
  type TaskRetryState,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import { hasUnansweredDecision } from './decision-admission.js';

export class TaskRetryBlockedError extends AutopodError {
  constructor(message: string, code = 'TASK_RETRY_RECONCILIATION_REQUIRED') {
    super(message, code, 409);
  }
}
export interface TaskRetryLedger {
  state(podId: string): TaskRetryState;
  admit(
    podId: string,
    generation: number,
    identity: TaskRetryIdentity,
    bindingHash: string,
    backoffs: number[],
  ): TaskRetryAttempt;
  start(id: string): void;
  finish(id: string, outcome: TaskRetryOutcome, measuredDurationMs: number | null): void;
  recoverInterrupted(): number;
  authorize(
    podId: string,
    requestKey: string,
    reason: string,
    actor: OperatorActor,
  ): TaskRetryAuthorization;
}
const keys: Array<keyof TaskRetryIdentity> = [
  'source',
  'contract',
  'commands',
  'environment',
  'implementation',
];
const validHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function createTaskRetryLedger(db: Database.Database): TaskRetryLedger {
  const membership = (podId: string) => {
    const row = db
      .prepare(`SELECT e.task_id AS taskId, e.execution_id AS executionId, p.lifecycle_generation AS generation
      FROM task_executions e JOIN pods p ON p.id = e.pod_id WHERE e.pod_id = ?`)
      .get(podId) as { taskId: string; executionId: string; generation: number } | undefined;
    if (!row)
      throw new TaskRetryBlockedError(
        'Task retry identity unavailable; reconcile lineage before execution',
      );
    return row;
  };
  const assertNoPendingDecision = (podId: string) => {
    if (hasUnansweredDecision(db, podId))
      throw new TaskRetryBlockedError(
        'An unanswered human decision must be reconciled before validation can execute',
      );
  };
  const latest = (taskId: string) =>
    db
      .prepare(
        "SELECT * FROM task_retry_attempts WHERE task_id = ? AND stage = 'validation' ORDER BY rowid DESC LIMIT 1",
      )
      .get(taskId) as Record<string, unknown> | undefined;
  const attempt = (row: Record<string, unknown>): TaskRetryAttempt => ({
    id: row.id as string,
    taskId: row.task_id as string,
    podId: row.pod_id as string,
    stage: 'validation',
    identity: JSON.parse(row.identity as string),
    retryKind: row.retry_kind as TaskRetryAttempt['retryKind'],
    admittedAt: row.admitted_at as string,
    notBefore: row.not_before as string,
    startedAt: row.started_at as string | null,
    endedAt: row.ended_at as string | null,
    outcome: row.outcome as TaskRetryOutcome | null,
    measuredDurationMs: row.measured_duration_ms as number | null,
  });
  const authorization = (row: Record<string, unknown>): TaskRetryAuthorization => ({
    id: row.id as string,
    requestKey: row.request_key as string,
    taskId: row.task_id as string,
    podId: row.pod_id as string,
    stage: 'validation',
    failureId: row.failure_id as string,
    actor: JSON.parse(row.actor as string),
    reason: row.reason as string,
    createdAt: row.created_at as string,
    usedByAttemptId: (row.attempt_id as string | null) ?? null,
  });
  const authorizationSelect =
    'SELECT a.*, u.attempt_id FROM task_retry_authorizations a LEFT JOIN task_retry_authorization_uses u ON u.authorization_id = a.id';
  const state = (podId: string): TaskRetryState => {
    const { taskId } = membership(podId);
    const policy = db
      .prepare(
        "SELECT backoffs FROM task_retry_policies WHERE task_id = ? AND stage = 'validation'",
      )
      .get(taskId) as { backoffs: string } | undefined;
    const counts = db
      .prepare(`SELECT COUNT(*) AS admissions, SUM(started_at IS NOT NULL) AS executions,
      SUM(retry_kind = 'transient') AS retries, SUM(COALESCE(measured_duration_ms, 0)) AS duration,
      SUM(outcome = 'unknown') AS interrupted FROM task_retry_attempts WHERE task_id = ? AND stage = 'validation'`)
      .get(taskId) as Record<string, number | null>;
    const last = latest(taskId);
    const decisions = db
      .prepare(`${authorizationSelect} WHERE a.task_id = ? ORDER BY a.created_at DESC LIMIT 100`)
      .all(taskId) as Array<Record<string, unknown>>;
    return {
      taskId,
      stage: 'validation',
      backoffsMs: policy ? JSON.parse(policy.backoffs) : null,
      admissionCount: counts.admissions ?? 0,
      executedCount: counts.executions ?? 0,
      transientRetryCount: counts.retries ?? 0,
      measuredDurationMs: counts.duration ?? 0,
      interruptedCount: counts.interrupted ?? 0,
      latest: last ? attempt(last) : null,
      authorizations: decisions.map(authorization),
      telemetry: 'partial',
    };
  };
  return {
    state,
    admit: db.transaction(
      (
        podId: string,
        generation: number,
        identity: TaskRetryIdentity,
        bindingHash: string,
        backoffs: number[],
      ) => {
        const member = membership(podId);
        assertNoPendingDecision(podId);
        if (member.generation !== generation)
          throw new TaskRetryBlockedError('Stale lifecycle cannot admit validation');
        if (
          !validHash(bindingHash) ||
          keys.some((key) => identity[key] !== null && !validHash(identity[key]))
        )
          throw new TaskRetryBlockedError('Invalid trusted retry input identity');
        if (
          backoffs.length > 10 ||
          backoffs.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 300000)
        )
          throw new TaskRetryBlockedError('Invalid task retry backoff policy');
        db.prepare(
          "INSERT OR IGNORE INTO task_retry_policies(task_id, stage, version, backoffs) VALUES (?, 'validation', 1, ?)",
        ).run(member.taskId, JSON.stringify(backoffs));
        const task = state(podId);
        const prior = latest(member.taskId);
        let retryKind: TaskRetryAttempt['retryKind'] = null;
        let useAuthorization: string | undefined;
        let notBefore = Date.now();
        if (prior && !prior.ended_at)
          throw new TaskRetryBlockedError(
            'A validation admission is already active for this logical task',
            'TASK_RETRY_IN_PROGRESS',
          );
        if (prior && prior.outcome !== 'pass') {
          if (prior.binding_hash !== bindingHash)
            throw new TaskRetryBlockedError(
              'Validation provider binding changed; explicitly reconcile the authorized provider before retrying',
              'TASK_RETRY_BINDING_CHANGED',
            );
          const old = JSON.parse(prior.identity as string) as TaskRetryIdentity;
          const changed = keys.some(
            (key) => validHash(old[key]) && validHash(identity[key]) && old[key] !== identity[key],
          );
          const grant = db
            .prepare(
              `${authorizationSelect} WHERE a.pod_id = ? AND a.failure_id = ? AND u.attempt_id IS NULL ORDER BY a.created_at, a.id LIMIT 1`,
            )
            .get(podId, prior.id) as Record<string, unknown> | undefined;
          if (grant) {
            retryKind = 'override';
            useAuthorization = grant.id as string;
          } else if (prior.outcome === 'transient') {
            const delay = task.backoffsMs?.[task.transientRetryCount];
            if (delay === undefined)
              throw new TaskRetryBlockedError(
                'Task-wide validation retry budget exhausted; record an authorized retry with a reason before repeating',
              );
            retryKind = 'transient';
            notBefore = Date.parse(prior.ended_at as string) + delay;
          } else if (changed) retryKind = 'changed_conditions';
          else
            throw new TaskRetryBlockedError(
              'Unchanged or unverified nonretryable validation inputs; change relevant conditions or record an authorized retry with a reason',
            );
        }
        const id = randomUUID();
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO task_retry_attempts(id,task_id,pod_id,execution_id,generation,stage,identity,binding_hash,retry_kind,previous_failure_id,admitted_at,not_before)
        VALUES (?,?,?,?,?,'validation',?,?,?,?,?,?)`).run(
          id,
          member.taskId,
          podId,
          member.executionId,
          generation,
          JSON.stringify(identity),
          bindingHash,
          retryKind,
          prior && prior.outcome !== 'pass' ? prior.id : null,
          now,
          new Date(notBefore).toISOString(),
        );
        if (useAuthorization)
          db.prepare(
            'INSERT INTO task_retry_authorization_uses(authorization_id,attempt_id) VALUES (?,?)',
          ).run(useAuthorization, id);
        return attempt(
          db.prepare('SELECT * FROM task_retry_attempts WHERE id = ?').get(id) as Record<
            string,
            unknown
          >,
        );
      },
    ),
    start(id) {
      const row = db.prepare('SELECT * FROM task_retry_attempts WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row || row.started_at || row.ended_at)
        throw new TaskRetryBlockedError('Retry admission has already started or settled');
      const member = membership(row.pod_id as string);
      assertNoPendingDecision(row.pod_id as string);
      if (member.executionId !== row.execution_id || member.generation !== row.generation)
        throw new TaskRetryBlockedError('Retry admission belongs to a stale execution');
      if (Date.parse(row.not_before as string) > Date.now())
        throw new TaskRetryBlockedError(
          'Persisted retry backoff has not elapsed',
          'TASK_RETRY_BACKOFF_PENDING',
        );
      const claimed = db
        .prepare(`UPDATE task_retry_attempts SET started_at = ?
        WHERE id = ? AND started_at IS NULL AND ended_at IS NULL
        AND EXISTS (SELECT 1 FROM task_executions e JOIN pods p ON p.id = e.pod_id
          WHERE e.execution_id = task_retry_attempts.execution_id
          AND p.id = task_retry_attempts.pod_id AND p.lifecycle_generation = task_retry_attempts.generation
          AND p.status <> 'awaiting_input'
          AND p.pending_escalation IS NULL
          AND NOT EXISTS (SELECT 1 FROM pod_finalizations f WHERE f.pod_id = p.id AND f.generation = p.lifecycle_generation
            AND f.pending_decision_id IS NOT NULL AND NOT EXISTS
              (SELECT 1 FROM completion_decisions d WHERE d.pod_id = f.pod_id AND d.decision_id = f.pending_decision_id)))`)
        .run(new Date().toISOString(), id);
      if (claimed.changes !== 1)
        throw new TaskRetryBlockedError('Retry execution claim was superseded');
    },
    finish(id, outcome, measuredDurationMs) {
      const row = db
        .prepare('SELECT started_at, ended_at, outcome FROM task_retry_attempts WHERE id = ?')
        .get(id) as
        | { started_at: string | null; ended_at: string | null; outcome: string | null }
        | undefined;
      if (!row) throw new Error('Unknown retry admission');
      if (row.ended_at) {
        if (row.outcome !== outcome) throw new Error('Retry admission already settled differently');
        return;
      }
      if (
        !row.started_at &&
        (measuredDurationMs !== null || !['cancelled', 'unknown'].includes(outcome))
      )
        throw new Error('Unexecuted admission cannot claim a measured validation result');
      if (
        measuredDurationMs !== null &&
        (!Number.isSafeInteger(measuredDurationMs) || measuredDurationMs < 0)
      )
        throw new Error('Invalid measured validation duration');
      db.prepare(
        'UPDATE task_retry_attempts SET ended_at = ?, outcome = ?, measured_duration_ms = ? WHERE id = ?',
      ).run(new Date().toISOString(), outcome, measuredDurationMs, id);
    },
    recoverInterrupted() {
      return db
        .prepare(
          "UPDATE task_retry_attempts SET ended_at = ?, outcome = 'unknown', measured_duration_ms = NULL WHERE ended_at IS NULL",
        )
        .run(new Date().toISOString()).changes;
    },
    authorize: db.transaction(
      (podId: string, requestKey: string, reason: string, actor: OperatorActor) => {
        if (
          actor.type !== 'human' ||
          !actor.userId ||
          !requestKey ||
          requestKey.length > 200 ||
          !reason.trim() ||
          reason.length > 4000
        )
          throw new AutopodError(
            'Human identity, stable request key and reason are required',
            'INVALID_INPUT',
            400,
          );
        const member = membership(podId);
        const existing = db
          .prepare(`${authorizationSelect} WHERE a.request_key = ?`)
          .get(requestKey) as Record<string, unknown> | undefined;
        if (existing) {
          const recorded = authorization(existing);
          if (
            recorded.podId !== podId ||
            recorded.reason !== reason ||
            JSON.stringify(recorded.actor) !== JSON.stringify(actor)
          )
            throw new AutopodError(
              'Retry request key already records a different authorization',
              'CONFLICT',
              409,
            );
          return recorded;
        }
        const failure = latest(member.taskId);
        if (!failure?.ended_at || failure.outcome === 'pass')
          throw new TaskRetryBlockedError(
            'A settled failed validation is required before authorizing one retry',
          );
        const id = randomUUID();
        db.prepare(
          "INSERT INTO task_retry_authorizations(id,request_key,task_id,pod_id,stage,failure_id,actor,reason,created_at) VALUES (?,?,?,?,'validation',?,?,?,?)",
        ).run(
          id,
          requestKey,
          member.taskId,
          podId,
          failure.id,
          JSON.stringify(actor),
          reason,
          new Date().toISOString(),
        );
        return authorization(
          db.prepare(`${authorizationSelect} WHERE a.id = ?`).get(id) as Record<string, unknown>,
        );
      },
    ),
  };
}
