import { randomUUID } from 'node:crypto';
import { AutopodError, type OperatorGuidanceDelivery } from '@autopod/shared';
import type Database from 'better-sqlite3';

const MAX_BATCH_BYTES = 256 * 1024;
const MAX_BATCH_MESSAGES = 16;

export function createOperatorGuidanceDelivery(db: Database.Database): {
  read(podId: string): OperatorGuidanceDelivery | null;
  acknowledge(podId: string, deliveryId: string): void;
} {
  const owner = (podId: string) => {
    const row = db
      .prepare(`SELECT p.lifecycle_generation AS generation,e.task_id AS taskId,r.id AS runId
      FROM pods p JOIN task_executions e ON e.pod_id=p.id
      JOIN task_agent_runs r ON r.pod_id=p.id AND r.generation=p.lifecycle_generation
      WHERE p.id=? AND r.ended_at IS NULL`)
      .get(podId) as { generation: number; taskId: string; runId: string } | undefined;
    if (!row)
      throw new AutopodError(
        'Pending guidance requires a current worker to receive and acknowledge it. Guidance remains saved.',
        'GUIDANCE_EXECUTION_UNAVAILABLE',
        409,
      );
    return row;
  };
  const payload = (deliveryId: string): OperatorGuidanceDelivery => ({
    deliveryId,
    messages: (
      db
        .prepare(`SELECT n.message FROM operator_guidance_delivery_items i
      JOIN nudge_messages n ON n.id=i.message_id WHERE i.delivery_id=? ORDER BY i.message_id`)
        .all(deliveryId) as Array<{ message: string }>
    ).map((row) => row.message),
  });
  return {
    read: db.transaction((podId: string): OperatorGuidanceDelivery | null => {
      const candidates = db
        .prepare(`SELECT id,length(CAST(message AS BLOB)) AS bytes FROM nudge_messages
        WHERE pod_id=? AND consumed=0 ORDER BY id LIMIT ?`)
        .all(podId, MAX_BATCH_MESSAGES) as Array<{ id: number; bytes: number }>;
      if (!candidates.length) return null;
      const current = owner(podId);
      const prior = db
        .prepare(`SELECT d.id FROM operator_guidance_deliveries d
        LEFT JOIN operator_guidance_acknowledgments a ON a.delivery_id=d.id
        WHERE d.pod_id=? AND d.generation=? AND d.run_id=? AND a.delivery_id IS NULL ORDER BY d.rowid LIMIT 1`)
        .get(podId, current.generation, current.runId) as { id: string } | undefined;
      if (prior) return payload(prior.id);
      const ids: number[] = [];
      let bytes = 0;
      for (const row of candidates) {
        if (bytes + row.bytes > MAX_BATCH_BYTES) break;
        ids.push(row.id);
        bytes += row.bytes;
      }
      if (!ids.length)
        throw new AutopodError(
          'A saved guidance message exceeds the bounded delivery size and needs operator reconciliation. It has not been consumed.',
          'GUIDANCE_PAYLOAD_TOO_LARGE',
          409,
        );
      const deliveryId = randomUUID();
      db.prepare(
        'INSERT INTO operator_guidance_deliveries(id,task_id,pod_id,generation,run_id,created_at) VALUES (?,?,?,?,?,?)',
      ).run(
        deliveryId,
        current.taskId,
        podId,
        current.generation,
        current.runId,
        new Date().toISOString(),
      );
      const insert = db.prepare(
        'INSERT INTO operator_guidance_delivery_items(delivery_id,message_id) VALUES (?,?)',
      );
      for (const id of ids) insert.run(deliveryId, id);
      return payload(deliveryId);
    }),
    acknowledge: db.transaction((podId: string, deliveryId: string): void => {
      const delivery = db
        .prepare(`SELECT d.generation,d.run_id AS runId,a.acknowledged_at AS acknowledgedAt
        FROM operator_guidance_deliveries d LEFT JOIN operator_guidance_acknowledgments a ON a.delivery_id=d.id
        WHERE d.id=? AND d.pod_id=?`)
        .get(deliveryId, podId) as
        | { generation: number; runId: string; acknowledgedAt: string | null }
        | undefined;
      if (!delivery)
        throw new AutopodError(
          'Unknown operator guidance delivery for this pod.',
          'GUIDANCE_DELIVERY_NOT_FOUND',
          404,
        );
      if (delivery.acknowledgedAt) return;
      const current = owner(podId);
      if (delivery.generation !== current.generation || delivery.runId !== current.runId)
        throw new AutopodError(
          'This guidance receipt belongs to an older worker. Read and acknowledge the current delivery; guidance remains saved.',
          'GUIDANCE_DELIVERY_STALE',
          409,
        );
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO operator_guidance_acknowledgments(delivery_id,acknowledged_at) VALUES (?,?)',
      ).run(deliveryId, now);
      db.prepare(`UPDATE nudge_messages SET consumed=1,consumed_at=? WHERE pod_id=? AND consumed=0
        AND id IN (SELECT message_id FROM operator_guidance_delivery_items WHERE delivery_id=?)`).run(
        now,
        podId,
        deliveryId,
      );
    }),
  };
}
