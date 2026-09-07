import { createHash } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

export interface BackupReceipt {
  version: 1;
  sourceIdentity: string;
  file: string;
  startedAt: string;
  completedAt: string;
  sha256: string;
  bytes: number;
  watermark: Record<string, { rows: number; latestUpdatedAt: string | null }>;
}
export function databaseIdentity(file: string): string {
  return createHash('sha256').update(realpathSync(file)).digest('hex');
}
export async function fileChecksum(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function databaseWatermark(db: Database.Database): BackupReceipt['watermark'] {
  const result: BackupReceipt['watermark'] = {};
  for (const table of [
    'pods',
    'provider_attempts',
    'validation_history',
    'escalation_requests',
    'schema_version',
  ]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      continue;
    const hasUpdatedAt = (db.pragma(`table_info(${table})`) as { name: string }[]).some(
      (column) => column.name === 'updated_at',
    );
    result[table] = db
      .prepare(
        `SELECT COUNT(*) AS rows, ${hasUpdatedAt ? 'MAX(updated_at)' : 'NULL'} AS latestUpdatedAt FROM ${table}`,
      )
      .get() as { rows: number; latestUpdatedAt: string | null };
  }
  return result;
}
export function assertBackupIntegrity(db: Database.Database): void {
  const integrity = db.pragma('integrity_check') as { integrity_check: string }[];
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
    throw new Error('Backup integrity check failed');
  if (db.prepare('PRAGMA foreign_key_check').iterate().next().done !== true)
    throw new Error('Backup foreign key check failed');
}
export function parseBackupReceipt(text: string): BackupReceipt {
  const value = JSON.parse(text) as BackupReceipt;
  if (
    value?.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(value.sourceIdentity) ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= 0 ||
    !value.watermark ||
    typeof value.watermark !== 'object' ||
    typeof value.file !== 'string' ||
    value.file.includes('/') ||
    value.file.includes('\\')
  )
    throw new Error('Invalid backup provenance receipt');
  return value;
}
/** Restore into a throwaway directory, never the daemon's live DB or queue.
 * Expected identity must come from the intended active DB, not from the receipt.
 */
export async function verifyBackupRestore(
  backupPath: string,
  options: {
    expectedSourceIdentity: string;
    maxAgeMs: number;
    now?: number;
  },
): Promise<{
  verifiedAt: string;
  sourceIdentity: string;
  watermark: BackupReceipt['watermark'];
  sha256: string;
}> {
  const receipt = parseBackupReceipt(await readFile(`${backupPath}.json`, 'utf8'));
  const now = options.now ?? Date.now();
  if (receipt.sourceIdentity !== options.expectedSourceIdentity)
    throw new Error('Backup does not belong to the intended active database');
  const age = now - Date.parse(receipt.completedAt);
  if (
    !Number.isFinite(options.maxAgeMs) ||
    options.maxAgeMs <= 0 ||
    age < 0 ||
    age > options.maxAgeMs
  )
    throw new Error('Backup freshness requirement failed');
  const dir = await mkdtemp(join(tmpdir(), 'autopod-isolated-restore-'));
  try {
    const restoredPath = join(dir, 'restored.db');
    await copyFile(backupPath, restoredPath);
    if ((await fileChecksum(restoredPath)) !== receipt.sha256)
      throw new Error('Backup checksum mismatch');
    const restored = new Database(restoredPath);
    try {
      assertBackupIntegrity(restored);
      const watermark = databaseWatermark(restored);
      if (JSON.stringify(watermark) !== JSON.stringify(receipt.watermark))
        throw new Error('Restored data does not match the recorded backup watermark');
      restored.exec('BEGIN; CREATE TABLE autopod_restore_write_probe (id INTEGER); ROLLBACK;');
      return {
        verifiedAt: new Date(now).toISOString(),
        sourceIdentity: receipt.sourceIdentity,
        watermark,
        sha256: receipt.sha256,
      };
    } finally {
      restored.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
