import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createUnitOfWork } from './unit-of-work.js';

it('publishes nested state only after the outer commit and discards rolled-back effects', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE state (value TEXT)');
  const unit = createUnitOfWork(db);
  const observed: unknown[] = [];
  try {
    unit.atomically(() => {
      db.prepare('INSERT INTO state VALUES (?)').run('outer');
      unit.atomically(() => {
        db.prepare('INSERT INTO state VALUES (?)').run('inner');
        unit.afterCommit(() => observed.push(db.prepare('SELECT * FROM state').all()));
      });
      expect(observed).toEqual([]);
      expect(() =>
        unit.atomically(() => {
          db.prepare('INSERT INTO state VALUES (?)').run('rolled back');
          unit.afterCommit(() => observed.push('must not publish'));
          throw new Error('crash');
        }),
      ).toThrow('crash');
    });
    expect(observed).toEqual([[{ value: 'outer' }, { value: 'inner' }]]);
    expect(() =>
      unit.atomically(() => {
        unit.atomically(() => unit.afterCommit(() => observed.push('outer rollback leak')));
        throw new Error('outer crash');
      }),
    ).toThrow('outer crash');
    expect(observed).toHaveLength(1);
    expect(() => unit.atomically(() => Promise.resolve())).toThrow('must be synchronous');
  } finally {
    db.close();
  }
});
