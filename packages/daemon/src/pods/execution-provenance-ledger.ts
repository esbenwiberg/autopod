import { randomUUID } from 'node:crypto';
import {
  AutopodError,
  type ExecutionProvenance,
  type ExecutionProvenanceInput,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
export interface ExecutionProvenanceLedger {
  record(podId: string, generation: number, input: ExecutionProvenanceInput): ExecutionProvenance;
  latest(podId: string): ExecutionProvenance | null;
}
export function createExecutionProvenanceLedger(db: Database.Database): ExecutionProvenanceLedger {
  return {
    record: db.transaction((podId: string, generation: number, input: ExecutionProvenanceInput) => {
      const identity = db
        .prepare(
          'SELECT e.execution_id AS executionId,e.task_id AS taskId,p.lifecycle_generation AS generation FROM task_executions e JOIN pods p ON p.id=e.pod_id WHERE e.pod_id=?',
        )
        .get(podId) as { executionId: string; taskId: string; generation: number } | undefined;
      if (!identity || generation !== identity.generation)
        throw new AutopodError(
          'Execution provenance requires a current lifecycle identity',
          'PROVENANCE_IDENTITY_UNAVAILABLE',
          409,
        );
      const result: ExecutionProvenance = {
        ...input,
        id: randomUUID(),
        podId,
        taskId: identity.taskId,
        executionId: identity.executionId,
        generation,
        checkedAt: new Date().toISOString(),
      };
      const payload = JSON.stringify(result);
      if (Buffer.byteLength(payload) > 65536)
        throw new AutopodError(
          'Execution provenance exceeds its evidence bound',
          'PROVENANCE_TOO_LARGE',
          409,
        );
      db.prepare(
        'INSERT INTO execution_provenance(id,execution_id,task_id,pod_id,generation,checked_at,payload) VALUES (?,?,?,?,?,?,?)',
      ).run(
        result.id,
        result.executionId,
        result.taskId,
        podId,
        generation,
        result.checkedAt,
        payload,
      );
      return result;
    }),
    latest(podId) {
      const row = db
        .prepare(
          'SELECT r.payload FROM execution_provenance r JOIN task_executions e ON e.execution_id=r.execution_id WHERE e.pod_id=? ORDER BY r.rowid DESC LIMIT 1',
        )
        .get(podId) as { payload: string } | undefined;
      return row ? (JSON.parse(row.payload) as ExecutionProvenance) : null;
    },
  };
}
