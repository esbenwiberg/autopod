import { AutopodError, type OperatorActor, type Pod } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { hasUnansweredDecision } from './decision-admission.js';

type Finalization = NonNullable<Pod['finalization']>;
export interface CompletionJournal {
  get(podId: string, generation: number): Finalization | null;
  getForDisplay?(podId: string, generation: number): Finalization | null;
  begin(pod: Pod): void;
  settle(pod: Pod, result?: string): Finalization;
  mark(pod: Pod, phase: Finalization['phase'], sourcePreserved?: boolean): void;
  recoveryContext(pod: Pod): string;
  replyWatermark(podId: string): number;
  recordReply(pod: Pod, message: string, actor: OperatorActor): void;
}

/** SQLite journal, deliberately independent of ephemeral MCP waiters and runtime promises. */
export function createCompletionJournal(db: Database.Database): CompletionJournal {
  function get(podId: string, generation: number, display = false): Finalization | null {
    const entry =
      (db
        .prepare(`SELECT generation, cycle, phase, agent_settled_at AS agentSettledAt,
      ${display ? 'substr(result, 1, 500)' : 'result'} AS result,
      ${display ? 'length(result) > 500 AS resultTruncated,' : ''}
      pending_decision_id AS pendingDecisionId, source_preserved_at AS sourcePreservedAt
      FROM pod_finalizations WHERE pod_id = ? AND generation = ? ORDER BY cycle DESC LIMIT 1`)
        .get(podId, generation) as Finalization | undefined) ?? null;
    return display && entry ? { ...entry, resultTruncated: Boolean(entry.resultTruncated) } : entry;
  }
  function current(pod: Pod): boolean {
    const row = db
      .prepare('SELECT lifecycle_generation AS generation FROM pods WHERE id = ?')
      .get(pod.id) as { generation: number } | undefined;
    return row?.generation === pod.lifecycleGeneration;
  }
  const begin = db.transaction((pod: Pod, initialSettlement = false) => {
    if (!current(pod)) return;
    const previous = get(pod.id, pod.lifecycleGeneration);
    if (!(initialSettlement && !previous) && hasUnansweredDecision(db, pod.id))
      throw new AutopodError(
        'An unanswered human decision must be resolved before starting another worker.',
        'HUMAN_DECISION_PENDING',
        409,
      );
    db.prepare(`INSERT INTO pod_finalizations (pod_id, generation, cycle, phase, updated_at)
      VALUES (?, ?, ?, 'running', ?)`).run(
      pod.id,
      pod.lifecycleGeneration,
      (previous?.cycle ?? 0) + 1,
      new Date().toISOString(),
    );
  });
  return {
    getForDisplay: (podId, generation) => get(podId, generation, true),
    get,
    begin: (pod) => begin(pod),
    replyWatermark(podId) {
      return (
        db
          .prepare(
            'SELECT COALESCE(MAX(event_watermark), 0) AS watermark FROM completion_decisions WHERE pod_id = ?',
          )
          .get(podId) as { watermark: number }
      ).watermark;
    },
    recoveryContext(pod) {
      const size = db
        .prepare(`SELECT COUNT(*) AS count,
        COALESCE(SUM(length(CAST(response AS BLOB)) + COALESCE(length(CAST(question AS BLOB)), 0)), 0) AS bytes
        FROM completion_decisions WHERE pod_id = ?`)
        .get(pod.id) as { count: number; bytes: number };
      if (!size.count) return '';
      if (size.count > 64 || size.bytes > 65_536)
        throw new AutopodError(
          'Saved decision context exceeds the safe continuation bound. Reconcile the decision history before starting a worker; no reply was discarded.',
          'DECISION_CONTEXT_RECONCILIATION_REQUIRED',
          409,
        );
      const decisions = db
        .prepare(`SELECT decision_id AS decisionId, generation, question,
        response, responded_at AS respondedAt FROM completion_decisions WHERE pod_id = ? ORDER BY rowid`)
        .all(pod.id);
      const context = [
        '\n\nRECORDED OPERATOR DECISIONS (durable history):',
        'Preserve these answers and their decision IDs. Replaying this history is not a new request to repeat completed actions or expand approval. Check preserved work before continuing.',
        JSON.stringify(decisions),
      ].join('\n');
      if (Buffer.byteLength(context, 'utf8') > 65_536)
        throw new AutopodError(
          'Saved decision context exceeds the safe continuation bound. Reconcile the decision history before starting a worker; no reply was discarded.',
          'DECISION_CONTEXT_RECONCILIATION_REQUIRED',
          409,
        );
      return context;
    },
    settle: db.transaction((pod: Pod, result?: string): Finalization => {
      if (!current(pod)) throw new Error('Stale lifecycle cannot record settlement');
      let entry = get(pod.id, pod.lifecycleGeneration);
      if (!entry) {
        begin(pod, true);
        entry = get(pod.id, pod.lifecycleGeneration);
      }
      if (!entry) throw new Error('Missing completion journal');
      if (entry.agentSettledAt) return entry;
      const now = new Date().toISOString();
      const waiting = pod.status === 'awaiting_input' || pod.pendingEscalation !== null;
      db.prepare(`UPDATE pod_finalizations SET phase = ?, agent_settled_at = ?, result = ?,
        pending_decision_id = ?, updated_at = ? WHERE pod_id = ? AND generation = ? AND cycle = ?`).run(
        waiting ? 'awaiting_human' : 'ready',
        now,
        result ?? null,
        pod.pendingEscalation?.id ?? null,
        now,
        pod.id,
        pod.lifecycleGeneration,
        entry.cycle,
      );
      return get(pod.id, pod.lifecycleGeneration) as Finalization;
    }),
    mark(pod, phase, sourcePreserved = false) {
      if (!current(pod)) return;
      const entry = get(pod.id, pod.lifecycleGeneration);
      if (!entry) return;
      // Only a recorded human response may clear an outstanding decision.
      if (entry.pendingDecisionId && phase !== 'awaiting_human' && phase !== 'preserving') return;
      const now = new Date().toISOString();
      db.prepare(`UPDATE pod_finalizations SET phase = ?, source_preserved_at = COALESCE(?, source_preserved_at),
        updated_at = ? WHERE pod_id = ? AND generation = ? AND cycle = ?`).run(
        phase,
        sourcePreserved ? now : null,
        now,
        pod.id,
        pod.lifecycleGeneration,
        entry.cycle,
      );
    },
    recordReply: db.transaction((pod: Pod, message: string, actor: OperatorActor) => {
      if (!current(pod)) throw new Error('Stale lifecycle cannot resolve a decision');
      const decision = pod.pendingEscalation;
      if (!decision) return;
      const existing = db
        .prepare('SELECT response FROM completion_decisions WHERE pod_id = ? AND decision_id = ?')
        .get(pod.id, decision.id) as { response: string } | undefined;
      if (existing && existing.response !== message)
        throw new Error('Decision already has a different durable response');
      // An idempotent duplicate preserves the first responder and response time.
      if (existing) return;
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO completion_decisions (pod_id, decision_id, response, actor, responded_at, generation, question, event_watermark)
         VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(id), 0) FROM events WHERE pod_id = ?))`,
      ).run(
        pod.id,
        decision.id,
        message,
        JSON.stringify(actor),
        now,
        pod.lifecycleGeneration,
        JSON.stringify(decision.payload),
        pod.id,
      );
      // Runtime escalation events can lack an MCP row; the independent decision receipt is still durable.
      db.prepare(
        'UPDATE escalations SET response = ?, resolved_at = ? WHERE id = ? AND pod_id = ?',
      ).run(
        JSON.stringify({
          respondedBy: actor.type === 'human' ? 'human' : 'ai',
          actor,
          response: message,
          respondedAt: now,
        }),
        now,
        decision.id,
        pod.id,
      );
      db.prepare(`UPDATE pod_finalizations SET phase = 'ready', pending_decision_id = NULL, updated_at = ?
        WHERE pod_id = ? AND generation = ? AND pending_decision_id = ?`).run(
        now,
        pod.id,
        pod.lifecycleGeneration,
        decision.id,
      );
    }),
  };
}
