// Local preparation only. Hosted execution requires a separately approved payload.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const invariant = (condition, code) => {
  if (!condition) throw new Error(code);
};

export function migrationHash(directory) {
  const files = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  return hash(
    JSON.stringify(files.map((name) => [name, hash(fs.readFileSync(path.join(directory, name)))])),
  );
}

function checksum(file, deadline) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    while (true) {
      const count = fs.readSync(fd, buffer);
      if (count === 0) break;
      invariant(Date.now() <= deadline, 'time_limit');
      digest.update(buffer.subarray(0, count));
    }
    return digest.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function retainedRows(db, tables, deadline) {
  const fingerprints = [];
  for (const { name, columns } of tables) {
    let count = 0;
    let sum = 0n;
    const rows = db
      .prepare(`SELECT ${columns.map(quote).join(',')} FROM ${quote(name)}`)
      .raw()
      .safeIntegers()
      .iterate();
    for (const row of rows) {
      invariant(Date.now() <= deadline, 'time_limit');
      const canonical = JSON.stringify(
        row.map((value) => {
          if (Buffer.isBuffer(value)) return ['blob', value.toString('hex')];
          if (typeof value === 'bigint') return ['integer', String(value)];
          return [value === null ? 'null' : typeof value, value];
        }),
      );
      invariant(canonical.length <= 16 * 1024 * 1024, 'row_limit');
      sum = (sum + BigInt(`0x${hash(canonical)}`)) % (1n << 256n);
      count++;
    }
    fingerprints.push([name, count, sum.toString(16)]);
  }
  return JSON.stringify(fingerprints);
}

// Dependencies are injected so the bundle uses the candidate's actual migration
// runner and the target host's compatible native SQLite module, never daemon startup.
export function verifyUpgradeCopy({
  Database,
  runMigrations,
  snapshot,
  expectedSnapshotHash,
  migrationsDir,
  expectedMigrationHash,
  scratchParent,
  maxMs = 240000,
}) {
  let directory;
  let db;
  let result = { status: 'incomplete', activeDatabaseOpened: false };
  const deadline = Date.now() + maxMs;
  try {
    invariant(/^[a-f0-9]{64}$/.test(expectedSnapshotHash), 'snapshot_hash_required');
    invariant(/^[a-f0-9]{64}$/.test(expectedMigrationHash), 'migration_hash_required');
    const before = fs.lstatSync(snapshot);
    invariant(
      before.isFile() && !before.isSymbolicLink() && before.nlink === 1,
      'snapshot_identity',
    );
    invariant(before.size > 0 && before.size <= 2 * 1024 ** 3, 'snapshot_size');
    invariant(
      !fs.existsSync(`${snapshot}-wal`) && !fs.existsSync(`${snapshot}-journal`),
      'snapshot_sidecar',
    );
    invariant(checksum(snapshot, deadline) === expectedSnapshotHash, 'snapshot_hash_mismatch');
    invariant(migrationHash(migrationsDir) === expectedMigrationHash, 'migration_hash_mismatch');
    const space = fs.statfsSync(scratchParent);
    invariant(space.bavail * space.bsize > 3 * before.size + 256 * 1024 ** 2, 'headroom');
    directory = fs.mkdtempSync(path.join(fs.realpathSync(scratchParent), 'autopod-upgrade-'));
    fs.chmodSync(directory, 0o700);
    const output = path.join(directory, 'isolated.db');
    fs.copyFileSync(snapshot, output, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(output, 0o600);
    invariant(checksum(output, deadline) === expectedSnapshotHash, 'copy_hash_mismatch');
    db = new Database(output, { timeout: 1000 });
    db.pragma('foreign_keys = ON');
    invariant(db.pragma('integrity_check', { simple: true }) === 'ok', 'before_integrity');
    invariant(db.pragma('foreign_key_check').length === 0, 'before_foreign_keys');
    const beforeVersion = db
      .prepare('SELECT MAX(version) AS version FROM schema_version')
      .get().version;
    invariant(beforeVersion === 152, 'expected_managed_152');
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_version' ORDER BY name",
      )
      .all()
      .map(({ name }) => ({
        name,
        columns: db
          .prepare(`PRAGMA table_info(${quote(name)})`)
          .all()
          .map((row) => row.name),
      }));
    invariant(tables.length > 0 && tables.length <= 256, 'table_limit');
    const retainedBefore = retainedRows(db, tables, deadline);
    const logger = { info() {}, warn() {}, debug() {}, error() {} };
    runMigrations(db, migrationsDir, logger, output);
    invariant(Date.now() <= deadline, 'time_limit');
    invariant(
      db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version === 183,
      'expected_candidate_183',
    );
    invariant(retainedRows(db, tables, deadline) === retainedBefore, 'retained_content_changed');
    invariant(db.pragma('integrity_check', { simple: true }) === 'ok', 'after_integrity');
    invariant(db.pragma('foreign_key_check').length === 0, 'after_foreign_keys');
    const pods = db.prepare('SELECT COUNT(*) AS n FROM pods').get().n;
    invariant(
      db.prepare('SELECT COUNT(*) AS n FROM task_executions').get().n === pods,
      'task_backfill',
    );
    db.exec('BEGIN; CREATE TABLE isolated_upgrade_write_probe (id INTEGER); ROLLBACK;');
    invariant(
      !db.prepare("SELECT 1 FROM sqlite_master WHERE name='isolated_upgrade_write_probe'").get(),
      'rollback_probe',
    );
    db.close();
    db = undefined;
    const after = fs.lstatSync(snapshot);
    invariant(
      before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs,
      'snapshot_changed',
    );
    invariant(checksum(snapshot, deadline) === expectedSnapshotHash, 'snapshot_content_changed');
    invariant(migrationHash(migrationsDir) === expectedMigrationHash, 'migration_source_changed');
    result = {
      status: 'isolated_upgrade_verified',
      activeDatabaseOpened: false,
      beforeVersion: 152,
      afterVersion: 183,
      retainedTableCount: tables.length,
      retainedOriginalColumnsAndRows: true,
      comparison: 'count and SHA256 multiset per original table',
      integrityOk: true,
      foreignKeysOk: true,
      taskBackfillOk: true,
      rollbackWriteProbeOk: true,
      inputHashUnchanged: true,
      snapshotSha256: expectedSnapshotHash,
      migrationSha256: expectedMigrationHash,
    };
  } catch {
    // Never export raw SQL, rows, exception text, stack paths or credentials.
    result = { status: 'incomplete', activeDatabaseOpened: false };
  } finally {
    try {
      db?.close();
    } catch {
      result.status = 'incomplete';
    }
    if (directory) {
      try {
        fs.rmSync(directory, { recursive: true });
      } catch {
        result.status = 'incomplete';
      }
      result.isolatedDirectoryRemoved = !fs.existsSync(directory);
    }
  }
  return result;
}
