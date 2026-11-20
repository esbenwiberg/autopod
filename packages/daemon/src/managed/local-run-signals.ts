import type Database from 'better-sqlite3';

// In-process hints only. Key by the local daemon's connection AND installation. No worker
// payload, persisted authority or change to the managed wire protocol. Wake merely enqueues
// a microtask: SQLite (after the surrounding synchronous transaction) decides readiness.
const listeners = new WeakMap<Database.Database, Map<string, () => void>>();
const observers = new WeakMap<Database.Database, Map<string, Set<() => void>>>();

export function signalLocalRun(db: Database.Database, installation: string) {
  listeners.get(db)?.get(installation)?.();
  for (const wake of observers.get(db)?.get(installation) ?? []) wake();
}

/** Read waiters may coexist with the single scheduler. They never own dispatch. */
export function observeLocalRun(db: Database.Database, installation: string, wake: () => void) {
  const groups = observers.get(db) ?? new Map<string, Set<() => void>>();
  const group = groups.get(installation) ?? new Set<() => void>();
  group.add(wake);
  groups.set(installation, group);
  observers.set(db, groups);
  return () => {
    group.delete(wake);
    if (!group.size && groups.get(installation) === group) groups.delete(installation);
  };
}
export function subscribeLocalRun(
  db: Database.Database,
  installation: string,
  enqueue: () => void,
) {
  const group = listeners.get(db) ?? new Map<string, () => void>();
  if (group.has(installation)) throw new Error('local-controller-already-attached');
  group.set(installation, enqueue);
  listeners.set(db, group);
  return () => {
    if (group.get(installation) === enqueue) group.delete(installation);
  };
}
