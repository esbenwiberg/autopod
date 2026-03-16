import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { createDatabase } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { createServer } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
const IS_DEV = process.env.NODE_ENV !== 'production';
const PORT = Number.parseInt(process.env.PORT ?? '3100', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_PATH = process.env.DB_PATH ?? './autopod.db';

// Standalone logger for pre-server operations (db setup, migrations)
const logger = pino({
  level: LOG_LEVEL,
  transport: IS_DEV ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
});

// Database setup
const db = createDatabase(DB_PATH, logger);

// Run migrations
const migrationsDir =
  [
    path.join(__dirname, 'db', 'migrations'),
    path.join(__dirname, '..', 'src', 'db', 'migrations'),
  ].find((dir) => fs.existsSync(dir)) ?? path.join(__dirname, '..', 'src', 'db', 'migrations');

runMigrations(db, migrationsDir, logger);

// Start server
const app = createServer({ logLevel: LOG_LEVEL, prettyLog: IS_DEV });

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info({ port: PORT, host: HOST }, 'Autopod daemon started');
} catch (err) {
  app.log.fatal(err, 'Failed to start daemon');
  process.exit(1);
}
