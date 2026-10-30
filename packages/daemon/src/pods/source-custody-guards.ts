import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import { sourceAdoptionError } from './source-adoption-identity.js';
import { assertValidationResourceSettled } from './validation-execution-evidence.js';

export function assertSourceResourceReleasable(db: Database.Database, containerId: string): void {
  assertValidationResourceSettled(db, containerId);
  if (
    db
      .prepare(
        "SELECT 1 FROM source_adoptions WHERE json_extract(binding,'$.containerId')=? LIMIT 1",
      )
      .get(containerId)
  )
    sourceAdoptionError(
      'Original source/report resource remains in custody.',
      'SOURCE_CUSTODY_HELD',
    );
}
const owners = new WeakMap<Database.Database, AsyncLocalStorage<string>>();
export function sourceOwnerScope(db: Database.Database): AsyncLocalStorage<string> {
  let scope = owners.get(db);
  if (!scope) {
    scope = new AsyncLocalStorage<string>();
    owners.set(db, scope);
  }
  return scope;
}
/** Private async capability, scoped to this connection and ONE original pod/epoch. */
export function assertSourceAvailable(
  db: Database.Database,
  podId: string,
  owner = sourceOwnerScope(db).getStore(),
): void {
  const blocked = db
    .prepare(`SELECT s.id,s.pod_id AS podId,s.error,
    COALESCE(s.adopted_generation,json_extract(s.binding,'$.generation')) AS generation
    FROM source_adoptions s WHERE s.completed_at IS NULL AND
    (s.task_id=(SELECT task_id FROM task_executions WHERE pod_id=?) OR s.pod_id=?
    OR json_extract(s.binding,'$.containerId')=(SELECT container_id FROM pods WHERE id=?)
    OR json_extract(s.binding,'$.worktreePath')=(SELECT worktree_path FROM pods WHERE id=?))`)
    .all(podId, podId, podId, podId) as {
    id: string;
    podId: string;
    error: string | null;
    generation: number;
  }[];
  if (!blocked.length) return;
  const current = db
    .prepare('SELECT lifecycle_generation AS generation FROM pods WHERE id=?')
    .get(podId) as { generation: number } | undefined;
  if (
    blocked.some(
      (row) =>
        row.id !== owner ||
        row.podId !== podId ||
        row.error ||
        row.generation !== current?.generation,
    )
  )
    sourceAdoptionError(
      'Source adoption owns this task/resource. Observe its durable operation; no competing worker, validation or lifecycle mutation is admitted.',
      'SOURCE_ADOPTION_IN_PROGRESS',
    );
}
/** Delivery/release is NEVER implied by the private mutation capability or passing checks. */
export function assertSourceDeliveryAllowed(db: Database.Database, podId: string): void {
  if (
    db
      .prepare(
        'SELECT 1 FROM source_adoptions WHERE pod_id=? OR task_id=(SELECT task_id FROM task_executions WHERE pod_id=?) LIMIT 1',
      )
      .get(podId, podId)
  )
    sourceAdoptionError(
      'Source adoption authorizes checks only; original delivery constraints and source/report custody remain held.',
      'SOURCE_ADOPTION_DELIVERY_HELD',
    );
}
