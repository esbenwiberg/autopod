import {
  AutopodError,
  type HandledElsewhereArchiveRequest,
  handledElsewhereArchiveRequestSchema,
  PodNotFoundError,
} from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface FleetArchiveRepository {
  archivedAt(id: string): string | null;
  archive(id: string, actorId: string, reason: string): void;
  archiveHandledElsewhere(
    id: string,
    actorId: string,
    request: HandledElsewhereArchiveRequest,
  ): void;
  restore(id: string): void;
}

/** Visibility is not termination, abandonment, source preservation, or deletion authority. */
export function createFleetArchiveRepository(db: Database.Database): FleetArchiveRepository {
  const archivedAt = db.prepare(
    'SELECT archived_at FROM pod_fleet_archives WHERE pod_id = ? AND restored_at IS NULL',
  );
  const requirePod = (id: string) => {
    const row = db
      .prepare(`SELECT status,lifecycle_generation AS generation,
      pause_reason AS pauseReason,agent_mode AS agentMode,output_target AS output
      FROM pods WHERE id = ?`)
      .get(id) as
      | {
          status: string;
          generation: number;
          pauseReason: string | null;
          agentMode: string | null;
          output: string | null;
        }
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
    archiveHandledElsewhere: db.transaction(
      (id: string, actorId: string, input: HandledElsewhereArchiveRequest): void => {
        const request = handledElsewhereArchiveRequestSchema.parse(input);
        const pod = requirePod(id);
        if (!actorId.trim())
          throw new AutopodError('Authenticated human required', 'UNAUTHORIZED', 401);
        if (pod.generation !== request.expectedGeneration || pod.status !== request.expectedStatus)
          throw new AutopodError(
            'Refresh the exact generation and state before archival.',
            'STALE_FLEET_ARCHIVE',
            409,
          );
        if (
          pod.agentMode === 'interactive' ||
          !['pr', 'branch'].includes(pod.output ?? '') ||
          db.prepare('SELECT 1 FROM pod_goals WHERE pod_id=? LIMIT 1').get(id) ||
          (pod.status === 'paused' && pod.pauseReason !== 'manual')
        )
          throw new AutopodError(
            'Only ordinary code tasks and explicit manual pauses support this visibility disposition.',
            'FLEET_ARCHIVE_INVALID_STATE',
            409,
          );
        // This is an operator-supplied reference, not a provider-verified receipt.
        // In particular, no publication/usage/worker/custody record is changed.
        const reason = JSON.stringify({
          kind: 'handled-elsewhere-visibility-v1',
          generation: request.expectedGeneration,
          status: request.expectedStatus,
          reason: request.reason,
          reference: request.reference,
          acknowledgement: request.acknowledgement,
        });
        if (reason.length > 4000)
          throw new AutopodError(
            'Encoded archive disposition exceeds 4000 characters.',
            'INVALID_ARCHIVE_REASON',
            400,
          );
        db.prepare(`INSERT INTO pod_fleet_archives (pod_id, archived_at, actor_id, reason)
        VALUES (?, ?, ?, ?) ON CONFLICT(pod_id) DO UPDATE SET
        archived_at=excluded.archived_at, actor_id=excluded.actor_id,
        reason=excluded.reason, restored_at=NULL
        WHERE pod_fleet_archives.restored_at IS NOT NULL`).run(
          id,
          new Date().toISOString(),
          actorId,
          reason,
        );
      },
    ),
    restore: db.transaction((id: string): void => {
      requirePod(id);
      db.prepare(
        'UPDATE pod_fleet_archives SET restored_at = ? WHERE pod_id = ? AND restored_at IS NULL',
      ).run(new Date().toISOString(), id);
    }),
  };
}
