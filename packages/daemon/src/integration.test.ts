import fs from 'node:fs';
import path from 'node:path';
import type { JwtPayload } from '@autopod/shared';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from './api/server.js';
import type { AuthModule } from './interfaces/index.js';
import type { WorktreeManager } from './interfaces/worktree-manager.js';
import {
  createEscalationRepository,
  createEventBus,
  createEventRepository,
  createPodManager,
  createPodQueue,
  createPodRepository,
} from './pods/index.js';
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

describe('Integration', () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createTestDb();

    const profileStore = createProfileStore(db);
    const podRepo = createPodRepository(db);
    const eventRepo = createEventRepository(db);
    const escalationRepo = createEscalationRepository(db);
    const eventBus = createEventBus(eventRepo, logger);
    const authModule = createMockAuthModule();

    // Mock infrastructure
    const containerManager = {
      spawn: vi.fn().mockResolvedValue('container-123'),
      kill: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(''),
      getStatus: vi.fn().mockResolvedValue('running' as const),
      execInContainer: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
      execStreaming: vi.fn(),
    };

    const worktreeManager = {
      create: vi.fn().mockResolvedValue('/tmp/worktree/test'),
      cleanup: vi.fn().mockResolvedValue(undefined),
      getDiffStats: vi
        .fn()
        .mockResolvedValue({ filesChanged: 3, linesAdded: 50, linesRemoved: 10 }),
      getDiff: vi.fn().mockResolvedValue('diff --git a/file.ts b/file.ts\n+added line'),
      mergeBranch: vi.fn().mockResolvedValue(undefined),
      commitFiles: vi.fn().mockResolvedValue(undefined),
      pushBranch: vi.fn().mockResolvedValue(undefined),
      readBranchFolder: vi.fn().mockResolvedValue({
        relPath: '',
        files: [],
        sharedContext: '',
      }),
    };

    const runtimeRegistry = {
      get: vi.fn().mockReturnValue({
        type: 'claude' as const,
        spawn: vi.fn().mockReturnValue(
          (async function* () {
            yield {
              type: 'status' as const,
              timestamp: new Date().toISOString(),
              message: 'Working...',
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

    // Stub bridge for MCP (not testing MCP transport in integration)
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
    };

    app = await createServer({
      authModule,
      podManager,
      profileStore,
      worktreeManager: worktreeManager as unknown as WorktreeManager,
      eventBus,
      eventRepo,
      podBridge,
      pendingRequestsByPod: new Map(),
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

    it('GET /profiles/:name/editor returns raw + resolved + null parent for base profile', async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: validProfileInput,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/profiles/test-app/editor',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.raw.name).toBe('test-app');
      expect(body.resolved.name).toBe('test-app');
      expect(body.parent).toBeNull();
      expect(body.sourceMap.buildCommand).toBe('own');
      expect(body.sourceMap.extends).toBe('own');
      expect(body.credentialOwner).toBeNull();
    });

    it('GET /profiles/:name/editor reports the credential owner from the extends chain', async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          ...validProfileInput,
          name: 'auth-base',
          modelProvider: 'max',
          providerCredentials: {
            provider: 'max',
            accessToken: 'a',
            refreshToken: 'r',
            expiresAt: '2026-12-31T00:00:00Z',
          },
        },
      });
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          ...validProfileInput,
          name: 'auth-derived',
          extends: 'auth-base',
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/profiles/auth-derived/editor',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().credentialOwner).toBe('auth-base');
    });

    it('GET /profiles/:name/editor reflects overrides on derived profile', async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: validProfileInput,
      });
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          ...validProfileInput,
          name: 'test-app-derived',
          extends: 'test-app',
          buildCommand: 'pnpm build:derived',
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/profiles/test-app-derived/editor',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.parent).not.toBeNull();
      expect(body.parent.name).toBe('test-app');
      expect(body.resolved.buildCommand).toBe('pnpm build:derived');
      expect(body.sourceMap.buildCommand).toBe('own');
    });

    it('PATCH /profiles/:name with buildCommand: null clears override on derived profile', async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: validProfileInput,
      });
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          ...validProfileInput,
          name: 'test-app-derived',
          extends: 'test-app',
          buildCommand: 'pnpm build:derived',
        },
      });

      const patchRes = await app.inject({
        method: 'PATCH',
        url: '/profiles/test-app-derived',
        headers: { authorization: 'Bearer test-token' },
        payload: { buildCommand: null },
      });
      expect(patchRes.statusCode).toBe(200);

      const editorRes = await app.inject({
        method: 'GET',
        url: '/profiles/test-app-derived/editor',
        headers: { authorization: 'Bearer test-token' },
      });
      const body = editorRes.json();
      expect(body.raw.buildCommand).toBeNull();
      expect(body.resolved.buildCommand).toBe(validProfileInput.buildCommand);
      expect(body.sourceMap.buildCommand).toBe('inherited');
    });

    it('PATCH /profiles/:name rejects buildCommand: null on base profile', async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: validProfileInput,
      });

      const res = await app.inject({
        method: 'PATCH',
        url: '/profiles/test-app',
        headers: { authorization: 'Bearer test-token' },
        payload: { buildCommand: null },
      });
      expect(res.statusCode).toBe(400);
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

    it('POST /pods creates a pod', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: { authorization: 'Bearer test-token' },
        payload: { profileName: 'test-app', task: 'Add a button' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().profileName).toBe('test-app');
      expect(res.json().status).toBe('queued');
    });

    it('GET /pods lists pods', async () => {
      await app.inject({
        method: 'POST',
        url: '/pods',
        headers: { authorization: 'Bearer test-token' },
        payload: { profileName: 'test-app', task: 'Task 1' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/pods',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().length).toBeGreaterThanOrEqual(1);
    });

    it('GET /pods/:podId returns pod details', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: { authorization: 'Bearer test-token' },
        payload: { profileName: 'test-app', task: 'Task 1' },
      });
      const podId = createRes.json().id;

      const res = await app.inject({
        method: 'GET',
        url: `/pods/${podId}`,
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(podId);
    });

    it('POST /pods/:podId/kill kills a pod', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: { authorization: 'Bearer test-token' },
        payload: { profileName: 'test-app', task: 'Task to kill' },
      });
      const podId = createRes.json().id;

      // Wait a tick for the queue to potentially process
      await new Promise((r) => setTimeout(r, 50));

      // Check current status — pod may have been processed already
      const getRes = await app.inject({
        method: 'GET',
        url: `/pods/${podId}`,
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
        url: `/pods/${podId}/kill`,
        headers: { authorization: 'Bearer test-token' },
      });

      if (killRes.statusCode === 200) {
        const afterKill = await app.inject({
          method: 'GET',
          url: `/pods/${podId}`,
          headers: { authorization: 'Bearer test-token' },
        });
        expect(afterKill.json().status).toBe('killed');
      } else {
        // Pod already transitioned to a non-killable state (validated, approved, etc.)
        expect([200, 409]).toContain(killRes.statusCode);
      }
    });
  });

  describe('Validation report', () => {
    beforeEach(async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: validProfileInput,
      });
    });

    it('GET /pods/:podId/report returns HTML', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: { authorization: 'Bearer test-token' },
        payload: { profileName: 'test-app', task: 'Build a widget' },
      });
      const podId = createRes.json().id;

      const res = await app.inject({
        method: 'GET',
        url: `/pods/${podId}/report`,
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('<!DOCTYPE html>');
      expect(res.body).toContain('Build a widget');
      expect(res.body).toContain(podId);
    });

    it('GET /pods/:podId/report returns 404 for nonexistent pod', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/pods/nonexistent/report',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('Preview', () => {
    beforeEach(async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: validProfileInput,
      });
    });

    it('POST /pods/:podId/preview returns 409 when pod has no container', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: { authorization: 'Bearer test-token' },
        payload: { profileName: 'test-app', task: 'Preview test' },
      });
      const podId = createRes.json().id;

      // Freshly created pod has no containerId yet
      const res = await app.inject({
        method: 'POST',
        url: `/pods/${podId}/preview`,
        headers: { authorization: 'Bearer test-token' },
      });
      // May be 409 (no container) or 200 (if pod was already processed fast enough)
      expect([200, 409]).toContain(res.statusCode);
    });

    it('DELETE /pods/:podId/preview returns 409 when pod has no container', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: { authorization: 'Bearer test-token' },
        payload: { profileName: 'test-app', task: 'Preview stop test' },
      });
      const podId = createRes.json().id;

      const res = await app.inject({
        method: 'DELETE',
        url: `/pods/${podId}/preview`,
        headers: { authorization: 'Bearer test-token' },
      });
      expect([200, 409]).toContain(res.statusCode);
    });

    it('POST /pods/:podId/preview returns 404 for nonexistent pod', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pods/nonexistent/preview',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.statusCode).toBe(404);
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

    it('returns 404 for nonexistent pod', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/pods/nonexistent',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('POD_NOT_FOUND');
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

  describe('Workspace Sessions', () => {
    it('POST /pods creates a workspace pod', async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: validProfileInput,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          profileName: 'test-app',
          task: 'Workspace pod',
          outputMode: 'workspace',
        },
      });

      expect(res.statusCode).toBe(201);
      const pod = res.json();
      expect(pod.outputMode).toBe('workspace');
      expect(pod.status).toBe('queued');
    });

    it('POST /pods rejects workspace + ACI execution target', async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: validProfileInput,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          profileName: 'test-app',
          task: 'Workspace pod',
          outputMode: 'workspace',
          executionTarget: 'aci',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('local');
    });

    it('POST /pods rejects deny-all network policy with cloud-backed runtime', async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          ...validProfileInput,
          name: 'deny-all-profile',
          networkPolicy: {
            enabled: true,
            mode: 'deny-all',
            allowedHosts: [],
          },
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          profileName: 'deny-all-profile',
          task: 'This should fail',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('deny-all');
      expect(res.json().error).toContain('restricted');
    });

    it('POST /pods allows deny-all network policy for workspace pods', async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          ...validProfileInput,
          name: 'deny-all-workspace',
          networkPolicy: {
            enabled: true,
            mode: 'deny-all',
            allowedHosts: [],
          },
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          profileName: 'deny-all-workspace',
          task: 'Interactive workspace',
          outputMode: 'workspace',
        },
      });

      expect(res.statusCode).toBe(201);
    });

    it('POST /pods/:id/complete rejects non-workspace pods', async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: validProfileInput,
      });

      const createRes = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          profileName: 'test-app',
          task: 'Normal PR pod',
        },
      });
      const pod = createRes.json();

      // Force to running state for the test
      db.prepare('UPDATE pods SET status = ? WHERE id = ?').run('running', pod.id);

      const res = await app.inject({
        method: 'POST',
        url: `/pods/${pod.id}/complete`,
        headers: { authorization: 'Bearer test-token' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('POST /pods/:id/complete transitions workspace pod to complete', async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: validProfileInput,
      });

      const createRes = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          profileName: 'test-app',
          task: 'Workspace pod',
          outputMode: 'workspace',
        },
      });
      const pod = createRes.json();

      // Force to running state with worktree path
      db.prepare('UPDATE pods SET status = ?, worktree_path = ? WHERE id = ?').run(
        'running',
        '/tmp/worktree/test',
        pod.id,
      );

      const res = await app.inject({
        method: 'POST',
        url: `/pods/${pod.id}/complete`,
        headers: { authorization: 'Bearer test-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);

      // Verify pod is now complete
      const getRes = await app.inject({
        method: 'GET',
        url: `/pods/${pod.id}`,
        headers: { authorization: 'Bearer test-token' },
      });
      expect(getRes.json().status).toBe('complete');
    });

    it('POST /pods accepts baseBranch and acFrom parameters', async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: validProfileInput,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          profileName: 'test-app',
          task: 'Execute the plan',
          baseBranch: 'feat/plan-auth',
          acFrom: 'specs/auth/acceptance-criteria.md',
        },
      });

      expect(res.statusCode).toBe(201);
      const pod = res.json();
      expect(pod.baseBranch).toBe('feat/plan-auth');
      expect(pod.acFrom).toBe('specs/auth/acceptance-criteria.md');
    });

    it('POST /pods rejects acFrom with path traversal', async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: validProfileInput,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          profileName: 'test-app',
          task: 'Evil pod',
          acFrom: '../../etc/passwd',
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('Series', () => {
    beforeEach(async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: validProfileInput,
      });
    });

    it('POST /pods/series creates pods with seriesId and dependency chain', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pods/series',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          seriesName: 'auth-refactor',
          profile: 'test-app',
          prMode: 'single',
          briefs: [
            { title: '01-types', task: 'Implement auth types', dependsOn: [] },
            { title: '02-backend', task: 'Implement auth backend', dependsOn: ['01-types'] },
            { title: '03-frontend', task: 'Implement auth frontend', dependsOn: ['02-backend'] },
          ],
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.seriesId).toBeTruthy();
      expect(body.seriesName).toBe('auth-refactor');
      expect(body.pods).toHaveLength(3);

      // All pods share the same seriesId
      for (const pod of body.pods) {
        expect(pod.seriesId).toBe(body.seriesId);
        expect(pod.seriesName).toBe('auth-refactor');
      }

      // Dependency chain: pod 2 depends on pod 1, pod 3 depends on pod 2
      expect(body.pods[0].dependsOnPodId).toBeNull();
      expect(body.pods[1].dependsOnPodId).toBe(body.pods[0].id);
      expect(body.pods[2].dependsOnPodId).toBe(body.pods[1].id);
    });

    it('POST /pods/series sets output:branch for intermediate pods in single mode', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pods/series',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          seriesName: 'feature-x',
          profile: 'test-app',
          prMode: 'single',
          briefs: [
            { title: '01-a', task: 'Task A', dependsOn: [] },
            { title: '02-b', task: 'Task B', dependsOn: ['01-a'] },
          ],
        },
      });

      expect(res.statusCode).toBe(201);
      const { pods } = res.json();
      expect(pods[0].options.output).toBe('branch');
      expect(pods[1].options.output).toBe('pr');
    });

    it('GET /pods/series/:id returns pods and cost roll-up', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/pods/series',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          seriesName: 'cost-test',
          profile: 'test-app',
          briefs: [
            { title: 'step-1', task: 'Step 1', dependsOn: [] },
            { title: 'step-2', task: 'Step 2', dependsOn: ['step-1'] },
          ],
        },
      });
      const { seriesId } = createRes.json();

      const res = await app.inject({
        method: 'GET',
        url: `/pods/series/${seriesId}`,
        headers: { authorization: 'Bearer test-token' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.seriesId).toBe(seriesId);
      expect(body.pods).toHaveLength(2);
      expect(body.tokenUsageSummary).toMatchObject({
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
        costUsd: expect.any(Number),
      });
      // All pods should be in a valid terminal or in-progress status
      const totalPods = Object.values(body.statusCounts as Record<string, number>).reduce(
        (sum: number, n: number) => sum + n,
        0,
      );
      expect(totalPods).toBe(2);
    });

    it('GET /pods/series/:id returns 404 for unknown series', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/pods/series/nonexistent-series-id',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('POST /pods with dependsOnPodId and seriesId stores fields correctly', async () => {
      // Create a standalone pod first
      const firstRes = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: { authorization: 'Bearer test-token' },
        payload: { profileName: 'test-app', task: 'First pod in chain' },
      });
      const firstPod = firstRes.json();

      // Create a dependent pod
      const secondRes = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          profileName: 'test-app',
          task: 'Second pod in chain',
          dependsOnPodId: firstPod.id,
          seriesId: 'my-series-123',
          seriesName: 'my-series',
        },
      });

      expect(secondRes.statusCode).toBe(201);
      const second = secondRes.json();
      expect(second.dependsOnPodId).toBe(firstPod.id);
      expect(second.seriesId).toBe('my-series-123');
      expect(second.seriesName).toBe('my-series');
    });

    it('POST /pods accepts dependsOnPodIds array for fan-in dependencies', async () => {
      const parentAResponse = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: { authorization: 'Bearer test-token' },
        payload: { profileName: 'test-app', task: 'parent A' },
      });
      const parentA = parentAResponse.json();
      const parentBResponse = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: { authorization: 'Bearer test-token' },
        payload: { profileName: 'test-app', task: 'parent B' },
      });
      const parentB = parentBResponse.json();

      const childResponse = await app.inject({
        method: 'POST',
        url: '/pods',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          profileName: 'test-app',
          task: 'integration pod waiting on both parents',
          dependsOnPodIds: [parentA.id, parentB.id],
          seriesId: 'fanin-test',
          seriesName: 'fanin-test',
        },
      });
      expect(childResponse.statusCode).toBe(201);
      const child = childResponse.json();
      expect(child.dependsOnPodIds).toEqual([parentA.id, parentB.id]);
      // Child stays queued until both parents validate.
      expect(child.status).toBe('queued');
      // Legacy single-parent mirror is set to the first parent.
      expect(child.dependsOnPodId).toBe(parentA.id);
    });

    it('POST /pods/series supports fan-in briefs (child.dependsOn = [a, b])', async () => {
      // Stacked mode — each sibling gets its own branch, so true fan-out/fan-in
      // parallelism is possible. (Single mode chains siblings on the shared branch.)
      const res = await app.inject({
        method: 'POST',
        url: '/pods/series',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          seriesName: 'diamond',
          profile: 'test-app',
          prMode: 'stacked',
          briefs: [
            { title: '01-base', task: 'Base task', dependsOn: [] },
            { title: '02-a', task: 'Branch A', dependsOn: ['01-base'] },
            { title: '02-b', task: 'Branch B', dependsOn: ['01-base'] },
            { title: '03-merge', task: 'Merge branches', dependsOn: ['02-a', '02-b'] },
          ],
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.pods).toHaveLength(4);
      const [base, a, b, merge] = body.pods;
      expect(base.dependsOnPodIds).toEqual([]);
      expect(a.dependsOnPodIds).toEqual([base.id]);
      expect(b.dependsOnPodIds).toEqual([base.id]);
      expect(merge.dependsOnPodIds).toEqual([a.id, b.id]);
    });

    it('POST /pods/series chains single-mode siblings so they serialize on the shared branch', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pods/series',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          seriesName: 'single-chain',
          profile: 'test-app',
          prMode: 'single',
          briefs: [
            { title: '01-base', task: 'Base task', dependsOn: [] },
            { title: '02-a', task: 'Branch A', dependsOn: ['01-base'] },
            { title: '02-b', task: 'Branch B', dependsOn: ['01-base'] },
          ],
        },
      });
      expect(res.statusCode).toBe(201);
      const [base, a, b] = res.json().pods;
      expect(base.dependsOnPodIds).toEqual([]);
      expect(a.dependsOnPodIds).toEqual([base.id]);
      // 02-b's brief only says it depends on base, but single mode chains it
      // onto 02-a so Git doesn't race on the shared branch.
      expect(b.dependsOnPodIds).toEqual([base.id, a.id]);
      // All three share the root's branch (single-mode invariant).
      expect(a.branch).toBe(base.branch);
      expect(b.branch).toBe(base.branch);
    });

    it('POST /pods/series accepts structured AcDefinition acceptance criteria', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/pods/series',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          seriesName: 'ac-test',
          profile: 'test-app',
          briefs: [
            {
              title: 'with-acs',
              task: 'Task with ACs',
              dependsOn: [],
              acceptanceCriteria: [
                { type: 'none', test: 'npx pnpm build', pass: 'exit 0', fail: 'any error' },
                {
                  type: 'api',
                  test: 'GET /health',
                  pass: '200 ok',
                  fail: 'non-200',
                },
              ],
            },
          ],
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.pods[0].acceptanceCriteria).toHaveLength(2);
      expect(body.pods[0].acceptanceCriteria[0].type).toBe('none');
      expect(body.pods[0].acceptanceCriteria[1].type).toBe('api');
    });

    it('POST /pods/series forces agentMode:auto even when profile defaults to interactive', async () => {
      await app.inject({
        method: 'POST',
        url: '/profiles',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          ...validProfileInput,
          name: 'workspace-default',
          pod: { agentMode: 'interactive', output: 'branch' },
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/pods/series',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          seriesName: 'auto-override',
          profile: 'workspace-default',
          briefs: [
            { title: '01', task: 'First', dependsOn: [] },
            { title: '02', task: 'Second', dependsOn: ['01'] },
          ],
        },
      });

      expect(res.statusCode).toBe(201);
      const { pods } = res.json();
      for (const pod of pods) {
        expect(pod.options.agentMode).toBe('auto');
      }
    });
  });
});
