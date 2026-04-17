import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type Dockerode from 'dockerode';
import type { FastifyInstance } from 'fastify';
import type { PodQueue } from '../../pods/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from package.json at module load time.
// Tries multiple paths because tsup bundles into dist/index.js (1 dir up)
// while source runs from src/api/routes/ (3 dirs up).
function readVersion(): string {
  const candidates = [
    resolve(__dirname, '../package.json'), // bundled: dist/ -> daemon/
    resolve(__dirname, '../../../package.json'), // source: src/api/routes/ -> daemon/
  ];
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === '@autopod/daemon' && pkg.version) {
        return pkg.version;
      }
    } catch {
      // try next candidate
    }
  }
  return '0.0.0';
}

const VERSION = readVersion();

export interface HealthDeps {
  onShutdown?: () => void;
  docker?: Dockerode;
  db?: Database.Database;
  podQueue?: PodQueue;
  maxConcurrency?: number;
}

export function healthRoutes(app: FastifyInstance, deps: HealthDeps = {}): void {
  const { onShutdown, docker, db, podQueue, maxConcurrency } = deps;

  app.get('/health', { config: { auth: false } }, async (request, reply) => {
    const { detail } = request.query as { detail?: string };

    if (detail !== undefined && detail !== 'full') {
      return reply.status(400).send({
        error: `Unknown detail value: "${detail}". Supported values: "full"`,
      });
    }

    const start = performance.now();
    const response = {
      status: 'ok',
      version: VERSION,
      timestamp: new Date().toISOString(),
      requestDurationMs: 0,
    };
    response.requestDurationMs = Math.round((performance.now() - start) * 100) / 100;

    if (detail !== 'full') {
      return response;
    }

    // Full diagnostics
    let dockerConnected = false;
    let containersRunning = 0;
    if (docker) {
      try {
        await docker.ping();
        dockerConnected = true;
        const containers = await docker.listContainers();
        containersRunning = containers.length;
      } catch {
        dockerConnected = false;
      }
    }

    let dbConnected = false;
    let migrationsApplied = 0;
    if (db) {
      try {
        db.prepare('SELECT 1').get();
        dbConnected = true;
        const row = db.prepare('SELECT COUNT(*) as count FROM schema_version').get() as {
          count: number;
        };
        migrationsApplied = row.count;
      } catch {
        dbConnected = false;
      }
    }

    const activeSessions = podQueue?.processing ?? 0;
    const queuedSessions = podQueue?.pending ?? 0;

    return {
      status: 'ok',
      version: VERSION,
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
        max_concurrency: maxConcurrency ?? 3,
      },
    };
  });

  app.get('/version', { config: { auth: false } }, async () => {
    return { version: VERSION };
  });

  if (onShutdown) {
    app.post('/shutdown', async (_request, reply) => {
      reply.status(202).send({ ok: true, message: 'Shutting down...' });
      // Defer so the response is sent before shutdown begins
      setImmediate(onShutdown);
    });
  }
}
