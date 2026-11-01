import { AsyncLocalStorage } from 'node:async_hooks';
import { AutopodError } from '@autopod/shared';
import type Database from 'better-sqlite3';

interface DestructionOwner {
  podId: string;
  containerId: string;
  phase: 'delete' | 'cleanup';
}
const scopes = new WeakMap<Database.Database, AsyncLocalStorage<() => DestructionOwner>>();

/** Destruction is a separate authority, never proof that validation settled. */
export function ownsValidationAbandonment(
  db: Database.Database,
  selection: { podId: string } | { containerId: string },
): boolean {
  const owner = scopes.get(db)?.getStore()?.();
  return (
    !!owner &&
    ('podId' in selection
      ? owner.phase === 'cleanup' && owner.podId === selection.podId
      : owner.containerId === selection.containerId)
  );
}

/** Only a durable explicit decision may scope DELETE or its post-404 pod cleanup. */
export function withValidationAbandonment<T>(
  db: Database.Database,
  requestId: string,
  phase: 'delete' | 'cleanup',
  assertCurrent: () => void,
  operation: () => Promise<T>,
): Promise<T> {
  let active = true;
  const authorize = () => {
    if (!active)
      throw new AutopodError(
        'Validation abandonment capability expired',
        'STALE_SANDBOX_RECOVERY',
        409,
      );
    assertCurrent();
    const receipt = db
      .prepare(`SELECT pod_id AS podId,sandbox_id AS containerId,
      validation_evidence AS evidence,completed_at AS completedAt
      FROM sandbox_recovery_requests WHERE id=? AND action='abandon'`)
      .get(requestId) as
      | (Omit<DestructionOwner, 'phase'> & { evidence: string | null; completedAt: string | null })
      | undefined;
    if (!receipt || !receipt.evidence || (phase === 'cleanup') !== !!receipt.completedAt)
      throw new AutopodError(
        'Exact validation abandonment authority unavailable',
        'STALE_SANDBOX_RECOVERY',
        409,
      );
    return { ...receipt, phase };
  };
  authorize();
  let scope = scopes.get(db);
  if (!scope) {
    scope = new AsyncLocalStorage<() => DestructionOwner>();
    scopes.set(db, scope);
  }
  return scope.run(authorize, async () => {
    try {
      return await operation();
    } finally {
      active = false;
    }
  });
}
