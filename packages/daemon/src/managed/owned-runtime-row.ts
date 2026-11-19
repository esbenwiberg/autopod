import type Database from 'better-sqlite3';
import type { ManagedPodRow } from './managed-service.js';

// Backend IDs are not a cross-backend namespace. Resolve using the same host
// partition that owns observation, and never guess between duplicate identities.
export function ownedRuntimeRow(
  db: Database.Database,
  ref: string,
  owns?: (id: string) => boolean,
) {
  const rows = (
    db.prepare('SELECT * FROM managed_pods WHERE runtime_ref=?').all(ref) as ManagedPodRow[]
  ).filter((r) => !owns || owns(r.dispatcher_installation_id));
  if (rows.length > 1) throw new Error('managed-runtime-ref-ambiguous');
  return rows[0];
}
