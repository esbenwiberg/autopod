import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

const migrations = new URL('./migrations', import.meta.url).pathname;
const logger = pino({ level: 'silent' });
const findingsFile = '232_research_findings.sql';

// Deliberately use the production runner, never createTestDb's SQL-file loop.
describe('research findings production upgrade from main schema 231', () => {
  let db: Database.Database;
  let root: string;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'findings-upgrade-'));
    for (const file of fs.readdirSync(migrations)) {
      if (file.endsWith('.sql') && Number.parseInt(file, 10) <= 231) {
        fs.copyFileSync(path.join(migrations, file), path.join(root, file));
      }
    }
  });
  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  function version() {
    return (
      db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
        version: number;
      }
    ).version;
  }
  function populateMain() {
    runMigrations(db, root, logger);
    expect(version()).toBe(231);
    db.exec(`
      INSERT INTO profiles (name, repo_url, build_command, start_command)
        VALUES ('retained-profile', 'https://example.invalid/repo', '', '');
      INSERT INTO pods (id, profile_name, task, status, model, runtime, branch, user_id,
        execution_target, container_id, worktree_path, failure_reason)
        VALUES ('retained-sandbox', 'retained-profile', 'Retain unresolved investigation',
          'failed', 'model', 'codex', 'retained', 'owner', 'sandbox', 'sandbox-retained',
          '/retained/source', 'Unresolved wakeup dispatch');
      INSERT INTO sandbox_wakeup_baselines VALUES
        ('sandbox-resource', 'sandbox-retained', '2026-11-01T00:00:00Z');
      INSERT INTO sandbox_wakeup_intents
        (id, resource_key, sandbox_id, pod_id, started_at, dispatch_started_at)
        VALUES ('pending-dispatch', 'sandbox-resource', 'sandbox-retained',
          'retained-sandbox', '2026-11-01T00:01:00Z', '2026-11-01T00:01:01Z');
    `);
  }
  function originalRows() {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_version' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    return tables.map(({ name }) => {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      const columns = (db.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{ name: string }>)
        .map(({ name }) => `"${name.replaceAll('"', '""')}"`)
        .join(',');
      return { name, columns, rows: db.prepare(`SELECT ${columns} FROM ${quoted}`).all() };
    });
  }
  function assertPreserved(before: ReturnType<typeof originalRows>) {
    for (const { name, columns, rows } of before) {
      expect(db.prepare(`SELECT ${columns} FROM "${name}"`).all(), name).toEqual(rows);
    }
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(() => db.exec('DELETE FROM sandbox_wakeup_intents')).toThrow(/immutable/);
  }
  function assertFindingsSchema() {
    expect(db.prepare('SELECT * FROM research_findings_receipts').all()).toEqual([]);
    expect(db.prepare('SELECT completion_policy, research_findings FROM pods').all()).toEqual([
      { completion_policy: null, research_findings: null },
    ]);
    expect(
      db.prepare('SELECT completion_policy, research_findings FROM task_history_pods').all(),
    ).toEqual([]);
  }
  it('upgrades populated main without changing any original business row or custody', () => {
    populateMain();
    const before = originalRows();
    // Reproduce the historical numbering bug using only a temporary copy.
    fs.copyFileSync(
      path.join(migrations, findingsFile),
      path.join(root, '225_research_findings.sql'),
    );
    runMigrations(db, root, logger);
    expect(version()).toBe(231);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='research_findings_receipts'").get(),
    ).toBeUndefined();
    expect(
      (db.prepare('PRAGMA table_info(pods)').all() as Array<{ name: string }>).map((c) => c.name),
    ).not.toContain('completion_policy');
    fs.unlinkSync(path.join(root, '225_research_findings.sql'));
    runMigrations(db, migrations, logger);
    expect(version()).toBe(232);
    assertFindingsSchema();
    assertPreserved(before);
    const current = originalRows();
    runMigrations(db, migrations, logger);
    expect(originalRows()).toEqual(current);
  });
  it('builds the complete schema from empty using production version selection', () => {
    runMigrations(db, migrations, logger);
    expect(version()).toBe(232);
    expect(db.prepare('SELECT * FROM research_findings_receipts').all()).toEqual([]);
    expect(db.prepare('SELECT completion_policy, research_findings FROM pods').all()).toEqual([]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
  it('refuses an already-applied unpublished 225 candidate without reinterpreting its evidence', () => {
    populateMain();
    // A database with candidate columns must be reconciled explicitly on a backup.
    db.exec(fs.readFileSync(path.join(migrations, findingsFile), 'utf8'));
    db.prepare('INSERT INTO schema_version(version) VALUES (225)').run();
    db.exec(`INSERT INTO research_findings_receipts VALUES
      ('historical-research', 1, 1, 0, '{"retained":"candidate evidence"}')`);
    const before = originalRows();
    expect(() => runMigrations(db, migrations, logger)).toThrow(/duplicate column/);
    expect(version()).toBe(231);
    assertPreserved(before);
    expect(() => db.exec("UPDATE research_findings_receipts SET receipt='{}'")).toThrow(
      /immutable/,
    );
  });
});
