import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { registerRetainedPathFunctions } from './retained-path-functions.js';

export function createDatabase(
  dbPath: string,
  logger: Logger,
  options: { fileMustExist?: boolean } = {},
): Database.Database {
  const db = new Database(dbPath, options);
  registerRetainedPathFunctions(db);

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  logger.info({ dbPath }, 'Database connection established');
  return db;
}
