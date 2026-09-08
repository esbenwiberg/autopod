import type Database from 'better-sqlite3';
import { canonicalMergePrIdentity } from '../worktrees/merge-pr-identity.js';

const initialized = new WeakSet<Database.Database>();

/** Normalize historical aliases on read; never rewrite immutable journal rows. */
export function ensureMergeIdentityProjection(db: Database.Database): void {
  if (initialized.has(db)) return;
  db.function('canonical_merge_pr_identity', { deterministic: true }, (raw) => {
    if (typeof raw !== 'string') return null;
    try {
      return canonicalMergePrIdentity(raw);
    } catch {
      return null;
    }
  });
  // Reject large/invalid values in SQLite before crossing the JS boundary.
  // The temporary view is connection-local and never changes database schema.
  db.exec(`CREATE TEMP VIEW canonical_merge_intents AS
    SELECT rowid AS rowid, id, identity, publication_id, pod_id, task_id, generation,
      canonical_merge_pr_identity(CASE WHEN typeof(pr_identity) = 'text'
        AND length(CAST(pr_identity AS BLOB)) <= 4096 THEN pr_identity END) AS pr_identity,
      request, created_at FROM main.merge_intents`);
  initialized.add(db);
}
