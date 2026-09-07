import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ExecutionProvenanceInput } from '@autopod/shared';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createPodRepository } from './pod-repository.js';

const input: ExecutionProvenanceInput = {
  version: 1,
  status: 'blocked',
  runtime: 'codex',
  model: 'gpt-5.6-sol',
  providerId: 'openai',
  providerAccountId: 'account',
  release: { commitSha: null, dirty: null, builtAt: null, source: 'unavailable' },
  cliPath: null,
  cliVersion: null,
  imageDigest: null,
  contractHash: 'a'.repeat(64),
  validationImplementationHash: null,
  capabilities: {
    streamingExec: 'unverified',
    memoryLimitBytes: null,
    cpuLimit: null,
    networkMode: null,
  },
  commands: {
    requirements: [],
    unresolvedSources: [],
    deferredArtifacts: [],
    explicitDependencies: false,
  },
  diagnostics: [{ code: 'PREFLIGHT_RUNTIME_UNAVAILABLE', detail: 'CLI version unknown' }],
};
it('retains failed provenance through restart and pod deletion without changing a receipt or attributing it to a stale lifecycle', () => {
  const f = createTestDb();
  insertTestProfile(f);
  const repo = createPodRepository(f);
  repo.insert({
    id: 'pod',
    profileName: 'test-profile',
    task: 'Probe environment',
    status: 'queued',
    runtime: 'codex',
    model: 'gpt-5.6-sol',
    executionTarget: 'local',
    branch: 'branch',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  const saved = repo.executionProvenance?.record('pod', 1, input);
  expect(saved).toBeTruthy();
  expect(() => repo.executionProvenance?.record('pod', 2, input)).toThrow('current lifecycle');
  expect(() => f.prepare("UPDATE execution_provenance SET payload = '{}'").run()).toThrow(
    'immutable',
  );
  const dir = mkdtempSync(join(tmpdir(), 'provenance-restart-'));
  const file = join(dir, 'state.db');
  writeFileSync(file, f.serialize());
  f.close();
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  try {
    expect(createPodRepository(db).executionProvenance?.latest('pod')).toEqual(saved);
    db.prepare("DELETE FROM pods WHERE id = 'pod'").run();
    expect(createPodRepository(db).executionProvenance?.latest('pod')).toBeNull();
    expect(db.prepare('SELECT count(*) AS count FROM execution_provenance').get()).toEqual({
      count: 1,
    });
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it.each([139, 157])(
  'upgrades schema %s without manufacturing missing historical provenance',
  (version) => {
    const dir = mkdtempSync(join(tmpdir(), 'provenance-upgrade-'));
    const migrations = resolve(import.meta.dirname, '../db/migrations');
    for (const file of readdirSync(migrations))
      if (Number.parseInt(file, 10) <= version)
        copyFileSync(join(migrations, file), join(dir, file));
    const db = new Database(join(dir, 'state.db'));
    db.pragma('foreign_keys = ON');
    try {
      runMigrations(db, dir, logger);
      insertTestProfile(db);
      db.prepare(
        "INSERT INTO pods (id,profile_name,task,status,model,runtime,branch,user_id,task_summary) VALUES ('old','test-profile','old','failed','model','codex','branch','operator','malformed-preserve')",
      ).run();
      runMigrations(db, migrations, logger);
      expect(createPodRepository(db).executionProvenance?.latest('old')).toBeNull();
      expect(db.prepare("SELECT task_summary FROM pods WHERE id='old'").get()).toEqual({
        task_summary: 'malformed-preserve',
      });
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
