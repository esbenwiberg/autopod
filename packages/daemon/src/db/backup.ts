import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import {
  type BackupReceipt,
  assertBackupIntegrity,
  databaseIdentity,
  databaseWatermark,
  fileChecksum,
  parseBackupReceipt,
} from './backup-verification.js';

interface BackupManagerOptions {
  intervalMs?: number;
  retain?: number;
  now?: () => number;
  availableBytes?: () => number;
  reserveBytes?: number;
}
export function createDbBackupManager(
  db: Database.Database,
  dbPath: string,
  logger: Logger,
  opts: BackupManagerOptions = {},
) {
  const intervalMs = opts.intervalMs ?? 900_000;
  const retain = opts.retain ?? 4;
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs <= 0 ||
    !Number.isSafeInteger(retain) ||
    retain < 1
  )
    throw new Error('Invalid backup interval or retention');
  const sourceIdentity = databaseIdentity(db.name);
  let requestedIdentity: string | null = null;
  try {
    requestedIdentity = databaseIdentity(dbPath);
  } catch {
    /* actionable error below */
  }
  if (sourceIdentity !== requestedIdentity)
    throw new Error('Backup path does not identify the active database');
  const backupDir = path.join(path.dirname(path.resolve(dbPath)), 'backups');
  mkdirSync(backupDir, { recursive: true });
  const prefix = `autopod-${sourceIdentity.slice(0, 16)}-`;
  const now = opts.now ?? Date.now;
  const availableBytes =
    opts.availableBytes ??
    (() => {
      const disk = statfsSync(backupDir);
      return disk.bavail * disk.bsize;
    });
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;
  let failure: string | null = null;
  function receipts(): BackupReceipt[] {
    return readdirSync(backupDir)
      .filter((file) => file.startsWith(prefix) && file.endsWith('.db.json'))
      .flatMap((file) => {
        try {
          const receipt = parseBackupReceipt(readFileSync(path.join(backupDir, file), 'utf8'));
          return receipt.sourceIdentity === sourceIdentity &&
            receipt.file.startsWith(prefix) &&
            file === `${receipt.file}.json` &&
            statSync(path.join(backupDir, receipt.file)).size === receipt.bytes
            ? [receipt]
            : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.file.localeCompare(b.file));
  }
  function headroom() {
    // Online backups must leave room for both a snapshot and continued WAL growth.
    return {
      availableBytes: availableBytes(),
      requiredBytes:
        Math.max(
          statSync(dbPath).size,
          Number(db.pragma('page_count', { simple: true })) *
            Number(db.pragma('page_size', { simple: true })),
        ) *
          2 +
        (opts.reserveBytes ?? 128 * 1024 * 1024),
    };
  }
  function getStatus() {
    const latest = receipts().at(-1) ?? null;
    const disk = headroom();
    const ageMs = latest ? now() - Date.parse(latest.completedAt) : null;
    const state =
      disk.availableBytes < disk.requiredBytes
        ? 'low_headroom'
        : failure
          ? 'failed'
          : !latest
            ? 'missing'
            : ageMs === null || ageMs < 0 || ageMs > intervalMs * 2
              ? 'stale'
              : 'fresh';
    return {
      state,
      sourceIdentity,
      sourceMatches: true,
      latest,
      ageMs,
      ...disk,
      failure,
      inFlight,
    };
  }
  async function runOnce() {
    if (inFlight) return;
    inFlight = true;
    const started = now();
    const file = `${prefix}${started}-${randomUUID()}.db`;
    const finalPath = path.join(backupDir, file);
    const pendingPath = `${finalPath}.pending`;
    try {
      const disk = headroom();
      if (disk.availableBytes < disk.requiredBytes)
        throw new Error('Insufficient backup disk headroom');
      await db.backup(pendingPath);
      chmodSync(pendingPath, 0o600);
      const snapshot = new Database(pendingPath, { readonly: true, fileMustExist: true });
      let watermark: BackupReceipt['watermark'];
      try {
        assertBackupIntegrity(snapshot);
        watermark = databaseWatermark(snapshot);
      } finally {
        snapshot.close();
      }
      const receipt: BackupReceipt = {
        version: 1,
        sourceIdentity,
        file,
        startedAt: new Date(started).toISOString(),
        completedAt: new Date(now()).toISOString(),
        sha256: await fileChecksum(pendingPath),
        bytes: statSync(pendingPath).size,
        watermark,
      };
      renameSync(pendingPath, finalPath);
      writeFileSync(`${finalPath}.json.pending`, JSON.stringify(receipt), { mode: 0o600 });
      renameSync(`${finalPath}.json.pending`, `${finalPath}.json`);
      failure = null;
      // Only finalized, verified snapshots of this exact source are eligible.
      for (const old of receipts().slice(0, -retain)) {
        rmSync(path.join(backupDir, old.file));
        rmSync(path.join(backupDir, `${old.file}.json`));
      }
      logger.info({ sourceIdentity, elapsedMs: now() - started }, 'Active DB backup verified');
    } catch (err) {
      failure = err instanceof Error ? err.message : 'Backup failed';
      logger.error({ err, sourceIdentity }, 'DB backup failed');
    } finally {
      rmSync(pendingPath, { force: true });
      inFlight = false;
    }
  }
  return {
    runOnce,
    getStatus,
    start() {
      if (timer) return;
      void runOnce();
      timer = setInterval(() => {
        void runOnce();
      }, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
export type DbBackupManager = ReturnType<typeof createDbBackupManager>;
