import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { healthRoutes } from './health.js';

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

  describe('GET /health (basic — no query param)', () => {
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

    it('does not include diagnostic fields', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      const body = res.json();
      expect(body).not.toHaveProperty('uptime_seconds');
      expect(body).not.toHaveProperty('docker');
      expect(body).not.toHaveProperty('database');
      expect(body).not.toHaveProperty('queue');
    });
  });

  describe('GET /health?detail=full', () => {
    let appWithDeps: ReturnType<typeof Fastify>;
    let db: Database.Database;

    beforeEach(async () => {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(2);

      const mockDocker = {
        ping: vi.fn().mockResolvedValue(undefined),
        listContainers: vi.fn().mockResolvedValue([{}, {}]), // 2 containers
      } as unknown as import('dockerode').default;

      const mockQueue = {
        pending: 1,
        processing: 2,
        enqueue: vi.fn(),
        drain: vi.fn(),
      };

      appWithDeps = Fastify();
      healthRoutes(appWithDeps, {
        docker: mockDocker,
        db,
        sessionQueue: mockQueue,
        maxConcurrency: 5,
      });
      await appWithDeps.ready();
    });

    afterEach(async () => {
      await appWithDeps.close();
      db.close();
    });

    it('returns 200 with all required fields', async () => {
      const res = await appWithDeps.inject({ method: 'GET', url: '/health?detail=full' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('ok');
      expect(body.version).toBe('0.0.1');
      expect(typeof body.uptime_seconds).toBe('number');
      expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
    });

    it('returns docker diagnostics', async () => {
      const res = await appWithDeps.inject({ method: 'GET', url: '/health?detail=full' });
      const body = res.json();
      expect(body.docker).toBeDefined();
      expect(body.docker.connected).toBe(true);
      expect(body.docker.containers_running).toBe(2);
    });

    it('returns database diagnostics', async () => {
      const res = await appWithDeps.inject({ method: 'GET', url: '/health?detail=full' });
      const body = res.json();
      expect(body.database).toBeDefined();
      expect(body.database.connected).toBe(true);
      expect(body.database.migrations_applied).toBe(2);
    });

    it('returns queue diagnostics', async () => {
      const res = await appWithDeps.inject({ method: 'GET', url: '/health?detail=full' });
      const body = res.json();
      expect(body.queue).toBeDefined();
      expect(body.queue.active_sessions).toBe(2);
      expect(body.queue.queued_sessions).toBe(1);
      expect(body.queue.max_concurrency).toBe(5);
    });

    it('returns docker.connected=false when docker ping fails', async () => {
      const failingDocker = {
        ping: vi.fn().mockRejectedValue(new Error('connection refused')),
        listContainers: vi.fn().mockResolvedValue([]),
      } as unknown as import('dockerode').default;

      const app2 = Fastify();
      healthRoutes(app2, { docker: failingDocker, db });
      await app2.ready();

      const res = await app2.inject({ method: 'GET', url: '/health?detail=full' });
      const body = res.json();
      expect(body.docker.connected).toBe(false);

      await app2.close();
    });

    it('returns sensible defaults when no deps are provided', async () => {
      const bare = Fastify();
      healthRoutes(bare);
      await bare.ready();

      const res = await bare.inject({ method: 'GET', url: '/health?detail=full' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.docker.connected).toBe(false);
      expect(body.database.connected).toBe(false);
      expect(body.queue.active_sessions).toBe(0);
      expect(body.queue.queued_sessions).toBe(0);
      expect(body.queue.max_concurrency).toBe(3);

      await bare.close();
    });
  });

  describe('GET /health with unknown detail value', () => {
    it('returns 400 for unknown detail param', async () => {
      const res = await app.inject({ method: 'GET', url: '/health?detail=banana' });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toMatch(/banana/);
    });

    it('returns 400 for detail=partial', async () => {
      const res = await app.inject({ method: 'GET', url: '/health?detail=partial' });
      expect(res.statusCode).toBe(400);
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
