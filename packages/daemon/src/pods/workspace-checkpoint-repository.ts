import type Database from 'better-sqlite3';
import type { WorkspaceCheckpointResult } from '../worktrees/sandbox-workspace-checkpoint.js';
import type {
  CheckpointRecord,
  CheckpointRecordStore,
  WorkspaceFingerprint,
} from './workspace-checkpoint-controller.js';

function hydrate(row: Record<string, unknown>): CheckpointRecord {
  return {
    podId: row.pod_id as string,
    sequence: row.sequence as number,
    fingerprint: JSON.parse(row.fingerprint as string) as WorkspaceFingerprint,
    result: JSON.parse(row.result as string) as WorkspaceCheckpointResult,
    verifiedAt: row.verified_at as string | null,
    attempts: row.attempts as number,
    error: row.error
      ? (JSON.parse(row.error as string) as WorkspaceCheckpointResult['error'])
      : undefined,
  };
}
export function createWorkspaceCheckpointRepository(db: Database.Database): CheckpointRecordStore {
  return {
    async save(record) {
      db.prepare(`INSERT OR REPLACE INTO workspace_checkpoints
      (pod_id, sequence, fingerprint, result, verified_at, attempts, error) VALUES
      (@podId,@sequence,@fingerprint,@result,@verifiedAt,@attempts,@error)`).run({
        ...record,
        fingerprint: JSON.stringify(record.fingerprint),
        result: JSON.stringify(record.result),
        error: record.error ? JSON.stringify(record.error) : null,
      });
    },
    async latest(podId) {
      const row = db
        .prepare(
          'SELECT * FROM workspace_checkpoints WHERE pod_id = ? ORDER BY sequence DESC LIMIT 1',
        )
        .get(podId) as Record<string, unknown> | undefined;
      return row ? hydrate(row) : null;
    },
    async latestVerified(podId) {
      const row = db
        .prepare(
          'SELECT * FROM workspace_checkpoints WHERE pod_id = ? AND verified_at IS NOT NULL ORDER BY sequence DESC LIMIT 1',
        )
        .get(podId) as Record<string, unknown> | undefined;
      return row ? hydrate(row) : null;
    },
    async incomplete() {
      return (
        db
          .prepare(
            'SELECT * FROM workspace_checkpoints WHERE verified_at IS NULL ORDER BY created_at',
          )
          .all() as Record<string, unknown>[]
      ).map(hydrate);
    },
  };
}
