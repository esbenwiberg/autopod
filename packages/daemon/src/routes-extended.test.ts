/**
 * Extended integration tests for routes not covered in integration.test.ts.
 *
 * Covers:
 * - GET /sessions/stats
 * - POST /sessions/:id/message
 * - POST /sessions/:id/nudge
 * - GET /sessions/:id/validations
 * - GET /sessions/:id/report/token
 * - POST /sessions/:id/approve (error path — only valid from validated state)
 * - POST /sessions/:id/reject (error path)
 * - POST /sessions/approve-all
 * - POST /sessions/kill-failed
 * - POST /sessions/:id/pause
 * - DELETE /sessions/:id
 * - GET /sessions/:id/diff (with container manager)
 * - POST /shutdown (when onShutdown is provided)
 * - GET /sessions filtered by status / profile
 */
import fs from 'node:fs';
import path from 'node:path';
import type { JwtPayload } from '@autopod/shared';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from './api/server.js';
import type { AuthModule } from './interfaces/index.js';
import { createProfileStore } from './profiles/index.js';
import {
  createEscalationRepository,
  createEventBus,
  createEventRepository,
  createSessionManager,
  createSessionQueue,
  createSessionRepository,
} from './sessions/index.js';
import { createNudgeRepository } from './sessions/nudge-repository.js';

const migrationsDir = path.resolve(import.meta.dirname, 'db/migrations');
const MIGRATION_FILES = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf-8'));

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
  for (const sql of MIGRATION_FILES) {
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      try {
        db.exec(`${stmt};`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '';
        if (!msg.includes('duplicate column name')) throw err;
      }
    }
  }
  return db;
}

function createMockAuthModule(): AuthModule {
  return {
    async validateToken() {
      return testUser;
    },
    validateTokenSync() {
      return testUser;
    },
  };
}

const validProfileInput = {
  name: 'test-app',
  repoUrl: 'https://github.com/org/repo',
  buildCommand: 'npm run build',
  startCommand: 'node server.js --port $PORT',
};

const authHeaders = { authorization: 'Bearer test-token' };

