import type Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createProvisioningFixture } from './provisioning-helpers.js';
import { createSandboxWakeupFixture } from './sandbox-wakeup-helpers.js';

function expectProductionConnection(db: Database.Database) {
  expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  expect(db.pragma('synchronous', { simple: true })).toBe(1);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  expect(db.pragma('foreign_key_check')).toEqual([]);
}

it('keeps production connection policy and pod state across a provisioning fixture disk reopen', () => {
  const f = createProvisioningFixture(true);
  try {
    expectProductionConnection(f.db);
    const before = f.db.prepare('SELECT * FROM pods').all();
    expect(before).toHaveLength(1);
    const original = f.db;
    f.reopen();
    expect(original.open).toBe(false);
    expectProductionConnection(f.db);
    expect(f.db.prepare('SELECT * FROM pods').all()).toEqual(before);
  } finally {
    f.close();
  }
});

it('keeps production connection policy and wakeup evidence across a real fixture disk reopen', () => {
  const f = createSandboxWakeupFixture(true, true);
  expectProductionConnection(f.db);
  const before = f.db.prepare('SELECT * FROM sandbox_wakeup_baselines').all();
  expect(before).toHaveLength(1);
  const original = f.db;
  f.reopen();
  expect(original.open).toBe(false);
  expectProductionConnection(f.db);
  expect(f.db.prepare('SELECT * FROM sandbox_wakeup_baselines').all()).toEqual(before);
});
