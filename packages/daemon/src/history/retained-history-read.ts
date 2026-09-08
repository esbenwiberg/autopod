import type Database from 'better-sqlite3';

export interface HistoryDiagnosticSink {
  (field: string, code: 'invalid_json' | 'invalid_shape' | 'size_limit'): void;
  budget?: { remainingBytes: number; remainingRows: number };
}

/** Export-only bounded reads; runtime/control-plane readers retain their existing strict behavior. */
export function readRetainedHistory<T>(
  db: Database.Database,
  table: 'validations' | 'escalations' | 'events' | 'session_progress_events',
  podId: string,
  decode: (row: Record<string, unknown>) => T,
  diagnostic: HistoryDiagnosticSink,
): T[] {
  const fields =
    table === 'validations'
      ? ['result']
      : table === 'escalations'
        ? ['payload', 'response']
        : table === 'events'
          ? ['payload']
          : ['phase', 'description'];
  const size = db
    .prepare(
      `SELECT COUNT(*) AS count,COALESCE(SUM(${fields.map((field) => `COALESCE(length(CAST(${field} AS BLOB)),0)`).join('+')}),0) AS bytes FROM retained_${table} WHERE pod_id=?`,
    )
    .get(podId) as { count: number; bytes: number };
  if (
    size.count > 1000 ||
    size.bytes > 2 * 1024 * 1024 ||
    size.count > (diagnostic.budget?.remainingRows ?? Number.POSITIVE_INFINITY) ||
    size.bytes > (diagnostic.budget?.remainingBytes ?? Number.POSITIVE_INFINITY)
  ) {
    diagnostic(table, 'size_limit');
    return [];
  }
  if (diagnostic.budget) {
    diagnostic.budget.remainingBytes -= size.bytes;
    diagnostic.budget.remainingRows -= size.count;
  }
  const order =
    table === 'validations' ? 'sequence,id' : table === 'events' ? 'id' : 'created_at,id';
  const rows = db
    .prepare(`SELECT * FROM retained_${table} WHERE pod_id=? ORDER BY ${order}`)
    .all(podId) as Array<Record<string, unknown>>;
  const result: T[] = [];
  for (const row of rows) {
    try {
      result.push(decode(row));
    } catch (error) {
      diagnostic(
        table === 'validations' ? `${table}:${String(row.id).slice(0, 100)}` : table,
        error instanceof SyntaxError ? 'invalid_json' : 'invalid_shape',
      );
    }
  }
  return result;
}
