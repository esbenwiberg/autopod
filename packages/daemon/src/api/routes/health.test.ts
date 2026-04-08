import path from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../db/migrate.js';
import { healthRoutes } from './health.js';

const migrationsDir = path.resolve(import.meta.dirname, '../../db/migrations');
const silentLogger = pino({ level: 'silent' });

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir, silentLogger);
  return db;
}

describe('healthRoutes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify();
    healthRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /health', () => {
    it('returns status ok', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('ok');
    });

    it('returns version', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.json().version).toBe('0.0.1');
    });

    it('returns timestamp as ISO string', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      const body = res.json();
      expect(body.timestamp).toBeDefined();
      expect(() => new Date(body.timestamp)).not.toThrow();
    });

    it('returns requestDurationMs as a number', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      const body = res.json();
      expect(body).toHaveProperty('requestDurationMs');
      expect(typeof body.requestDurationMs).toBe('number');
      expect(body.requestDurationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('GET /version', () => {
    it('returns version', async () => {
      const res = await app.inject({ method: 'GET', url: '/version' });
      expect(res.statusCode).toBe(200);
      expect(res.json().version).toBe('0.0.1');
    });
  });
});

describe('healthRoutes — detail param', () => {
  let app: ReturnType<typeof Fastify>;
  let db: Database.Database;

  const mockDocker = {
    ping: vi.fn().mockResolvedValue(undefined),
    listContainers: vi
      .fn()
      .mockResolvedValue([{ State: 'running' }, { State: 'running' }, { State: 'exited' }]),
  };

  beforeEach(async () => {
    db = createTestDb();
    app = Fastify();
    healthRoutes(app, undefined, { db, docker: mockDocker, maxConcurrency: 5 });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    vi.clearAllMocks();
  });

  describe('GET /health?detail=full', () => {
    it('returns 200 with all required fields', async () => {
      const res = await app.inject({ method: 'GET', url: '/health?detail=full' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('status', 'ok');
      expect(body).toHaveProperty('version');
      expect(body).toHaveProperty('uptime_seconds');
      expect(body).toHaveProperty('docker');
      expect(body).toHaveProperty('database');
      expect(body).toHaveProperty('queue');
    });

    it('version comes from package.json (not hardcoded undefined)', async () => {
      const res = await app.inject({ method: 'GET', url: '/health?detail=full' });
      const { version } = res.json() as { version: string };
      expect(typeof version).toBe('string');
      expect(version.length).toBeGreaterThan(0);
    });

    it('uptime_seconds is a non-negative integer', async () => {
      const res = await app.inject({ method: 'GET', url: '/health?detail=full' });
      const { uptime_seconds } = res.json() as { uptime_seconds: number };
      expect(typeof uptime_seconds).toBe('number');
      expect(uptime_seconds).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(uptime_seconds)).toBe(true);
    });

    it('docker.connected reflects actual ping result', async () => {
      const res = await app.inject({ method: 'GET', url: '/health?detail=full' });
      expect(res.json().docker.connected).toBe(true);
      expect(mockDocker.ping).toHaveBeenCalled();
    });

    it('docker.connected is false when ping throws', async () => {
      mockDocker.ping.mockRejectedValueOnce(new Error('Docker not available'));
      const res = await app.inject({ method: 'GET', url: '/health?detail=full' });
      expect(res.json().docker.connected).toBe(false);
    });

    it('docker.containers_running counts running containers', async () => {
      const res = await app.inject({ method: 'GET', url: '/health?detail=full' });
      // mockDocker returns 2 running + 1 exited
      expect(res.json().docker.containers_running).toBe(2);
    });

    it('database.connected is true for a healthy db', async () => {
      const res = await app.inject({ method: 'GET', url: '/health?detail=full' });
      expect(res.json().database.connected).toBe(true);
    });

    it('database.migrations_applied returns the count of applied migrations', async () => {
      const res = await app.inject({ method: 'GET', url: '/health?detail=full' });
      const { migrations_applied } = res.json().database as { migrations_applied: number };
      expect(typeof migrations_applied).toBe('number');
      expect(migrations_applied).toBeGreaterThan(0);
    });

    it('queue.active_sessions and queued_sessions reflect session counts', async () => {
      // Insert a profile required by the foreign key constraint
      db.prepare(
        `INSERT INTO profiles (name, repo_url, build_command, start_command)
         VALUES (?, ?, ?, ?)`,
      ).run('p', 'https://github.com/org/repo', 'npm build', 'node server.js');

      // Insert a queued and a running session
      db.prepare(
        `INSERT INTO sessions (id, profile_name, task, status, model, runtime, execution_target,
         branch, user_id, max_validation_attempts, skip_validation, output_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('s1', 'p', 'task', 'running', 'claude', 'claude', 'local', 'b1', 'u1', 3, 0, 'pr');
      db.prepare(
        `INSERT INTO sessions (id, profile_name, task, status, model, runtime, execution_target,
         branch, user_id, max_validation_attempts, skip_validation, output_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('s2', 'p', 'task', 'queued', 'claude', 'claude', 'local', 'b2', 'u1', 3, 0, 'pr');

      const res = await app.inject({ method: 'GET', url: '/health?detail=full' });
      const { queue } = res.json() as {
        queue: { active_sessions: number; queued_sessions: number; max_concurrency: number };
      };
      expect(queue.active_sessions).toBe(1);
      expect(queue.queued_sessions).toBe(1);
      expect(queue.max_concurrency).toBe(5);
    });

    it('queue.max_concurrency reflects the injected value', async () => {
      const res = await app.inject({ method: 'GET', url: '/health?detail=full' });
      expect(res.json().queue.max_concurrency).toBe(5);
    });
  });

  describe('GET /health — unknown detail value', () => {
    it('returns 400 for unknown detail value', async () => {
      const res = await app.inject({ method: 'GET', url: '/health?detail=banana' });
      expect(res.statusCode).toBe(400);
    });

    it('returns a clear error message for unknown detail value', async () => {
      const res = await app.inject({ method: 'GET', url: '/health?detail=banana' });
      const body = res.json() as { message: string };
      expect(body.message).toContain('banana');
      expect(body.message.toLowerCase()).toContain('unknown');
    });
  });

  describe('GET /health — no detail param (backwards compat)', () => {
    it('still returns status ok without detail param', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('ok');
    });

    it('does not include docker/database/queue fields without detail param', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      const body = res.json();
      expect(body).not.toHaveProperty('docker');
      expect(body).not.toHaveProperty('database');
      expect(body).not.toHaveProperty('queue');
    });
  });
});
