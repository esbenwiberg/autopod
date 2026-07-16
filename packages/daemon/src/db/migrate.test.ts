import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProfileStore } from '../profiles/profile-store.js';
import { runMigrations } from './migrate.js';

const logger = pino({ level: 'silent' });
const MIGRATIONS_DIR = new URL('../../src/db/migrations', import.meta.url).pathname;

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

describe('runMigrations — @allow-duplicate-columns', () => {
  let migrationsDir: string;

  beforeEach(() => {
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
    fs.writeFileSync(
      path.join(migrationsDir, '001_init.sql'),
      'CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT);',
    );
  });

  afterEach(() => {
    fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  it('applies missing ADD COLUMN when previous migration partially applied', () => {
    // Simulate the stuck-DB state: schema_version at 2, but `colB` never got added.
    const db = new Database(':memory:');
    runMigrations(db, migrationsDir, logger);
    db.exec('ALTER TABLE widgets ADD COLUMN colA TEXT');
    db.prepare('INSERT INTO schema_version (version) VALUES (2)').run();

    fs.writeFileSync(
      path.join(migrationsDir, '003_repair.sql'),
      `-- @allow-duplicate-columns
ALTER TABLE widgets ADD COLUMN colA TEXT;
ALTER TABLE widgets ADD COLUMN colB TEXT;`,
    );

    runMigrations(db, migrationsDir, logger);

    expect(hasColumn(db, 'widgets', 'colA')).toBe(true);
    expect(hasColumn(db, 'widgets', 'colB')).toBe(true);
    const ver = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
    expect(ver.v).toBe(3);
  });

  it('is a no-op on a fresh DB where all columns already exist', () => {
    const db = new Database(':memory:');
    fs.writeFileSync(
      path.join(migrationsDir, '002_add_cols.sql'),
      `ALTER TABLE widgets ADD COLUMN colA TEXT;
ALTER TABLE widgets ADD COLUMN colB TEXT;`,
    );
    fs.writeFileSync(
      path.join(migrationsDir, '003_repair.sql'),
      `-- @allow-duplicate-columns
ALTER TABLE widgets ADD COLUMN colA TEXT;
ALTER TABLE widgets ADD COLUMN colB TEXT;`,
    );

    expect(() => runMigrations(db, migrationsDir, logger)).not.toThrow();
    expect(hasColumn(db, 'widgets', 'colA')).toBe(true);
    expect(hasColumn(db, 'widgets', 'colB')).toBe(true);
  });

  it('still surfaces non-duplicate-column errors', () => {
    const db = new Database(':memory:');
    fs.writeFileSync(
      path.join(migrationsDir, '002_bad.sql'),
      `-- @allow-duplicate-columns
ALTER TABLE does_not_exist ADD COLUMN foo TEXT;`,
    );
    expect(() => runMigrations(db, migrationsDir, logger)).toThrow(/no such table/);
  });

  it('without the marker, duplicate-column errors are not swallowed', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrationsDir, logger);
    db.exec('ALTER TABLE widgets ADD COLUMN colA TEXT');
    db.prepare('INSERT INTO schema_version (version) VALUES (2)').run();

    fs.writeFileSync(
      path.join(migrationsDir, '003_no_marker.sql'),
      'ALTER TABLE widgets ADD COLUMN colA TEXT;',
    );
    expect(() => runMigrations(db, migrationsDir, logger)).toThrow(/duplicate column/);
  });
});

// ── Migrations 092-095 — Safety / Guardrails foundation ──────────────────────

