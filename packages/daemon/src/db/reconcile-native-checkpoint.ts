import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { assertBackupIntegrity, fileChecksum } from './backup-verification.js';
import { runMigrations } from './migrate.js';

interface Options {
  migrationsDir: string;
  legacyDir: string;
  logger: Logger;
  availableBytes?: () => number;
}
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const schema = (db: Database.Database) =>
  JSON.stringify(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all());
const versions = (db: Database.Database) =>
  (
    db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[]
  ).map((row) => row.version);

function expectedSchema(options: Options, version?: number): Database.Database {
  const db = new Database(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'autopod-lineage-schema-'));
  try {
    for (const name of readdirSync(options.migrationsDir))
      if (name.endsWith('.sql') && (version === undefined || Number.parseInt(name, 10) <= 150))
        copyFileSync(join(options.migrationsDir, name), join(dir, name));
    if (version !== undefined)
      for (const name of readdirSync(options.legacyDir))
        if (name.endsWith('.sql') && Number.parseInt(name, 10) <= version)
          copyFileSync(join(options.legacyDir, name), join(dir, name));
    runMigrations(db, dir, options.logger);
    return db;
  } catch (error) {
    db.close();
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Hash existing user columns without printing or retaining their values in a receipt. */
function retainedRows(
  db: Database.Database,
  columns?: Map<string, string[]>,
): {
  columns: Map<string, string[]>;
  hashes: Record<string, string>;
} {
  const selected =
    columns ??
    new Map(
      (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_version' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map(({ name }) => [
        name,
        (
          db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').all(name) as {
            name: string;
          }[]
        ).map((column) => column.name),
      ]),
    );
  const hashes: Record<string, string> = {};
  for (const [table, names] of selected) {
    const hash = createHash('sha256');
    // The accepted schema consists of ordinary rowid tables. New columns are
    // intentionally excluded when checking retained data after later migrations.
    for (const row of db
      .prepare(`SELECT ${names.map(quote).join(',')} FROM ${quote(table)} ORDER BY rowid`)
      .raw()
      .safeIntegers()
      .iterate() as Iterable<unknown[]>) {
      hash.update('row:');
      for (const value of row) {
        if (Buffer.isBuffer(value)) {
          hash.update(`blob:${value.length}:`);
          hash.update(value);
        } else {
          const encoded = value === null ? 'null' : `${typeof value}:${String(value)}`;
          hash.update(`${Buffer.byteLength(encoded)}:`);
          hash.update(encoded);
        }
      }
    }
    hashes[table] = hash.digest('hex');
  }
  return { columns: selected, hashes };
}

/** Converts only a named, stable checkpoint snapshot into a new file. Never activates it. */
export async function reconcileNativeCheckpoint(input: string, output: string, options: Options) {
  if (existsSync(output)) throw new Error('Output already exists; choose a new file');
  if (resolve(input) === resolve(output))
    throw new Error('Input and output must be different files');
  if (!lstatSync(input).isFile() || lstatSync(input).isSymbolicLink())
    throw new Error('Input must be a regular checkpoint snapshot');
  if (['-wal', '-shm', '-journal'].some((suffix) => existsSync(`${input}${suffix}`)))
    throw new Error('Use a completed checkpoint snapshot without WAL sidecars');
  const source = new Database(input, { readonly: true, fileMustExist: true });
  let owned: { dev: number; ino: number } | undefined;
  let converted: Database.Database | undefined;
  let stageDir: string | undefined;
  try {
    assertBackupIntegrity(source);
    const priorVersions = versions(source);
    const fromVersion = priorVersions.at(-1);
    if (fromVersion === undefined || fromVersion < 151 || fromVersion > 163)
      throw new Error('Unsupported native checkpoint schema version');
    const expected = expectedSchema(options, fromVersion);
    try {
      if (
        schema(source) !== schema(expected) ||
        JSON.stringify(priorVersions) !== JSON.stringify(versions(expected))
      )
        throw new Error('Checkpoint schema does not match the retained native lineage');
    } finally {
      expected.close();
    }
    const disk = statfsSync(dirname(resolve(output)));
    const available = options.availableBytes?.() ?? disk.bavail * disk.bsize;
    const required =
      Number(source.pragma('page_count', { simple: true })) *
        Number(source.pragma('page_size', { simple: true })) *
        2 +
      128 * 1024 * 1024;
    if (!Number.isFinite(available) || available < required)
      throw new Error('Insufficient reconciliation disk headroom');
    const inputSha256 = await fileChecksum(input);
    const before = retainedRows(source);
    stageDir = mkdtempSync(join(dirname(resolve(output)), '.autopod-reconcile-'));
    owned = lstatSync(stageDir);
    const staged = join(stageDir, 'verified.db');
    await source.backup(staged);
    chmodSync(staged, 0o600);
    converted = new Database(staged, { fileMustExist: true });
    converted.pragma('journal_mode = DELETE');
    converted.pragma('foreign_keys = ON');
    assertBackupIntegrity(converted);
    if (
      JSON.stringify(retainedRows(converted, before.columns).hashes) !==
      JSON.stringify(before.hashes)
    )
      throw new Error('Snapshot rows changed during copy');
    const target = converted;
    target
      .transaction(() => {
        target
          .prepare(
            'UPDATE schema_version SET version = version + 13 WHERE version BETWEEN 151 AND 163',
          )
          .run();
        for (const name of ['151_managed_provider_requests.sql', '152_managed_request_usage.sql']) {
          target.exec(readFileSync(join(options.migrationsDir, name), 'utf8'));
          target
            .prepare('INSERT INTO schema_version(version) VALUES (?)')
            .run(Number.parseInt(name, 10));
        }
      })
      .immediate();
    runMigrations(target, options.migrationsDir, options.logger);
    assertBackupIntegrity(target);
    const expectedCurrent = expectedSchema(options);
    try {
      if (
        schema(target) !== schema(expectedCurrent) ||
        JSON.stringify(versions(target)) !== JSON.stringify(versions(expectedCurrent))
      )
        throw new Error('Reconciled schema does not match the current lineage');
    } finally {
      expectedCurrent.close();
    }
    if (
      JSON.stringify(retainedRows(target, before.columns).hashes) !== JSON.stringify(before.hashes)
    )
      throw new Error('Retained rows changed during reconciliation');
    const toVersion = versions(target).at(-1);
    target.close();
    converted = undefined;
    const observed = lstatSync(stageDir);
    if (!observed.isDirectory() || observed.dev !== owned.dev || observed.ino !== owned.ino)
      throw new Error('Staging ownership changed');
    if ((await fileChecksum(input)) !== inputSha256)
      throw new Error('Input snapshot changed during reconciliation');
    const outputSha256 = await fileChecksum(staged);
    // Same-filesystem hard link publishes without replacing any existing target,
    // including a target created while verification was in progress.
    if (['-wal', '-shm', '-journal'].some((suffix) => existsSync(`${output}${suffix}`)))
      throw new Error('Output has database sidecars; choose a new file');
    linkSync(staged, output);
    return {
      fromVersion,
      toVersion,
      inputSha256,
      outputSha256,
      retainedRowsVerified: true as const,
      inputFreshness: 'unverified' as const,
      activated: false as const,
      verifiedAt: new Date().toISOString(),
    };
  } finally {
    if (converted?.open) converted.close();
    source.close();
    if (stageDir && owned && existsSync(stageDir)) {
      const observed = lstatSync(stageDir);
      if (observed.isDirectory() && observed.dev === owned.dev && observed.ino === owned.ino)
        rmSync(stageDir, { recursive: true, force: true });
    }
  }
}
