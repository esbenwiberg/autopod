/**
 * Route-level integration tests for GET /pods/analytics/reliability.
 * Uses app.inject() against a full Fastify server backed by an in-memory SQLite DB.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { JwtPayload } from '@autopod/shared';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../../api/server.js';
import type { AuthModule } from '../../interfaces/index.js';
import {
  createEscalationRepository,
  createEventBus,
  createEventRepository,
  createPodManager,
  createPodQueue,
  createPodRepository,
} from '../../pods/index.js';
import { createNudgeRepository } from '../../pods/nudge-repository.js';
import { createQualityScoreRepository } from '../../pods/quality-score-repository.js';
import { createProfileStore } from '../../profiles/index.js';

// ── DB setup (mirrors routes-extended.test.ts pattern) ────────────────────────

const migrationsDir = path.resolve(import.meta.dirname, '../../db/migrations');
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

const authHeaders = { authorization: 'Bearer test-token' };

// ── Minimal pod insert (direct SQL) ──────────────────────────────────────────

let podSeq = 0;

function insertPod(
  db: Database.Database,
  opts: {
    id?: string;
    status?: string;
    completedAt?: string;
    reworkCount?: number;
    outputMode?: string;
  } = {},
): string {
  const id = opts.id ?? `pod-${++podSeq}`;
  db.prepare(`
    INSERT INTO pods (
      id, profile_name, task, status, model, runtime, execution_target, branch,
      user_id, max_validation_attempts, skip_validation,
      output_mode, agent_mode, output_target, validate, promotable,
      completed_at, rework_count
    ) VALUES (
      @id, 'test-profile', 'task', @status, 'claude-opus-4-7', 'claude', 'local', 'branch-1',
      'user-1', 3, 0,
      @outputMode, 'auto', 'pr', 1, 0,
      @completedAt, @reworkCount
    )
  `).run({
    id,
    status: opts.status ?? 'complete',
    outputMode: opts.outputMode ?? 'pr',
    completedAt: opts.completedAt ?? new Date().toISOString(),
    reworkCount: opts.reworkCount ?? 0,
  });
  return id;
}

// ── Test setup ────────────────────────────────────────────────────────────────

describe('GET /pods/analytics/reliability', () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    podSeq = 0;
    db = createTestDb();

    const profileStore = createProfileStore(db);
    const podRepo = createPodRepository(db);
    const eventRepo = createEventRepository(db);
    const escalationRepo = createEscalationRepository(db);
    const nudgeRepo = createNudgeRepository(db);
    const eventBus = createEventBus(eventRepo, logger);
    const authModule = createMockAuthModule();

    const worktreeManager = {
      create: vi.fn(),
      cleanup: vi.fn(),
      getDiffStats: vi.fn(),
      getDiff: vi.fn(),
      mergeBranch: vi.fn(),
      commitFiles: vi.fn(),
      pushBranch: vi.fn(),
      getCommitLog: vi.fn(),
    };

    const runtimeRegistry = {
      get: vi.fn().mockReturnValue({
        type: 'claude' as const,
        spawn: vi.fn().mockReturnValue(
          (async function* () {
            yield { type: 'complete' as const, timestamp: new Date().toISOString(), result: 'done' };
          })(),
        ),
        resume: vi.fn(),
        abort: vi.fn(),
        suspend: vi.fn(),
      }),
    };

    const validationEngine = {
      validate: vi.fn().mockResolvedValue({
        podId: 'x',
        attempt: 0,
        timestamp: new Date().toISOString(),
        smoke: {
          status: 'pass',
          build: { status: 'pass', output: '', duration: 100 },
          health: { status: 'pass', url: 'http://localhost/', responseCode: 200, duration: 50 },
          pages: [],
        },
        taskReview: null,
        overall: 'pass',
        duration: 200,
      }),
    };

    // biome-ignore lint/style/useConst: circular dependency break
    let podManager: ReturnType<typeof createPodManager>;

    const podQueue = createPodQueue(
      1,
      async (podId) => podManager.processPod(podId),
      logger,
    );

    podManager = createPodManager({
      podRepo,
      escalationRepo,
      nudgeRepo,
      profileStore,
      eventBus,
      containerManagerFactory: {
        get: vi.fn(() => ({
          spawn: vi.fn().mockResolvedValue('c-1'),
          kill: vi.fn(),
          stop: vi.fn(),
          start: vi.fn(),
          refreshFirewall: vi.fn(),
          writeFile: vi.fn(),
          readFile: vi.fn(),
          getStatus: vi.fn().mockResolvedValue('running' as const),
          execInContainer: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
          execStreaming: vi.fn(),
        })),
      },
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
      callReviewerModel: vi.fn().mockResolvedValue('ok'),
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
      db,
      logLevel: 'silent',
      prettyLog: false,
    });

    // Seed a profile so pod inserts don't violate the FK constraint
    await app.inject({
      method: 'POST',
      url: '/profiles',
      headers: authHeaders,
      payload: {
        name: 'test-profile',
        repoUrl: 'https://github.com/org/repo',
        buildCommand: 'npm run build',
        startCommand: 'node server.js --port $PORT',
      },
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  // ── Endpoint round-trip ─────────────────────────────────────────────────────

  it('returns 200 with correct top-level shape', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pods/analytics/reliability?days=30',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Validate one field per top-level key
    expect(typeof body.firstPassRate).toBe('number');
    expect(Array.isArray(body.firstPassRateSparkline)).toBe(true);
    expect(body.firstPassRateDelta).toHaveProperty('direction');
    expect(body.funnel.bands).toHaveLength(8);
    expect(Array.isArray(body.funnel.drops)).toBe(true);
    expect(body.stageFailures).toHaveLength(8);
    expect(Array.isArray(body.profileHeatmap)).toBe(true);
    expect(body.summary).toHaveProperty('topFailureStage');
  });

  it('firstPassRate is between 0 and 1', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pods/analytics/reliability?days=30',
      headers: authHeaders,
    });

    const body = res.json();
    expect(body.firstPassRate).toBeGreaterThanOrEqual(0);
    expect(body.firstPassRate).toBeLessThanOrEqual(1);
  });

  // ── days validation ─────────────────────────────────────────────────────────

  it('days=0 returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pods/analytics/reliability?days=0',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(400);
  });

  it('days=400 returns 400 (exceeds max of 365)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pods/analytics/reliability?days=400',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(400);
  });

  it('days=30 returns 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pods/analytics/reliability?days=30',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
  });

  it('missing days defaults to 30 entries in sparkline', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pods/analytics/reliability',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().firstPassRateSparkline).toHaveLength(30);
  });

  // ── Workspace exclusion ─────────────────────────────────────────────────────

  it('workspace pods are excluded from the response', async () => {
    // Workspace pod — should NOT count
    insertPod(db, { status: 'complete', reworkCount: 0, outputMode: 'workspace' });
    // Normal pod — should count
    insertPod(db, { status: 'complete', reworkCount: 0, outputMode: 'pr' });

    const res = await app.inject({
      method: 'GET',
      url: '/pods/analytics/reliability?days=30',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.totalPodsInWindow).toBe(1);
    expect(body.firstPassRate).toBe(1);
  });
});

// ── GET /pods/analytics/quality ───────────────────────────────────────────────

describe('GET /pods/analytics/quality', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let qualityRepo: ReturnType<typeof createQualityScoreRepository>;

  beforeEach(async () => {
    podSeq = 0;
    db = createTestDb();
    db.pragma('foreign_keys = OFF');
    qualityRepo = createQualityScoreRepository(db);

    const profileStore = createProfileStore(db);
    const podRepo = createPodRepository(db);
    const eventRepo = createEventRepository(db);
    const escalationRepo = createEscalationRepository(db);
    const nudgeRepo = createNudgeRepository(db);
    const eventBus = createEventBus(eventRepo, logger);
    const authModule = createMockAuthModule();

    const worktreeManager = {
      create: vi.fn(),
      cleanup: vi.fn(),
      getDiffStats: vi.fn(),
      getDiff: vi.fn(),
      mergeBranch: vi.fn(),
      commitFiles: vi.fn(),
      pushBranch: vi.fn(),
      getCommitLog: vi.fn(),
    };

    const runtimeRegistry = {
      get: vi.fn().mockReturnValue({
        type: 'claude' as const,
        spawn: vi.fn().mockReturnValue(
          (async function* () {
            yield { type: 'complete' as const, timestamp: new Date().toISOString(), result: 'done' };
          })(),
        ),
        resume: vi.fn(),
        abort: vi.fn(),
        suspend: vi.fn(),
      }),
    };

    const validationEngine = {
      validate: vi.fn().mockResolvedValue({
        podId: 'x',
        attempt: 0,
        timestamp: new Date().toISOString(),
        smoke: {
          status: 'pass',
          build: { status: 'pass', output: '', duration: 100 },
          health: { status: 'pass', url: 'http://localhost/', responseCode: 200, duration: 50 },
          pages: [],
        },
        taskReview: null,
        overall: 'pass',
        duration: 200,
      }),
    };

    // biome-ignore lint/style/useConst: circular dependency break
    let podManager: ReturnType<typeof createPodManager>;

    const podQueue = createPodQueue(
      1,
      async (podId) => podManager.processPod(podId),
      logger,
    );

    podManager = createPodManager({
      podRepo,
      escalationRepo,
      nudgeRepo,
      profileStore,
      eventBus,
      containerManagerFactory: {
        get: vi.fn(() => ({
          spawn: vi.fn().mockResolvedValue('c-1'),
          kill: vi.fn(),
          stop: vi.fn(),
          start: vi.fn(),
          refreshFirewall: vi.fn(),
          writeFile: vi.fn(),
          readFile: vi.fn(),
          getStatus: vi.fn().mockResolvedValue('running' as const),
          execInContainer: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
          execStreaming: vi.fn(),
        })),
      },
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
      callReviewerModel: vi.fn().mockResolvedValue('ok'),
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
      db,
      qualityScoreRepo: qualityRepo,
      logLevel: 'silent',
      prettyLog: false,
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('returns 200 with correct top-level shape', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pods/analytics/quality?days=30',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.summary.totalPodsScored).toBe('number');
    expect(Array.isArray(body.sparkline)).toBe(true);
    expect(body.distribution).toHaveLength(10);
    expect(typeof body.reasons.lowReadEditRatio).toBe('number');
    expect(typeof body.reasons.editsWithoutPriorRead).toBe('number');
    expect(typeof body.reasons.userInterrupts).toBe('number');
    expect(typeof body.reasons.validationFailed).toBe('number');
    expect(typeof body.reasons.prFixAttempts).toBe('number');
    expect(typeof body.reasons.editChurn).toBe('number');
    expect(typeof body.reasons.tells).toBe('number');
    expect(Array.isArray(body.scores)).toBe(true);
  });

  it('missing days defaults to 30 sparkline entries', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pods/analytics/quality',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sparkline).toHaveLength(30);
  });

  it('days=0 returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pods/analytics/quality?days=0',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error');
  });

  it('days=400 returns 400 (exceeds max of 365)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pods/analytics/quality?days=400',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error');
  });

  it('days=30 returns 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pods/analytics/quality?days=30',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
  });

  it('seeded pod appears in response scores and updates summary counts', async () => {
    qualityRepo.insert({
      podId: 'q1',
      score: 85,
      readCount: 10,
      editCount: 5,
      readEditRatio: 2,
      editsWithoutPriorRead: 0,
      userInterrupts: 0,
      editChurnCount: 0,
      tellsCount: 0,
      prFixAttempts: 0,
      validationPassed: true,
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.1,
      runtime: 'claude',
      profileName: 'test-profile',
      model: 'claude-opus-4-7',
      finalStatus: 'complete',
      completedAt: new Date().toISOString(),
      computedAt: new Date().toISOString(),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/pods/analytics/quality?days=30',
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.totalPodsScored).toBe(1);
    expect(body.summary.greenCount).toBe(1);
    expect(body.scores).toHaveLength(1);
    expect(body.scores[0].podId).toBe('q1');
  });
});