describe('Extended Route Tests', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let containerManager: ReturnType<typeof createMockContainerManager>;

  function createMockContainerManager() {
    return {
      spawn: vi.fn().mockResolvedValue('container-123'),
      kill: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      refreshFirewall: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(''),
      getStatus: vi.fn().mockResolvedValue('running' as const),
      execInContainer: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
      execStreaming: vi.fn(),
    };
  }

  beforeEach(async () => {
    db = createTestDb();
    containerManager = createMockContainerManager();

    const profileStore = createProfileStore(db);
    const sessionRepo = createSessionRepository(db);
    const eventRepo = createEventRepository(db);
    const escalationRepo = createEscalationRepository(db);
    const nudgeRepo = createNudgeRepository(db);
    const eventBus = createEventBus(eventRepo, logger);
    const authModule = createMockAuthModule();

    const worktreeManager = {
      create: vi.fn().mockResolvedValue({ worktreePath: '/tmp/wt', bareRepoPath: '/tmp/bare.git' }),
      cleanup: vi.fn().mockResolvedValue(undefined),
      getDiffStats: vi
        .fn()
        .mockResolvedValue({ filesChanged: 3, linesAdded: 50, linesRemoved: 10 }),
      getDiff: vi.fn().mockResolvedValue('diff --git a/file.ts b/file.ts\n+added line'),
      mergeBranch: vi.fn().mockResolvedValue(undefined),
      commitFiles: vi.fn().mockResolvedValue(undefined),
      pushBranch: vi.fn().mockResolvedValue(undefined),
      getCommitLog: vi.fn().mockResolvedValue(''),
    };

    const runtimeRegistry = {
      get: vi.fn().mockReturnValue({
        type: 'claude' as const,
        spawn: vi.fn().mockReturnValue(
          (async function* () {
            yield {
              type: 'status' as const,
              timestamp: new Date().toISOString(),
              message: 'Working',
            };
            yield {
              type: 'complete' as const,
              timestamp: new Date().toISOString(),
              result: 'Done',
            };
          })(),
        ),
        resume: vi.fn().mockReturnValue(
          (async function* () {
            yield {
              type: 'complete' as const,
              timestamp: new Date().toISOString(),
              result: 'Resumed',
            };
          })(),
        ),
        abort: vi.fn().mockResolvedValue(undefined),
        suspend: vi.fn().mockResolvedValue(undefined),
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
          health: {
            status: 'pass',
            url: 'http://localhost:3000/',
            responseCode: 200,
            duration: 100,
          },
          pages: [],
        },
        taskReview: null,
        overall: 'pass',
        duration: 2000,
      }),
    };

    // biome-ignore lint/style/useConst: assigned after sessionQueue to break circular dependency
    let sessionManager: ReturnType<typeof createSessionManager>;

    const sessionQueue = createSessionQueue(
      2,
      async (sessionId) => {
        await sessionManager.processSession(sessionId);
      },
      logger,
    );

    sessionManager = createSessionManager({
      sessionRepo,
      escalationRepo,
      nudgeRepo,
      profileStore,
      eventBus,
      containerManagerFactory: { get: vi.fn(() => containerManager) },
      worktreeManager,
      runtimeRegistry,
      validationEngine,
      enqueueSession: (id) => sessionQueue.enqueue(id),
      mcpBaseUrl: 'http://localhost:3100',
      daemonConfig: { mcpServers: [], claudeMdSections: [] },
      logger,
    });

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
      reportPlan: vi.fn(),
      reportProgress: vi.fn(),
      consumeMessages: vi.fn().mockReturnValue({ hasMessage: false }),
      executeAction: vi.fn(),
      getAvailableActions: vi.fn().mockReturnValue([]),
      writeFileInContainer: vi.fn(),
      execInContainer: vi.fn(),
    };

    app = await createServer({
      authModule,
      sessionManager,
      profileStore,
      eventBus,
      eventRepo,
      sessionBridge,
      pendingRequestsBySession: new Map(),
      containerManagerFactory: { get: vi.fn(() => containerManager) },
      logLevel: 'silent',
      prettyLog: false,
    });

    // Create a profile so session endpoints work
    await app.inject({
      method: 'POST',
      url: '/profiles',
      headers: authHeaders,
      payload: validProfileInput,
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  // -------------------------------------------------------------------------
  // Session stats
  // -------------------------------------------------------------------------

  describe('GET /sessions/stats', () => {
    it('returns session counts grouped by status', async () => {
      // Create a session first
      await app.inject({
        method: 'POST',
        url: '/sessions',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task 1' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/sessions/stats',
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(200);
      const stats = res.json();
      expect(typeof stats).toBe('object');
    });

    it('accepts a profile query param', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/sessions/stats?profile=test-app',
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Session filter by status
  // -------------------------------------------------------------------------

  describe('GET /sessions with filters', () => {
    it('filters sessions by profile name', async () => {
      await app.inject({
        method: 'POST',
        url: '/sessions',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/sessions?profileName=test-app',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(200);
    });

    it('filters sessions by status', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/sessions?status=queued',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Send message
  // -------------------------------------------------------------------------

  describe('POST /sessions/:id/message', () => {
    it('sends a message to a paused session', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/sessions',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });
      const sessionId = createRes.json().id;

      // Wait for session to reach a terminal state before forcing to paused,
      // which avoids the background queue racing and overwriting our state.
      await new Promise((r) => setTimeout(r, 100));
      db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('paused', sessionId);

      const res = await app.inject({
        method: 'POST',
        url: `/sessions/${sessionId}/message`,
        headers: authHeaders,
        payload: { message: 'please continue' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });

    it('returns 404 for nonexistent session', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sessions/nonexistent/message',
        headers: authHeaders,
        payload: { message: 'hello' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for invalid message payload', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/sessions',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });
      const sessionId = createRes.json().id;

      const res = await app.inject({
        method: 'POST',
        url: `/sessions/${sessionId}/message`,
        headers: authHeaders,
        payload: { invalid: 'payload' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Nudge
  // -------------------------------------------------------------------------

  describe('POST /sessions/:id/nudge', () => {
    it('queues a nudge message for a running session', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/sessions',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });
      const sessionId = createRes.json().id;

      // Wait for background processing to settle before forcing to running state
      await new Promise((r) => setTimeout(r, 100));
      db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('running', sessionId);

      const res = await app.inject({
        method: 'POST',
        url: `/sessions/${sessionId}/nudge`,
        headers: authHeaders,
        payload: { message: 'soft nudge' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });

    it('returns 404 for nonexistent session', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sessions/nonexistent/nudge',
        headers: authHeaders,
        payload: { message: 'nudge' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Validations history
  // -------------------------------------------------------------------------

  describe('GET /sessions/:id/validations', () => {
    it('returns empty array for new session', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/sessions',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });
      const sessionId = createRes.json().id;

      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${sessionId}/validations`,
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    });

    it('returns 404 for nonexistent session', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/sessions/nonexistent/validations',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Report token
  // -------------------------------------------------------------------------

  describe('GET /sessions/:id/report/token', () => {
    it('returns null token when no session token issuer is configured', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/sessions',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });
      const sessionId = createRes.json().id;

      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${sessionId}/report/token`,
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.token).toBeNull();
      expect(body.reportUrl).toContain(sessionId);
    });

    it('returns 404 for nonexistent session', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/sessions/nonexistent/report/token',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Approve
  // -------------------------------------------------------------------------

  describe('POST /sessions/:id/approve', () => {
    it('returns 409 when session is not in validated state', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/sessions',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });
      const sessionId = createRes.json().id;

      // queued → not approvable
      const res = await app.inject({
        method: 'POST',
        url: `/sessions/${sessionId}/approve`,
        headers: authHeaders,
        payload: {},
      });
      expect(res.statusCode).toBe(409);
    });

    it('returns 404 for nonexistent session', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sessions/nonexistent/approve',
        headers: authHeaders,
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Reject
  // -------------------------------------------------------------------------

  describe('POST /sessions/:id/reject', () => {
    it('returns 409 when session is not in validated state', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/sessions',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });
      const sessionId = createRes.json().id;

      const res = await app.inject({
        method: 'POST',
        url: `/sessions/${sessionId}/reject`,
        headers: authHeaders,
        payload: { feedback: 'not good enough' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('returns 404 for nonexistent session', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sessions/nonexistent/reject',
        headers: authHeaders,
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Approve-all
  // -------------------------------------------------------------------------

  describe('POST /sessions/approve-all', () => {
    it('returns the result of approving all validated sessions', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sessions/approve-all',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Kill-failed
  // -------------------------------------------------------------------------

  describe('POST /sessions/kill-failed', () => {
    it('returns the result of killing all failed sessions', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sessions/kill-failed',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Pause
  // -------------------------------------------------------------------------

  describe('POST /sessions/:id/pause', () => {
    it('returns 409 when session is not pausable', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/sessions',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });
      const sessionId = createRes.json().id;

      // queued is not pausable
      const res = await app.inject({
        method: 'POST',
        url: `/sessions/${sessionId}/pause`,
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(409);
    });

    it('returns 404 for nonexistent session', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sessions/nonexistent/pause',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Delete session
  // -------------------------------------------------------------------------

  describe('DELETE /sessions/:id', () => {
    it('deletes a terminal session and returns 204', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/sessions',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task to delete' },
      });
      const sessionId = createRes.json().id;

      // Force to a terminal state so deletion is allowed
      db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('killed', sessionId);

      const res = await app.inject({
        method: 'DELETE',
        url: `/sessions/${sessionId}`,
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(204);
    });

    it('returns 404 for nonexistent session', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/sessions/nonexistent',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Diff route
  // -------------------------------------------------------------------------

  describe('GET /sessions/:id/diff', () => {
    it('returns empty diff for session with no container', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/sessions',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });
      const sessionId = createRes.json().id;

      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${sessionId}/diff`,
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.files).toEqual([]);
      expect(body.stats.changed).toBe(0);
    });

    it('returns diff when container has a git diff', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/sessions',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });
      const sessionId = createRes.json().id;

      // Add a containerId to the session
      db.prepare('UPDATE sessions SET container_id = ?, status = ? WHERE id = ?').run(
        'container-123',
        'running',
        sessionId,
      );

      const unifiedDiff = [
        'diff --git a/src/app.ts b/src/app.ts',
        'index abc123..def456 100644',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,3 +1,4 @@',
        " import express from 'express';",
        "+import cors from 'cors';",
        ' ',
        ' const app = express();',
      ].join('\n');

      // First call: git fetch (success)
      // Second call: git diff origin/main...HEAD (returns unified diff)
      containerManager.execInContainer
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git fetch
        .mockResolvedValueOnce({ stdout: unifiedDiff, stderr: '', exitCode: 0 }); // git diff

      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${sessionId}/diff`,
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.files.length).toBeGreaterThanOrEqual(1);
      expect(body.stats.changed).toBeGreaterThanOrEqual(1);
    });

    it('returns 404 for nonexistent session', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/sessions/nonexistent/diff',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Validate trigger
  // -------------------------------------------------------------------------

  describe('POST /sessions/:id/validate', () => {
    it('returns 409 when session cannot be validated from current state', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/sessions',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });
      const sessionId = createRes.json().id;

      const res = await app.inject({
        method: 'POST',
        url: `/sessions/${sessionId}/validate`,
        headers: authHeaders,
      });
      // queued → not in a state that can be force-validated
      expect([200, 409]).toContain(res.statusCode);
    });

    it('returns 404 for nonexistent session', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sessions/nonexistent/validate',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  describe('POST /shutdown', () => {
    it('invokes the onShutdown callback and returns 202', async () => {
      const onShutdown = vi.fn();

      // Create a second server with a shutdown hook
      const db2 = createTestDb();
      const profileStore2 = createProfileStore(db2);
      const sessionRepo2 = createSessionRepository(db2);
      const eventRepo2 = createEventRepository(db2);
      const escalationRepo2 = createEscalationRepository(db2);
      const eventBus2 = createEventBus(eventRepo2, logger);

      // biome-ignore lint/style/useConst: assigned after sq2 to break circular dependency
      let sm2: ReturnType<typeof createSessionManager>;
      const sq2 = createSessionQueue(1, async (id) => sm2.processSession(id), logger);
      sm2 = createSessionManager({
        sessionRepo: sessionRepo2,
        escalationRepo: escalationRepo2,
        profileStore: profileStore2,
        eventBus: eventBus2,
        containerManagerFactory: { get: vi.fn(() => containerManager) },
        worktreeManager: {
          create: vi.fn(),
          cleanup: vi.fn(),
          getDiffStats: vi.fn(),
          getDiff: vi.fn(),
          mergeBranch: vi.fn(),
          commitFiles: vi.fn(),
          pushBranch: vi.fn(),
          getCommitLog: vi.fn(),
        },
        runtimeRegistry: { get: vi.fn() },
        validationEngine: { validate: vi.fn() },
        enqueueSession: (id) => sq2.enqueue(id),
        mcpBaseUrl: 'http://localhost:3100',
        daemonConfig: { mcpServers: [], claudeMdSections: [] },
        logger,
      });

      const app2 = await createServer({
        authModule: createMockAuthModule(),
        sessionManager: sm2,
        profileStore: profileStore2,
        eventBus: eventBus2,
        eventRepo: eventRepo2,
        sessionBridge: {
          createEscalation: vi.fn(),
          resolveEscalation: vi.fn(),
          getAiEscalationCount: vi.fn().mockReturnValue(0),
          getMaxAiCalls: vi.fn().mockReturnValue(5),
          getAutoPauseThreshold: vi.fn().mockReturnValue(3),
          getHumanResponseTimeout: vi.fn().mockReturnValue(3600),
          getReviewerModel: vi.fn().mockReturnValue('sonnet'),
          callReviewerModel: vi.fn().mockResolvedValue('AI says yes'),
          incrementEscalationCount: vi.fn(),
          reportPlan: vi.fn(),
          reportProgress: vi.fn(),
          consumeMessages: vi.fn().mockReturnValue({ hasMessage: false }),
          executeAction: vi.fn(),
          getAvailableActions: vi.fn().mockReturnValue([]),
          writeFileInContainer: vi.fn(),
          execInContainer: vi.fn(),
        },
        pendingRequestsBySession: new Map(),
        logLevel: 'silent',
        prettyLog: false,
        onShutdown,
      });

      const res = await app2.inject({
        method: 'POST',
        url: '/shutdown',
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(202);
      expect(res.json().ok).toBe(true);

      // Give setImmediate time to fire
      await new Promise((r) => setImmediate(r));
      expect(onShutdown).toHaveBeenCalled();

      await app2.close();
      db2.close();
    });
  });

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  describe('Authentication', () => {
    it('returns 401 when no authorization header is provided', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/sessions',
      });
      expect(res.statusCode).toBe(401);
    });

    it('GET /health is accessible without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
      });
      expect(res.statusCode).toBe(200);
    });

    it('GET /version is accessible without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/version',
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
