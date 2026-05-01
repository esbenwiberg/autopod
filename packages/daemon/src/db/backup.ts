import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';

interface BackupManagerOptions {
  intervalMs?: number;
  retain?: number;
}

export function createDbBackupManager(
  db: Database.Database,
  dbPath: string,
  logger: Logger,
  opts: BackupManagerOptions = {},
) {
  const intervalMs = opts.intervalMs ?? 900_000;
  const retain = opts.retain ?? 4;
  const backupDir = path.join(path.dirname(path.resolve(dbPath)), 'backups');

  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;

  function prune() {
    try {
      const files = readdirSync(backupDir)
        .filter((f) => f.endsWith('.db'))
        .sort();
      const excess = files.length - retain;
      if (excess <= 0) return;
      for (const f of files.slice(0, excess)) {
        rmSync(path.join(backupDir, f));
        logger.debug({ file: f }, 'Pruned old DB backup');
      }
    } catch (err) {
      logger.error({ err }, 'Failed to prune DB backups');
    }
  }

  async function tick() {
    if (inFlight) {
      logger.warn('DB backup already in progress, skipping tick');
      return;
    }
    inFlight = true;
    const start = Date.now();
    const destPath = path.join(backupDir, `${Date.now()}.db`);
    try {
      await db.backup(destPath);
      logger.info({ backupPath: destPath, elapsedMs: Date.now() - start }, 'DB backup complete');
      prune();
    } catch (err) {
      logger.error({ err, destPath }, 'DB backup failed');
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      mkdirSync(backupDir, { recursive: true });
      tick().catch((err) => logger.error({ err }, 'Initial DB backup error'));
      timer = setInterval(() => {
        tick().catch((err) => logger.error({ err }, 'DB backup tick error'));
      }, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
