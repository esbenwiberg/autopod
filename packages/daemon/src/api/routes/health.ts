import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

interface DockerHealthClient {
  ping(): Promise<unknown>;
  listContainers(opts?: { all?: boolean }): Promise<Array<{ State: string }>>;
}

export interface HealthDeps {
  db?: Database.Database;
  docker?: DockerHealthClient;
  maxConcurrency?: number;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.join(__dirname, '..', '..', '..', 'package.json');

let _version: string | undefined;
function readVersion(): string {
  if (_version !== undefined) return _version;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    _version = pkg.version ?? '0.0.1';
  } catch {
    _version = '0.0.1';
  }
  return _version;
}

export function healthRoutes(
  app: FastifyInstance,
  onShutdown?: () => void,
  healthDeps?: HealthDeps,
): void {
  app.get('/health', { config: { auth: false } }, async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const detail = query.detail;

    if (detail !== undefined && detail !== 'full') {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: `Unknown detail value: "${detail}". Allowed values: "full"`,
      });
    }

    const start = performance.now();

    if (detail === 'full') {
      const { db, docker, maxConcurrency = 3 } = healthDeps ?? {};

      // Docker diagnostics
      let dockerConnected = false;
      let containersRunning = 0;
      if (docker) {
        try {
          await docker.ping();
          dockerConnected = true;
          const containers = await docker.listContainers({ all: false });
          containersRunning = containers.filter((c) => c.State === 'running').length;
        } catch {
          dockerConnected = false;
        }
      }

      // Database diagnostics
      let dbConnected = false;
      let migrationsApplied = 0;
      if (db) {
        try {
          db.prepare('SELECT 1').get();
          dbConnected = true;
          const row = db.prepare('SELECT COUNT(*) as count FROM schema_version').get() as
            | { count: number }
            | undefined;
          migrationsApplied = row?.count ?? 0;
        } catch {
          dbConnected = false;
        }
      }

      // Queue diagnostics
      let activeSessions = 0;
      let queuedSessions = 0;
      if (db) {
        try {
          const activeRow = db
            .prepare("SELECT COUNT(*) as count FROM sessions WHERE status = 'running'")
            .get() as { count: number } | undefined;
          activeSessions = activeRow?.count ?? 0;

          const queuedRow = db
            .prepare("SELECT COUNT(*) as count FROM sessions WHERE status = 'queued'")
            .get() as { count: number } | undefined;
          queuedSessions = queuedRow?.count ?? 0;
        } catch {
          // leave counts as 0
        }
      }

      return reply.send({
        status: 'ok',
        version: readVersion(),
        uptime_seconds: Math.floor(process.uptime()),
        docker: {
          connected: dockerConnected,
          containers_running: containersRunning,
        },
        database: {
          connected: dbConnected,
          migrations_applied: migrationsApplied,
        },
        queue: {
          active_sessions: activeSessions,
          queued_sessions: queuedSessions,
          max_concurrency: maxConcurrency,
        },
      });
    }

    const response = {
      status: 'ok',
      version: '0.0.1',
      timestamp: new Date().toISOString(),
      requestDurationMs: 0,
    };
    response.requestDurationMs = Math.round((performance.now() - start) * 100) / 100;
    return response;
  });

  app.get('/version', { config: { auth: false } }, async () => {
    return { version: '0.0.1' };
  });

  if (onShutdown) {
    app.post('/shutdown', async (_request, reply) => {
      reply.status(202).send({ ok: true, message: 'Shutting down...' });
      // Defer so the response is sent before shutdown begins
      setImmediate(onShutdown);
    });
  }
}
