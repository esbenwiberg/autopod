import type { MemoryUsageEvent, MemoryUsageKind, MemoryUsageOutcome } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface MemoryUsageRepository {
  record(event: Omit<MemoryUsageEvent, 'createdAt'>): MemoryUsageEvent;
  listByMemory(memoryId: string): MemoryUsageEvent[];
  listByPod(podId: string): MemoryUsageEvent[];
}

function rowToUsageEvent(row: Record<string, unknown>): MemoryUsageEvent {
  return {
    id: row.id as string,
    memoryId: row.memory_id as string,
    podId: row.pod_id as string,
    kind: row.kind as MemoryUsageKind,
    outcome: (row.outcome as MemoryUsageOutcome) ?? null,
    reason: (row.reason as string) ?? null,
    relevanceReason: (row.relevance_reason as string) ?? null,
    createdAt: row.created_at as string,
  };
}

export function createMemoryUsageRepository(db: Database.Database): MemoryUsageRepository {
  return {
    record(event: Omit<MemoryUsageEvent, 'createdAt'>): MemoryUsageEvent {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO memory_usage_events
         (id, memory_id, pod_id, kind, outcome, reason, relevance_reason, created_at)
         VALUES (@id, @memoryId, @podId, @kind, @outcome, @reason, @relevanceReason, @now)`,
      ).run({
        id: event.id,
        memoryId: event.memoryId,
        podId: event.podId,
        kind: event.kind,
        outcome: event.outcome ?? null,
        reason: event.reason ?? null,
        relevanceReason: event.relevanceReason ?? null,
        now,
      });
      return {
        ...event,
        outcome: event.outcome ?? null,
        reason: event.reason ?? null,
        relevanceReason: event.relevanceReason ?? null,
        createdAt: now,
      };
    },

    listByMemory(memoryId: string): MemoryUsageEvent[] {
      const rows = db
        .prepare('SELECT * FROM memory_usage_events WHERE memory_id = ? ORDER BY created_at ASC')
        .all(memoryId) as Record<string, unknown>[];
      return rows.map(rowToUsageEvent);
    },

    listByPod(podId: string): MemoryUsageEvent[] {
      const rows = db
        .prepare('SELECT * FROM memory_usage_events WHERE pod_id = ? ORDER BY created_at ASC')
        .all(podId) as Record<string, unknown>[];
      return rows.map(rowToUsageEvent);
    },
  };
}
