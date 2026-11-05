import {
  AutopodError,
  type OperatorActor,
  type ReworkRequestInput,
  type ReworkRequestReceipt,
} from '@autopod/shared';
import type Database from 'better-sqlite3';

/** Journal before dispatch. An unresolved record is never permission to dispatch again. */
export interface ReworkRequestRepository {
  read(requestKey: string): ReworkRequestReceipt | null;
  replay(
    podId: string,
    input: ReworkRequestInput,
    actor: OperatorActor,
  ): ReworkRequestReceipt | null;
  assertIdle(podId: string): void;
  accept(
    podId: string,
    input: ReworkRequestInput,
    actor: OperatorActor,
    admit: () => void,
  ): { receipt: ReworkRequestReceipt; fresh: boolean };
  settle(requestKey: string, error: string | null): void;
}
export function createReworkRequestRepository(db: Database.Database): ReworkRequestRepository {
  const read = (requestKey: string): ReworkRequestReceipt | null => {
    const row = db.prepare('SELECT * FROM rework_requests WHERE request_key=?').get(requestKey) as
      | Record<string, unknown>
      | undefined;
    return row
      ? {
          requestKey: row.request_key as string,
          taskId: row.task_id as string,
          podId: row.pod_id as string,
          generation: row.generation as number,
          actor: JSON.parse(row.actor as string),
          guidance: row.guidance as string,
          createdAt: row.created_at as string,
          settledAt: row.settled_at as string | null,
          error: row.error as string | null,
        }
      : null;
  };
  const replay = (podId: string, input: ReworkRequestInput, actor: OperatorActor) => {
    const existing = read(input.requestKey);
    if (
      existing &&
      (existing.podId !== podId ||
        existing.generation !== input.generation ||
        existing.guidance !== input.guidance ||
        JSON.stringify(existing.actor) !== JSON.stringify(actor))
    )
      throw new AutopodError(
        'Rework request key records a different payload or actor',
        'REWORK_REQUEST_CONFLICT',
        409,
      );
    return existing;
  };
  const assertIdle = (podId: string) => {
    if (
      db.prepare('SELECT 1 FROM rework_requests WHERE pod_id=? AND settled_at IS NULL').get(podId)
    )
      throw new AutopodError(
        'A Rework request is unresolved. Inspect its receipt and pod state; do not replay execution.',
        'REWORK_REQUEST_UNRESOLVED',
        409,
      );
  };
  return {
    read,
    replay,
    assertIdle,
    accept: db.transaction(
      (podId: string, input: ReworkRequestInput, actor: OperatorActor, admit: () => void) => {
        const existing = replay(podId, input, actor);
        if (existing) return { receipt: existing, fresh: false };
        assertIdle(podId);
        const member = db
          .prepare(`SELECT e.task_id AS taskId,p.lifecycle_generation AS generation
        FROM task_executions e JOIN pods p ON p.id=e.pod_id WHERE p.id=?`)
          .get(podId) as { taskId: string; generation: number } | undefined;
        if (!member || member.generation !== input.generation)
          throw new AutopodError(
            'Rework lifecycle changed; refresh before submitting',
            'REWORK_LIFECYCLE_STALE',
            409,
          );
        if (actor.type !== 'human' || !actor.userId || input.guidance.length > 16000)
          throw new AutopodError(
            'Authenticated human and bounded guidance required',
            'INVALID_INPUT',
            400,
          );
        admit();
        const now = new Date().toISOString();
        const messageId = input.guidance
          ? db
              .prepare('INSERT INTO nudge_messages(pod_id,message,created_at) VALUES (?,?,?)')
              .run(podId, input.guidance, now).lastInsertRowid
          : null;
        db.prepare(`INSERT INTO rework_requests(request_key,task_id,pod_id,generation,actor,guidance,message_id,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(
          input.requestKey,
          member.taskId,
          podId,
          input.generation,
          JSON.stringify(actor),
          input.guidance,
          messageId,
          now,
        );
        const receipt = read(input.requestKey);
        if (!receipt) throw new Error('Rework request was not persisted');
        return { receipt, fresh: true };
      },
    ),
    settle(requestKey: string, error: string | null) {
      db.prepare(
        'UPDATE rework_requests SET settled_at=?,error=? WHERE request_key=? AND settled_at IS NULL',
      ).run(new Date().toISOString(), error, requestKey);
    },
  };
}
