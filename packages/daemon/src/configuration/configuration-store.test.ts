import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';

describe('configuration revision store', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });
  it('retains revisions through rename and rejects stale edits', () => {
    const { store } = createTestConfiguration(db);
    const old = store.get('environment', 'env');
    const next = store.write({
      ...old,
      name: 'New name',
      expectedRevision: old.revision,
      payload: { ...old.payload, template: 'node24' },
    });
    expect(next.revision).toBe(2);
    expect(store.get('environment', 'env', 1).payload.template).toBe('node22');
    expect(store.get('environment', 'env', 1).name).toBe('Node');
    expect(() => store.write({ ...old, expectedRevision: 1 })).toThrow('Configuration changed');
    expect(() => store.archive('environment', 'env', 2)).toThrow('still referenced');
  });
  it('checks batch references and rolls back cyclic worker profiles', () => {
    const { store } = createTestConfiguration(db);
    const old = store.get('profile', 'profile');
    expect(() =>
      store.writeBatch([
        { ...old, expectedRevision: 1, payload: { ...old.payload, workerProfileId: 'worker' } },
        {
          id: 'worker',
          kind: 'profile',
          name: 'Worker',
          payload: { ...old.payload, workerProfileId: 'profile' },
        },
      ]),
    ).toThrow('cycle');
    expect(store.get('profile', 'profile').revision).toBe(1);
    expect(() => store.get('profile', 'worker')).toThrow('not found');
    expect(() =>
      store.write({ ...old, expectedRevision: 1, payload: { ...old.payload, aiId: 'env' } }),
    ).toThrow('not found');
  });
  it('archives unreferenced choices while retaining historical payloads', () => {
    const { store } = createTestConfiguration(db);
    store.archive('repository', 'repo-b', 1);
    expect(store.list('repository')).toHaveLength(1);
    expect(store.get('repository', 'repo-b', 1).payload.remote).toContain('repo-b');
    expect(() => store.get('repository', 'repo-b')).toThrow('archived');
  });
});