describe('runMigrations — migrations 092-095 (safety foundation)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, MIGRATIONS_DIR, logger);
  });

  it('creates safety_events table with expected columns', () => {
    const colNames = db
      .prepare('PRAGMA table_info(safety_events)')
      .all()
      .map((r) => (r as { name: string }).name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('pod_id');
    expect(colNames).toContain('source');
    expect(colNames).toContain('kind');
    expect(colNames).toContain('pattern_name');
    expect(colNames).toContain('severity');
    expect(colNames).toContain('payload_excerpt');
    expect(colNames).toContain('created_at');
    const count = (db.prepare('SELECT COUNT(*) as n FROM safety_events').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('adds pii_categories column to action_audit', () => {
    expect(hasColumn(db, 'action_audit', 'pii_categories')).toBe(true);
  });

  it('adds network_policy_resolved column to pods', () => {
    expect(hasColumn(db, 'pods', 'network_policy_resolved')).toBe(true);
  });

  it('creates audit_chain_verifications table and it is empty on a fresh DB', () => {
    const colNames = db
      .prepare('PRAGMA table_info(audit_chain_verifications)')
      .all()
      .map((r) => (r as { name: string }).name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('ran_at');
    expect(colNames).toContain('total_pods');
    expect(colNames).toContain('total_entries');
    expect(colNames).toContain('valid');
    expect(colNames).toContain('first_mismatch_pod_id');
    expect(colNames).toContain('first_mismatch_row_id');
    expect(colNames).toContain('first_mismatch_reason');
    const count = (
      db.prepare('SELECT COUNT(*) as n FROM audit_chain_verifications').get() as { n: number }
    ).n;
    expect(count).toBe(0);
  });
});

// ── Migration 120 — provider accounts ───────────────────────────────────────

describe('runMigrations — migration 120 (provider accounts)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, MIGRATIONS_DIR, logger);
  });

  it('creates provider_accounts and adds the nullable profile link column', () => {
    const providerAccountColumns = db
      .prepare('PRAGMA table_info(provider_accounts)')
      .all()
      .map((r) => (r as { name: string }).name);

    expect(providerAccountColumns).toContain('id');
    expect(providerAccountColumns).toContain('name');
    expect(providerAccountColumns).toContain('provider');
    expect(providerAccountColumns).toContain('credentials');
    expect(providerAccountColumns).toContain('last_authenticated_at');
    expect(providerAccountColumns).toContain('last_used_at');
    expect(hasColumn(db, 'profiles', 'provider_account_id')).toBe(true);
  });

  it('keeps old profile rows loadable with no provider account link', () => {
    db.prepare(`
      INSERT INTO profiles (
        name, repo_url, default_branch, template, build_command, start_command,
        health_path, health_timeout, validation_pages, max_validation_attempts,
        default_model, default_runtime, escalation_config
      ) VALUES (
        'legacy', 'https://github.com/org/repo', 'main', 'node22', 'npm run build', 'npm start',
        '/', 120, '[]', 3, 'claude-opus-4-8', 'claude', '{}'
      )
    `).run();

    const store = createProfileStore(db);
    expect(store.getRaw('legacy').providerAccountId).toBeNull();
  });
});

describe('runMigrations — migration 122 (failure reason repair)', () => {
  it('adds failure_reason when schema version 121 was recorded by a colliding migration', () => {
    const pre121Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-pre121-'));
    try {
      for (const file of fs.readdirSync(MIGRATIONS_DIR)) {
        const version = Number.parseInt(file.split('_', 1)[0] ?? '', 10);
        if (file.endsWith('.sql') && version <= 120) {
          fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(pre121Dir, file));
        }
      }

      const db = new Database(':memory:');
      runMigrations(db, pre121Dir, logger);
      db.prepare('INSERT INTO schema_version (version) VALUES (121)').run();

      expect(hasColumn(db, 'pods', 'failure_reason')).toBe(false);
      runMigrations(db, MIGRATIONS_DIR, logger);

      expect(hasColumn(db, 'pods', 'failure_reason')).toBe(true);
      const version = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as {
        v: number;
      };
      expect(version.v).toBe(122);
    } finally {
      fs.rmSync(pre121Dir, { recursive: true, force: true });
    }
  });
});

// ── Migration 091 — drop screenshot blobs ────────────────────────────────────

/** The SQL for migration 091 — located in the real migrations directory. */
const MIGRATION_091_PATH = new URL(
  '../../src/db/migrations/091_drop_screenshot_blobs.sql',
  import.meta.url,
);
const MIGRATION_091_SQL = fs.readFileSync(MIGRATION_091_PATH, 'utf-8');

/** Build a minimal DB that looks like "post-090, pre-091": validations table with
 *  legacy `screenshots` column and `result` JSON containing embedded base64 fields. */
function buildLegacyDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS validations (
      id TEXT PRIMARY KEY,
      pod_id TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      result TEXT,
      screenshots TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Mark schema_version at 90 so only 091 is pending
  db.prepare('INSERT INTO schema_version (version) VALUES (90)').run();

  // Insert a row with legacy base64 fields embedded in result JSON
  const legacyResult = JSON.stringify({
    smoke: {
      pages: [
        { path: '/', screenshotBase64: 'abc123base64==', passed: true },
        { path: '/about', screenshotBase64: 'def456base64==', passed: true },
      ],
    },
    taskReview: {
      screenshots: ['img1base64==', 'img2base64=='],
      passed: true,
    },
  });
  db.prepare(
    'INSERT INTO validations (id, pod_id, attempt, result, screenshots) VALUES (?, ?, ?, ?, ?)',
  ).run('val-1', 'pod-1', 1, legacyResult, JSON.stringify(['screenshotBlob==']));
}

