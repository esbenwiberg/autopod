import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { assertActiveDatabasePath, snapshotBeforeCutover } from './cutover-backup.js';
import {
  detachLegacyPodProfile,
  detachLegacyScheduledProfile,
  detachLegacyWatchedProfile,
} from './detach-legacy-profile.js';

/** Destructive cutovers require a verified pre-migration online backup. */
const CUTOVER_MIGRATIONS: Record<number, string> = {
  91: 'pre-screenshot-cutover',
  99: 'pre-single-fix-pod',
  193: 'pre-repository-memory-scope',
  194: 'pre-pod-configuration-identity',
  198: 'pre-scheduled-launch-selection',
  200: 'pre-issue-watcher-bindings',
};

function inspectMigrations(db: Database.Database, migrationsDir: string) {
  const hasVersions = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();
  const currentVersion = hasVersions
    ? ((
        db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
          version: number | null;
        }
      ).version ?? 0)
    : 0;
  // Find migration files
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // Refuse ambiguous prefixes even when they are below MAX(version). Otherwise a
  // deployed schema can silently skip another branch's unrelated definitions.
  const namesByVersion = new Map<number, string>();
  for (const file of files) {
    const match = file.match(/^(\d+)_/);
    if (!match?.[1]) continue;
    const version = Number.parseInt(match[1], 10);
    if (!Number.isSafeInteger(version) || version <= 0)
      throw new Error(`Invalid migration version: ${file}`);
    const previous = namesByVersion.get(version);
    if (previous) throw new Error(`Migration prefix collision ${version}: ${previous} and ${file}`);
    namesByVersion.set(version, file);
  }

  // Release 255 is authoritative. The unpublished spike used 255–261 before
  // the orchestration migrations were moved to 262–268. Never relabel its rows
  // (especially unknown allocations) or run part of the new chain on mixed state.
  if (namesByVersion.get(262) === '262_orchestration_continuations.sql' && currentVersion >= 255) {
    const retired = db
      .prepare('SELECT 1 FROM schema_version WHERE version BETWEEN 257 AND 261 LIMIT 1')
      .get();
    const table = (name: string) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    // MAX(version) alone cannot prove that every preceding step was applied.
    // schema_version.version is a primary key; the range count therefore proves
    // the complete prefix up to this branch's last migration (or the current tip).
    const expectedCount = Math.max(0, Math.min(currentVersion, 269) - 261);
    const recordedCount = db
      .prepare('SELECT count(*) FROM schema_version WHERE version BETWEEN 262 AND 269')
      .pluck()
      .get();
    if (
      retired ||
      Boolean(table('fresh_handoff_preparations')) !== currentVersion >= 256 ||
      Boolean(db.prepare('SELECT 1 FROM schema_version WHERE version=256').get()) !==
        currentVersion >= 256 ||
      !table('validation_phase_timings') ||
      !db.prepare('SELECT 1 FROM schema_version WHERE version=255').get() ||
      recordedCount !== expectedCount ||
      Boolean(table('orchestration_runs')) !== expectedCount > 0
    ) {
      throw new Error(
        'Unpublished or mixed orchestration migration lineage; database retained unchanged',
      );
    }
  }

  // No released database has pre-269 orchestration runs. Even an empty/missing
  // custody table does not establish that such a run was nonoperator. Do not
  // guess ownership when upgrading a populated unpublished intermediate build.
  if (
    namesByVersion.get(269) === '269_operator_run_ownership.sql' &&
    currentVersion >= 262 &&
    currentVersion < 269 &&
    db.prepare('SELECT 1 FROM orchestration_runs LIMIT 1').get()
  ) {
    throw new Error(
      'Unpublished run ownership requires explicit reconciliation; database retained unchanged',
    );
  }

  // Earlier unpublished reliability checkpoints used 151-163, which now overlap
  // the managed lane's authoritative 151-152. Never reinterpret or auto-renumber
  // a database from that lineage merely because MAX(version) looks recent.
  if (
    namesByVersion.get(164) === '164_completion_journal.sql' &&
    currentVersion >= 151 &&
    currentVersion <= 163 &&
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name IN ('pod_finalizations', 'logical_tasks') LIMIT 1",
      )
      .get()
  ) {
    throw new Error(
      'Unpublished native migration lineage requires explicit reconciliation on a verified backup before upgrade; the database was retained unchanged.',
    );
  }

  // Pre-scan: check if the cutover migration is pending before applying anything
  const pendingVersions = new Set<number>();
  for (const file of files) {
    const match = file.match(/^(\d+)_/);
    if (!match?.[1]) continue;
    const version = Number.parseInt(match[1], 10);
    if (version > currentVersion) pendingVersions.add(version);
  }

  const sqlByFile = new Map(
    files.map((file) => [file, fs.readFileSync(path.join(migrationsDir, file), 'utf8')]),
  );
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([currentVersion, [...sqlByFile]]))
    .digest('hex');
  const hasData = Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_version' LIMIT 1",
      )
      .get(),
  );
  const cutovers = Object.entries(CUTOVER_MIGRATIONS).filter(([version]) =>
    pendingVersions.has(Number(version)),
  );
  return { currentVersion, files, sqlByFile, fingerprint, cutovers, hasData };
}
type MigrationPlan = ReturnType<typeof inspectMigrations>;

