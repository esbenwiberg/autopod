import path from 'node:path';
import type Database from 'better-sqlite3';
import { retainedPathIdentity } from '../pods/retained-path-identity.js';

const registered = new WeakSet<Database.Database>();

/** Resolve physical identities at the actual SQL write, not an earlier async preflight.
 * Filesystem-dependent (NOT deterministic); unavailable identity fails closed.
 */
export function registerRetainedPathFunctions(db: Database.Database): void {
  if (registered.has(db)) return;
  db.function('autopod_paths_overlap', (left: unknown, right: unknown) => {
    if (left == null || right == null) return 0;
    if (typeof left !== 'string' || typeof right !== 'string')
      throw new Error('Invalid retained path');
    const a = retainedPathIdentity(left);
    const b = retainedPathIdentity(right);
    return Number(a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep));
  });
  registered.add(db);
}