describe('runMigrations — migration 091 (drop screenshot blobs)', () => {
  let tmpDir: string;
  let migrationsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-091-test-'));
    migrationsDir = path.join(tmpDir, 'migrations');
    fs.mkdirSync(migrationsDir);
    fs.writeFileSync(path.join(migrationsDir, '091_drop_screenshot_blobs.sql'), MIGRATION_091_SQL);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('strips base64 fields from result JSON and drops screenshots column', () => {
    const db = new Database(':memory:');
    buildLegacyDb(db);

    runMigrations(db, migrationsDir, logger); // :memory: → no snapshot

    // Column is gone
    expect(hasColumn(db, 'validations', 'screenshots')).toBe(false);

    // result JSON no longer has base64 fields
    const row = db.prepare('SELECT result FROM validations WHERE id = ?').get('val-1') as {
      result: string;
    };
    const result = JSON.parse(row.result) as {
      smoke: { pages: Array<{ screenshotBase64?: string }> };
      taskReview: { screenshots?: unknown[] };
    };

    // smoke pages — screenshotBase64 removed
    expect(result.smoke.pages[0]?.screenshotBase64).toBeUndefined();
    expect(result.smoke.pages[1]?.screenshotBase64).toBeUndefined();

    // taskReview.screenshots — set to empty array
    expect(result.taskReview.screenshots).toEqual([]);
  });

  it('creates a snapshot file before applying 091 for a real DB path', () => {
    const dbPath = path.join(tmpDir, 'autopod.db');
    const backupsDir = path.join(tmpDir, 'backups');
    fs.mkdirSync(backupsDir);

    // Open a real file-based DB and populate it
    const db = new Database(dbPath);
    buildLegacyDb(db);
    db.close();

    // Reopen (migrate.ts doesn't close it; we need to pass an open handle + dbPath)
    const db2 = new Database(dbPath);
    runMigrations(db2, migrationsDir, logger, dbPath);
    db2.close();

    // A snapshot file should exist in the backups dir
    const backupFiles = fs
      .readdirSync(backupsDir)
      .filter((f) => f.endsWith('-pre-screenshot-cutover.db'));
    expect(backupFiles).toHaveLength(1);
  });

  it('skips the snapshot when dbPath is :memory:', () => {
    const copyFileSyncSpy = vi.spyOn(fs, 'copyFileSync');

    const db = new Database(':memory:');
    buildLegacyDb(db);
    runMigrations(db, migrationsDir, logger, ':memory:');

    // copyFileSync should never have been called
    expect(copyFileSyncSpy).not.toHaveBeenCalled();
    // Migration still applied
    expect(hasColumn(db, 'validations', 'screenshots')).toBe(false);
  });

  it('does NOT apply migration when snapshot fails (fail-closed)', () => {
    const dbPath = path.join(tmpDir, 'autopod.db');
    const db = new Database(dbPath);
    buildLegacyDb(db);

    // Make copyFileSync throw so the snapshot fails
    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => runMigrations(db, migrationsDir, logger, dbPath)).toThrow('disk full');

    // Column must still be present — migration was not applied
    expect(hasColumn(db, 'validations', 'screenshots')).toBe(true);

    db.close();
  });
});

// ── Migration 107 — memory learning schema ───────────────────────────────────

