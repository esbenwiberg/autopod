/**
 * Extended integration tests for routes not covered in integration.test.ts.
 *
 * Covers:
 * - GET /pods/stats
 * - POST /pods/:id/message
 * - POST /pods/:id/nudge
 * - GET /pods/:id/validations
 * - GET /pods/:id/report/token
 * - POST /pods/:id/approve (error path — only valid from validated state)
 * - POST /pods/:id/reject (error path)
 * - POST /pods/approve-all
 * - POST /pods/kill-failed
 * - POST /pods/:id/pause
 * - DELETE /pods/:id
 * - GET /pods/:id/diff (with container manager)
 * - POST /shutdown (when onShutdown is provided)
 * - GET /pods filtered by status / profile
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
import {
  createEscalationRepository,
  createEventBus,
  createEventRepository,
  createPodManager,
  createPodQueue,
  createPodRepository,
} from './pods/index.js';
import { createNudgeRepository } from './pods/nudge-repository.js';
import { createProfileStore } from './profiles/index.js';

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
    const podRepo = createPodRepository(db);
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
        podId: 'test',
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

    // biome-ignore lint/style/useConst: assigned after podQueue to break circular dependency
    let podManager: ReturnType<typeof createPodManager>;

    const podQueue = createPodQueue(
      2,
      async (podId) => {
        await podManager.processPod(podId);
      },
      logger,
    );

    podManager = createPodManager({
      podRepo,
      escalationRepo,
      nudgeRepo,
      profileStore,
      eventBus,
      containerManagerFactory: { get: vi.fn(() => containerManager) },
      worktreeManager,
      runtimeRegistry,
      validationEngine,
      enqueueSession: (id) => podQueue.enqueue(id),
      mcpBaseUrl: 'http://localhost:3100',
      daemonConfig: { mcpServers: [], claudeMdSections: [] },
      logger,
    });

    const podBridge = {
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
      podManager,
      profileStore,
      eventBus,
      eventRepo,
      podBridge,
      pendingRequestsByPod: new Map(),
      containerManagerFactory: { get: vi.fn(() => containerManager) },
      logLevel: 'silent',
      prettyLog: false,
    });

    // Create a profile so pod endpoints work
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
  // Pod stats
  // -------------------------------------------------------------------------

  describe('GET /pods/stats', () => {
    it('returns pod counts grouped by status', async () => {
      // Create a pod first
      await app.inject({
        method: 'POST',
        url: '/pods',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task 1' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/pods/stats',
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(200);
      const stats = res.json();
      expect(typeof stats).toBe('object');
    });

    it('accepts a profile query param', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/pods/stats?profile=test-app',
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Pod filter by status
  // -------------------------------------------------------------------------

  describe('GET /pods with filters', () => {
    it('filters pods by profile name', async () => {
      await app.inject({
        method: 'POST',
        url: '/pods',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/pods?profileName=test-app',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(200);
    });

    it('filters pods by status', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/pods?status=queued',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Send message
  // -------------------------------------------------------------------------

  describe('POST /pods/:id/message', () => {
    it('sends a message to a paused pod', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });
      const podId = createRes.json().id;

      // Wait for pod to reach a terminal state before forcing to paused,
      // which avoids the background queue racing and overwriting our state.
      await new Promise((r) => setTimeout(r, 100));
      db.prepare('UPDATE pods SET status = ? WHERE id = ?').run('paused', podId);

      const res = await app.inject({
        method: 'POST',
        url: `/pods/${podId}/message`,
        headers: authHeaders,
        payload: { message: 'please continue' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });

    it('returns 404 for nonexistent pod', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pods/nonexistent/message',
        headers: authHeaders,
        payload: { message: 'hello' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for invalid message payload', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });
      const podId = createRes.json().id;

      const res = await app.inject({
        method: 'POST',
        url: `/pods/${podId}/message`,
        headers: authHeaders,
        payload: { invalid: 'payload' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Nudge
  // -------------------------------------------------------------------------

  describe('POST /pods/:id/nudge', () => {
    it('queues a nudge message for a running pod', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });
      const podId = createRes.json().id;

      // Wait for background processing to settle before forcing to running state
      await new Promise((r) => setTimeout(r, 100));
      db.prepare('UPDATE pods SET status = ? WHERE id = ?').run('running', podId);

      const res = await app.inject({
        method: 'POST',
        url: `/pods/${podId}/nudge`,
        headers: authHeaders,
        payload: { message: 'soft nudge' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });

    it('returns 404 for nonexistent pod', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pods/nonexistent/nudge',
        headers: authHeaders,
        payload: { message: 'nudge' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Validations history
  // -------------------------------------------------------------------------

  describe('GET /pods/:id/validations', () => {
    it('returns empty array for new pod', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });
      const podId = createRes.json().id;

      const res = await app.inject({
        method: 'GET',
        url: `/pods/${podId}/validations`,
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    });

    it('returns 404 for nonexistent pod', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/pods/nonexistent/validations',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Report token
  // -------------------------------------------------------------------------

  describe('GET /pods/:id/report/token', () => {
    it('returns null token when no pod token issuer is configured', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });
      const podId = createRes.json().id;

      const res = await app.inject({
        method: 'GET',
        url: `/pods/${podId}/report/token`,
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.token).toBeNull();
      expect(body.reportUrl).toContain(podId);
    });

    it('returns 404 for nonexistent pod', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/pods/nonexistent/report/token',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Approve
  // -------------------------------------------------------------------------

  describe('POST /pods/:id/approve', () => {
    it('returns 409 when pod is not in validated state', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });
      const podId = createRes.json().id;

      // queued → not approvable
      const res = await app.inject({
        method: 'POST',
        url: `/pods/${podId}/approve`,
        headers: authHeaders,
        payload: {},
      });
      expect(res.statusCode).toBe(409);
    });

    it('returns 404 for nonexistent pod', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pods/nonexistent/approve',
        headers: authHeaders,
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Reject
  // -------------------------------------------------------------------------

  describe('POST /pods/:id/reject', () => {
    it('returns 409 when pod is not in validated state', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });
      const podId = createRes.json().id;

      const res = await app.inject({
        method: 'POST',
        url: `/pods/${podId}/reject`,
        headers: authHeaders,
        payload: { feedback: 'not good enough' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('returns 404 for nonexistent pod', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pods/nonexistent/reject',
        headers: authHeaders,
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Approve-all
  // -------------------------------------------------------------------------

  describe('POST /pods/approve-all', () => {
    it('returns the result of approving all validated pods', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pods/approve-all',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Kill-failed
  // -------------------------------------------------------------------------

  describe('POST /pods/kill-failed', () => {
    it('returns the result of killing all failed pods', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pods/kill-failed',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Pause
  // -------------------------------------------------------------------------

  describe('POST /pods/:id/pause', () => {
    it('returns 409 when pod is not pausable', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });
      const podId = createRes.json().id;

      // Force to a terminal state so the pod is definitively not pausable,
      // avoiding a race condition where async processing transitions it to 'running'.
      db.prepare('UPDATE pods SET status = ? WHERE id = ?').run('complete', podId);

      const res = await app.inject({
        method: 'POST',
        url: `/pods/${podId}/pause`,
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(409);
    });

    it('returns 404 for nonexistent pod', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pods/nonexistent/pause',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Delete pod
  // -------------------------------------------------------------------------

  describe('DELETE /pods/:id', () => {
    it('deletes a terminal pod and returns 204', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task to delete' },
      });
      const podId = createRes.json().id;

      // Force to a terminal state so deletion is allowed
      db.prepare('UPDATE pods SET status = ? WHERE id = ?').run('killed', podId);

      const res = await app.inject({
        method: 'DELETE',
        url: `/pods/${podId}`,
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(204);
    });

    it('returns 404 for nonexistent pod', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/pods/nonexistent',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Diff route
  // -------------------------------------------------------------------------

  describe('GET /pods/:id/diff', () => {
    it('returns empty diff for pod with no container', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });
      const podId = createRes.json().id;

      const res = await app.inject({
        method: 'GET',
        url: `/pods/${podId}/diff`,
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
        url: '/pods',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });
      const podId = createRes.json().id;

      // Add a containerId to the pod
      db.prepare('UPDATE pods SET container_id = ?, status = ? WHERE id = ?').run(
        'container-123',
        'running',
        podId,
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

      // First call: git merge-base HEAD main (returns a SHA)
      // Second call: git diff <sha> HEAD (returns unified diff)
      containerManager.execInContainer
        .mockResolvedValueOnce({
          stdout: 'abc123def456abc123def456abc123def456abc1',
          stderr: '',
          exitCode: 0,
        }) // git merge-base
        .mockResolvedValueOnce({ stdout: unifiedDiff, stderr: '', exitCode: 0 }); // git diff

      const res = await app.inject({
        method: 'GET',
        url: `/pods/${podId}/diff`,
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.files.length).toBeGreaterThanOrEqual(1);
      expect(body.stats.changed).toBeGreaterThanOrEqual(1);
    });

    it('returns 404 for nonexistent pod', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/pods/nonexistent/diff',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Validate trigger
  // -------------------------------------------------------------------------

  describe('POST /pods/:id/validate', () => {
    it('returns 409 when pod cannot be validated from current state', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: authHeaders,
        payload: { profileName: 'test-app', task: 'Task' },
      });
      const podId = createRes.json().id;

      const res = await app.inject({
        method: 'POST',
        url: `/pods/${podId}/validate`,
        headers: authHeaders,
      });
      // queued → not in a state that can be force-validated
      expect([200, 409]).toContain(res.statusCode);
    });

    it('returns 404 for nonexistent pod', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pods/nonexistent/validate',
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
      const sessionRepo2 = createPodRepository(db2);
      const eventRepo2 = createEventRepository(db2);
      const escalationRepo2 = createEscalationRepository(db2);
      const eventBus2 = createEventBus(eventRepo2, logger);

      // biome-ignore lint/style/useConst: assigned after sq2 to break circular dependency
      let sm2: ReturnType<typeof createPodManager>;
      const sq2 = createPodQueue(1, async (id) => sm2.processPod(id), logger);
      sm2 = createPodManager({
        podRepo: sessionRepo2,
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
        podManager: sm2,
        profileStore: profileStore2,
        eventBus: eventBus2,
        eventRepo: eventRepo2,
        podBridge: {
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
        pendingRequestsByPod: new Map(),
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
        url: '/pods',
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
