import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentEvent,
  Runtime,
  RuntimeType,
  StackTemplate,
  ValidationResult,
} from '@autopod/shared';
import { AutopodError, InvalidStateTransitionError, SessionNotFoundError } from '@autopod/shared';
import Database from 'better-sqlite3';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type {
  ContainerManager,
  PrManager,
  RuntimeRegistry,
  ValidationEngine,
  WorktreeManager,
} from '../interfaces/index.js';
import type { ProfileStore } from '../profiles/index.js';
import { createEscalationRepository } from './escalation-repository.js';
import type { EscalationRepository } from './escalation-repository.js';
import { createEventBus } from './event-bus.js';
import type { EventBus } from './event-bus.js';
import { createEventRepository } from './event-repository.js';
import { type SessionManagerDependencies, createSessionManager } from './session-manager.js';
import { createSessionRepository } from './session-repository.js';
import type { SessionRepository } from './session-repository.js';

const logger = pino({ level: 'silent' });

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  // Run migrations inline
  const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
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

function insertTestProfile(db: Database.Database, name = 'test-profile') {
  db.prepare(`
    INSERT INTO profiles (
      name, repo_url, default_branch, template, build_command, start_command,
      health_path, health_timeout, validation_pages, max_validation_attempts,
      default_model, default_runtime, escalation_config
    ) VALUES (
      @name, @repoUrl, @defaultBranch, @template, @buildCommand, @startCommand,
      @healthPath, @healthTimeout, @validationPages, @maxValidationAttempts,
      @defaultModel, @defaultRuntime, @escalationConfig
    )
  `).run({
    name,
    repoUrl: 'https://github.com/org/repo',
    defaultBranch: 'main',
    template: 'node22',
    buildCommand: 'npm run build',
    startCommand: 'npm start',
    healthPath: '/health',
    healthTimeout: 120,
    validationPages: '[]',
    maxValidationAttempts: 3,
    defaultModel: 'opus',
    defaultRuntime: 'claude',
    escalationConfig: JSON.stringify({
      askHuman: true,
      askAi: { enabled: true, model: 'sonnet', maxCalls: 5 },
      autoPauseAfter: 3,
      humanResponseTimeout: 3600,
    }),
  });
}

function createMockRuntime(): Runtime {
  return {
    type: 'claude',
    spawn: vi.fn(async function* () {} as () => AsyncIterable<AgentEvent>),
    resume: vi.fn(async function* () {} as () => AsyncIterable<AgentEvent>),
    abort: vi.fn(async () => {}),
  };
}

function createMockContainerManager(): ContainerManager {
  return {
    spawn: vi.fn(async () => 'container-123'),
    kill: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    getStatus: vi.fn(async () => 'running' as const),
    execInContainer: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    execStreaming: vi.fn(),
  };
}

function createMockWorktreeManager(): WorktreeManager {
  return {
    create: vi.fn(async () => '/tmp/worktree/abc'),
    cleanup: vi.fn(async () => {}),
    getDiffStats: vi.fn(async () => ({ filesChanged: 3, linesAdded: 50, linesRemoved: 10 })),
    getDiff: vi.fn(async () => 'diff --git a/file.ts b/file.ts\n+added line'),
    mergeBranch: vi.fn(async () => {}),
    commitFiles: vi.fn(async () => {}),
    pushBranch: vi.fn(async () => {}),
  };
}

function createMockRuntimeRegistry(runtime: Runtime): RuntimeRegistry {
  return {
    get: vi.fn(() => runtime),
  };
}

function createMockPrManager(): PrManager {
  return {
    createPr: vi.fn(async () => 'https://github.com/org/repo/pull/42'),
    mergePr: vi.fn(async () => {}),
  };
}

function createMockValidationEngine(result?: Partial<ValidationResult>): ValidationEngine {
  return {
    validate: vi.fn(async () => ({
      sessionId: 'test',
      attempt: 1,
      timestamp: new Date().toISOString(),
      smoke: {
        status: 'pass' as const,
        build: { status: 'pass' as const, output: '', duration: 100 },
        health: {
          status: 'pass' as const,
          url: 'http://localhost:3000',
          responseCode: 200,
          duration: 50,
        },
        pages: [],
      },
      taskReview: null,
      overall: 'pass' as const,
      duration: 5000,
      ...result,
    })),
  };
}