describe('runMigrations — memory-learning-schema (migration 107)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, MIGRATIONS_DIR, logger);
  });

  it('legacy memory_entries rows survive with defaults for new columns', () => {
    db.prepare(
      `INSERT INTO memory_entries
         (id, scope, scope_id, path, content, content_sha256, version, approved)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('mem-legacy', 'profile', 'my-profile', '/notes/old.md', 'old note', 'sha256abc', 1, 1);

    const row = db.prepare('SELECT * FROM memory_entries WHERE id = ?').get('mem-legacy') as Record<
      string,
      unknown
    >;

    expect(row.id).toBe('mem-legacy');
    expect(row.kind).toBeNull();
    expect(row.tags).toBe('[]');
    expect(row.applies_when).toBeNull();
    expect(row.avoid_when).toBeNull();
    expect(row.confidence).toBeNull();
    expect(row.source_evidence).toBe('[]');
    expect(row.impact_summary).toBeNull();
  });

  it('memory_candidates table exists with correct columns', () => {
    const cols = db
      .prepare('PRAGMA table_info(memory_candidates)')
      .all()
      .map((r) => (r as { name: string }).name);

    for (const col of [
      'id',
      'action',
      'target_memory_id',
      'scope',
      'scope_id',
      'path',
      'content',
      'rationale',
      'kind',
      'tags',
      'applies_when',
      'avoid_when',
      'confidence',
      'source_evidence',
      'impact_summary',
      'status',
      'created_by_pod_id',
      'fallback_reason',
      'created_at',
      'updated_at',
    ]) {
      expect(cols, `expected column: ${col}`).toContain(col);
    }

    const count = (db.prepare('SELECT COUNT(*) as n FROM memory_candidates').get() as { n: number })
      .n;
    expect(count).toBe(0);
  });

  it('memory_usage_events table exists with correct columns', () => {
    const cols = db
      .prepare('PRAGMA table_info(memory_usage_events)')
      .all()
      .map((r) => (r as { name: string }).name);

    for (const col of [
      'id',
      'memory_id',
      'pod_id',
      'kind',
      'outcome',
      'reason',
      'relevance_reason',
      'created_at',
    ]) {
      expect(cols, `expected column: ${col}`).toContain(col);
    }

    const count = (
      db.prepare('SELECT COUNT(*) as n FROM memory_usage_events').get() as { n: number }
    ).n;
    expect(count).toBe(0);
  });

  it('required indexes exist', () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((r) => (r as { name: string }).name);

    for (const idx of [
      'idx_memory_candidates_status',
      'idx_memory_candidates_scope',
      'idx_memory_candidates_pod',
      'idx_memory_usage_memory',
      'idx_memory_usage_pod',
      'idx_memory_usage_kind',
    ]) {
      expect(indexes, `expected index: ${idx}`).toContain(idx);
    }
  });

  it('memory_usage_events cascade-deletes when memory_entry is removed', () => {
    db.prepare(
      `INSERT INTO memory_entries
         (id, scope, scope_id, path, content, content_sha256, version, approved)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('mem-1', 'global', null, '/test.md', 'content', 'sha', 1, 1);
    db.prepare(
      `INSERT INTO memory_usage_events (id, memory_id, pod_id, kind)
       VALUES (?, ?, ?, ?)`,
    ).run('evt-1', 'mem-1', 'pod-abc', 'selected');

    db.prepare('DELETE FROM memory_entries WHERE id = ?').run('mem-1');

    const remaining = (
      db.prepare('SELECT COUNT(*) as n FROM memory_usage_events WHERE id = ?').get('evt-1') as {
        n: number;
      }
    ).n;
    expect(remaining).toBe(0);
  });
});

// ── Migration 109 — memory extraction attempts ──────────────────────────────

describe('runMigrations — memory extraction attempts (migration 109)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, MIGRATIONS_DIR, logger);
  });

  afterEach(() => {
    db.close();
  });

  it('memory_extraction_attempts table exists with correct columns and indexes', () => {
    const cols = db
      .prepare('PRAGMA table_info(memory_extraction_attempts)')
      .all()
      .map((r) => (r as { name: string }).name);

    for (const col of [
      'id',
      'pod_id',
      'profile_name',
      'status',
      'reason',
      'score',
      'signals',
      'candidate_id',
      'created_at',
      'updated_at',
    ]) {
      expect(cols, `expected column: ${col}`).toContain(col);
    }

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((r) => (r as { name: string }).name);

    expect(indexes).toContain('idx_memory_extraction_attempts_pod');
    expect(indexes).toContain('idx_memory_extraction_attempts_profile');
    expect(indexes).toContain('idx_memory_extraction_attempts_status');
  });
});

// ── Migration 110 — canonical profile model aliases ─────────────────────────

const MIGRATION_110_PATH = new URL(
  '../../src/db/migrations/110_canonicalize_profile_model_aliases.sql',
  import.meta.url,
);
const MIGRATION_110_SQL = fs.readFileSync(MIGRATION_110_PATH, 'utf-8');

