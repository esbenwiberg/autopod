import { mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { digest } from '../managed/canonical.js';

// Multiplex distinct logical claims on one owning connection. Other connections
// (also older binaries) still see the original OS lock for the whole lifetime.
const held = new WeakMap<
  Database.Database,
  Map<string, { claims: Set<string>; unlock: () => void }>
>();
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
  const claim = digest([run, key]),
    slot = claim.slice(-2);
  const slots = held.get(db) ?? new Map<string, { claims: Set<string>; unlock: () => void }>();
  let entry = slots.get(slot);
  if (!entry) {
    const unlock = tryLock(path.join(dir, slot));
    if (!unlock) return null;
    entry = { claims: new Set<string>(), unlock };
    slots.set(slot, entry);
    held.set(db, slots);
  }
  if (entry.claims.has(claim)) return null;
  entry.claims.add(claim);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.claims.delete(claim);
    if (!entry.claims.size) {
      slots.delete(slot);
      entry.unlock();
    }
  };
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

/** Stock daemon lifetime, including unenrolled mode. Acquire before migrations or resume. */
export function claimDaemonLifetime(db: Database.Database) {
  let release = tryOperatorDaemonOwner(db);
  if (!release) throw new Error('operator-daemon-owner-active');
  return {
    owns: (other: Database.Database) => !!release && db === other,
    close: () => {
      release?.();
      release = null;
    },
  };
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