interface TestContext {
  db: Database.Database;
  sessionRepo: SessionRepository;
  escalationRepo: EscalationRepository;
  eventBus: EventBus;
  profileStore: ProfileStore;
  containerManager: ContainerManager;
  worktreeManager: WorktreeManager;
  runtimeRegistry: RuntimeRegistry;
  validationEngine: ValidationEngine;
  prManager: PrManager;
  runtime: Runtime;
  enqueuedSessions: string[];
  deps: SessionManagerDependencies;
}

function createTestContext(validationResult?: Partial<ValidationResult>): TestContext {
  const db = createTestDb();
  insertTestProfile(db);

  const sessionRepo = createSessionRepository(db);
  const eventRepo = createEventRepository(db);
  const escalationRepo = createEscalationRepository(db);
  const eventBus = createEventBus(eventRepo, logger);

  // ProfileStore mock that reads from DB
  const profileStore: ProfileStore = {
    create: vi.fn(),
    get: vi.fn((name: string) => {
      const row = db.prepare('SELECT * FROM profiles WHERE name = ?').get(name) as
        | Record<string, unknown>
        | undefined;
      if (!row) throw new Error(`Profile "${name}" not found`);
      return {
        name: row.name as string,
        repoUrl: row.repo_url as string,
        defaultBranch: row.default_branch as string,
        template: row.template as StackTemplate,
        buildCommand: row.build_command as string,
        startCommand: row.start_command as string,
        healthPath: row.health_path as string,
        healthTimeout: row.health_timeout as number,
        smokePages: JSON.parse(row.validation_pages as string),
        maxValidationAttempts: row.max_validation_attempts as number,
        defaultModel: row.default_model as string,
        defaultRuntime: row.default_runtime as RuntimeType,
        customInstructions: (row.custom_instructions as string) ?? null,
        escalation: JSON.parse(row.escalation_config as string),
        executionTarget: 'local' as const,
        extends: null,
        warmImageTag: null,
        warmImageBuiltAt: null,
        mcpServers: JSON.parse((row.mcp_servers as string) ?? '[]'),
        claudeMdSections: JSON.parse((row.claude_md_sections as string) ?? '[]'),
        networkPolicy: null,
        actionPolicy: null,
        outputMode: 'pr' as const,
        modelProvider: (row.model_provider as 'anthropic' | 'max' | 'foundry') ?? 'anthropic',
        providerCredentials: row.provider_credentials
          ? JSON.parse(row.provider_credentials as string)
          : null,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
      };
    }),
    getRaw: vi.fn(),
    list: vi.fn(() => []),
    update: vi.fn(),
    delete: vi.fn(),
    exists: vi.fn(() => true),
  };

  const runtime = createMockRuntime();
  const containerManager = createMockContainerManager();
  const worktreeManager = createMockWorktreeManager();
  const runtimeRegistry = createMockRuntimeRegistry(runtime);
  const validationEngine = createMockValidationEngine(validationResult);
  const prManager = createMockPrManager();

  const enqueuedSessions: string[] = [];

  const deps: SessionManagerDependencies = {
    sessionRepo,
    escalationRepo,
    profileStore,
    eventBus,
    containerManagerFactory: { get: vi.fn(() => containerManager) },
    worktreeManager,
    runtimeRegistry,
    validationEngine,
    prManagerFactory: () => prManager,
    enqueueSession: (id) => enqueuedSessions.push(id),
    mcpBaseUrl: 'http://localhost:8080',
    daemonConfig: { mcpServers: [], claudeMdSections: [] },
    logger,
  };

  return {
    db,
    sessionRepo,
    escalationRepo,
    eventBus,
    profileStore,
    containerManager,
    worktreeManager,
    runtimeRegistry,
    validationEngine,
    prManager,
    runtime,
    enqueuedSessions,
    deps,
  };
}

