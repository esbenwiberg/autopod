import { AutopodError, PodNotFoundError } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface FleetArchiveRepository {
  archivedAt(id: string): string | null;
  archive(id: string, actorId: string, reason: string): void;
  restore(id: string): void;
}

/** Visibility is not termination, abandonment, source preservation, or deletion authority. */
export function createFleetArchiveRepository(db: Database.Database): FleetArchiveRepository {
  const archivedAt = db.prepare(
    'SELECT archived_at FROM pod_fleet_archives WHERE pod_id = ? AND restored_at IS NULL',
  );
  const requirePod = (id: string) => {
    const row = db.prepare('SELECT status FROM pods WHERE id = ?').get(id) as
      | { status: string }
      | undefined;
    if (!row) throw new PodNotFoundError(id);
    return row;
  };
  return {
    archivedAt(id: string): string | null {
      return (archivedAt.get(id) as { archived_at: string } | undefined)?.archived_at ?? null;
    },
    archive: db.transaction((id: string, actorId: string, reason: string): void => {
      const pod = requirePod(id);
      if (!['review_required', 'failed', 'complete', 'killed'].includes(pod.status))
        throw new AutopodError(
          'Only review-required, failed, or terminal pods can leave the fleet. Archive does not stop execution or release resources.',
          'FLEET_ARCHIVE_INVALID_STATE',
          409,
        );
      const trimmed = reason.trim();
      if (!actorId.trim() || trimmed.length < 10 || trimmed.length > 4000)
        throw new AutopodError(
          'Archive requires a human actor and a 10–4000 character reason.',
          'INVALID_ARCHIVE_REASON',
          400,
        );
      // Repeated requests retain the original actor, reason and timestamp.
      db.prepare(`INSERT INTO pod_fleet_archives (pod_id, archived_at, actor_id, reason)
        VALUES (?, ?, ?, ?) ON CONFLICT(pod_id) DO UPDATE SET
        archived_at=excluded.archived_at, actor_id=excluded.actor_id,
        reason=excluded.reason, restored_at=NULL
        WHERE pod_fleet_archives.restored_at IS NOT NULL`).run(
        id,
        new Date().toISOString(),
        actorId,
        trimmed,
      );
    }),
    restore: db.transaction((id: string): void => {
      requirePod(id);
      db.prepare(
        'UPDATE pod_fleet_archives SET restored_at = ? WHERE pod_id = ? AND restored_at IS NULL',
      ).run(new Date().toISOString(), id);
    }),
  };
}
