import type { OperatorGuidanceDelivery } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { createOperatorGuidanceDelivery } from './operator-guidance-delivery.js';

export interface NudgeMessage {
  id: number;
  podId: string;
  message: string;
  consumed: boolean;
  createdAt: string;
  consumedAt: string | null;
}

export interface NudgeRepository {
  queue(podId: string, message: string): void;
  readPending(podId: string): OperatorGuidanceDelivery | null;
  acknowledgeDelivery(podId: string, deliveryId: string): void;
  listPending(podId: string): NudgeMessage[];
  hasPending(podId: string): boolean;
}

export function createNudgeRepository(db: Database.Database): NudgeRepository {
  const deliveries = createOperatorGuidanceDelivery(db);
  return {
    readPending: deliveries.read,
    acknowledgeDelivery: deliveries.acknowledge,
    queue(podId: string, message: string): void {
      db.prepare('INSERT INTO nudge_messages (pod_id, message, created_at) VALUES (?, ?, ?)').run(
        podId,
        message,
        new Date().toISOString(),
      );
    },

    hasPending(podId: string): boolean {
      return Boolean(
        db
          .prepare('SELECT 1 FROM nudge_messages WHERE pod_id = ? AND consumed = 0 LIMIT 1')
          .get(podId),
      );
    },

    listPending(podId: string): NudgeMessage[] {
      const rows = db
        .prepare('SELECT * FROM nudge_messages WHERE pod_id = ? AND consumed = 0 ORDER BY id ASC')
        .all(podId) as Array<Record<string, unknown>>;

      return rows.map((row) => ({
        id: row.id as number,
        podId: row.pod_id as string,
        message: row.message as string,
        consumed: Boolean(row.consumed),
        createdAt: row.created_at as string,
        consumedAt: (row.consumed_at as string) ?? null,
      }));
    },
  };
}
