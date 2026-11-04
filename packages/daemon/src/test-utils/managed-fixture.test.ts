import type Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { fixture } from './managed-fixture.js';

function expectProductionConnection(db: Database.Database) {
  expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  expect(db.pragma('synchronous', { simple: true })).toBe(1);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
}

it('uses the production disk policy on initial and reopened managed fixture connections', async () => {
  const f = fixture();
  try {
    expectProductionConnection(f.db);
    const handle = await f.service().start('installation-one', f.request);
    const original = f.db;
    const row = f.db.prepare('SELECT * FROM managed_pods WHERE pod_id = ?').get(handle.podId);
    expect(row).toBeDefined();
    f.restart();
    expect(original.open).toBe(false);
    expectProductionConnection(f.db);
    expect(f.db.prepare('SELECT * FROM managed_pods WHERE pod_id = ?').get(handle.podId)).toEqual(
      row,
    );
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
    expect(f.launches()).toBe(1);
  } finally {
    f.close();
  }
});
