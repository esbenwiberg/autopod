import type { ClaudeResultUsageEvent } from '@autopod/shared';
import type Database from 'better-sqlite3';

export function createClaudeCostCursor(db: Database.Database) {
  const read = db.prepare<[string, string], { cumulative_cost_usd: number }>(
    'SELECT cumulative_cost_usd FROM claude_cost_cursors WHERE pod_id = ? AND session_id = ?',
  );
  const write = db.prepare(`
    INSERT INTO claude_cost_cursors (pod_id, session_id, cumulative_cost_usd) VALUES (?, ?, ?)
    ON CONFLICT (pod_id, session_id) DO UPDATE SET cumulative_cost_usd = excluded.cumulative_cost_usd
  `);
  return {
    get: (podId: string, sessionId: string) => read.get(podId, sessionId)?.cumulative_cost_usd,
    set: (podId: string, sessionId: string, total: number) => write.run(podId, sessionId, total),
  };
}

/** Reconcile native result costs without ever treating an unknown resume as starting at zero. */
export function claudeResultCost(
  event: ClaudeResultUsageEvent,
  cursor: number | undefined,
): { delta?: number; cursor?: number } {
  const previous = cursor ?? (event.freshSession ? 0 : undefined);
  const { cumulativeCostUsd: total, resultCostUsd: nativeDelta } = event;
  if (total === undefined) {
    // The next cumulative observation must not re-bill a native delta we already counted.
    return {
      delta: nativeDelta,
      cursor: previous === undefined ? undefined : previous + (nativeDelta ?? 0),
    };
  }
  if (previous === undefined) return { delta: nativeDelta, cursor: total };
  if (total < previous - 1e-9 && nativeDelta === undefined) return { cursor: previous };
  // A larger cumulative delta can recover cost absent from intermediate results.
  // A native delta still counts if Claude restored an older transcript balance.
  return {
    delta: Math.max(0, total - previous, nativeDelta ?? 0),
    cursor: total,
  };
}
