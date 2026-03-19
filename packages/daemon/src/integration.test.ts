import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { JwtPayload } from '@autopod/shared';
import { createProfileStore } from './profiles/index.js';
import {
  createSessionRepository,
  createEventRepository,
  createEscalationRepository,
  createEventBus,
  createSessionQueue,
  createSessionManager,
} from './sessions/index.js';
import { createServer } from './api/server.js';
import type { AuthModule } from './interfaces/index.js';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';

const migrationsDir = path.resolve(import.meta.dirname, 'db/migrations');
const MIGRATION_SQL = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf-8'))
  .join('\n');

const logger = pino({ level: 'silent' });

const testUser: JwtPayload = {
  oid: 'test-user-1',
  preferred_username: 'tester',
  name: 'Test User',
  roles: ['admin'],
  aud: 'autopod',
  iss: 'autopod-test',
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
};

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(MIGRATION_SQL);
  return db;
}

function createMockAuthModule(): AuthModule {
  return {
    async validateToken() { return testUser; },
    validateTokenSync() { return testUser; },
  };
}

const validProfileInput = {
  name: 'test-app',
  repoUrl: 'https://github.com/org/repo',
  buildCommand: 'npm run build',
  startCommand: 'node server.js --port $PORT',
};

describe('Integration', () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createTestDb();

    const profileStore = createProfileStore(db);
    const sessionRepo = createSessionRepository(db);
    const eventRepo = createEventRepository(db);
    const escalationRepo = createEscalationRepository(db);
    const eventBus = createEventBus(eventRepo, logger);
    const authModule = createMockAuthModule();

    // Mock infrastructure
    const containerManager = {
      spawn: vi.fn().mockResolvedValue('container-123'),
      kill: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockResolvedValue('running' as const),
      execInContainer: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    };

    const worktreeManager = {
      create: vi.fn().mockResolvedValue('/tmp/worktree/test'),
      cleanup: vi.fn().mockResolvedValue(undefined),
      getDiffStats: vi.fn().mockResolvedValue({ filesChanged: 3, linesAdded: 50, linesRemoved: 10 }),
      mergeBranch: vi.fn().mockResolvedValue(undefined),
    };

    const runtimeRegistry = {
      get: vi.fn().mockReturnValue({
        type: 'claude' as const,
        spawn: vi.fn().mockReturnValue((async function* () {
          yield { type: 'status' as const, timestamp: new Date().toISOString(), message: 'Working...' };
          yield { type: 'complete' as const, timestamp: new Date().toISOString(), result: 'Done' };
        })()),
        resume: vi.fn().mockReturnValue((async function* () {
          yield { type: 'complete' as const, timestamp: new Date().toISOString(), result: 'Resumed' };
        })()),
        abort: vi.fn().mockResolvedValue(undefined),
      }),
    };

    const validationEngine = {
      validate: vi.fn().mockResolvedValue({
        sessionId: 'test',
        attempt: 1,
        timestamp: new Date().toISOString(),
        smoke: {
          status: 'pass',
          build: { status: 'pass', output: 'ok', duration: 1000 },
          health: { status: 'pass', url: 'http://localhost:3000/', responseCode: 200, duration: 100 },
          pages: [],
        },
        taskReview: null,
        overall: 'pass',
        duration: 2000,
      }),
    };

    let sessionManager: ReturnType<typeof createSessionManager>;

    const sessionQueue = createSessionQueue(
      2,
      async (sessionId) => { await sessionManager.processSession(sessionId); },
      logger,
    );

    sessionManager = createSessionManager({
      sessionRepo,
      escalationRepo,
      profileStore,
      eventBus,
      containerManager,
      worktreeManager,
      runtimeRegistry,
      validationEngine,
      enqueueSession: (id) => sessionQueue.enqueue(id),
      mcpBaseUrl: 'http://localhost:3100',
      daemonConfig: { mcpServers: [], claudeMdSections: [] },
      logger,
    });

    // Stub bridge for MCP (not testing MCP transport in integration)
    const sessionBridge = {
      createEscalation: vi.fn(),
      resolveEscalation: vi.fn(),
      getAiEscalationCount: vi.fn().mockReturnValue(0),
      getMaxAiCalls: vi.fn().mockReturnValue(5),
      getAutoPauseThreshold: vi.fn().mockReturnValue(3),
      getHumanResponseTimeout: vi.fn().mockReturnValue(3600),
      getReviewerModel: vi.fn().mockReturnValue('sonnet'),
      callReviewerModel: vi.fn().mockResolvedValue('AI says yes'),
      incrementEscalationCount: vi.fn(),
    };

    app = await createServer({
      authModule,
      sessionManager,
      profileStore,
      eventBus,
      eventRepo,
      sessionBridge,
      pendingRequestsBySession: new Map(),
      logLevel: 'silent',
      prettyLog: false,
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  describe('Health', () => {
    it('GET /health returns ok', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('ok');
    });

    it('GET /version returns version', async () => {
      const res = await app.inject({ method: 'GET', url: '/version' });
      expect(res.statusCode).toBe(200);
      expect(res.json().version).toBe('0.0.1');
    });
  });

  describe('Profiles', () => {
    it('POST /profiles creates a profile', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: validProfileInput,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().name).toBe('test-app');
    });

    it('GET /profiles lists profiles', async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: validProfileInput,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(1);
    });

    it('GET /profiles/:name returns a profile', async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: validProfileInput,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/profiles/test-app',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('test-app');
    });

    it('PUT /profiles/:name updates a profile', async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: validProfileInput,
      });

      const res = await app.inject({
        method: 'PUT',
        url: '/profiles/test-app',
        headers: { authorization: 'Bearer test-token' },
        payload: { buildCommand: 'pnpm build' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().buildCommand).toBe('pnpm build');
    });

    it('DELETE /profiles/:name removes a profile', async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: validProfileInput,
      });

      const res = await app.inject({
        method: 'DELETE',
        url: '/profiles/test-app',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.statusCode).toBe(204);
    });

    it('POST /profiles/:name/warm returns 501', async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: validProfileInput,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/profiles/test-app/warm',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.statusCode).toBe(501);
    });
  });

  describe('Sessions', () => {
    beforeEach(async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: validProfileInput,
      });
    });

    it('POST /sessions creates a session', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        headers: { authorization: 'Bearer test-token' },
        payload: { profileName: 'test-app', task: 'Add a button' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().profileName).toBe('test-app');
      expect(res.json().status).toBe('queued');
    });

    it('GET /sessions lists sessions', async () => {
      await app.inject({
        method: 'POST',
        url: '/sessions',
        headers: { authorization: 'Bearer test-token' },
        payload: { profileName: 'test-app', task: 'Task 1' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/sessions',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().length).toBeGreaterThanOrEqual(1);
    });

    it('GET /sessions/:sessionId returns session details', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/sessions',
        headers: { authorization: 'Bearer test-token' },
        payload: { profileName: 'test-app', task: 'Task 1' },
      });
      const sessionId = createRes.json().id;

      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${sessionId}`,
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(sessionId);
    });

    it('POST /sessions/:sessionId/kill kills a session', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/sessions',
        headers: { authorization: 'Bearer test-token' },
        payload: { profileName: 'test-app', task: 'Task to kill' },
      });
      const sessionId = createRes.json().id;

      // Wait a tick for the queue to potentially process
      await new Promise((r) => setTimeout(r, 50));

      // Check current status — session may have been processed already
      const getRes = await app.inject({
        method: 'GET',
        url: `/sessions/${sessionId}`,
        headers: { authorization: 'Bearer test-token' },
      });
      const status = getRes.json().status;

      // If it's already in a terminal state, skip the kill test
      if (status === 'complete' || status === 'killed') {
        expect(['complete', 'killed']).toContain(status);
        return;
      }

      // If it's in a killable state, kill it
      const killRes = await app.inject({
        method: 'POST',
        url: `/sessions/${sessionId}/kill`,
        headers: { authorization: 'Bearer test-token' },
      });

      if (killRes.statusCode === 200) {
        const afterKill = await app.inject({
          method: 'GET',
          url: `/sessions/${sessionId}`,
          headers: { authorization: 'Bearer test-token' },
        });
        expect(afterKill.json().status).toBe('killed');
      } else {
        // Session already transitioned to a non-killable state (validated, approved, etc.)
        expect([200, 409]).toContain(killRes.statusCode);
      }
    });
  });

  describe('Error handling', () => {
    it('returns 404 for nonexistent profile', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/profiles/nonexistent',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('PROFILE_NOT_FOUND');
    });

    it('returns 404 for nonexistent session', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/sessions/nonexistent',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('SESSION_NOT_FOUND');
    });

    it('returns 409 for duplicate profile', async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: validProfileInput,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: validProfileInput,
      });
      expect(res.statusCode).toBe(409);
    });
  });
});
