import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import {
  AutopodError,
  type SavedWorkDraftOperation,
  type SavedWorkDraftPreparationCancellation,
  type SavedWorkDraftPrepare,
} from '@autopod/shared';
import type Database from 'better-sqlite3';

export const draftHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function draftError(message: string): never {
  throw new AutopodError(message, 'SAVED_WORK_DRAFT_BLOCKED', 409);
}
export function assertSavedDraftAvailable(db: Database.Database, podId: string): void {
  // Historical published receipts retain evidence, not mutation ownership.
  if (
    db
      .prepare(`SELECT 1 FROM saved_work_draft_pr_operations WHERE
    (pod_id=? OR json_extract(body,'$.taskId')=(SELECT task_id FROM task_executions WHERE pod_id=?))
    AND json_extract(body,'$.state') NOT IN ('published','cancelled')`)
      .get(podId, podId)
  )
    draftError('Saved-work draft publication owns this source; observe the existing operation.');
}
export function assertSavedDraftResourceAvailable(db: Database.Database, containerId: string) {
  if (
    db
      .prepare(
        `SELECT 1 FROM saved_work_draft_pr_operations WHERE json_extract(body,'$.originalContainerId')=? AND json_extract(body,'$.state') NOT IN ('published','cancelled')`,
      )
      .get(containerId)
  )
    draftError(
      'Saved-work draft publication retains this original resource; observe its operation.',
    );
}
export function assertSavedDraftPathAvailable(db: Database.Database, location: string) {
  const identity = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const candidate = identity(location);
  const rows = db
    .prepare(
      `SELECT value AS location FROM saved_work_draft_pr_operations,json_each(body,'$.sourceLocations') WHERE json_extract(body,'$.state') NOT IN ('published','cancelled')`,
    )
    .all() as { location: string }[];
  for (const row of rows) {
    const held = identity(row.location);
    if (
      held === candidate ||
      held.startsWith(`${candidate}${path.sep}`) ||
      candidate.startsWith(`${held}${path.sep}`)
    )
      draftError(
        'Saved-work draft publication retains this original path; no mutation or cleanup is authorized.',
      );
  }
}
export function createSavedWorkDraftRepository(db: Database.Database) {
  const decode = (row: unknown): SavedWorkDraftOperation | null =>
    row ? JSON.parse((row as { body: string }).body) : null;
  const preparationCancellation = (podId: string, requestId: string) => {
    const row = db
      .prepare(
        'SELECT body FROM saved_work_draft_pr_preparation_cancellations WHERE pod_id=? AND request_id=?',
      )
      .get(podId, requestId) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as SavedWorkDraftPreparationCancellation) : null;
  };
  return {
    cancelPreparation: db.transaction(
      (
        podId: string,
        request: SavedWorkDraftPrepare,
        actorId: string,
      ): SavedWorkDraftPreparationCancellation => {
        const prior = preparationCancellation(podId, request.requestId);
        if (prior) {
          if (
            prior.actorId !== actorId ||
            prior.expectedBinding !== request.expectedBinding ||
            prior.sourceId !== request.sourceId
          )
            draftError('Pending cancellation belongs to a different exact request or human.');
          return prior;
        }
        const op = decode(
          db
            .prepare(
              'SELECT body FROM saved_work_draft_pr_operations WHERE pod_id=? AND request_id=?',
            )
            .get(podId, request.requestId),
        );
        if (op) {
          if (
            op.actorId !== actorId ||
            op.previewBinding !== request.expectedBinding ||
            op.source.id !== request.sourceId
          )
            draftError('Pending request no longer matches the recorded operation.');
          if (!['preparing', 'prepared', 'cancelled'].includes(op.state))
            draftError('An external effect was admitted; pending preparation cannot be cancelled.');
          if (op.state !== 'cancelled')
            db.prepare(
              'UPDATE saved_work_draft_pr_operations SET body=? WHERE id=? AND body=?',
            ).run(
              JSON.stringify({
                ...op,
                state: 'cancelled',
                message:
                  'Human revoked exact preparation before external admission. All source and resources retained.',
              }),
              op.id,
              JSON.stringify(op),
            );
        }
        const receipt: SavedWorkDraftPreparationCancellation = {
          ...request,
          podId,
          actorId,
          state: 'cancelled-before-publication',
        };
        db.prepare('INSERT INTO saved_work_draft_pr_preparation_cancellations VALUES (?,?,?)').run(
          podId,
          request.requestId,
          JSON.stringify(receipt),
        );
        return receipt;
      },
    ).immediate,
    assertCustodySettled(podId: string) {
      // Terminal checks retain originals permanently but no longer mutate them.
      // Do not use broad historical-custody predicates as active ownership evidence.
      const active = db
        .prepare(`SELECT 1 FROM source_adoptions WHERE completed_at IS NULL
        AND task_id=(SELECT task_id FROM task_executions WHERE pod_id=?)
        UNION ALL SELECT 1 FROM approval_source_rewrites r WHERE r.pod_id IN
          (SELECT pod_id FROM task_executions WHERE task_id=(SELECT task_id FROM task_executions WHERE pod_id=?))
          AND NOT EXISTS(SELECT 1 FROM approval_source_rewrite_events e WHERE e.rewrite_id=r.id AND e.kind IN ('checked','aborted'))
        UNION ALL SELECT 1 FROM retained_checkpoint_recoveries r WHERE r.task_id=(SELECT task_id FROM task_executions WHERE pod_id=?)
          AND NOT EXISTS(SELECT 1 FROM retained_checkpoint_recovery_events e WHERE e.recovery_id=r.id AND e.kind='checked')
          AND NOT EXISTS(SELECT 1 FROM retained_checkpoint_outcome_reconciliations e WHERE e.recovery_id=r.id)
        UNION ALL SELECT 1 FROM retained_finalizations f WHERE json_extract(f.receipt,'$.state')='pending'
          AND (f.pod_id=? OR json_extract(f.binding,'$.taskId')=(SELECT task_id FROM task_executions WHERE pod_id=?))
        UNION ALL SELECT 1 FROM recovery_forks f WHERE f.parent_pod_id=?
          AND NOT EXISTS(SELECT 1 FROM recovery_fork_facts e WHERE e.operation_id=f.id AND e.kind IN ('admitted','failed'))
        UNION ALL SELECT 1 FROM sandbox_recovery_requests r WHERE r.pod_id=? AND r.completed_at IS NULL
        UNION ALL SELECT 1 FROM sandbox_wakeup_intents i WHERE i.pod_id=? AND i.ended_at IS NULL
        LIMIT 1`)
        .get(podId, podId, podId, podId, podId, podId, podId, podId);
      if (active)
        draftError(
          'Active source adoption, rewrite or recovery owns source; settle that operation first.',
        );
    },
    get(podId: string, requestId: string) {
      return decode(
        db
          .prepare(
            'SELECT body FROM saved_work_draft_pr_operations WHERE pod_id=? AND request_id=?',
          )
          .get(podId, requestId),
      );
    },
    latest(podId: string) {
      return decode(
        db
          .prepare(
            'SELECT body FROM saved_work_draft_pr_operations WHERE pod_id=? ORDER BY rowid DESC LIMIT 1',
          )
          .get(podId),
      );
    },
    insert: db.transaction((op: SavedWorkDraftOperation, requestId: string) => {
      // Atomic with the cancellation tombstone, including a delayed in-flight inspect.
      if (preparationCancellation(op.podId, requestId))
        draftError('This exact preparation was durably cancelled; delayed admission is forbidden.');
      const prior = db
        .prepare(`SELECT request_id FROM saved_work_draft_pr_operations WHERE pod_id=?
        AND json_extract(body,'$.generation')=? AND json_extract(body,'$.repository')=?
        AND json_extract(body,'$.baseBranch')=? AND json_extract(body,'$.source.commit')=?
        AND json_extract(body,'$.source.tree')=? AND json_extract(body,'$.state') != 'cancelled'`)
        .get(
          op.podId,
          op.generation,
          op.repository,
          op.baseBranch,
          op.source.commit,
          op.source.tree,
        ) as { request_id: string } | undefined;
      if (prior)
        draftError(
          `This exact saved source already has operation request ${prior.request_id}; observe it instead of creating another draft.`,
        );
      db.prepare('INSERT INTO saved_work_draft_pr_operations VALUES (?,?,?,?,?)').run(
        op.id,
        op.podId,
        requestId,
        op.actorId,
        JSON.stringify(op),
      );
    }).immediate,
    transition(
      op: SavedWorkDraftOperation,
      state: SavedWorkDraftOperation['state'],
      receipt = op.receipt,
      message?: string,
    ) {
      const next = { ...op, state, receipt, ...(message ? { message } : {}) };
      const result = db
        .prepare('UPDATE saved_work_draft_pr_operations SET body=? WHERE id=? AND body=?')
        .run(JSON.stringify(next), op.id, JSON.stringify(op));
      if (result.changes !== 1) draftError('Operation changed; observe it without resubmitting.');
      return next;
    },
    /** Record publication-scan evidence on a prepared operation without changing its state. */
    recordPublicationScan(
      op: SavedWorkDraftOperation,
      scan: NonNullable<SavedWorkDraftOperation['publicationScan']>,
      message?: string,
    ): SavedWorkDraftOperation {
      if (op.state !== 'prepared') draftError('Only a prepared operation records scan evidence.');
      const { message: _previous, ...rest } = op;
      const next: SavedWorkDraftOperation = {
        ...rest,
        publicationScan: scan,
        ...(message ? { message } : {}),
      };
      const result = db
        .prepare('UPDATE saved_work_draft_pr_operations SET body=? WHERE id=? AND body=?')
        .run(JSON.stringify(next), op.id, JSON.stringify(op));
      if (result.changes !== 1) draftError('Operation changed; observe it without resubmitting.');
      return next;
    },
    assertAvailable: (podId: string) => assertSavedDraftAvailable(db, podId),
  };
}
export type SavedWorkDraftRepository = ReturnType<typeof createSavedWorkDraftRepository>;