/** Synchronous use remains available for in-memory, empty and non-cutover upgrades. */
export function runMigrations(
  db: Database.Database,
  migrationsDir: string,
  logger: Logger,
  dbPath = db.name,
): void {
  assertActiveDatabasePath(db, dbPath);
  const plan = inspectMigrations(db, migrationsDir);
  if (!db.memory && plan.hasData && plan.cutovers.length)
    throw new Error(
      'Destructive migration requires runMigrationsWithBackups for the active database; source retained unchanged',
    );
  applyMigrations(db, plan, logger);
}

/** Daemon startup awaits verified online backups before applying any pending migration. */
export async function runMigrationsWithBackups(
  db: Database.Database,
  migrationsDir: string,
  logger: Logger,
  dbPath = db.name,
): Promise<void> {
  assertActiveDatabasePath(db, dbPath);
  if (db.inTransaction) throw new Error('Migrations require a database outside a transaction');
  const plan = inspectMigrations(db, migrationsDir);
  const sourceState = () =>
    JSON.stringify([
      db.pragma('data_version', { simple: true }),
      db.pragma('schema_version', { simple: true }),
      db.prepare('SELECT total_changes() AS changes').get(),
    ]);
  const before = sourceState();
  if (!db.memory && plan.hasData) {
    for (const [, suffix] of plan.cutovers) await snapshotBeforeCutover(db, dbPath, logger, suffix);
  }
  if (
    sourceState() !== before ||
    inspectMigrations(db, migrationsDir).fingerprint !== plan.fingerprint
  )
    throw new Error(
      'Database or migration source changed during cutover backup; source retained without migration',
    );
  applyMigrations(db, plan, logger);
}

function applyMigrations(db: Database.Database, plan: MigrationPlan, logger: Logger): void {
  const { files, currentVersion, sqlByFile } = plan;
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  let applied = 0;
  let latestAppliedVersion = currentVersion;

  for (const file of files) {
    const match = file.match(/^(\d+)_/);
    if (!match?.[1]) {
      logger.warn({ file }, 'Skipping migration file with invalid name');
      continue;
    }

    const version = Number.parseInt(match[1], 10);
    if (version <= currentVersion) {
      continue;
    }

    const sql = sqlByFile.get(file);
    if (sql === undefined) throw new Error('Migration plan source unavailable');

    // PRAGMA foreign_keys = OFF/ON must be set at the connection level — they are
    // silently ignored when executed inside a transaction. Detect migrations that
    // need FK enforcement suspended and toggle it around the transaction.
    const needsFkDisabled = /PRAGMA\s+foreign_keys\s*=\s*OFF/i.test(sql);
    if (needsFkDisabled) {
      db.pragma('foreign_keys = OFF');
    }

    // Opt-in marker for repair migrations that re-assert ALTER TABLE ADD COLUMN
    // statements which may or may not already be applied (SQLite lacks
    // IF NOT EXISTS for ADD COLUMN). When present, split on `;` and swallow
    // only "duplicate column name" errors per statement.
    const allowDuplicateColumns = /--\s*@allow-duplicate-columns/i.test(sql);

    const migrate = db.transaction(() => {
      if (version === 194 && /--\s*@detach-legacy-pod-profile/.test(sql)) {
        detachLegacyPodProfile(db);
      } else if (version === 198 && /--\s*@detach-legacy-scheduled-profile/.test(sql)) {
        detachLegacyScheduledProfile(db);
        db.exec(sql);
      } else if (version === 200 && /--\s*@detach-legacy-watched-profile/.test(sql)) {
        detachLegacyWatchedProfile(db);
        db.exec(sql);
      } else if (allowDuplicateColumns) {
        const statements = sql
          .split(';')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        for (const stmt of statements) {
          try {
            db.exec(`${stmt};`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : '';
            if (!msg.includes('duplicate column name')) throw err;
            logger.debug({ stmt, file }, 'Skipping already-applied ADD COLUMN');
          }
        }
      } else {
        db.exec(sql);
      }
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
    });

    try {
      migrate();
    } finally {
      if (needsFkDisabled) {
        db.pragma('foreign_keys = ON');
      }
    }
    applied++;
    latestAppliedVersion = version;
    logger.info({ version, file }, 'Applied migration');
  }

  if (applied === 0) {
    logger.info({ currentVersion }, 'Database schema is up to date');
  } else {
    logger.info({ applied, newVersion: latestAppliedVersion }, 'Migrations complete');
  }
}
