import { mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { digest } from '../managed/canonical.js';

/** OS-released writer lock spanning one async local recovery operation. Never hold the
 * application DB write lock while awaiting Git or a backend. A bounded set of sibling
 * lock files lives with the local SQLite database (not disposable mirror scratch).
 * Colliding slots defer to the next pass. Never unlink a slot while hosts are active. */
export function tryRecoveryClaim(
  db: Database.Database,
  run: string,
  key: string,
): (() => void) | null {
  const dir = realpathSync(db.name) + '.continuation-locks';
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const slot = digest([run, key]).slice(-2);
  return tryLock(path.join(dir, slot));
}

/** A watching scheduler retains its own lock until its final pass drains. Separate
 * from operation slots: a long-lived watcher must never starve an intent claim. */
export function tryControllerOwner(db: Database.Database, run: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(run)) throw new Error('invalid-controller-run');
  return tryOwnerSlot(db, digest(run).slice(7));
}

/** The operator API must be single-owner even while all its configured runs are idle. */
export function tryOperatorDaemonOwner(db: Database.Database) {
  return tryOwnerSlot(db, 'operator-daemon');
}

function tryOwnerSlot(db: Database.Database, slot: string) {
  const file = realpathSync(db.name);
  if (statSync(file).nlink !== 1) throw new Error('ambiguous-controller-database');
  const dir = file + '.controller-owners';
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return tryLock(path.join(dir, slot));
}

function tryLock(file: string): (() => void) | null {
  const lock = new Database(file, { timeout: 0 });
  try {
    lock.exec('BEGIN IMMEDIATE');
    return () => lock.close();
  } catch (error) {
    lock.close();
    if (error instanceof Database.SqliteError && error.code === 'SQLITE_BUSY') return null;
    throw error;
  }
}