function buildPre110Db(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE profiles (
      name TEXT PRIMARY KEY,
      default_model TEXT,
      reviewer_model TEXT,
      escalation_config TEXT
    );
    CREATE TABLE pods (
      id TEXT PRIMARY KEY,
      model TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO schema_version (version) VALUES (109)').run();
}

describe('runMigrations — canonical profile model aliases (migration 110)', () => {
  let tmpDir: string;
  let migrationsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-110-test-'));
    migrationsDir = path.join(tmpDir, 'migrations');
    fs.mkdirSync(migrationsDir);
    fs.writeFileSync(
      path.join(migrationsDir, '110_canonicalize_profile_model_aliases.sql'),
      MIGRATION_110_SQL,
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rewrites profile aliases while leaving canonical values and pod history unchanged', () => {
    const db = new Database(':memory:');
    buildPre110Db(db);

    db.prepare(
      'INSERT INTO profiles (name, default_model, reviewer_model, escalation_config) VALUES (?, ?, ?, ?)',
    ).run(
      'legacy',
      'opus',
      'sonnet',
      JSON.stringify({ askAi: { enabled: true, model: 'haiku', maxCalls: 5 } }),
    );
    db.prepare(
      'INSERT INTO profiles (name, default_model, reviewer_model, escalation_config) VALUES (?, ?, ?, ?)',
    ).run(
      'canonical',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      JSON.stringify({ askAi: { enabled: true, model: 'claude-opus-4-7', maxCalls: 5 } }),
    );
    db.prepare('INSERT INTO pods (id, model) VALUES (?, ?)').run('pod-legacy', 'opus');

    runMigrations(db, migrationsDir, logger);

    const legacy = db.prepare('SELECT * FROM profiles WHERE name = ?').get('legacy') as {
      default_model: string;
      reviewer_model: string;
      escalation_config: string;
    };
    expect(legacy.default_model).toBe('claude-opus-4-8');
    expect(legacy.reviewer_model).toBe('claude-sonnet-4-6');
    expect(JSON.parse(legacy.escalation_config).askAi.model).toBe('claude-haiku-4-5');

    const canonical = db.prepare('SELECT * FROM profiles WHERE name = ?').get('canonical') as {
      default_model: string;
      reviewer_model: string;
      escalation_config: string;
    };
    expect(canonical.default_model).toBe('claude-opus-4-7');
    expect(canonical.reviewer_model).toBe('claude-sonnet-4-6');
    expect(JSON.parse(canonical.escalation_config).askAi.model).toBe('claude-opus-4-7');

    const pod = db.prepare('SELECT model FROM pods WHERE id = ?').get('pod-legacy') as {
      model: string;
    };
    expect(pod.model).toBe('opus');
  });
});

// ── Migration 104 — remove acceptance criteria ──────────────────────────────

const MIGRATION_104_PATH = new URL(
  '../../src/db/migrations/104_remove_acceptance_criteria.sql',
  import.meta.url,
);
const MIGRATION_104_SQL = fs.readFileSync(MIGRATION_104_PATH, 'utf-8');

function buildPre104Db(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE profiles (
      name TEXT PRIMARY KEY,
      skip_validation_phases TEXT,
      evaluate_plan INTEGER
    );
    CREATE TABLE pods (
      id TEXT PRIMARY KEY,
      last_validation_result TEXT,
      acceptance_criteria TEXT,
      ac_from TEXT,
      ac_self_report TEXT
    );
    CREATE TABLE validations (
      id TEXT PRIMARY KEY,
      result TEXT
    );
    CREATE TABLE watched_issues (
      id INTEGER PRIMARY KEY,
      pod_id TEXT
    );
  `);
  db.prepare('INSERT INTO schema_version (version) VALUES (103)').run();
}

describe('runMigrations — migration 104 (remove acceptance criteria)', () => {
  let tmpDir: string;
  let migrationsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-104-test-'));
    migrationsDir = path.join(tmpDir, 'migrations');
    fs.mkdirSync(migrationsDir);
    fs.writeFileSync(
      path.join(migrationsDir, '104_remove_acceptance_criteria.sql'),
      MIGRATION_104_SQL,
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rewrites skipped ac phase settings to facts and deduplicates existing facts', () => {
    const db = new Database(':memory:');
    buildPre104Db(db);
    db.prepare(
      'INSERT INTO profiles (name, skip_validation_phases, evaluate_plan) VALUES (?, ?, ?)',
    ).run('legacy-ac', JSON.stringify(['ac']), 1);
    db.prepare(
      'INSERT INTO profiles (name, skip_validation_phases, evaluate_plan) VALUES (?, ?, ?)',
    ).run('mixed', JSON.stringify(['lint', 'ac', 'facts', 'test']), 1);

    runMigrations(db, migrationsDir, logger);

    const rows = db.prepare('SELECT name, skip_validation_phases FROM profiles').all() as Array<{
      name: string;
      skip_validation_phases: string;
    }>;
    const phasesByProfile = new Map(
      rows.map((row) => [row.name, JSON.parse(row.skip_validation_phases) as string[]]),
    );
    expect(phasesByProfile.get('legacy-ac')).toEqual(['facts']);
    expect(phasesByProfile.get('mixed')).toEqual(['lint', 'facts', 'test']);
    expect(hasColumn(db, 'profiles', 'evaluate_plan')).toBe(false);
    expect(hasColumn(db, 'pods', 'acceptance_criteria')).toBe(false);
    expect(hasColumn(db, 'watched_issues', 'phase')).toBe(true);
  });
});
