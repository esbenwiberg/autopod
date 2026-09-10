import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { logger } from '../test-utils/mock-helpers.js';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import {
  type ValidationInputIdentity,
  createValidationEvidenceCache,
} from './validation-evidence-cache.js';

const identity: ValidationInputIdentity = {
  version: 1,
  hermetic: true,
  sourceTree: '1'.repeat(64),
  contract: '2'.repeat(64),
  toolchain: '3'.repeat(64),
  commands: '4'.repeat(64),
  dependencies: '5'.repeat(64),
  environment: '6'.repeat(64),
  implementation: '7'.repeat(64),
};
function fixture() {
  const db = createTestDb();
  insertTestProfile(db);
  db.prepare(`INSERT INTO pods (id, profile_name, task, status, model, runtime, branch, user_id)
    VALUES ('original', 'test-profile', 'validate', 'validating', 'model', 'codex', 'branch', 'user')`).run();
  return { db, cache: createValidationEvidenceCache(db) };
}

describe('exact-input validation evidence', () => {
  it.each([139, 152])(
    'upgrades schema %s and reuses immutable evidence after a real database close/reopen',
    (version) => {
      const dir = mkdtempSync(join(tmpdir(), 'evidence-upgrade-'));
      const migrations = new URL('../db/migrations', import.meta.url).pathname;
      for (const file of readdirSync(migrations))
        if (Number.parseInt(file, 10) <= version)
          copyFileSync(join(migrations, file), join(dir, file));
      let db = new Database(join(dir, 'test.db'));
      try {
        runMigrations(db, dir, logger);
        insertTestProfile(db);
        db.prepare(`INSERT INTO pods (id, profile_name, task, status, model, runtime, branch, user_id)
        VALUES ('original', 'test-profile', 'validate', 'validating', 'model', 'codex', 'branch', 'user')`).run();
        runMigrations(db, migrations, logger);
        const receipt = createValidationEvidenceCache(db).record('original', 'test', identity, {
          status: 'pass',
          duration: 100,
        });
        db.close();
        db = new Database(join(dir, 'test.db'));
        runMigrations(db, migrations, logger);
        expect(
          createValidationEvidenceCache(db).get('test', identity)?.reusedEvidence.receiptId,
        ).toBe(receipt);
        expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
        expect(db.pragma('foreign_key_check')).toEqual([]);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('retains successful original evidence and exposes reuse separately from execution time', () => {
    const { db, cache } = fixture();
    try {
      const receipt = cache.record('original', 'test', identity, {
        status: 'pass',
        duration: 123,
        stdout: 'fixed coverage passed',
      });
      expect(receipt).not.toBeNull();
      const reopened = createValidationEvidenceCache(db);
      expect(reopened.get('test', identity)).toMatchObject({
        status: 'pass',
        duration: 0,
        reusedEvidence: { receiptId: receipt, originalDurationMs: 123 },
      });
      expect(reopened.get('lint', identity)).toBeNull();
      expect(() =>
        db.prepare("UPDATE validation_phase_evidence SET result = '{}' WHERE id = ?").run(receipt),
      ).toThrow('immutable');
    } finally {
      db.close();
    }
  });
  it.each([
    'sourceTree',
    'contract',
    'toolchain',
    'commands',
    'dependencies',
    'environment',
    'implementation',
  ] as const)('invalidates reuse when %s changes or is unavailable', (field) => {
    const { db, cache } = fixture();
    try {
      cache.record('original', 'test', identity, { status: 'pass', duration: 123 });
      expect(cache.get('test', { ...identity, [field]: 'a'.repeat(64) })).toBeNull();
      expect(cache.get('test', { ...identity, [field]: '' })).toBeNull();
      expect(
        cache.record(
          'original',
          'test',
          { ...identity, [field]: '' },
          { status: 'pass', duration: 1 },
        ),
      ).toBeNull();
    } finally {
      db.close();
    }
  });
  it('never reuses unknown environment scope, skips, failures or already reused evidence', () => {
    const { db, cache } = fixture();
    try {
      expect(
        cache.record(
          'original',
          'test',
          { ...identity, hermetic: false },
          { status: 'pass', duration: 1 },
        ),
      ).toBeNull();
      for (const result of [
        { status: 'fail', duration: 1 },
        { status: 'skip', duration: 0 },
        { status: 'pass', duration: 1, infrastructureFailure: { retryable: true } },
        { status: 'pass', duration: 0, reusedEvidence: { receiptId: 'old' } },
      ]) {
        expect(cache.record('original', 'test', identity, result)).toBeNull();
      }
      expect(cache.get('test', identity)).toBeNull();
      expect(cache.get('test', undefined)).toBeNull();
    } finally {
      db.close();
    }
  });
});
