import type Database from 'better-sqlite3';

/** Read current durable authority, including unresolved cycles hidden by legacy drift. */
export function hasUnansweredDecision(db: Database.Database, podId: string): boolean {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM pods p WHERE p.id = ? AND (
      p.status = 'awaiting_input' OR p.pending_escalation IS NOT NULL OR
      EXISTS (SELECT 1 FROM pod_finalizations f WHERE f.pod_id = p.id
        AND f.generation = p.lifecycle_generation AND f.pending_decision_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM completion_decisions d
          WHERE d.pod_id = f.pod_id AND d.decision_id = f.pending_decision_id)))`)
      .get(podId),
  );
}
