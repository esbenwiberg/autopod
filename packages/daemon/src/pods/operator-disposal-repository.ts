import {
  AutopodError,
  type OperatorDisposalReceipt,
  type OperatorDisposalRequest,
  operatorDisposalRequestSchema,
  PodNotFoundError,
} from '@autopod/shared';
import type Database from 'better-sqlite3';

const conflict = (message: string): never => {
  throw new AutopodError(message, 'OPERATOR_DISPOSAL_CONFLICT', 409);
};
export function assertNoOperatorDisposal(db: Database.Database, podId: string): void {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='operator_disposal_intents'").get())
    return;
  if (
    db
      .prepare(
        `SELECT 1 FROM operator_disposal_intents WHERE pod_id=? OR task_id=(SELECT task_id FROM task_executions WHERE pod_id=?)
        OR pod_id IN (SELECT value FROM pods p,json_each(p.depends_on_pod_ids) WHERE p.id=?)
        OR pod_id=(SELECT depends_on_pod_id FROM pods WHERE id=?)`,
      )
      .get(podId, podId, podId, podId)
  )
    conflict(
      'Operator disposal fences this task. Read its History/Recovery receipt; no retry, start, publication or dependent release is authorized.',
    );
}
export function createOperatorDisposalRepository(db: Database.Database) {
  type Row = {
    pod_id: string;
    request_key: string;
    generation: number;
    request: string;
    actor: string;
    subject: string;
    accepted_at: string;
  };
  const row = (id: string, key?: string) =>
    (key
      ? db
          .prepare('SELECT * FROM operator_disposal_intents WHERE pod_id=? AND request_key=?')
          .get(id, key)
      : db
          .prepare(
            'SELECT * FROM operator_disposal_intents WHERE pod_id=? ORDER BY rowid DESC LIMIT 1',
          )
          .get(id)) as Row | undefined;
  function receipt(id: string, key?: string): OperatorDisposalReceipt | null {
    const r = row(id, key);
    if (!r) return null;
    const events = db
      .prepare(
        'SELECT kind,evidence FROM operator_disposal_events WHERE pod_id=? AND request_key=? ORDER BY sequence',
      )
      .all(id, r.request_key) as { kind: string; evidence: string }[];
    const complete = [...events].reverse().find((e) => e.kind === 'complete');
    const selected = events.find((e) => e.kind === 'targets');
    const selectedTargets = selected
      ? (JSON.parse(selected.evidence) as { kind: string; id: string; namespace: string }[])
      : [];
    const stopTargets = events
      .filter((e) => e.kind.startsWith('stop:') || e.kind.startsWith('stopped:'))
      .map((e) => JSON.parse(e.evidence).target)
      .filter(
        (t) =>
          t && typeof t === 'object' && typeof t.id === 'string' && typeof t.namespace === 'string',
      ) as { kind: string; id: string; namespace: string }[];
    const targets = [...selectedTargets, ...stopTargets].filter(
      (t, i, all) => all.findIndex((q) => q.kind === t.kind && q.id === t.id) === i,
    );
    return {
      contract: 'operator-disposal-v1',
      podId: id,
      generation: r.generation,
      requestKey: r.request_key,
      intent: JSON.parse(r.request).intent,
      actor: JSON.parse(r.actor),
      acceptedAt: r.accepted_at,
      scope: 'exact-pod-unpublished-resources',
      state: complete ? JSON.parse(complete.evidence).state : 'cleanup_pending',
      diagnostics: events
        .filter((e) => e.kind === 'diagnostic')
        .map((e) => JSON.parse(e.evidence).message),
      resources: targets.map((t) => ({
        kind: t.kind,
        id: t.id,
        namespace: t.namespace,
        stopDispatched: events.some((e) => e.kind === 'stop:' + t.id),
        discardDispatched: events.some((e) => e.kind === 'remove:' + t.id),
        observedStopped: events.some((e) => e.kind === 'stopped:' + t.id),
        observedAbsent: events.some((e) => e.kind === 'absent:' + t.id),
      })),
    };
  }
  function event(id: string, key: string, kind: string, evidence: unknown) {
    db.prepare(
      'INSERT INTO operator_disposal_events(pod_id,request_key,kind,evidence,recorded_at) VALUES (?,?,?,?,?)',
    ).run(id, key, kind, JSON.stringify(evidence), new Date().toISOString());
  }
  return {
    receipt,
    event,
    assertStopUnshared(id: string, containerId: string) {
      if (
        db
          .prepare(`SELECT 1 FROM task_agent_runs WHERE pod_id<>? AND json_extract(binding,'$.resource.containerId')=?
        UNION ALL SELECT 1 FROM retained_allocation_attempts a JOIN retained_allocation_facts f ON f.attempt_id=a.id
        WHERE a.pod_id<>? AND a.role='container' AND json_extract(f.evidence,'$.id')=?`)
          .get(id, containerId, id, containerId)
      )
        conflict('A foreign historical worker or allocation claims this exact execution.');
    },
    assertPublicationSettled(id: string) {
      if (
        db
          .prepare(`SELECT 1 FROM source_publication_intents i LEFT JOIN source_publication_receipts r ON r.intent_id=i.id
        WHERE i.pod_id=? AND r.intent_id IS NULL`)
          .get(id)
      )
        conflict(
          'An already admitted publication remains unconfirmed. Reconcile its original outcome; disposal cannot replay it or classify its resources unpublished.',
        );
    },
    admitEffect(id: string, key: string, kind: string, evidence: unknown): boolean {
      return db
        .transaction(() => {
          const intent = row(id, key);
          if (!intent) throw new PodNotFoundError(id);
          if (
            db
              .prepare(`SELECT 1 FROM operator_disposal_events e JOIN operator_disposal_intents i
          ON i.pod_id=e.pod_id AND i.request_key=e.request_key
          WHERE e.pod_id=? AND i.generation=? AND e.kind=?`)
              .get(id, intent.generation, kind)
          )
            return false;
          event(id, key, kind, evidence);
          return true;
        })
        .immediate();
    },
    targets(id: string, key: string): import('./retained-cleanup-repository.js').Target[] | null {
      const e = db
        .prepare(
          "SELECT evidence FROM operator_disposal_events WHERE pod_id=? AND request_key=? AND kind='targets' ORDER BY sequence LIMIT 1",
        )
        .get(id, key) as { evidence: string } | undefined;
      return e ? JSON.parse(e.evidence) : null;
    },
    subject(id: string, key: string) {
      const r = row(id, key);
      if (!r) throw new PodNotFoundError(id);
      return JSON.parse(r.subject);
    },
    hasEvent(id: string, key: string, kind: string) {
      return !!db
        .prepare(
          'SELECT 1 FROM operator_disposal_events WHERE pod_id=? AND request_key=? AND kind=?',
        )
        .get(id, key, kind);
    },
    assertAvailable(id: string) {
      assertNoOperatorDisposal(db, id);
    },
    accept(
      id: string,
      input: OperatorDisposalRequest,
      actor: { type: 'human'; userId: string },
    ): OperatorDisposalReceipt {
      if (db.inTransaction)
        conflict('Disposal acceptance must commit independently before effects.');
      return db.transaction(() => {
        const request = operatorDisposalRequestSchema.parse(input);
        if (!actor.userId.trim() || actor.type !== 'human')
          throw new AutopodError('Authenticated human required', 'UNAUTHORIZED', 401);
        const prior = row(id, request.requestKey);
        if (prior) {
          if (prior.request !== JSON.stringify(request) || prior.actor !== JSON.stringify(actor))
            conflict('Idempotency key belongs to another request or actor.');
          return receipt(id, request.requestKey)!;
        }
        const pod = db.prepare('SELECT * FROM pods WHERE id=?').get(id) as
          | Record<string, unknown>
          | undefined;
        if (!pod) throw new PodNotFoundError(id);
        if (pod.lifecycle_generation !== request.expectedGeneration)
          conflict('Stale generation; refresh the exact pod.');
        const latest = receipt(id);
        if (latest && !(latest.intent === 'kill' && request.intent === 'delete'))
          conflict(
            'Read the existing receipt; only an explicit Kill to Delete upgrade creates another intent.',
          );
        const task = db.prepare('SELECT task_id FROM task_executions WHERE pod_id=?').get(id) as
          | { task_id: string }
          | undefined;
        db.prepare(
          'INSERT INTO operator_disposal_intents(pod_id,request_key,generation,task_id,request,actor,subject,accepted_at) VALUES (?,?,?,?,?,?,?,?)',
        ).run(
          id,
          request.requestKey,
          request.expectedGeneration,
          task?.task_id ?? null,
          JSON.stringify(request),
          JSON.stringify(actor),
          JSON.stringify({
            id,
            lifecycle_generation: pod.lifecycle_generation,
            status: pod.status,
            container_id: pod.container_id,
            worktree_path: pod.worktree_path,
            branch: pod.branch,
            execution_target: pod.execution_target,
            scope: 'exact-pod-unpublished-resources',
          }),
          new Date().toISOString(),
        );
        return receipt(id, request.requestKey)!;
      })();
    },
  };
}
export type OperatorDisposalRepository = ReturnType<typeof createOperatorDisposalRepository>;
