import type Database from 'better-sqlite3';

export interface UnitOfWork {
  atomically<T>(work: () => T): T;
  afterCommit(effect: () => void): void;
}

/** Synchronous SQLite state changes; external publication happens only after commit. */
export function createUnitOfWork(db: Database.Database): UnitOfWork {
  const frames: Array<Array<() => void>> = [];
  return {
    atomically<T>(work: () => T): T {
      if (db.inTransaction && frames.length === 0)
        throw new Error('Managed atomic changes cannot publish inside an unmanaged transaction');
      const effects: Array<() => void> = [];
      frames.push(effects);
      let result: T;
      try {
        result = db.transaction(() => {
          const value = work();
          if (value && typeof (value as { then?: unknown }).then === 'function')
            throw new Error('SQLite atomic work must be synchronous');
          return value;
        })();
      } catch (error) {
        frames.pop();
        throw error;
      }
      frames.pop();
      const parent = frames.at(-1);
      if (parent) parent.push(...effects);
      else for (const effect of effects) effect();
      return result;
    },
    afterCommit(effect) {
      const frame = frames.at(-1);
      if (frame) frame.push(effect);
      else if (db.inTransaction)
        throw new Error('External publication requires a managed transaction');
      else effect();
    },
  };
}

/** Legacy injected repositories may lack SQLite; production always supplies this boundary. */
export function atomicPodChange<T>(repo: Partial<UnitOfWork>, work: () => T): T {
  return repo.atomically ? repo.atomically(work) : work();
}
