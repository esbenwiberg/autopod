import type Database from 'better-sqlite3';

/** Keep this list and migration 177's mirrors in sync when adding durable task evidence. */
const TABLES = [
  'pods',
  'task_executions',
  'task_agent_runs',
  'provider_attempts',
  'provider_attempt_telemetry_corrections',
  'validations',
  'validation_phase_evidence',
  'pod_finalizations',
  'completion_decisions',
  'escalations',
  'nudge_messages',
] as const;

/** Prepared at startup so a future schema/mirror mismatch fails before destructive cleanup. */
export function createTaskHistoryArchive(db: Database.Database): (podId: string) => void {
  const insert = db.prepare(
    'INSERT INTO task_history_deletions(pod_id, archived_at) VALUES (?, ?)',
  );
  const copies = TABLES.map((table) =>
    db.prepare(
      `INSERT INTO task_history_${table} SELECT * FROM ${table} WHERE ${table === 'pods' ? 'id' : 'pod_id'} = ?`,
    ),
  );
  return (podId) => {
    if (!db.inTransaction)
      throw new Error('Task history archival must share the deletion transaction');
    insert.run(podId, new Date().toISOString());
    for (const copy of copies) copy.run(podId);
  };
}