describe('SessionManager', () => {
  describe('createSession', () => {
    it('creates a session in queued status', () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Add dark mode' },
        'user-1',
      );

      expect(session.status).toBe('queued');
      expect(session.profileName).toBe('test-profile');
      expect(session.task).toBe('Add dark mode');
      expect(session.userId).toBe('user-1');
      expect(session.model).toBe('opus');
      expect(session.runtime).toBe('claude');
      expect(session.branch).toContain('autopod/');
    });

    it('uses custom model and branch when provided', () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Fix bug', model: 'sonnet', branch: 'fix/my-bug' },
        'user-1',
      );

      expect(session.model).toBe('sonnet');
      expect(session.branch).toBe('fix/my-bug');
    });

    it('enqueues the session for processing', () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );

      expect(ctx.enqueuedSessions).toContain(session.id);
    });

    it('emits session.created event', () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const events: unknown[] = [];
      ctx.eventBus.subscribe((e) => events.push(e));

      manager.createSession({ profileName: 'test-profile', task: 'Do stuff' }, 'user-1');

      const createdEvent = events.find((e: any) => e.type === 'session.created');
      expect(createdEvent).toBeDefined();
    });
  });

  describe('getSession', () => {
    it('returns an existing session', () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const created = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );

      const fetched = manager.getSession(created.id);
      expect(fetched.id).toBe(created.id);
    });

    it('throws SessionNotFoundError for unknown id', () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      expect(() => manager.getSession('nonexistent')).toThrow(SessionNotFoundError);
    });
  });

  describe('listSessions', () => {
    it('lists all sessions', () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      manager.createSession({ profileName: 'test-profile', task: 'Task 1' }, 'user-1');
      manager.createSession({ profileName: 'test-profile', task: 'Task 2' }, 'user-2');

      const sessions = manager.listSessions();
      expect(sessions).toHaveLength(2);
    });

    it('filters by userId', () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      manager.createSession({ profileName: 'test-profile', task: 'Task 1' }, 'user-1');
      manager.createSession({ profileName: 'test-profile', task: 'Task 2' }, 'user-2');

      const sessions = manager.listSessions({ userId: 'user-1' });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.userId).toBe('user-1');
    });
  });

  describe('killSession', () => {
    it('transitions session through killing to killed', async () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );

      // Session is in queued state, which is killable
      await manager.killSession(session.id);

      const killed = manager.getSession(session.id);
      expect(killed.status).toBe('killed');
      expect(killed.completedAt).not.toBeNull();
    });

    it('emits session.completed event with killed status', async () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );

      const events: unknown[] = [];
      ctx.eventBus.subscribe((e) => events.push(e));

      await manager.killSession(session.id);

      const completedEvent = events.find((e: any) => e.type === 'session.completed') as any;
      expect(completedEvent).toBeDefined();
      expect(completedEvent.finalStatus).toBe('killed');
    });

    it('calls container kill and worktree cleanup when present', async () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );

      // Manually set containerId and worktreePath to simulate a running session
      ctx.sessionRepo.update(session.id, {
        containerId: 'ctr-1',
        worktreePath: '/tmp/wt',
      });

      await manager.killSession(session.id);

      expect(ctx.containerManager.kill).toHaveBeenCalledWith('ctr-1');
      expect(ctx.worktreeManager.cleanup).toHaveBeenCalledWith('/tmp/wt');
    });

    it('throws for sessions that cannot be killed', async () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );

      // Move to a non-killable state: queued -> provisioning -> running -> validating -> validated -> approved
      ctx.sessionRepo.update(session.id, { status: 'approved' });

      await expect(manager.killSession(session.id)).rejects.toThrow(AutopodError);
    });
  });

  describe('approveSession', () => {
    it('transitions validated -> approved -> merging -> complete', async () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );

      // Move to validated state
      ctx.sessionRepo.update(session.id, { status: 'validated' });

      await manager.approveSession(session.id);

      const approved = manager.getSession(session.id);
      expect(approved.status).toBe('complete');
      expect(approved.completedAt).not.toBeNull();
    });

    it('emits session.completed event', async () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.sessionRepo.update(session.id, { status: 'validated' });

      const events: unknown[] = [];
      ctx.eventBus.subscribe((e) => events.push(e));

      await manager.approveSession(session.id);

      const completedEvent = events.find((e: any) => e.type === 'session.completed') as any;
      expect(completedEvent).toBeDefined();
      expect(completedEvent.finalStatus).toBe('complete');
    });

    it('merges PR when prUrl exists', async () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.sessionRepo.update(session.id, {
        status: 'validated',
        worktreePath: '/tmp/wt',
        prUrl: 'https://github.com/org/repo/pull/42',
      });

      await manager.approveSession(session.id);

      expect(ctx.prManager.mergePr).toHaveBeenCalledWith({
        worktreePath: '/tmp/wt',
        prUrl: 'https://github.com/org/repo/pull/42',
        squash: undefined,
      });
      // Should NOT fall back to direct branch push
      expect(ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    });

    it('passes squash option to PR merge', async () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.sessionRepo.update(session.id, {
        status: 'validated',
        worktreePath: '/tmp/wt',
        prUrl: 'https://github.com/org/repo/pull/42',
      });

      await manager.approveSession(session.id, { squash: true });

      expect(ctx.prManager.mergePr).toHaveBeenCalledWith(expect.objectContaining({ squash: true }));
    });

    it('falls back to branch push when no prUrl', async () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.sessionRepo.update(session.id, { status: 'validated', worktreePath: '/tmp/wt' });

      await manager.approveSession(session.id);

      expect(ctx.worktreeManager.mergeBranch).toHaveBeenCalledWith({
        worktreePath: '/tmp/wt',
        targetBranch: 'main',
      });
      expect(ctx.prManager.mergePr).not.toHaveBeenCalled();
    });
  });

  describe('rejectSession', () => {
    it('resumes agent with rejection feedback and completes cycle', async () => {
      // With passing validation, rejection triggers: resume → agent → validation pass → validated
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.sessionRepo.update(session.id, { status: 'validated', containerId: 'ctr-1' });

      await manager.rejectSession(session.id, 'Button color wrong');

      // Agent was resumed with the rejection feedback (3rd arg is containerId)
      const resumeCalls = vi.mocked(ctx.runtime.resume).mock.calls;
      expect(resumeCalls.length).toBeGreaterThanOrEqual(1);
      const resumeMessage = resumeCalls[0]?.[1] as string;
      expect(resumeMessage).toContain('Button color wrong');
      expect(resumeMessage).toContain('Rejected by Reviewer');

      // Full cycle completes: rejection → agent runs → validation passes → validated
      const result = manager.getSession(session.id);
      expect(result.status).toBe('validated');
    });

    it('resets validation attempts before resuming agent', async () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.sessionRepo.update(session.id, {
        status: 'validated',
        validationAttempts: 2,
        containerId: 'ctr-1',
      });

      await manager.rejectSession(session.id, 'Needs more work');

      // Validation attempts were reset (then incremented by 1 during the new validation cycle)
      const result = manager.getSession(session.id);
      expect(result.validationAttempts).toBe(1);
      expect(result.status).toBe('validated');
    });

    it('allows rejection from failed state', async () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.sessionRepo.update(session.id, {
        status: 'failed',
        validationAttempts: 3,
        containerId: 'ctr-1',
      });

      await manager.rejectSession(session.id, 'Try a different approach');

      // Agent was given another chance; with passing validation mock it ends up validated
      expect(ctx.runtime.resume).toHaveBeenCalled();
      const result = manager.getSession(session.id);
      expect(result.status).toBe('validated');
    });

    it('throws for invalid state transition', async () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );

      // queued -> running is not a valid transition
      await expect(manager.rejectSession(session.id)).rejects.toThrow(InvalidStateTransitionError);
    });
  });

  describe('state transitions', () => {
    it('emits status_changed events on transitions', async () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );

      const statusEvents: unknown[] = [];
      ctx.eventBus.subscribe((e) => {
        if ((e as any).type === 'session.status_changed') statusEvents.push(e);
      });

      // Kill goes through queued -> killing -> killed (2 transitions)
      await manager.killSession(session.id);

      expect(statusEvents).toHaveLength(2);
      expect((statusEvents[0] as any).previousStatus).toBe('queued');
      expect((statusEvents[0] as any).newStatus).toBe('killing');
      expect((statusEvents[1] as any).previousStatus).toBe('killing');
      expect((statusEvents[1] as any).newStatus).toBe('killed');
    });
  });

  describe('processSession', () => {
    it('transitions through provisioning and running', async () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature', skipValidation: true },
        'user-1',
      );

      await manager.processSession(session.id);

      const processed = manager.getSession(session.id);
      // With skipValidation and empty agent events, should end up at validated
      expect(processed.status).toBe('validated');
      expect(processed.containerId).toBe('container-123');
      expect(processed.worktreePath).toBe('/tmp/worktree/abc');
    });

    it('calls containerManager.spawn and worktreeManager.create', async () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature', skipValidation: true },
        'user-1',
      );

      await manager.processSession(session.id);

      expect(ctx.containerManager.spawn).toHaveBeenCalled();
      expect(ctx.worktreeManager.create).toHaveBeenCalled();
      expect(ctx.containerManager.writeFile).toHaveBeenCalled();
    });

    it('handles errors by killing the session', async () => {
      const ctx = createTestContext();
      (ctx.containerManager.spawn as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Docker failed'),
      );

      const manager = createSessionManager(ctx.deps);
      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );

      await manager.processSession(session.id);

      // Should have been killed due to error during provisioning
      const result = manager.getSession(session.id);
      expect(result.status).toBe('killed');
    });
  });

  describe('triggerValidation', () => {
    it('transitions to validated on pass', async () => {
      const ctx = createTestContext({ overall: 'pass' });
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      ctx.sessionRepo.update(session.id, {
        status: 'running',
        containerId: 'ctr-1',
        worktreePath: '/tmp/wt',
      });

      await manager.triggerValidation(session.id);

      const result = manager.getSession(session.id);
      expect(result.status).toBe('validated');
    });

    it('pushes branch and creates PR on validation pass', async () => {
      const ctx = createTestContext({ overall: 'pass' });
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      ctx.sessionRepo.update(session.id, {
        status: 'running',
        containerId: 'ctr-1',
        worktreePath: '/tmp/wt',
      });

      await manager.triggerValidation(session.id);

      // Branch was pushed
      expect(ctx.worktreeManager.mergeBranch).toHaveBeenCalledWith({
        worktreePath: '/tmp/wt',
        targetBranch: 'main',
      });

      // PR was created
      expect(ctx.prManager.createPr).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: session.id,
          task: 'Add feature',
          profileName: 'test-profile',
          baseBranch: 'main',
        }),
      );

      // PR URL stored on session
      const result = manager.getSession(session.id);
      expect(result.prUrl).toBe('https://github.com/org/repo/pull/42');
    });

    it('still validates even if PR creation fails', async () => {
      const ctx = createTestContext({ overall: 'pass' });
      (ctx.prManager.createPr as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('gh not found'),
      );
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      ctx.sessionRepo.update(session.id, {
        status: 'running',
        containerId: 'ctr-1',
        worktreePath: '/tmp/wt',
      });

      await manager.triggerValidation(session.id);

      const result = manager.getSession(session.id);
      expect(result.status).toBe('validated');
      expect(result.prUrl).toBeNull();
    });

    it('transitions to failed after max validation attempts', async () => {
      const ctx = createTestContext({ overall: 'fail' });
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      // Already used 2 attempts, max is 3, so this attempt (#3) is the last
      ctx.sessionRepo.update(session.id, {
        status: 'running',
        containerId: 'ctr-1',
        validationAttempts: 2,
      });

      await manager.triggerValidation(session.id);

      const result = manager.getSession(session.id);
      expect(result.status).toBe('failed');
    });

    it('retries with correction feedback until max attempts exhausted', async () => {
      // With always-failing validation, the retry loop exhausts all attempts
      const ctx = createTestContext({ overall: 'fail' });
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      ctx.sessionRepo.update(session.id, {
        status: 'running',
        containerId: 'ctr-1',
        validationAttempts: 0,
      });

      await manager.triggerValidation(session.id);

      // Agent was resumed with correction feedback for each retry (attempts 1 and 2)
      const resumeCalls = vi.mocked(ctx.runtime.resume).mock.calls;
      expect(resumeCalls.length).toBe(2);
      expect(resumeCalls[0]?.[1]).toContain('Validation Failed');
      // 2 retries before exhaustion (attempt 1 → retry, attempt 2 → retry, attempt 3 → failed)
      expect(ctx.runtime.resume).toHaveBeenCalledTimes(2);

      const result = manager.getSession(session.id);
      expect(result.status).toBe('failed');
      expect(result.validationAttempts).toBe(3);
    });

    it('does not resume agent on final attempt failure', async () => {
      const ctx = createTestContext({ overall: 'fail' });
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      ctx.sessionRepo.update(session.id, {
        status: 'running',
        containerId: 'ctr-1',
        validationAttempts: 2, // this is the last attempt
      });

      await manager.triggerValidation(session.id);

      // No resume — max retries exhausted on this attempt
      expect(ctx.runtime.resume).not.toHaveBeenCalled();
      expect(manager.getSession(session.id).status).toBe('failed');
    });
  });

  describe('sendMessage', () => {
    it('throws if session is not awaiting_input', async () => {
      const ctx = createTestContext();
      const manager = createSessionManager(ctx.deps);

      const session = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );

      await expect(manager.sendMessage(session.id, 'hello')).rejects.toThrow(AutopodError);
    });
  });

  describe('workspace sessions', () => {
    describe('createSession', () => {
      it('stores outputMode and baseBranch', () => {
        const ctx = createTestContext();
        const manager = createSessionManager(ctx.deps);

        const session = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Plan auth redesign',
            outputMode: 'workspace',
            baseBranch: 'feat/plan-auth',
          },
          'user-1',
        );

        expect(session.outputMode).toBe('workspace');
        expect(session.baseBranch).toBe('feat/plan-auth');
      });

      it('defaults outputMode to pr when not specified', () => {
        const ctx = createTestContext();
        const manager = createSessionManager(ctx.deps);

        const session = manager.createSession(
          { profileName: 'test-profile', task: 'Do stuff' },
          'user-1',
        );

        expect(session.outputMode).toBe('pr');
        expect(session.baseBranch).toBeNull();
      });

      it('stores acFrom on the session', () => {
        const ctx = createTestContext();
        const manager = createSessionManager(ctx.deps);

        const session = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Execute plan',
            acFrom: 'specs/auth/acceptance-criteria.md',
          },
          'user-1',
        );

        expect(session.acFrom).toBe('specs/auth/acceptance-criteria.md');
      });
    });

    describe('processSession', () => {
      it('passes baseBranch to worktreeManager.create', async () => {
        const ctx = createTestContext();
        const manager = createSessionManager(ctx.deps);

        const session = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Plan auth',
            outputMode: 'workspace',
            baseBranch: 'feat/plan-auth',
          },
          'user-1',
        );

        await manager.processSession(session.id);

        expect(ctx.worktreeManager.create).toHaveBeenCalledWith(
          expect.objectContaining({
            baseBranch: 'feat/plan-auth',
          }),
        );
      });

      it('returns early for workspace sessions — no agent spawn', async () => {
        const ctx = createTestContext();
        const manager = createSessionManager(ctx.deps);

        const session = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Workspace session',
            outputMode: 'workspace',
          },
          'user-1',
        );

        await manager.processSession(session.id);

        const updated = manager.getSession(session.id);
        expect(updated.status).toBe('running');
        expect(updated.containerId).toBe('container-123');
        expect(updated.worktreePath).toBe('/tmp/worktree/abc');

        // Agent should NOT have been spawned
        expect(ctx.runtime.spawn).not.toHaveBeenCalled();
      });

      it('reads acFrom file and populates acceptanceCriteria', async () => {
        const ctx = createTestContext();
        const manager = createSessionManager(ctx.deps);

        // Create a temp file for the AC
        const fs = await import('node:fs/promises');
        const tmpPath = '/tmp/worktree/abc';
        await fs.mkdir(`${tmpPath}/specs`, { recursive: true });
        await fs.writeFile(`${tmpPath}/specs/ac.md`, '- Login works\n- Logout works\n');

        const session = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Execute plan',
            outputMode: 'workspace',
            acFrom: 'specs/ac.md',
          },
          'user-1',
        );

        await manager.processSession(session.id);

        const updated = manager.getSession(session.id);
        expect(updated.acceptanceCriteria).toEqual(['Login works', 'Logout works']);

        // Cleanup
        await fs.rm(`${tmpPath}/specs`, { recursive: true, force: true });
      });
    });

    describe('completeSession', () => {
      it('pushes branch and transitions running → complete', async () => {
        const ctx = createTestContext();
        const manager = createSessionManager(ctx.deps);

        const session = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Workspace session',
            outputMode: 'workspace',
          },
          'user-1',
        );

        // Simulate processSession having run: set status to running with worktreePath
        ctx.sessionRepo.update(session.id, {
          status: 'running',
          worktreePath: '/tmp/worktree/abc',
          startedAt: new Date().toISOString(),
        });

        const result = await manager.completeSession(session.id);

        expect(result.pushError).toBeUndefined();
        expect(ctx.worktreeManager.pushBranch).toHaveBeenCalledWith('/tmp/worktree/abc');

        const completed = manager.getSession(session.id);
        expect(completed.status).toBe('complete');
        expect(completed.completedAt).not.toBeNull();
      });

      it('emits session.completed event', async () => {
        const ctx = createTestContext();
        const manager = createSessionManager(ctx.deps);

        const session = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Workspace session',
            outputMode: 'workspace',
          },
          'user-1',
        );

        ctx.sessionRepo.update(session.id, {
          status: 'running',
          worktreePath: '/tmp/worktree/abc',
          startedAt: new Date().toISOString(),
        });

        const events: unknown[] = [];
        ctx.eventBus.subscribe((e) => events.push(e));

        await manager.completeSession(session.id);

        const completedEvent = events.find((e: any) => e.type === 'session.completed') as any;
        expect(completedEvent).toBeDefined();
        expect(completedEvent.finalStatus).toBe('complete');
      });

      it('rejects non-workspace sessions', async () => {
        const ctx = createTestContext();
        const manager = createSessionManager(ctx.deps);

        const session = manager.createSession(
          { profileName: 'test-profile', task: 'Normal session' },
          'user-1',
        );

        ctx.sessionRepo.update(session.id, { status: 'running' });

        await expect(manager.completeSession(session.id)).rejects.toThrow(AutopodError);
        await expect(manager.completeSession(session.id)).rejects.toMatchObject({
          code: 'INVALID_OUTPUT_MODE',
        });
      });

      it('rejects sessions not in running status', async () => {
        const ctx = createTestContext();
        const manager = createSessionManager(ctx.deps);

        const session = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Workspace session',
            outputMode: 'workspace',
          },
          'user-1',
        );

        // Session is in queued status — not running
        await expect(manager.completeSession(session.id)).rejects.toThrow(AutopodError);
        await expect(manager.completeSession(session.id)).rejects.toMatchObject({
          code: 'INVALID_STATE',
        });
      });

      it('surfaces push errors without blocking completion', async () => {
        const ctx = createTestContext();
        (ctx.worktreeManager.pushBranch as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error('remote: Permission denied'),
        );
        const manager = createSessionManager(ctx.deps);

        const session = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Workspace session',
            outputMode: 'workspace',
          },
          'user-1',
        );

        ctx.sessionRepo.update(session.id, {
          status: 'running',
          worktreePath: '/tmp/worktree/abc',
          startedAt: new Date().toISOString(),
        });

        const result = await manager.completeSession(session.id);

        expect(result.pushError).toBe('remote: Permission denied');
        // Session still transitions to complete
        const completed = manager.getSession(session.id);
        expect(completed.status).toBe('complete');
      });
    });
  });
});
