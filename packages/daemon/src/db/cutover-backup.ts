import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import {
  type BackupReceipt,
  assertBackupIntegrity,
  databaseIdentity,
  databaseWatermark,
  fileChecksum,
} from './backup-verification.js';

export function assertActiveDatabasePath(db: Database.Database, dbPath: string): void {
  if (db.memory) {
    if (dbPath !== ':memory:') throw new Error('Backup path does not identify the active database');
    return;
  }
  if (databaseIdentity(db.name) !== databaseIdentity(dbPath))
    throw new Error('Backup path does not identify the active database');
}

function backupsDirectory(dbPath: string): string {
  let candidate = path.dirname(path.resolve(dbPath));
  for (let i = 0; i < 5; i++) {
    const dir = path.join(candidate, 'backups');
    if (fs.existsSync(dir)) return dir;
    const parent = path.dirname(candidate);
    if (candidate === parent) break;
    candidate = parent;
  }
  const dir = path.join(path.dirname(path.resolve(dbPath)), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function syncFile(file: string): void {
  const fd = fs.openSync(file, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Online backup preserves WAL contents and implicit rowids. No prior backup is replaced or pruned. */
export async function snapshotBeforeCutover(
  db: Database.Database,
  dbPath: string,
  logger: Logger,
  suffix: string,
): Promise<void> {
  assertActiveDatabasePath(db, dbPath);
  if (db.memory) return;
  if (db.inTransaction) throw new Error('Cutover backup requires a database outside a transaction');
  const sourceIdentity = databaseIdentity(db.name);
  const sourceFile = fs.statSync(dbPath);
  const dir = backupsDirectory(dbPath);
  const disk = fs.statfsSync(dir);
  const logicalBytes =
    Number(db.pragma('page_count', { simple: true })) *
    Number(db.pragma('page_size', { simple: true }));
  const requiredBytes = Math.max(fs.statSync(dbPath).size, logicalBytes) * 2 + 128 * 1024 * 1024;
  if (disk.bavail * disk.bsize < requiredBytes)
    throw new Error('Insufficient cutover backup disk headroom');
  const started = new Date().toISOString();
  const file = `${started.replace(/[:.]/g, '-')}-${randomUUID()}-${suffix}.db`;
  const staging = fs.mkdtempSync(path.join(dir, '.cutover-'));
  fs.chmodSync(staging, 0o700);
  const pending = path.join(staging, 'snapshot.db');
  const deadline = performance.now() + 120_000;
  try {
    await db.backup(pending, {
      progress: () => {
        if (performance.now() >= deadline) throw new Error('Cutover backup deadline exceeded');
        return 1000;
      },
    });
    if (performance.now() >= deadline) throw new Error('Cutover backup deadline exceeded');
    fs.chmodSync(pending, 0o600);
    const snapshot = new Database(pending, { readonly: true, fileMustExist: true });
    let watermark: BackupReceipt['watermark'];
    try {
      assertBackupIntegrity(snapshot);
      watermark = databaseWatermark(snapshot);
    } finally {
      snapshot.close();
    }
    const sha256 = await fileChecksum(pending);
    const currentFile = fs.statSync(dbPath);
    if (
      currentFile.dev !== sourceFile.dev ||
      currentFile.ino !== sourceFile.ino ||
      databaseIdentity(db.name) !== sourceIdentity
    )
      throw new Error('Active database file identity changed during cutover backup');
    const receipt: BackupReceipt = {
      version: 2,
      sourceIdentity,
      file,
      startedAt: started,
      completedAt: new Date().toISOString(),
      sha256,
      bytes: fs.statSync(pending).size,
      watermark,
    };
    const pendingReceipt = path.join(staging, 'receipt.json');
    fs.writeFileSync(pendingReceipt, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
    syncFile(pending);
    syncFile(pendingReceipt);
    // Hard-link publication refuses an existing destination. A crash between links
    // can leave a DB without its receipt; that is not a verified backup receipt.
    fs.linkSync(pending, path.join(dir, file));
    fs.linkSync(pendingReceipt, path.join(dir, `${file}.json`));
    syncFile(dir);
    logger.info(
      { file, sourceIdentity: receipt.sourceIdentity, suffix },
      'Cutover DB backup verified',
    );
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
