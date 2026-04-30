import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentEvent,
  Runtime,
  RuntimeType,
  StackTemplate,
  ValidationResult,
} from '@autopod/shared';
import { AutopodError, InvalidStateTransitionError, PodNotFoundError } from '@autopod/shared';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process so we can control deriveBareRepoPath and recovery-context git calls
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';

const mockedExecFile = vi.mocked(execFile);
import type {
  ContainerManager,
  PrManager,
  RuntimeRegistry,
  ValidationEngine,
  WorktreeManager,
} from '../interfaces/index.js';
import type { ProfileStore } from '../profiles/index.js';
import { DeletionGuardError } from '../worktrees/local-worktree-manager.js';
import { createEscalationRepository } from './escalation-repository.js';
import type { EscalationRepository } from './escalation-repository.js';
import { createEventBus } from './event-bus.js';
import type { EventBus } from './event-bus.js';
import { createEventRepository } from './event-repository.js';
import { type PodManagerDependencies, createPodManager } from './pod-manager.js';
import { createPodRepository } from './pod-repository.js';
import type { PodRepository } from './pod-repository.js';

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

interface TestProfileOverrides {
  name?: string;
  privateRegistries?: string;
  registryPat?: string;
  branchPrefix?: string;
  githubPat?: string;
  adoPat?: string;
  prProvider?: 'github' | 'ado';
}

function insertTestProfile(db: Database.Database, overrides: TestProfileOverrides | string = {}) {
  // Backwards compat: accept plain string as name
  const opts = typeof overrides === 'string' ? { name: overrides } : overrides;
  const name = opts.name ?? 'test-profile';

  db.prepare(`
    INSERT INTO profiles (
      name, repo_url, default_branch, template, build_command, start_command,
      health_path, health_timeout, validation_pages, max_validation_attempts,
      default_model, default_runtime, escalation_config,
      private_registries, registry_pat, branch_prefix,
      pr_provider, github_pat, ado_pat
    ) VALUES (
      @name, @repoUrl, @defaultBranch, @template, @buildCommand, @startCommand,
      @healthPath, @healthTimeout, @validationPages, @maxValidationAttempts,
      @defaultModel, @defaultRuntime, @escalationConfig,
      @privateRegistries, @registryPat, @branchPrefix,
      @prProvider, @githubPat, @adoPat
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
      advisor: { enabled: false },
      autoPauseAfter: 3,
      humanResponseTimeout: 3600,
    }),
    privateRegistries: opts.privateRegistries ?? '[]',
    registryPat: opts.registryPat ?? null,
    branchPrefix: opts.branchPrefix ?? 'autopod/',
    prProvider: opts.prProvider ?? 'github',
    githubPat: opts.githubPat ?? null,
    adoPat: opts.adoPat ?? null,
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
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    refreshFirewall: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => ''),
    extractDirectoryFromContainer: vi.fn(async () => {}),
    getStatus: vi.fn(async () => 'running' as const),
    execInContainer: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    execStreaming: vi.fn(),
  };
}

function createMockWorktreeManager(): WorktreeManager {
  return {
    create: vi.fn(async () => ({
      worktreePath: '/tmp/worktree/abc',
      bareRepoPath: '/tmp/bare/abc.git',
      startCommitSha: 'abc1234567890abcdef1234567890abcdef1234',
    })),
    cleanup: vi.fn(async () => {}),
    getDiffStats: vi.fn(async () => ({ filesChanged: 3, linesAdded: 50, linesRemoved: 10 })),
    getDiff: vi.fn(async () => 'diff --git a/file.ts b/file.ts\n+added line'),
    mergeBranch: vi.fn(async () => {}),
    commitFiles: vi.fn(async () => {}),
    pushBranch: vi.fn(async () => {}),
    getCommitLog: vi.fn(async () => 'abc1234 feat: implement feature\ndef5678 fix: edge case'),
    readBranchFolder: vi.fn(async ({ relPath }) => ({
      relPath,
      files: [],
      sharedContext: '',
    })),
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
    mergePr: vi.fn(async () => ({ merged: true, autoMergeScheduled: false })),
    getPrStatus: vi.fn(async () => ({ merged: true, open: false, blockReason: null })),
  };
}

function createMockValidationEngine(result?: Partial<ValidationResult>): ValidationEngine {
  return {
    validate: vi.fn(async () => ({
      podId: 'test',
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
  podRepo: PodRepository;
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
  deps: PodManagerDependencies;
}

function createTestContext(
  validationResult?: Partial<ValidationResult>,
  profileOverrides?: TestProfileOverrides,
): TestContext {
  const db = createTestDb();
  insertTestProfile(db, profileOverrides ?? {});

  const podRepo = createPodRepository(db);
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
        testCommand: (row.test_command as string) ?? null,
        prProvider: (row.pr_provider as 'github' | 'ado') ?? 'github',
        adoPat: (row.ado_pat as string) ?? null,
        githubPat: (row.github_pat as string) ?? null,
        skills: JSON.parse((row.skills as string) ?? '[]'),
        privateRegistries: JSON.parse((row.private_registries as string) ?? '[]'),
        registryPat: (row.registry_pat as string) ?? null,
        branchPrefix: (row.branch_prefix as string) ?? 'autopod/',
        containerMemoryGb: (row.container_memory_gb as number | null) ?? null,
        buildTimeout: (row.build_timeout as number | null) ?? 300,
        testTimeout: (row.test_timeout as number | null) ?? 600,
        version: (row.version as number | null) ?? 1,
        tokenBudget: (row.token_budget as number | null) ?? null,
        tokenBudgetWarnAt: (row.token_budget_warn_at as number | null) ?? 0.8,
        tokenBudgetPolicy: (row.token_budget_policy as 'soft' | 'hard' | null) ?? 'soft',
        maxBudgetExtensions: (row.max_budget_extensions as number | null) ?? null,
        workerProfile: (row.worker_profile as string) ?? null,
        reuseFixPod: ((row.reuse_fix_pod as number) ?? 0) === 1,
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

  const deps: PodManagerDependencies = {
    podRepo,
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
    podRepo,
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

describe('PodManager', () => {
  describe('createSession', () => {
    it('creates a pod in queued status', () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add dark mode' },
        'user-1',
      );

      expect(pod.status).toBe('queued');
      expect(pod.profileName).toBe('test-profile');
      expect(pod.task).toBe('Add dark mode');
      expect(pod.userId).toBe('user-1');
      expect(pod.model).toBe('opus');
      expect(pod.runtime).toBe('claude');
      expect(pod.branch).toContain('autopod/');
    });

    it('uses custom model and branch when provided', () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Fix bug', model: 'sonnet', branch: 'fix/my-bug' },
        'user-1',
      );

      expect(pod.model).toBe('sonnet');
      expect(pod.branch).toBe('fix/my-bug');
    });

    it('enqueues the pod for processing', () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );

      expect(ctx.enqueuedSessions).toContain(pod.id);
    });

    it('uses profile branchPrefix for auto-generated branch names', () => {
      const ctx = createTestContext(undefined, { branchPrefix: 'feature/' });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );

      expect(pod.branch).toMatch(/^feature\//);
      expect(pod.branch).not.toContain('autopod/');
    });

    it('uses request branchPrefix over profile branchPrefix', () => {
      const ctx = createTestContext(undefined, { branchPrefix: 'feature/' });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Hotfix', branchPrefix: 'hotfix/' },
        'user-1',
      );

      expect(pod.branch).toMatch(/^hotfix\//);
    });

    it('ignores branchPrefix when explicit branch is provided', () => {
      const ctx = createTestContext(undefined, { branchPrefix: 'feature/' });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Fix',
          branch: 'my-custom-branch',
          branchPrefix: 'hotfix/',
        },
        'user-1',
      );

      expect(pod.branch).toBe('my-custom-branch');
    });

    it('emits pod.created event', () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const events: unknown[] = [];
      ctx.eventBus.subscribe((e) => events.push(e));

      manager.createSession({ profileName: 'test-profile', task: 'Do stuff' }, 'user-1');

      // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union for field access
      const createdEvent = events.find((e: any) => e.type === 'pod.created');
      expect(createdEvent).toBeDefined();
    });
  });

  describe('getSession', () => {
    it('returns an existing pod', () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const created = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );

      const fetched = manager.getSession(created.id);
      expect(fetched.id).toBe(created.id);
    });

    it('throws PodNotFoundError for unknown id', () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      expect(() => manager.getSession('nonexistent')).toThrow(PodNotFoundError);
    });
  });

  describe('listSessions', () => {
    it('lists all pods', () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      manager.createSession({ profileName: 'test-profile', task: 'Task 1' }, 'user-1');
      manager.createSession({ profileName: 'test-profile', task: 'Task 2' }, 'user-2');

      const pods = manager.listSessions();
      expect(pods).toHaveLength(2);
    });

    it('filters by userId', () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      manager.createSession({ profileName: 'test-profile', task: 'Task 1' }, 'user-1');
      manager.createSession({ profileName: 'test-profile', task: 'Task 2' }, 'user-2');

      const pods = manager.listSessions({ userId: 'user-1' });
      expect(pods).toHaveLength(1);
      expect(pods[0]?.userId).toBe('user-1');
    });

    it('auto-attaches profile-enabled trusted sidecars without explicit request', () => {
      const ctx = createTestContext();
      // Override profile to enable Dagger + trustedSource. Auto-attach should
      // fold 'dagger' into pod.requireSidecars even though the request omits it.
      const baseGet = ctx.profileStore.get;
      ctx.profileStore.get = vi.fn((name: string) => ({
        ...baseGet(name),
        trustedSource: true,
        sidecars: {
          dagger: {
            enabled: true,
            engineImageDigest: `registry.dagger.io/engine@sha256:${'a'.repeat(64)}`,
            engineVersion: 'v0.18.6',
          },
        },
      }));
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'build a Dagger module' },
        'user-1',
      );

      expect(pod.requireSidecars).toEqual(['dagger']);
    });

    it('does not auto-attach Dagger when the profile is not trustedSource', () => {
      const ctx = createTestContext();
      const baseGet = ctx.profileStore.get;
      ctx.profileStore.get = vi.fn((name: string) => ({
        ...baseGet(name),
        trustedSource: false,
        sidecars: {
          dagger: {
            enabled: true,
            engineImageDigest: `registry.dagger.io/engine@sha256:${'a'.repeat(64)}`,
            engineVersion: 'v0.18.6',
          },
        },
      }));
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'untrusted profile' },
        'user-1',
      );

      // requireSidecars defaults to [] in the Pod type
      expect(pod.requireSidecars).toEqual([]);
    });

    it('dedupes when caller explicitly requests an already auto-attached sidecar', () => {
      const ctx = createTestContext();
      const baseGet = ctx.profileStore.get;
      ctx.profileStore.get = vi.fn((name: string) => ({
        ...baseGet(name),
        trustedSource: true,
        sidecars: {
          dagger: {
            enabled: true,
            engineImageDigest: `registry.dagger.io/engine@sha256:${'a'.repeat(64)}`,
            engineVersion: 'v0.18.6',
          },
        },
      }));
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'redundant explicit request',
          requireSidecars: ['dagger'],
        },
        'user-1',
      );

      expect(pod.requireSidecars).toEqual(['dagger']);
    });
  });

  describe('killSession', () => {
    it('transitions pod through killing to killed', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );

      // Pod is in queued state, which is killable
      await manager.killSession(pod.id);

      const killed = manager.getSession(pod.id);
      expect(killed.status).toBe('killed');
      expect(killed.completedAt).not.toBeNull();
    });

    it('emits pod.completed event with killed status', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );

      const events: unknown[] = [];
      ctx.eventBus.subscribe((e) => events.push(e));

      await manager.killSession(pod.id);

      // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union for field access
      const completedEvent = events.find((e: any) => e.type === 'pod.completed') as any;
      expect(completedEvent).toBeDefined();
      expect(completedEvent.finalStatus).toBe('killed');
    });

    it('calls container kill and worktree cleanup when present', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );

      // Manually set containerId and worktreePath to simulate a running pod
      ctx.podRepo.update(pod.id, {
        containerId: 'ctr-1',
        worktreePath: '/tmp/wt',
      });

      await manager.killSession(pod.id);

      expect(ctx.containerManager.kill).toHaveBeenCalledWith('ctr-1');
      expect(ctx.worktreeManager.cleanup).toHaveBeenCalledWith('/tmp/wt');
    });

    it('throws for pods that cannot be killed', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );

      // Move to a non-killable state: queued -> provisioning -> running -> validating -> validated -> approved
      ctx.podRepo.update(pod.id, { status: 'approved' });

      await expect(manager.killSession(pod.id)).rejects.toThrow(AutopodError);
    });

    it('keeps queued dependents in queued state when parent is killed', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const parent = manager.createSession(
        { profileName: 'test-profile', task: 'Parent task' },
        'user-1',
      );
      const child = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Child task',
          dependsOnPodIds: [parent.id],
        },
        'user-1',
      );

      await manager.killSession(parent.id);

      expect(manager.getSession(parent.id).status).toBe('killed');
      // Dependents must stay queued — they never ran and should remain schedulable
      // when the parent is eventually re-queued via rework.
      const childResult = manager.getSession(child.id);
      expect(childResult.status).toBe('queued');
      expect(childResult.mergeBlockReason).toBeNull();
    });
  });

  describe('approveSession', () => {
    it('transitions validated -> approved -> merging -> complete', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );

      // Move to validated state
      ctx.podRepo.update(pod.id, { status: 'validated' });

      await manager.approveSession(pod.id);

      const approved = manager.getSession(pod.id);
      expect(approved.status).toBe('complete');
      expect(approved.completedAt).not.toBeNull();
    });

    it('emits pod.completed event', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, { status: 'validated' });

      const events: unknown[] = [];
      ctx.eventBus.subscribe((e) => events.push(e));

      await manager.approveSession(pod.id);

      // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union for field access
      const completedEvent = events.find((e: any) => e.type === 'pod.completed') as any;
      expect(completedEvent).toBeDefined();
      expect(completedEvent.finalStatus).toBe('complete');
    });

    it('merges PR when prUrl exists', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'validated',
        worktreePath: '/tmp/wt',
        prUrl: 'https://github.com/org/repo/pull/42',
      });

      await manager.approveSession(pod.id);

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
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'validated',
        worktreePath: '/tmp/wt',
        prUrl: 'https://github.com/org/repo/pull/42',
      });

      await manager.approveSession(pod.id, { squash: true });

      expect(ctx.prManager.mergePr).toHaveBeenCalledWith(expect.objectContaining({ squash: true }));
    });

    it('creates and merges PR when prUrl is missing but prManager is available', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'validated',
        worktreePath: '/tmp/wt',
        filesChanged: 1,
      });

      await manager.approveSession(pod.id);

      // Branch is pushed first, then PR is created and merged. The push must target the
      // feature branch (pod.branch) — not the base branch — or it would force-push onto main.
      expect(ctx.worktreeManager.mergeBranch).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: '/tmp/wt',
          targetBranch: pod.branch,
        }),
      );
      expect(ctx.prManager.createPr).toHaveBeenCalled();
      expect(ctx.prManager.mergePr).toHaveBeenCalledWith(
        expect.objectContaining({ prUrl: 'https://github.com/org/repo/pull/42' }),
      );
    });

    it('falls back to branch push when no prUrl and no prManager', async () => {
      const ctx = createTestContext();
      ctx.deps.prManagerFactory = undefined;
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'validated',
        worktreePath: '/tmp/wt',
        filesChanged: 1,
      });

      await manager.approveSession(pod.id);

      expect(ctx.worktreeManager.mergeBranch).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: '/tmp/wt',
          targetBranch: pod.branch,
        }),
      );
      expect(ctx.prManager.mergePr).not.toHaveBeenCalled();
    });

    // Regression: approval-time mergeBranch sites used to omit the PAT, so a daemon
    // restart between worktree create and approval (or a recovery pod that mounts an
    // existing worktree) left the in-memory PAT cache cold. ADO clone URLs of the
    // form https://<org>@dev.azure.com/... then prompted for a password, and with
    // GIT_TERMINAL_PROMPT=0 the push died with "could not read Password".
    it('forwards profile PAT into mergeBranch on approval-time PR creation retry', async () => {
      const ctx = createTestContext(undefined, { githubPat: 'ghp_test_pat_12345' });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'validated',
        worktreePath: '/tmp/wt',
        filesChanged: 1,
      });

      await manager.approveSession(pod.id);

      expect(ctx.worktreeManager.mergeBranch).toHaveBeenCalledWith(
        expect.objectContaining({ pat: 'ghp_test_pat_12345' }),
      );
    });

    it('forwards profile PAT into mergeBranch on approval-time fallback push (no prManager)', async () => {
      const ctx = createTestContext(undefined, { githubPat: 'ghp_test_pat_67890' });
      ctx.deps.prManagerFactory = undefined;
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'validated',
        worktreePath: '/tmp/wt',
        filesChanged: 1,
      });

      await manager.approveSession(pod.id);

      expect(ctx.worktreeManager.mergeBranch).toHaveBeenCalledWith(
        expect.objectContaining({ pat: 'ghp_test_pat_67890' }),
      );
    });

    it('forwards profile.adoPat for ADO profiles (prProvider=ado) on approval push', async () => {
      const ctx = createTestContext(undefined, {
        prProvider: 'ado',
        adoPat: 'ado_test_pat_xyz',
        githubPat: 'should_not_be_used',
      });
      ctx.deps.prManagerFactory = undefined;
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'validated',
        worktreePath: '/tmp/wt',
        filesChanged: 1,
      });

      await manager.approveSession(pod.id);

      expect(ctx.worktreeManager.mergeBranch).toHaveBeenCalledWith(
        expect.objectContaining({ pat: 'ado_test_pat_xyz' }),
      );
    });

    it('enqueues dependent series pod after manual approval', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const parent = manager.createSession(
        { profileName: 'test-profile', task: 'Parent task' },
        'user-1',
      );
      const child = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Child task',
          dependsOnPodIds: [parent.id],
        },
        'user-1',
      );

      // Child must not be enqueued yet (waiting for parent)
      expect(ctx.enqueuedSessions).not.toContain(child.id);

      ctx.podRepo.update(parent.id, { status: 'validated', branch: 'feature/parent' });
      await manager.approveSession(parent.id);

      expect(manager.getSession(parent.id).status).toBe('complete');
      expect(ctx.enqueuedSessions).toContain(child.id);
    });

    it('rehydrate defers shared-branch child until parent reaches complete', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      // Single-mode series: every pod reuses the root's branch.
      const sharedBranch = 'feature/shared';
      const parent = manager.createSession(
        { profileName: 'test-profile', task: 'Parent task', branch: sharedBranch },
        'user-1',
      );
      const child = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Child task',
          branch: sharedBranch,
          dependsOnPodIds: [parent.id],
        },
        'user-1',
      );

      ctx.podRepo.update(parent.id, { status: 'validated' });
      ctx.enqueuedSessions.length = 0;

      manager.rehydrateDependentSessions();
      expect(ctx.enqueuedSessions).not.toContain(child.id);

      // Parent reaches complete → worktree released → child can start.
      ctx.podRepo.update(parent.id, { status: 'complete' });
      manager.rehydrateDependentSessions();
      expect(ctx.enqueuedSessions).toContain(child.id);
    });
  });

  describe('rejectSession', () => {
    it('resumes agent with rejection feedback and completes cycle', async () => {
      // With passing validation, rejection triggers: resume → agent → validation pass → validated
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, { status: 'validated', containerId: 'ctr-1' });

      await manager.rejectSession(pod.id, 'Button color wrong');

      // Agent was resumed with the rejection feedback (3rd arg is containerId)
      const resumeCalls = vi.mocked(ctx.runtime.resume).mock.calls;
      expect(resumeCalls.length).toBeGreaterThanOrEqual(1);
      const resumeMessage = resumeCalls[0]?.[1] as string;
      expect(resumeMessage).toContain('Button color wrong');
      expect(resumeMessage).toContain('Rejected by Reviewer');

      // Full cycle completes: rejection → agent runs → validation passes → validated
      const result = manager.getSession(pod.id);
      expect(result.status).toBe('validated');
    });

    it('resets validation attempts before resuming agent', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'validated',
        validationAttempts: 2,
        containerId: 'ctr-1',
      });

      await manager.rejectSession(pod.id, 'Needs more work');

      // Validation attempts were reset (then incremented by 1 during the new validation cycle)
      const result = manager.getSession(pod.id);
      expect(result.validationAttempts).toBe(1);
      expect(result.status).toBe('validated');
    });

    it('allows rejection from failed state', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'failed',
        validationAttempts: 3,
        containerId: 'ctr-1',
      });

      await manager.rejectSession(pod.id, 'Try a different approach');

      // Agent was given another chance; with passing validation mock it ends up validated
      expect(ctx.runtime.resume).toHaveBeenCalled();
      const result = manager.getSession(pod.id);
      expect(result.status).toBe('validated');
    });

    it('throws for invalid state transition', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );

      // queued -> running is not a valid transition
      await expect(manager.rejectSession(pod.id)).rejects.toThrow(InvalidStateTransitionError);
    });
  });

  describe('state transitions', () => {
    it('emits status_changed events on transitions', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );

      const statusEvents: unknown[] = [];
      ctx.eventBus.subscribe((e) => {
        // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union for field access
        if ((e as any).type === 'pod.status_changed') statusEvents.push(e);
      });

      // Kill goes through queued -> killing -> killed (2 transitions)
      await manager.killSession(pod.id);

      expect(statusEvents).toHaveLength(2);
      // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union for field access
      expect((statusEvents[0] as any).previousStatus).toBe('queued');
      // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union for field access
      expect((statusEvents[0] as any).newStatus).toBe('killing');
      // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union for field access
      expect((statusEvents[1] as any).previousStatus).toBe('killing');
      // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union for field access
      expect((statusEvents[1] as any).newStatus).toBe('killed');
    });
  });

  describe('processPod', () => {
    it('transitions through provisioning and running', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature', skipValidation: true },
        'user-1',
      );

      await manager.processPod(pod.id);

      const processed = manager.getSession(pod.id);
      // With skipValidation and empty agent events, should end up at validated
      expect(processed.status).toBe('validated');
      expect(processed.containerId).toBe('container-123');
      expect(processed.worktreePath).toBe('/tmp/worktree/abc');
    });

    it('calls containerManager.spawn and worktreeManager.create', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature', skipValidation: true },
        'user-1',
      );

      await manager.processPod(pod.id);

      expect(ctx.containerManager.spawn).toHaveBeenCalled();
      expect(ctx.worktreeManager.create).toHaveBeenCalled();
      expect(ctx.containerManager.writeFile).toHaveBeenCalled();
    });

    it('spawns from profile.warmImageTag when set, falling back to base image otherwise', async () => {
      const ctx = createTestContext();

      // Default profile has warmImageTag=null → spawn uses base image
      let manager = createPodManager(ctx.deps);
      let pod = manager.createSession(
        { profileName: 'test-profile', task: 'Bare image', skipValidation: true },
        'user-1',
      );
      await manager.processPod(pod.id);
      let spawnCalls = vi.mocked(ctx.containerManager.spawn).mock.calls;
      expect(spawnCalls.at(-1)?.[0]?.image).toBe('autopod-node22:latest');

      // Now patch profileStore.get to return a profile with warmImageTag set.
      // Capture the original impl via getMockImplementation() — `ctx.profileStore.get`
      // itself is the mock, so calling it after mockImplementation would recurse.
      const originalGet = vi.mocked(ctx.profileStore.get).getMockImplementation();
      if (!originalGet) throw new Error('profileStore.get has no mock implementation');
      vi.mocked(ctx.profileStore.get).mockImplementation((name: string) => {
        const base = originalGet(name);
        return { ...base, warmImageTag: 'autopod/test-profile:latest' };
      });

      manager = createPodManager(ctx.deps);
      pod = manager.createSession(
        { profileName: 'test-profile', task: 'Warm image', skipValidation: true },
        'user-1',
      );
      await manager.processPod(pod.id);
      spawnCalls = vi.mocked(ctx.containerManager.spawn).mock.calls;
      expect(spawnCalls.at(-1)?.[0]?.image).toBe('autopod/test-profile:latest');
    });

    it('persists startCommitSha from worktreeManager.create before the container starts (prevents diff route falling back to merge-base)', async () => {
      const ctx = createTestContext();
      (ctx.worktreeManager.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        worktreePath: '/tmp/worktree/abc',
        bareRepoPath: '/tmp/bare/abc.git',
        startCommitSha: 'cafebabe1111222233334444555566667777aaaa',
      });

      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature', skipValidation: true },
        'user-1',
      );

      // Pod row must NOT have startCommitSha until provisioning runs.
      const beforeProcess = manager.getSession(pod.id);
      expect(beforeProcess.startCommitSha).toBeFalsy();

      await manager.processPod(pod.id);

      const after = manager.getSession(pod.id);
      expect(after.startCommitSha).toBe('cafebabe1111222233334444555566667777aaaa');
    });

    it('does not persist startCommitSha when worktreeManager returns empty SHA — leaves capture to in-container poller', async () => {
      const ctx = createTestContext();
      (ctx.worktreeManager.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        worktreePath: '/tmp/worktree/abc',
        bareRepoPath: '/tmp/bare/abc.git',
        startCommitSha: '',
      });

      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature', skipValidation: true },
        'user-1',
      );

      await manager.processPod(pod.id);

      const after = manager.getSession(pod.id);
      // Stays falsy — captureStartSha will retry from inside the container later.
      expect(after.startCommitSha).toBeFalsy();
    });

    it('fails the pod on unexpected errors (not killed — killed is reserved for user intent)', async () => {
      const ctx = createTestContext();
      (ctx.containerManager.spawn as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Docker failed'),
      );

      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );

      await manager.processPod(pod.id);

      const result = manager.getSession(pod.id);
      expect(result.status).toBe('failed');
    });

    it('never writes /workspace/.mcp.json for agent pods (stdio servers route via runtime --mcp-config)', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature', skipValidation: true },
        'user-1',
      );

      await manager.processPod(pod.id);

      const writeCalls = vi.mocked(ctx.containerManager.writeFile).mock.calls;
      const workspaceMcpWrites = writeCalls.filter(([, path]) => path === '/workspace/.mcp.json');
      expect(workspaceMcpWrites).toHaveLength(0);
    });

    it('writes .npmrc to container when profile has npm registry', async () => {
      const registries = [
        {
          type: 'npm',
          url: 'https://pkgs.dev.azure.com/myorg/_packaging/feed/npm/registry/',
          scope: '@myorg',
        },
      ];
      const ctx = createTestContext(undefined, {
        privateRegistries: JSON.stringify(registries),
        registryPat: 'test-pat-123',
      });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Install deps', skipValidation: true },
        'user-1',
      );

      await manager.processPod(pod.id);

      const writeCalls = vi.mocked(ctx.containerManager.writeFile).mock.calls;
      const npmrcCall = writeCalls.find(([, path]) => path.endsWith('.npmrc'));
      expect(npmrcCall).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: guarded by preceding expect
      const content = npmrcCall![2] as string;
      expect(content).toContain(
        '@myorg:registry=https://pkgs.dev.azure.com/myorg/_packaging/feed/npm/registry/',
      );
      expect(content).toContain(':_authToken=test-pat-123');
      expect(content).toContain(':always-auth=true');
    });

    it('writes NuGet.config to container when profile has nuget registry', async () => {
      const registries = [
        {
          type: 'nuget',
          url: 'https://pkgs.dev.azure.com/myorg/_packaging/feed/nuget/v3/index.json',
        },
      ];
      const ctx = createTestContext(undefined, {
        privateRegistries: JSON.stringify(registries),
        registryPat: 'nuget-pat',
      });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Build project', skipValidation: true },
        'user-1',
      );

      await manager.processPod(pod.id);

      const writeCalls = vi.mocked(ctx.containerManager.writeFile).mock.calls;
      const nugetCall = writeCalls.find(([, path]) => path.toLowerCase().endsWith('nuget.config'));
      expect(nugetCall).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: guarded by preceding expect
      const content = nugetCall![2] as string;
      expect(content).toContain('<packageSources>');
      expect(content).toContain('myorg-feed');
      // No credentials in config — auth handled by credential provider via env var
      expect(content).not.toContain('ClearTextPassword');
      expect(content).not.toContain('nuget-pat');
    });

    it('writes both .npmrc and NuGet.config when profile has both registry types', async () => {
      const registries = [
        {
          type: 'npm',
          url: 'https://pkgs.dev.azure.com/myorg/_packaging/feed/npm/registry/',
          scope: '@myorg',
        },
        {
          type: 'nuget',
          url: 'https://pkgs.dev.azure.com/myorg/_packaging/feed/nuget/v3/index.json',
        },
      ];
      const ctx = createTestContext(undefined, {
        privateRegistries: JSON.stringify(registries),
        registryPat: 'dual-pat',
      });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Full stack build', skipValidation: true },
        'user-1',
      );

      await manager.processPod(pod.id);

      const writeCalls = vi.mocked(ctx.containerManager.writeFile).mock.calls;
      const writtenPaths = writeCalls.map(([, path]) => path);
      expect(writtenPaths.some((p) => p.endsWith('.npmrc'))).toBe(true);
      expect(writtenPaths.some((p) => p.toLowerCase().endsWith('nuget.config'))).toBe(true);
    });

    it('does not write registry files when profile has no registries', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Normal task', skipValidation: true },
        'user-1',
      );

      await manager.processPod(pod.id);

      const writeCalls = vi.mocked(ctx.containerManager.writeFile).mock.calls;
      const registryFiles = writeCalls.filter(
        ([, path]) => path === '/workspace/.npmrc' || path === '/workspace/NuGet.config',
      );
      expect(registryFiles).toHaveLength(0);
    });

    describe('recovery mode', () => {
      const recoveryWorktree = '/tmp/worktree/existing';
      const fakeBareRepo = '/tmp/bare/repo.git';
      const fakeBareWorktreeDir = `${fakeBareRepo}/worktrees/existing`;

      beforeEach(() => {
        // Create a proper git worktree structure so the enhanced recovery viability
        // check passes: a .git GITLINK FILE pointing to an existing bare-repo metadata dir.
        fs.mkdirSync(recoveryWorktree, { recursive: true });
        fs.mkdirSync(fakeBareWorktreeDir, { recursive: true });
        fs.writeFileSync(path.join(recoveryWorktree, '.git'), `gitdir: ${fakeBareWorktreeDir}\n`);
      });

      afterEach(() => {
        fs.rmSync(recoveryWorktree, { recursive: true, force: true });
        fs.rmSync(fakeBareRepo, { recursive: true, force: true });
      });

      /**
       * Configure execFile mock to handle:
       * - deriveBareRepoPath: git rev-parse --git-common-dir
       * - recovery-context getGitLog: git log --oneline
       * - recovery-context getUncommittedDiff: git diff HEAD --stat
       */
      function setupExecFileMock(opts?: {
        bareRepoPath?: string;
        gitLog?: string;
        diffStat?: string;
      }) {
        const bareRepo = opts?.bareRepoPath ?? '/tmp/bare/repo.git';
        const gitLog = opts?.gitLog ?? 'abc1234 Previous work';
        const diffStat = opts?.diffStat ?? '';

        mockedExecFile.mockImplementation((...args: unknown[]) => {
          const gitArgs = args[1] as string[];
          const callback = args[args.length - 1] as (
            err: Error | null,
            result: { stdout: string; stderr: string },
          ) => void;

          if (gitArgs[0] === 'rev-parse' && gitArgs[1] === '--git-common-dir') {
            callback(null, { stdout: bareRepo, stderr: '' });
          } else if (gitArgs[0] === 'log') {
            callback(null, { stdout: gitLog, stderr: '' });
          } else if (gitArgs[0] === 'diff') {
            callback(null, { stdout: diffStat, stderr: '' });
          } else {
            callback(null, { stdout: '', stderr: '' });
          }
          return undefined as never;
        });
      }

      it('skips worktree creation and reuses existing path in recovery mode', async () => {
        const ctx = createTestContext();
        setupExecFileMock({ bareRepoPath: '/tmp/bare/recovered.git' });

        const manager = createPodManager(ctx.deps);
        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Continue feature', skipValidation: true },
          'user-1',
        );

        // Set recovery state: worktree already exists from previous run
        ctx.podRepo.update(pod.id, {
          recoveryWorktreePath: '/tmp/worktree/existing',
        });

        await manager.processPod(pod.id);

        // Worktree manager should NOT have been called
        expect(ctx.worktreeManager.create).not.toHaveBeenCalled();

        // Container should have been spawned with the recovery worktree path
        const spawnCalls = vi.mocked(ctx.containerManager.spawn).mock.calls;
        expect(spawnCalls).toHaveLength(1);
        const volumes = spawnCalls[0]?.[0]?.volumes;
        expect(volumes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ host: '/tmp/worktree/existing', container: '/mnt/worktree' }),
          ]),
        );

        // Pod should have worktreePath set correctly
        const updated = manager.getSession(pod.id);
        expect(updated.worktreePath).toBe('/tmp/worktree/existing');
      });

      it('clears recoveryWorktreePath after recovery starts', async () => {
        const ctx = createTestContext();
        setupExecFileMock();

        const manager = createPodManager(ctx.deps);
        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Continue feature', skipValidation: true },
          'user-1',
        );

        ctx.podRepo.update(pod.id, {
          recoveryWorktreePath: '/tmp/worktree/existing',
        });

        await manager.processPod(pod.id);

        const updated = manager.getSession(pod.id);
        expect(updated.recoveryWorktreePath).toBeNull();
      });

      it('uses runtime.resume for Claude with claudeSessionId', async () => {
        const runtime = createMockRuntime();
        // Add setClaudeSessionId to make it duck-type as ClaudeRuntime
        (runtime as Record<string, unknown>).setClaudeSessionId = vi.fn();

        const ctx = createTestContext(undefined, {});
        // Replace the runtime registry to use our custom runtime
        ctx.deps.runtimeRegistry = createMockRuntimeRegistry(runtime);

        setupExecFileMock();

        const manager = createPodManager(ctx.deps);
        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Continue feature', skipValidation: true },
          'user-1',
        );

        ctx.podRepo.update(pod.id, {
          recoveryWorktreePath: '/tmp/worktree/existing',
          claudeSessionId: 'claude-ses-abc',
        });

        await manager.processPod(pod.id);

        // setClaudeSessionId should have been called to rehydrate
        expect((runtime as Record<string, unknown>).setClaudeSessionId).toHaveBeenCalledWith(
          pod.id,
          'claude-ses-abc',
        );

        // resume should have been called (not spawn)
        expect(runtime.resume).toHaveBeenCalled();
        const resumeCall = vi.mocked(runtime.resume).mock.calls[0];
        expect(resumeCall?.[0]).toBe(pod.id);
        // The continuation prompt should mention pod interruption
        expect(resumeCall?.[1]).toContain('interrupted');
      });

      it('uses runtime.spawn with recovery task for non-Claude runtime', async () => {
        const runtime = createMockRuntime();
        runtime.type = 'copilot';

        const ctx = createTestContext();
        ctx.deps.runtimeRegistry = createMockRuntimeRegistry(runtime);

        setupExecFileMock({ gitLog: 'def5678 Half-done work' });

        const manager = createPodManager(ctx.deps);
        const pod = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Build the widget',
            runtime: 'copilot',
            skipValidation: true,
          },
          'user-1',
        );

        ctx.podRepo.update(pod.id, {
          recoveryWorktreePath: '/tmp/worktree/existing',
        });

        await manager.processPod(pod.id);

        // Should use spawn (not resume) for non-Claude runtime
        expect(runtime.spawn).toHaveBeenCalled();
        expect(runtime.resume).not.toHaveBeenCalled();

        // Task should include recovery context
        const spawnCall = vi.mocked(runtime.spawn).mock.calls[0];
        const task = spawnCall?.[0]?.task;
        expect(task).toContain('Build the widget');
        expect(task).toContain('RECOVERY CONTEXT');
        expect(task).toContain('def5678 Half-done work');
      });

      it('uses fresh spawn with rework prompt when reworkReason is set', async () => {
        const runtime = createMockRuntime();
        (runtime as Record<string, unknown>).setClaudeSessionId = vi.fn();

        const ctx = createTestContext(undefined, {});
        ctx.deps.runtimeRegistry = createMockRuntimeRegistry(runtime);

        setupExecFileMock({ gitLog: 'abc1234 Previous broken work' });

        const manager = createPodManager(ctx.deps);
        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Fix the bug', skipValidation: true },
          'user-1',
        );

        // Simulate a rework: recoveryWorktreePath + reworkReason set, claudeSessionId cleared
        ctx.podRepo.update(pod.id, {
          recoveryWorktreePath: '/tmp/worktree/existing',
          reworkReason: 'Your previous attempt failed. Review what went wrong and try again.',
          // claudeSessionId intentionally NOT set (cleared by triggerValidation)
        });

        await manager.processPod(pod.id);

        // Should use spawn (not resume) even for Claude runtime
        expect(runtime.spawn).toHaveBeenCalled();
        expect(runtime.resume).not.toHaveBeenCalled();

        // Task should include rework context, not recovery context
        const spawnCall = vi.mocked(runtime.spawn).mock.calls[0];
        const task = spawnCall?.[0]?.task;
        expect(task).toContain('Fix the bug');
        expect(task).toContain('REWORK CONTEXT');
        expect(task).toContain('Previous attempt made these commits');
        expect(task).not.toContain('interrupted');
        expect(task).not.toContain('RECOVERY CONTEXT');

        // reworkReason should be cleared after consumption
        const updated = manager.getSession(pod.id);
        expect(updated.reworkReason).toBeNull();
      });

      it('falls back to fresh spawn when Claude resume throws', async () => {
        const runtime = createMockRuntime();
        (runtime as Record<string, unknown>).setClaudeSessionId = vi.fn();

        // Make resume throw
        runtime.resume = vi.fn(() => {
          throw new Error('Resume failed: pod expired');
        });

        const ctx = createTestContext();
        ctx.deps.runtimeRegistry = createMockRuntimeRegistry(runtime);

        setupExecFileMock();

        const manager = createPodManager(ctx.deps);
        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Fix the bug', skipValidation: true },
          'user-1',
        );

        ctx.podRepo.update(pod.id, {
          recoveryWorktreePath: '/tmp/worktree/existing',
          claudeSessionId: 'claude-ses-expired',
        });

        await manager.processPod(pod.id);

        // Resume was attempted
        expect(runtime.resume).toHaveBeenCalled();

        // Fallback to spawn should have been called
        expect(runtime.spawn).toHaveBeenCalled();
        const spawnCall = vi.mocked(runtime.spawn).mock.calls[0];
        expect(spawnCall?.[0]?.task).toContain('RECOVERY CONTEXT');

        // Pod should still complete (not crash)
        const updated = manager.getSession(pod.id);
        expect(updated.status).toBe('validated');
      });

      it('falls back to fresh worktree when bare-repo worktree metadata is missing', async () => {
        // Simulate the case where the .git gitlink exists but the bare repo metadata dir
        // was pruned (git worktree prune removed it while the directory survived).
        const staleWorktree = '/tmp/worktree/stale-metadata';
        const staleWorktreeGit = path.join(staleWorktree, '.git');
        const nonExistentBareDir = '/tmp/bare/gone.git/worktrees/stale-metadata';
        fs.mkdirSync(staleWorktree, { recursive: true });
        fs.writeFileSync(staleWorktreeGit, `gitdir: ${nonExistentBareDir}\n`);

        try {
          const ctx = createTestContext();
          const manager = createPodManager(ctx.deps);
          const pod = manager.createSession(
            { profileName: 'test-profile', task: 'Recover stale', skipValidation: true },
            'user-1',
          );

          ctx.podRepo.update(pod.id, { recoveryWorktreePath: staleWorktree });

          await manager.processPod(pod.id);

          // Recovery should have been skipped — worktree manager creates a fresh one
          expect(ctx.worktreeManager.create).toHaveBeenCalled();

          // recoveryWorktreePath should be cleared
          const updated = manager.getSession(pod.id);
          expect(updated.recoveryWorktreePath).toBeNull();
        } finally {
          fs.rmSync(staleWorktree, { recursive: true, force: true });
        }
      });
    });

    it('falls back to fresh worktree when recovery path is missing', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Recover missing', skipValidation: true },
        'user-1',
      );

      // Set recovery path to a directory that does NOT exist
      ctx.podRepo.update(pod.id, {
        recoveryWorktreePath: '/tmp/worktree/gone',
      });

      await manager.processPod(pod.id);

      // Should have fallen back to worktreeManager.create
      expect(ctx.worktreeManager.create).toHaveBeenCalled();

      // Pod should still complete normally
      const updated = manager.getSession(pod.id);
      expect(updated.status).toBe('validated');

      // recoveryWorktreePath should be cleared
      expect(updated.recoveryWorktreePath).toBeNull();
    });

    it('does not write registry files when registryPat is null', async () => {
      const registries = [
        {
          type: 'npm',
          url: 'https://pkgs.dev.azure.com/myorg/_packaging/feed/npm/registry/',
        },
      ];
      const ctx = createTestContext(undefined, {
        privateRegistries: JSON.stringify(registries),
        registryPat: null as unknown as string,
      });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'No pat', skipValidation: true },
        'user-1',
      );

      await manager.processPod(pod.id);

      const writeCalls = vi.mocked(ctx.containerManager.writeFile).mock.calls;
      const npmrcCalls = writeCalls.filter(([, path]) => path === '/workspace/.npmrc');
      expect(npmrcCalls).toHaveLength(0);
    });

    it('accumulates costUsd across multiple runs instead of replacing', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Multi-run task', skipValidation: true },
        'user-1',
      );

      // First run: spawn emits a complete event with $0.02 cost
      (ctx.runtime.spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async function* (): AsyncIterable<AgentEvent> {
          yield {
            type: 'complete',
            timestamp: new Date().toISOString(),
            result: 'Done first run',
            costUsd: 0.02,
            totalInputTokens: 1000,
            totalOutputTokens: 200,
          };
        },
      );
      await manager.processPod(pod.id);

      const afterFirstRun = manager.getSession(pod.id);
      expect(afterFirstRun.costUsd).toBeCloseTo(0.02);

      // Put pod back to validated so we can reject it and trigger a second run
      ctx.podRepo.update(pod.id, { status: 'validated', containerId: 'ctr-1' });

      // Second run: resume emits a complete event with $0.03 cost
      (ctx.runtime.resume as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async function* (): AsyncIterable<AgentEvent> {
          yield {
            type: 'complete',
            timestamp: new Date().toISOString(),
            result: 'Done second run',
            costUsd: 0.03,
            totalInputTokens: 500,
            totalOutputTokens: 100,
          };
        },
      );
      await manager.rejectSession(pod.id, 'Try again');

      const afterSecondRun = manager.getSession(pod.id);
      // Cost should accumulate: $0.02 + $0.03 = $0.05 (not just $0.03)
      expect(afterSecondRun.costUsd).toBeCloseTo(0.05);
      // Tokens should also accumulate
      expect(afterSecondRun.inputTokens).toBe(1500);
      expect(afterSecondRun.outputTokens).toBe(300);
    });
  });

  describe('triggerValidation', () => {
    it('transitions to validated on pass', async () => {
      const ctx = createTestContext({ overall: 'pass' });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        worktreePath: '/tmp/wt',
      });

      await manager.triggerValidation(pod.id);

      const result = manager.getSession(pod.id);
      expect(result.status).toBe('validated');
    });

    it('pushes branch and creates PR on validation pass', async () => {
      const ctx = createTestContext({ overall: 'pass' });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        worktreePath: '/tmp/wt',
      });

      await manager.triggerValidation(pod.id);

      // Branch was pushed — must target the feature branch so `gh pr create --head` can
      // reference it; the PR itself targets baseBranch separately via prManager.createPr.
      expect(ctx.worktreeManager.mergeBranch).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: '/tmp/wt',
          targetBranch: pod.branch,
        }),
      );

      // PR was created
      expect(ctx.prManager.createPr).toHaveBeenCalledWith(
        expect.objectContaining({
          podId: pod.id,
          task: 'Add feature',
          profileName: 'test-profile',
          baseBranch: 'main',
        }),
      );

      // PR URL stored on pod
      const result = manager.getSession(pod.id);
      expect(result.prUrl).toBe('https://github.com/org/repo/pull/42');
    });

    it('still validates even if PR creation fails', async () => {
      const ctx = createTestContext({ overall: 'pass' });
      (ctx.prManager.createPr as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('gh not found'),
      );
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        worktreePath: '/tmp/wt',
      });

      await manager.triggerValidation(pod.id);

      const result = manager.getSession(pod.id);
      expect(result.status).toBe('validated');
      expect(result.prUrl).toBeNull();
    });

    it('transitions to review_required after max validation attempts', async () => {
      const ctx = createTestContext({ overall: 'fail' });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      // Already used 2 attempts, max is 3, so this attempt (#3) is the last
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        validationAttempts: 2,
      });

      await manager.triggerValidation(pod.id);

      const result = manager.getSession(pod.id);
      expect(result.status).toBe('review_required');
    });

    it('retries with correction feedback until max attempts exhausted', async () => {
      // With always-failing validation, the retry loop exhausts all attempts
      const ctx = createTestContext({ overall: 'fail' });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        validationAttempts: 0,
      });

      await manager.triggerValidation(pod.id);

      // Agent was resumed with correction feedback for each retry (attempts 1 and 2)
      const resumeCalls = vi.mocked(ctx.runtime.resume).mock.calls;
      expect(resumeCalls.length).toBe(2);
      expect(resumeCalls[0]?.[1]).toContain('Validation Failed');
      // 2 retries before exhaustion (attempt 1 → retry, attempt 2 → retry, attempt 3 → review_required)
      expect(ctx.runtime.resume).toHaveBeenCalledTimes(2);

      const result = manager.getSession(pod.id);
      expect(result.status).toBe('review_required');
      expect(result.validationAttempts).toBe(3);
    });

    it('does not resume agent on final attempt failure', async () => {
      const ctx = createTestContext({ overall: 'fail' });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        validationAttempts: 2, // this is the last attempt
      });

      await manager.triggerValidation(pod.id);

      // No resume — max retries exhausted on this attempt
      expect(ctx.runtime.resume).not.toHaveBeenCalled();
      expect(manager.getSession(pod.id).status).toBe('review_required');
    });
  });

  describe('re-validation from terminal states', () => {
    it('allows re-validation from killed state and resets attempt counter', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'killed',
        containerId: 'ctr-1',
        validationAttempts: 3,
      });

      await manager.triggerValidation(pod.id, { force: true });

      const result = manager.getSession(pod.id);
      expect(result.status).toBe('validated');
      expect(result.validationAttempts).toBe(1);
    });

    it('resets attempt counter when re-validating from failed state', async () => {
      const ctx = createTestContext({ overall: 'pass' });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'failed',
        containerId: 'ctr-1',
        validationAttempts: 3,
      });

      await manager.triggerValidation(pod.id, { force: true });

      const result = manager.getSession(pod.id);
      expect(result.status).toBe('validated');
      expect(result.validationAttempts).toBe(1);
    });

    it('re-provisions with fresh container when force-reworking from failed with worktree', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'failed',
        containerId: 'ctr-1',
        worktreePath: '/tmp/worktrees/test-branch',
        claudeSessionId: 'claude-ses-old',
        validationAttempts: 3,
      });

      await manager.triggerValidation(pod.id, { force: true });

      const result = manager.getSession(pod.id);
      // Pod should be re-queued for fresh provisioning, not validated in-place
      expect(result.status).toBe('queued');
      expect(result.containerId).toBeNull();
      expect(result.validationAttempts).toBe(0);
      expect(result.recoveryWorktreePath).toBe('/tmp/worktrees/test-branch');
      // claudeSessionId should be cleared so we get a fresh spawn, not a stale resume
      expect(result.claudeSessionId).toBeNull();
      // reworkReason should be set to signal rework (not crash recovery)
      expect(result.reworkReason).toBeTruthy();
      expect(ctx.enqueuedSessions).toContain(pod.id);
      // Old container should be killed
      expect(ctx.containerManager.kill).toHaveBeenCalledWith('ctr-1');
    });

    it('re-provisions from validated state with worktree on force rework', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'validated',
        containerId: 'ctr-1',
        worktreePath: '/tmp/worktrees/test-branch',
        validationAttempts: 2,
      });

      await manager.triggerValidation(pod.id, { force: true });

      const result = manager.getSession(pod.id);
      expect(result.status).toBe('queued');
      expect(result.recoveryWorktreePath).toBe('/tmp/worktrees/test-branch');
      expect(ctx.enqueuedSessions).toContain(pod.id);
    });
  });

  describe('sendMessage', () => {
    it('throws if pod is not awaiting_input', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );

      await expect(manager.sendMessage(pod.id, 'hello')).rejects.toThrow(AutopodError);
    });
  });

  describe('workspace pods', () => {
    describe('createSession', () => {
      it('stores outputMode and baseBranch', () => {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Plan auth redesign',
            outputMode: 'workspace',
            baseBranch: 'feat/plan-auth',
          },
          'user-1',
        );

        expect(pod.outputMode).toBe('workspace');
        expect(pod.baseBranch).toBe('feat/plan-auth');
      });

      it('defaults outputMode to pr when not specified', () => {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Do stuff' },
          'user-1',
        );

        expect(pod.outputMode).toBe('pr');
        expect(pod.baseBranch).toBeNull();
      });

      it('stores acFrom on the pod', () => {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Execute plan',
            acFrom: 'specs/auth/acceptance-criteria.md',
          },
          'user-1',
        );

        expect(pod.acFrom).toBe('specs/auth/acceptance-criteria.md');
      });
    });

    describe('processPod', () => {
      it('passes baseBranch to worktreeManager.create', async () => {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Plan auth',
            outputMode: 'workspace',
            baseBranch: 'feat/plan-auth',
          },
          'user-1',
        );

        await manager.processPod(pod.id);

        expect(ctx.worktreeManager.create).toHaveBeenCalledWith(
          expect.objectContaining({
            baseBranch: 'feat/plan-auth',
          }),
        );
      });

      it('returns early for workspace pods — no agent spawn', async () => {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Workspace pod',
            outputMode: 'workspace',
          },
          'user-1',
        );

        await manager.processPod(pod.id);

        const updated = manager.getSession(pod.id);
        expect(updated.status).toBe('running');
        expect(updated.containerId).toBe('container-123');
        expect(updated.worktreePath).toBe('/tmp/worktree/abc');

        // Agent should NOT have been spawned
        expect(ctx.runtime.spawn).not.toHaveBeenCalled();
      });

      it('injects escalation MCP server into /workspace/.mcp.json for workspace pods', async () => {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Workspace pod',
            outputMode: 'workspace',
          },
          'user-1',
        );

        await manager.processPod(pod.id);

        const mcpJsonCalls = ctx.containerManager.writeFile.mock.calls.filter(
          ([, path]) => path === '/workspace/.mcp.json',
        );
        expect(mcpJsonCalls.length).toBe(1);
        const written = JSON.parse(mcpJsonCalls[0][2] as string);
        expect(written.mcpServers).toBeDefined();
        expect(written.mcpServers.escalation).toMatchObject({
          type: 'http',
          url: expect.stringContaining('/mcp/'),
        });
      });

      it('captures startCommitSha for workspace pods', async () => {
        const ctx = createTestContext();
        const fakeSha = 'abc123def456';
        ctx.containerManager.execInContainer.mockImplementation(async (_id, cmd) => {
          if (cmd[0] === 'git' && cmd[1] === 'rev-parse' && cmd[2] === 'HEAD') {
            return { stdout: `${fakeSha}\n`, stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        });
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Workspace pod',
            outputMode: 'workspace',
          },
          'user-1',
        );

        await manager.processPod(pod.id);

        const updated = manager.getSession(pod.id);
        expect(updated.startCommitSha).toBe(fakeSha);
      });

      it('reads acFrom file and populates acceptanceCriteria', async () => {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        // Create a temp file for the AC
        const fs = await import('node:fs/promises');
        const tmpPath = '/tmp/worktree/abc';
        await fs.mkdir(`${tmpPath}/specs`, { recursive: true });
        await fs.writeFile(`${tmpPath}/specs/ac.md`, '- Login works\n- Logout works\n');

        const pod = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Execute plan',
            outputMode: 'workspace',
            acFrom: 'specs/ac.md',
          },
          'user-1',
        );

        await manager.processPod(pod.id);

        const updated = manager.getSession(pod.id);
        expect(updated.acceptanceCriteria).toEqual([
          {
            type: 'none',
            test: 'Login works',
            pass: 'criterion satisfied',
            fail: 'criterion not satisfied',
          },
          {
            type: 'none',
            test: 'Logout works',
            pass: 'criterion satisfied',
            fail: 'criterion not satisfied',
          },
        ]);

        // Cleanup
        await fs.rm(`${tmpPath}/specs`, { recursive: true, force: true });
      });
    });

    describe('completeSession', () => {
      it('pushes branch and transitions running → complete', async () => {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Workspace pod',
            outputMode: 'workspace',
          },
          'user-1',
        );

        // Simulate processPod having run: set status to running with worktreePath
        ctx.podRepo.update(pod.id, {
          status: 'running',
          worktreePath: '/tmp/worktree/abc',
          startedAt: new Date().toISOString(),
        });

        const result = await manager.completeSession(pod.id);

        expect(result.pushError).toBeUndefined();
        expect(ctx.worktreeManager.mergeBranch).toHaveBeenCalledWith(
          expect.objectContaining({
            worktreePath: '/tmp/worktree/abc',
            targetBranch: expect.any(String),
          }),
        );

        const completed = manager.getSession(pod.id);
        expect(completed.status).toBe('complete');
        expect(completed.completedAt).not.toBeNull();
      });

      it('emits pod.completed event', async () => {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Workspace pod',
            outputMode: 'workspace',
          },
          'user-1',
        );

        ctx.podRepo.update(pod.id, {
          status: 'running',
          worktreePath: '/tmp/worktree/abc',
          startedAt: new Date().toISOString(),
        });

        const events: unknown[] = [];
        ctx.eventBus.subscribe((e) => events.push(e));

        await manager.completeSession(pod.id);

        // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union for field access
        const completedEvent = events.find((e: any) => e.type === 'pod.completed') as any;
        expect(completedEvent).toBeDefined();
        expect(completedEvent.finalStatus).toBe('complete');
      });

      it('rejects non-workspace pods', async () => {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Normal pod' },
          'user-1',
        );

        ctx.podRepo.update(pod.id, { status: 'running' });

        await expect(manager.completeSession(pod.id)).rejects.toThrow(AutopodError);
        await expect(manager.completeSession(pod.id)).rejects.toMatchObject({
          code: 'INVALID_OUTPUT_MODE',
        });
      });

      it('rejects pods not in running status', async () => {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Workspace pod',
            outputMode: 'workspace',
          },
          'user-1',
        );

        // Pod is in queued status — not running
        await expect(manager.completeSession(pod.id)).rejects.toThrow(AutopodError);
        await expect(manager.completeSession(pod.id)).rejects.toMatchObject({
          code: 'INVALID_STATE',
        });
      });

      it('surfaces push errors without blocking completion', async () => {
        const ctx = createTestContext();
        (ctx.worktreeManager.mergeBranch as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error('remote: Permission denied'),
        );
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Workspace pod',
            outputMode: 'workspace',
          },
          'user-1',
        );

        ctx.podRepo.update(pod.id, {
          status: 'running',
          worktreePath: '/tmp/worktree/abc',
          startedAt: new Date().toISOString(),
        });

        const result = await manager.completeSession(pod.id);

        expect(result.pushError).toBe('remote: Permission denied');
        // Pod still transitions to complete
        const completed = manager.getSession(pod.id);
        expect(completed.status).toBe('complete');
      });

      it('extracts /workspace to artifactsPath for interactive-artifact pods, skipping branch push', async () => {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Plan some stuff',
            options: {
              agentMode: 'interactive',
              output: 'artifact',
              validate: false,
              promotable: true,
            },
          },
          'user-1',
        );

        ctx.podRepo.update(pod.id, {
          status: 'running',
          containerId: 'container-abc',
          worktreePath: '/tmp/worktree/abc',
          startedAt: new Date().toISOString(),
        });

        const result = await manager.completeSession(pod.id);

        expect(result.pushError).toBeUndefined();
        expect(ctx.containerManager.extractDirectoryFromContainer).toHaveBeenCalledWith(
          'container-abc',
          '/workspace',
          expect.stringContaining(`artifacts/${pod.id}`),
        );
        expect(ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();

        const completed = manager.getSession(pod.id);
        expect(completed.status).toBe('complete');
        expect(completed.artifactsPath).toContain(`artifacts/${pod.id}`);
      });

      it('completes interactive-artifact pod even when extraction fails', async () => {
        const ctx = createTestContext();
        (
          ctx.containerManager.extractDirectoryFromContainer as ReturnType<typeof vi.fn>
        ).mockRejectedValue(new Error('tar: broken pipe'));
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Plan some stuff',
            options: {
              agentMode: 'interactive',
              output: 'artifact',
              validate: false,
              promotable: true,
            },
          },
          'user-1',
        );

        ctx.podRepo.update(pod.id, {
          status: 'running',
          containerId: 'container-abc',
          startedAt: new Date().toISOString(),
        });

        await manager.completeSession(pod.id);

        const completed = manager.getSession(pod.id);
        expect(completed.status).toBe('complete');
        // artifactsPath is still set — the dir was created even if extraction failed
        expect(completed.artifactsPath).toContain(`artifacts/${pod.id}`);
      });
    });
  });

  describe('retryCreatePr — worktree compromise guard', () => {
    async function setupCompletePodForRetry(ctx: TestContext) {
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do a thing' },
        'user-1',
      );
      // Transition queued → provisioning → running → validating → validated →
      // approved → merging → complete without a prUrl (the state needed by retry).
      ctx.podRepo.update(pod.id, {
        status: 'provisioning',
        worktreePath: '/tmp/worktree/abc',
        containerId: 'container-xyz',
        startedAt: new Date().toISOString(),
      });
      for (const status of [
        'running',
        'validating',
        'validated',
        'approved',
        'merging',
        'complete',
      ] as const) {
        ctx.podRepo.update(pod.id, { status });
      }
      return { manager, pod };
    }

    it('flags worktreeCompromised and emits event when mergeBranch hits the guard', async () => {
      const ctx = createTestContext();
      const { manager, pod } = await setupCompletePodForRetry(ctx);

      (ctx.worktreeManager.mergeBranch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new DeletionGuardError(1730, 0),
      );

      const compromisedEvents: unknown[] = [];
      ctx.eventBus.subscribe((evt) => {
        if (evt.type === 'pod.worktree_compromised') compromisedEvents.push(evt);
      });

      await expect(manager.retryCreatePr(pod.id)).rejects.toMatchObject({
        code: 'WORKTREE_COMPROMISED',
        statusCode: 409,
      });

      const persisted = manager.getSession(pod.id);
      expect(persisted.worktreeCompromised).toBe(true);
      expect(compromisedEvents).toHaveLength(1);
      expect(compromisedEvents[0]).toMatchObject({
        type: 'pod.worktree_compromised',
        podId: pod.id,
        deletionCount: 1730,
        threshold: 0,
      });
      expect(ctx.prManager.createPr).not.toHaveBeenCalled();
    });

    it('surfaces non-guard push failures as BRANCH_PUSH_FAILED 502', async () => {
      const ctx = createTestContext();
      const { manager, pod } = await setupCompletePodForRetry(ctx);

      (ctx.worktreeManager.mergeBranch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('ssh: connection refused'),
      );

      await expect(manager.retryCreatePr(pod.id)).rejects.toMatchObject({
        code: 'BRANCH_PUSH_FAILED',
        statusCode: 502,
      });

      const persisted = manager.getSession(pod.id);
      expect(persisted.worktreeCompromised).toBe(false);
    });

    it('passes maxDeletions: 0 so any staged deletion aborts the commit', async () => {
      const ctx = createTestContext();
      const { manager, pod } = await setupCompletePodForRetry(ctx);

      await manager.retryCreatePr(pod.id);

      expect(ctx.worktreeManager.mergeBranch).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: '/tmp/worktree/abc',
          maxDeletions: 0,
        }),
      );
    });

    it('pushes the feature branch (not the base branch) so the PR can be opened against main', async () => {
      const ctx = createTestContext();
      const { manager, pod } = await setupCompletePodForRetry(ctx);

      await manager.retryCreatePr(pod.id);

      // Regression guard: mergeBranch verifies HEAD == targetBranch and pushes
      // HEAD:refs/heads/<targetBranch>. Passing the base branch here would force-push the
      // feature work onto main and fail the HEAD assertion.
      expect(ctx.worktreeManager.mergeBranch).toHaveBeenCalledWith(
        expect.objectContaining({
          targetBranch: pod.branch,
        }),
      );
      expect(ctx.prManager.createPr).toHaveBeenCalledWith(
        expect.objectContaining({
          branch: pod.branch,
          baseBranch: 'main',
        }),
      );
    });
  });

  describe('spawnFixSession — long-lived fix pod (reuseFixPod=true)', () => {
    it('re-enqueues the same fix pod entity instead of spawning a new child', async () => {
      const ctx = createTestContext();
      // Enable the long-lived fix-pod path on this profile.
      ctx.db.prepare(`UPDATE profiles SET reuse_fix_pod = 1 WHERE name = 'test-profile'`).run();

      (ctx.prManager.getPrStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        merged: false,
        open: true,
        blockReason: 'CHANGES_REQUESTED',
        ciFailures: [],
        reviewComments: [{ body: 'Please rename foo to bar.', path: null }],
      });

      const manager = createPodManager(ctx.deps);
      const parent = manager.createSession(
        { profileName: 'test-profile', task: 'Original work' },
        'user-1',
      );

      // Drive parent into complete + merge_pending-with-PR.
      ctx.podRepo.update(parent.id, {
        status: 'provisioning',
        worktreePath: '/tmp/worktree/abc',
        containerId: 'container-xyz',
        startedAt: new Date().toISOString(),
      });
      for (const status of [
        'running',
        'validating',
        'validated',
        'approved',
        'merging',
        'complete',
      ] as const) {
        ctx.podRepo.update(parent.id, { status });
      }
      ctx.podRepo.update(parent.id, {
        prUrl: 'https://github.com/org/repo/pull/42',
      });

      // First spawn — creates a fix pod the normal way.
      await manager.spawnFixSession(parent.id, 'first round of feedback');
      const podsAfterFirst = ctx.podRepo.list({});
      const firstFix = podsAfterFirst.find((p) => p.linkedPodId === parent.id);
      expect(firstFix, 'first spawn should create a fix pod').toBeDefined();
      const firstFixId = firstFix?.id;

      // Drive that fix pod through to `complete` (it pushed and finished).
      for (const status of [
        'provisioning',
        'running',
        'validating',
        'validated',
        'approved',
        'merging',
        'complete',
      ] as const) {
        ctx.podRepo.update(firstFix?.id ?? '', { status });
      }

      // Second spawn — same parent gets a new round of feedback. With
      // reuseFixPod=true, the daemon should re-enqueue the same fix pod
      // entity, NOT create a new child.
      await manager.spawnFixSession(parent.id, 'second round of feedback');

      const podsAfterSecond = ctx.podRepo.list({});
      const fixPodsForParent = podsAfterSecond.filter((p) => p.linkedPodId === parent.id);
      expect(fixPodsForParent).toHaveLength(1);
      expect(fixPodsForParent[0]?.id).toBe(firstFixId);

      const reusedFix = ctx.podRepo.getOrThrow(firstFixId ?? '');
      expect(reusedFix.status).toBe('queued');
      expect(reusedFix.task).toContain('second round of feedback');
      expect(reusedFix.containerId).toBeNull();
      expect(reusedFix.fixIteration).toBe(1);
      expect(ctx.enqueuedSessions).toContain(firstFixId);

      // Parent's prFixAttempts incremented.
      const refreshedParent = ctx.podRepo.getOrThrow(parent.id);
      expect(refreshedParent.prFixAttempts).toBe(2);
      expect(refreshedParent.fixPodId).toBe(firstFixId);
    });

    it('falls back to spawning a new fix pod when reuseFixPod is false (default)', async () => {
      const ctx = createTestContext();
      // reuse_fix_pod is 0 by default — explicit for clarity.
      ctx.db.prepare(`UPDATE profiles SET reuse_fix_pod = 0 WHERE name = 'test-profile'`).run();

      (ctx.prManager.getPrStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        merged: false,
        open: true,
        blockReason: 'CHANGES_REQUESTED',
        ciFailures: [],
        reviewComments: [{ body: 'fix this', path: null }],
      });

      const manager = createPodManager(ctx.deps);
      const parent = manager.createSession(
        { profileName: 'test-profile', task: 'Original work' },
        'user-1',
      );

      ctx.podRepo.update(parent.id, {
        status: 'provisioning',
        worktreePath: '/tmp/wt',
        containerId: 'c',
        startedAt: new Date().toISOString(),
      });
      for (const status of [
        'running',
        'validating',
        'validated',
        'approved',
        'merging',
        'complete',
      ] as const) {
        ctx.podRepo.update(parent.id, { status });
      }
      ctx.podRepo.update(parent.id, { prUrl: 'https://github.com/org/repo/pull/42' });

      await manager.spawnFixSession(parent.id, 'round 1');
      const firstFix = ctx.podRepo.list({}).find((p) => p.linkedPodId === parent.id);
      expect(firstFix).toBeDefined();

      // Drive the first fix pod to complete.
      for (const status of [
        'provisioning',
        'running',
        'validating',
        'validated',
        'approved',
        'merging',
        'complete',
      ] as const) {
        ctx.podRepo.update(firstFix?.id ?? '', { status });
      }

      // Second spawn — should create ANOTHER child pod (today's behavior).
      await manager.spawnFixSession(parent.id, 'round 2');
      const fixPodsForParent = ctx.podRepo.list({}).filter((p) => p.linkedPodId === parent.id);
      expect(fixPodsForParent.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('spawnFixSession — userMessage delivery under cooldown', () => {
    it('bypasses the 10-minute cooldown and delivers userMessage into the new fix pod task', async () => {
      const ctx = createTestContext();
      // PR status fetch — return a CHANGES_REQUESTED with a review comment so
      // the build path emits a real fix task (not just headers).
      (ctx.prManager.getPrStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        merged: false,
        open: true,
        blockReason: 'CHANGES_REQUESTED',
        ciFailures: [],
        reviewComments: [{ body: 'Please rename foo to bar.', path: null }],
      });

      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Original work' },
        'user-1',
      );
      // Drive the pod into `complete` with a prUrl and an active cooldown
      // (lastFixPodSpawnedAt = now would normally block any further spawn).
      ctx.podRepo.update(pod.id, {
        status: 'provisioning',
        worktreePath: '/tmp/worktree/abc',
        containerId: 'container-xyz',
        startedAt: new Date().toISOString(),
      });
      for (const status of [
        'running',
        'validating',
        'validated',
        'approved',
        'merging',
        'complete',
      ] as const) {
        ctx.podRepo.update(pod.id, { status });
      }
      ctx.podRepo.update(pod.id, {
        prUrl: 'https://github.com/org/repo/pull/42',
        lastFixPodSpawnedAt: new Date().toISOString(),
      });

      await manager.spawnFixSession(pod.id, 'please use option B');

      // The fix pod is the one with linkedPodId === parent.id
      const allPods = ctx.podRepo.list({});
      const fixPod = allPods.find((p) => p.linkedPodId === pod.id);
      expect(fixPod, 'cooldown should be bypassed and a fix pod created').toBeDefined();
      expect(fixPod?.task).toContain('## Instructions from Reviewer');
      expect(fixPod?.task).toContain('please use option B');
      expect(ctx.enqueuedSessions).toContain(fixPod?.id);
    });
  });

  describe('spawnFixSession — single-mode series branch redirect', () => {
    /**
     * Stand up a 3-pod single-PR series where the *first* pod owns the PR
     * (branch `feature/series-root`, prUrl set) and the other two are
     * non-PR-owning siblings sharing the same branch.
     */
    function setupSingleSeries(ctx: TestContext) {
      const manager = createPodManager(ctx.deps);
      const seriesId = 'series-abc';
      const sharedBranch = 'feature/series-root';
      const prOwnerUrl = 'https://github.com/org/repo/pull/100';

      const root = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Brief 1',
          seriesId,
          seriesName: 'My series',
          prMode: 'single',
          branch: sharedBranch,
          options: { agentMode: 'auto', output: 'branch' },
        },
        'user-1',
      );
      const middle = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Brief 2',
          seriesId,
          seriesName: 'My series',
          prMode: 'single',
          branch: sharedBranch,
          options: { agentMode: 'auto', output: 'branch' },
          dependsOnPodIds: [root.id],
        },
        'user-1',
      );
      const last = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Brief 3',
          seriesId,
          seriesName: 'My series',
          prMode: 'single',
          branch: sharedBranch,
          options: { agentMode: 'auto', output: 'pr' },
          dependsOnPodIds: [middle.id],
        },
        'user-1',
      );

      // Drive each pod into a terminal state.
      // The PR-owner is the *root* (last pod actually opens PRs in real flows,
      // but the redirect logic only requires "the pod with prUrl set" — pin
      // the PR onto root to make sure the test exercises a real redirect: the
      // user clicks `last`, but the branch must come from `root`).
      for (const status of [
        'provisioning',
        'running',
        'validating',
        'validated',
        'approved',
        'merging',
        'complete',
      ] as const) {
        ctx.podRepo.update(root.id, { status });
        ctx.podRepo.update(middle.id, { status });
        ctx.podRepo.update(last.id, { status });
      }

      // Pin PR onto root only. Last and middle share the branch but have no PR.
      ctx.podRepo.update(root.id, {
        prUrl: prOwnerUrl,
        worktreePath: '/tmp/wt/root',
      });
      ctx.podRepo.update(middle.id, {
        worktreePath: '/tmp/wt/middle',
      });
      // Drive `last` into merge_pending so spawnFixSession's status guard
      // accepts it (it normally requires merge_pending or complete).
      ctx.podRepo.update(last.id, {
        status: 'merge_pending',
        worktreePath: '/tmp/wt/last',
      });

      return { manager, root, middle, last, sharedBranch, prOwnerUrl };
    }

    it('redirects fix pod to PR-owning sibling branch when user spawns from non-PR pod', async () => {
      const ctx = createTestContext();
      // Tighten guard so the prUrl-less sibling's spawnFixSession path is covered:
      // status fetch should use the PR-owner's URL even though `last.prUrl` is null.
      (ctx.prManager.getPrStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        merged: false,
        open: true,
        blockReason: 'CI failed',
        ciFailures: [{ name: 'lint', conclusion: 'failure', detailsUrl: null, annotations: [] }],
        reviewComments: [],
      });

      const { manager, root, last, sharedBranch, prOwnerUrl } = setupSingleSeries(ctx);

      // User clicks the LAST (non-PR-owning) sibling
      await manager.spawnFixSession(last.id);

      const fixPod = ctx.podRepo.list({}).find((p) => p.linkedPodId === last.id);
      expect(fixPod, 'fix pod should be created off the user-clicked sibling').toBeDefined();

      // The fix pod must take its branch + prUrl from the PR-owner (root),
      // not from the triggering pod (last). This is the regression — without
      // the redirect the fix pod would inherit `last.branch` and its commits
      // would never reach the PR.
      expect(fixPod?.branch).toBe(sharedBranch);
      expect(fixPod?.prUrl).toBe(prOwnerUrl);

      // Audit trail (cooldown / fixPodId / prFixAttempts) must stay attached
      // to the user-clicked pod, not the redirected branch source.
      const reread = manager.getSession(last.id);
      expect(reread.fixPodId).toBe(fixPod?.id);
      expect(reread.prFixAttempts).toBe(1);

      // The redirect must not move audit state onto the PR owner.
      const rootAfter = manager.getSession(root.id);
      expect(rootAfter.fixPodId).toBeNull();
    });

    it('still resolves the PR owner even when the triggering pod has its own (mismatched) branch', async () => {
      const ctx = createTestContext();
      (ctx.prManager.getPrStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        merged: false,
        open: true,
        blockReason: 'CI failed',
        ciFailures: [{ name: 'lint', conclusion: 'failure', detailsUrl: null, annotations: [] }],
        reviewComments: [],
      });

      const { manager, last, sharedBranch, prOwnerUrl } = setupSingleSeries(ctx);

      // Simulate the bug condition: triggering pod's branch diverged from the
      // PR's actual branch. The redirect must still target the PR-owner branch.
      ctx.podRepo.update(last.id, { worktreePath: '/tmp/wt/last' });
      // Override branch directly via SQL — PodUpdates doesn't expose branch.
      ctx.db
        .prepare('UPDATE pods SET branch = ? WHERE id = ?')
        .run('feature/wrong-branch', last.id);

      await manager.spawnFixSession(last.id);

      const fixPod = ctx.podRepo.list({}).find((p) => p.linkedPodId === last.id);
      expect(fixPod?.branch).toBe(sharedBranch);
      expect(fixPod?.prUrl).toBe(prOwnerUrl);
      expect(fixPod?.branch).not.toBe('feature/wrong-branch');
    });

    it('throws when no pod in the series owns a PR yet', async () => {
      const ctx = createTestContext();

      const { manager, root, last } = setupSingleSeries(ctx);

      // Strip the PR off the would-be owner so the series has no PR-owning pod.
      ctx.podRepo.update(root.id, { prUrl: null });
      // Ensure spawnFixSession's own prUrl guard doesn't short-circuit first —
      // it accepts single-mode siblings even without prUrl.
      ctx.podRepo.update(last.id, { prUrl: null });

      await expect(manager.spawnFixSession(last.id)).rejects.toMatchObject({
        statusCode: 409,
      });
    });

    it('falls through to parent branch for non-single (stacked) series pods', async () => {
      const ctx = createTestContext();
      (ctx.prManager.getPrStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        merged: false,
        open: true,
        blockReason: 'CI failed',
        ciFailures: [{ name: 'lint', conclusion: 'failure', detailsUrl: null, annotations: [] }],
        reviewComments: [],
      });

      const manager = createPodManager(ctx.deps);
      const stackedPod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Stacked feature',
          seriesId: 'series-stacked',
          prMode: 'stacked',
          options: { agentMode: 'auto', output: 'pr' },
        },
        'user-1',
      );
      for (const status of [
        'provisioning',
        'running',
        'validating',
        'validated',
        'approved',
        'merging',
        'complete',
      ] as const) {
        ctx.podRepo.update(stackedPod.id, { status });
      }
      ctx.podRepo.update(stackedPod.id, {
        prUrl: 'https://github.com/org/repo/pull/200',
        worktreePath: '/tmp/wt/stacked',
      });

      await manager.spawnFixSession(stackedPod.id);

      const fixPod = ctx.podRepo.list({}).find((p) => p.linkedPodId === stackedPod.id);
      expect(fixPod?.branch).toBe(stackedPod.branch);
      expect(fixPod?.prUrl).toBe('https://github.com/org/repo/pull/200');
    });

    it('falls through to parent for non-series (standalone) pods', async () => {
      const ctx = createTestContext();
      (ctx.prManager.getPrStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        merged: false,
        open: true,
        blockReason: 'CI failed',
        ciFailures: [{ name: 'lint', conclusion: 'failure', detailsUrl: null, annotations: [] }],
        reviewComments: [],
      });

      const manager = createPodManager(ctx.deps);
      const standalone = manager.createSession(
        { profileName: 'test-profile', task: 'Standalone' },
        'user-1',
      );
      for (const status of [
        'provisioning',
        'running',
        'validating',
        'validated',
        'approved',
        'merging',
        'complete',
      ] as const) {
        ctx.podRepo.update(standalone.id, { status });
      }
      ctx.podRepo.update(standalone.id, {
        prUrl: 'https://github.com/org/repo/pull/300',
        worktreePath: '/tmp/wt/standalone',
      });

      await manager.spawnFixSession(standalone.id);

      const fixPod = ctx.podRepo.list({}).find((p) => p.linkedPodId === standalone.id);
      expect(fixPod?.branch).toBe(standalone.branch);
      expect(fixPod?.prUrl).toBe('https://github.com/org/repo/pull/300');
    });
  });

  describe('triggerValidation — loud-fail on push', () => {
    it('transitions pod to failed when mergeBranch throws a non-guard error (no silent merge)', async () => {
      // Regression: previously the validation pass path swallowed mergeBranch
      // failures, then carried forward an existing prUrl into Approved → Merging.
      // For misrouted fix pods that meant a stale PR could merge with no new
      // commits. Loud-fail: the rethrow must abort the validated transition.
      const ctx = createTestContext({ overall: 'pass' });
      (ctx.worktreeManager.mergeBranch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('ssh: connection refused'),
      );

      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        worktreePath: '/tmp/wt',
        // Pre-existing prUrl simulates a fix-pod carry-forward — without the
        // loud-fail this is exactly where "Approved → Merging" got triggered
        // with no new commits.
        prUrl: 'https://github.com/org/repo/pull/999',
      });

      await manager.triggerValidation(pod.id);

      const result = manager.getSession(pod.id);
      // Loud-fail: outer catch flips the pod to failed instead of validated.
      expect(result.status).toBe('failed');
      // Must NOT have created a PR or carried forward — the push didn't land.
      expect(ctx.prManager.createPr).not.toHaveBeenCalled();
    });

    it('still flags worktreeCompromised (not failed) on DeletionGuardError', async () => {
      // The deletion guard has its own quarantine path — keep that behavior
      // intact instead of regressing to plain "failed".
      const ctx = createTestContext({ overall: 'pass' });
      (ctx.worktreeManager.mergeBranch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new DeletionGuardError(2000, 100),
      );

      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        worktreePath: '/tmp/wt',
      });

      await manager.triggerValidation(pod.id);

      const result = manager.getSession(pod.id);
      expect(result.worktreeCompromised).toBe(true);
      // Guard caught the error: no rethrow, validation pass path continues.
      // The pod still reaches `validated` (no PR though, since createPr was
      // not invoked because the push failed).
      expect(result.status).toBe('validated');
    });
  });

  describe('resumePod — token-free escape hatch for failed pods', () => {
    function setupFailedPod(
      ctx: TestContext,
      overrides: {
        validationOverall?: 'pass' | 'fail';
        prUrl?: string | null;
        worktreePath?: string | null;
        worktreeCompromised?: boolean;
        containerId?: string | null;
      } = {},
    ) {
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do a thing' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'provisioning',
        worktreePath:
          overrides.worktreePath === undefined ? '/tmp/worktree/abc' : overrides.worktreePath,
        containerId: overrides.containerId === undefined ? 'container-xyz' : overrides.containerId,
        startedAt: new Date().toISOString(),
      });
      // Move into a state we can transition to `failed` from.
      ctx.podRepo.update(pod.id, { status: 'running' });
      // Stash a validation result if requested. lastValidationResult is `unknown` so
      // we shape it to match what pod-manager checks: `lastValidationResult.overall`.
      if (overrides.validationOverall !== undefined) {
        ctx.podRepo.update(pod.id, {
          lastValidationResult: {
            podId: pod.id,
            attempt: 1,
            timestamp: new Date().toISOString(),
            smoke: null,
            taskReview: null,
            overall: overrides.validationOverall,
            duration: 1000,
          },
        });
      }
      if (overrides.prUrl !== undefined) {
        ctx.podRepo.update(pod.id, { prUrl: overrides.prUrl });
      }
      if (overrides.worktreeCompromised) {
        ctx.podRepo.update(pod.id, { worktreeCompromised: true });
      }
      ctx.podRepo.update(pod.id, { status: 'failed' });
      return { manager, pod };
    }

    it('Path 1: passed validation + no PR → pushes branch, opens PR, returns to validated', async () => {
      const ctx = createTestContext();
      const { manager, pod } = setupFailedPod(ctx, {
        validationOverall: 'pass',
        prUrl: null,
      });

      const result = await manager.resumePod(pod.id);

      expect(result).toEqual({ action: 'retry-pr' });
      expect(ctx.worktreeManager.mergeBranch).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: '/tmp/worktree/abc',
          targetBranch: pod.branch,
          maxDeletions: 0,
        }),
      );
      expect(ctx.prManager.createPr).toHaveBeenCalledTimes(1);

      const refreshed = manager.getSession(pod.id);
      expect(refreshed.status).toBe('validated');
      expect(refreshed.prUrl).toBe('https://github.com/org/repo/pull/42');
    });

    it('Path 1: surfaces push failures as BRANCH_PUSH_FAILED without flipping the pod', async () => {
      const ctx = createTestContext();
      const { manager, pod } = setupFailedPod(ctx, {
        validationOverall: 'pass',
        prUrl: null,
      });
      (ctx.worktreeManager.mergeBranch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('ssh: connection refused'),
      );

      await expect(manager.resumePod(pod.id)).rejects.toMatchObject({
        code: 'BRANCH_PUSH_FAILED',
        statusCode: 502,
      });

      const refreshed = manager.getSession(pod.id);
      // Still failed — the pod didn't move forward because push failed.
      expect(refreshed.status).toBe('failed');
      expect(refreshed.prUrl).toBeNull();
    });

    it('Path 2: failed validation → routes to revalidate (force=true) without spawning agent', async () => {
      const ctx = createTestContext();
      const { manager, pod } = setupFailedPod(ctx, {
        validationOverall: 'fail',
        prUrl: null,
      });

      // Spy on revalidateSession so we can assert the routing decision without
      // needing to walk through the full revalidation pipeline.
      const revalidateSpy = vi
        .spyOn(manager, 'revalidateSession')
        .mockResolvedValue({ newCommits: false, result: 'pass' });

      const result = await manager.resumePod(pod.id);

      expect(result).toEqual({ action: 'revalidate' });
      expect(revalidateSpy).toHaveBeenCalledWith(pod.id, { force: true });
      // Cheapest possible recovery — never spawn the agent runtime again.
      expect(ctx.runtime.spawn).not.toHaveBeenCalled();
      expect(ctx.runtime.resume).not.toHaveBeenCalled();
    });

    it('Path 2: existing PR + failed validation → revalidates (no second PR)', async () => {
      const ctx = createTestContext();
      const { manager, pod } = setupFailedPod(ctx, {
        validationOverall: 'fail',
        prUrl: 'https://github.com/org/repo/pull/7',
      });

      const revalidateSpy = vi
        .spyOn(manager, 'revalidateSession')
        .mockResolvedValue({ newCommits: false, result: 'pass' });

      const result = await manager.resumePod(pod.id);

      expect(result).toEqual({ action: 'revalidate' });
      expect(revalidateSpy).toHaveBeenCalledWith(pod.id, { force: true });
      // PR already exists — do not try to push a second one.
      expect(ctx.prManager.createPr).not.toHaveBeenCalled();
    });

    it('rejects when pod is not in failed status', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do a thing' },
        'user-1',
      );

      await expect(manager.resumePod(pod.id)).rejects.toMatchObject({
        code: 'INVALID_STATE',
        statusCode: 409,
      });
    });

    it('rejects when pod has no worktree (nothing to push or revalidate)', async () => {
      const ctx = createTestContext();
      const { manager, pod } = setupFailedPod(ctx, {
        validationOverall: 'pass',
        worktreePath: null,
      });

      await expect(manager.resumePod(pod.id)).rejects.toMatchObject({
        code: 'INVALID_STATE',
        statusCode: 409,
      });
    });

    it('rejects when worktree is compromised — operator must recover first', async () => {
      const ctx = createTestContext();
      const { manager, pod } = setupFailedPod(ctx, {
        validationOverall: 'pass',
        worktreeCompromised: true,
      });

      await expect(manager.resumePod(pod.id)).rejects.toMatchObject({
        code: 'WORKTREE_COMPROMISED',
        statusCode: 409,
      });
      // Refused before any push attempt.
      expect(ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    });
  });

  describe('forceComplete — admin override for stuck failed pods', () => {
    function setupFailedPod(ctx: TestContext, opts: { containerId?: string | null } = {}) {
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do a thing' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'provisioning',
        worktreePath: '/tmp/worktree/abc',
        containerId: opts.containerId === undefined ? 'container-xyz' : opts.containerId,
        startedAt: new Date().toISOString(),
      });
      ctx.podRepo.update(pod.id, { status: 'running' });
      ctx.podRepo.update(pod.id, { status: 'failed' });
      return { manager, pod };
    }

    it('transitions failed → complete and persists the operator reason', async () => {
      const ctx = createTestContext();
      const { manager, pod } = setupFailedPod(ctx);

      await manager.forceComplete(pod.id, 'subscription got nuked, work is fine');

      const refreshed = manager.getSession(pod.id);
      expect(refreshed.status).toBe('complete');
      expect(refreshed.forceCompletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(refreshed.forceCompletedReason).toBe('subscription got nuked, work is fine');
    });

    it('persists null when no reason is provided (or only whitespace)', async () => {
      const ctx = createTestContext();
      const { manager, pod } = setupFailedPod(ctx);

      await manager.forceComplete(pod.id, '   ');

      const refreshed = manager.getSession(pod.id);
      expect(refreshed.status).toBe('complete');
      expect(refreshed.forceCompletedReason).toBeNull();
    });

    it('stops the underlying container as part of the override', async () => {
      const ctx = createTestContext();
      const { manager, pod } = setupFailedPod(ctx, { containerId: 'container-stuck' });

      await manager.forceComplete(pod.id);

      expect(ctx.containerManager.stop).toHaveBeenCalledWith('container-stuck');
    });

    it('still completes when the container stop fails (best-effort cleanup)', async () => {
      const ctx = createTestContext();
      const { manager, pod } = setupFailedPod(ctx);
      (ctx.containerManager.stop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('container already gone'),
      );

      await manager.forceComplete(pod.id, 'cleanup');

      const refreshed = manager.getSession(pod.id);
      expect(refreshed.status).toBe('complete');
      expect(refreshed.forceCompletedReason).toBe('cleanup');
    });

    it('does not call container.stop when the pod has no containerId', async () => {
      const ctx = createTestContext();
      const { manager, pod } = setupFailedPod(ctx, { containerId: null });

      await manager.forceComplete(pod.id);

      expect(ctx.containerManager.stop).not.toHaveBeenCalled();
      const refreshed = manager.getSession(pod.id);
      expect(refreshed.status).toBe('complete');
    });

    it('rejects when pod is already complete (no double-override)', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do a thing' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'provisioning',
        worktreePath: '/tmp/worktree/abc',
        containerId: 'container-xyz',
        startedAt: new Date().toISOString(),
      });
      for (const status of [
        'running',
        'validating',
        'validated',
        'approved',
        'merging',
        'complete',
      ] as const) {
        ctx.podRepo.update(pod.id, { status });
      }

      await expect(manager.forceComplete(pod.id, 'reason')).rejects.toMatchObject({
        code: 'INVALID_STATE',
        statusCode: 409,
      });
    });

    it('rejects when pod is in any non-failed status', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do a thing' },
        'user-1',
      );
      // queued → not failed.
      await expect(manager.forceComplete(pod.id)).rejects.toMatchObject({
        code: 'INVALID_STATE',
        statusCode: 409,
      });

      const refreshed = manager.getSession(pod.id);
      expect(refreshed.status).toBe('queued');
      expect(refreshed.forceCompletedAt).toBeNull();
    });

    it('throws PodNotFoundError for unknown pod IDs', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      await expect(manager.forceComplete('does-not-exist', 'whatever')).rejects.toBeInstanceOf(
        PodNotFoundError,
      );
    });
  });

  describe('processPod — missing profile is caught (no orphaned queued pods)', () => {
    it('transitions pod out of queued when profileStore.get throws after creation', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature', skipValidation: true },
        'user-1',
      );

      // Simulate the profile being deleted (or its extends chain breaking) AFTER
      // the pod was queued — processPod's outer try/catch must catch this and
      // transition the pod into a terminal state (killed, since queued→failed
      // is not directly valid; the catch falls back to killing→killed).
      // The point of the bug fix is that the pod must NOT sit as 'queued' forever.
      vi.mocked(ctx.profileStore.get).mockImplementation((name: string) => {
        throw new Error(`Profile "${name}" not found`);
      });

      await manager.processPod(pod.id);

      const refreshed = manager.getSession(pod.id);
      expect(refreshed.status).not.toBe('queued');
      expect(['failed', 'killed']).toContain(refreshed.status);
    });
  });

  describe('kickPod — manual escape hatch', () => {
    it('re-enqueues a stuck queued pod and persists the reason', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'do thing' },
        'user-1',
      );
      // Pod is created in 'queued' state.
      ctx.enqueuedSessions.length = 0;

      const result = await manager.kickPod(pod.id, 'queue stalled');

      expect(result).toEqual({ action: 'requeued' });
      expect(ctx.enqueuedSessions).toEqual([pod.id]);
      const refreshed = manager.getSession(pod.id);
      expect(refreshed.status).toBe('queued');
      expect(refreshed.kickedReason).toBe('queue stalled');
      expect(refreshed.kickedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('kills container and transitions running pod to failed', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'do thing' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'provisioning',
        worktreePath: '/tmp/worktree/abc',
        containerId: 'container-stuck',
        startedAt: new Date().toISOString(),
      });
      ctx.podRepo.update(pod.id, { status: 'running' });

      const result = await manager.kickPod(pod.id, 'agent wedged');

      expect(result).toEqual({ action: 'failed' });
      expect(ctx.containerManager.stop).toHaveBeenCalledWith('container-stuck');
      const refreshed = manager.getSession(pod.id);
      expect(refreshed.status).toBe('failed');
      expect(refreshed.kickedReason).toBe('agent wedged');
    });

    it('still transitions to failed if container.stop throws (best-effort cleanup)', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'do thing' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'provisioning',
        worktreePath: '/tmp/worktree/abc',
        containerId: 'container-stuck',
        startedAt: new Date().toISOString(),
      });
      ctx.podRepo.update(pod.id, { status: 'running' });
      (ctx.containerManager.stop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('container already gone'),
      );

      await manager.kickPod(pod.id);

      const refreshed = manager.getSession(pod.id);
      expect(refreshed.status).toBe('failed');
    });

    it('rejects with INVALID_STATE for non-kickable statuses', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'do thing' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'provisioning',
        worktreePath: '/tmp/worktree/abc',
        containerId: 'c1',
        startedAt: new Date().toISOString(),
      });
      ctx.podRepo.update(pod.id, { status: 'running' });
      ctx.podRepo.update(pod.id, { status: 'failed' });

      await expect(manager.kickPod(pod.id, 'whatever')).rejects.toMatchObject({
        code: 'INVALID_STATE',
        statusCode: 409,
      });
    });

    it('throws PodNotFoundError for unknown pod IDs', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      await expect(manager.kickPod('nope', 'reason')).rejects.toBeInstanceOf(PodNotFoundError);
    });
  });

  describe('startStuckPodWatchdog — auto-fail running pods that have gone silent', () => {
    it('transitions a stale running pod to failed and stops the container', async () => {
      vi.useFakeTimers();
      try {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'do thing' },
          'user-1',
        );
        // Wedge the pod into running with a stale lastAgentEventAt (35 min old).
        const stale = new Date(Date.now() - 35 * 60 * 1000).toISOString();
        ctx.podRepo.update(pod.id, {
          status: 'provisioning',
          worktreePath: '/tmp/worktree/abc',
          containerId: 'container-hung',
          startedAt: stale,
        });
        ctx.podRepo.update(pod.id, { status: 'running', lastAgentEventAt: stale });

        // Tight thresholds + interval so a single tick fires.
        manager.startStuckPodWatchdog({ intervalMs: 50, thresholdMs: 30 * 60 * 1000 });
        // Fire one tick. The tick is async but its first microtask runs
        // synchronously after advanceTimersByTimeAsync resolves; advancing
        // a hair more lets any awaited container.stop / transition settle.
        await vi.advanceTimersByTimeAsync(60);
        await vi.advanceTimersByTimeAsync(0);
        manager.stopStuckPodWatchdog();

        expect(ctx.containerManager.stop).toHaveBeenCalledWith('container-hung');
        const refreshed = manager.getSession(pod.id);
        expect(refreshed.status).toBe('failed');
      } finally {
        vi.useRealTimers();
      }
    });

    it('leaves a fresh running pod alone', async () => {
      vi.useFakeTimers();
      try {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'do thing' },
          'user-1',
        );
        const fresh = new Date().toISOString();
        ctx.podRepo.update(pod.id, {
          status: 'provisioning',
          worktreePath: '/tmp/worktree/abc',
          containerId: 'container-active',
          startedAt: fresh,
        });
        ctx.podRepo.update(pod.id, { status: 'running', lastAgentEventAt: fresh });

        manager.startStuckPodWatchdog({ intervalMs: 50, thresholdMs: 30 * 60 * 1000 });
        await vi.advanceTimersByTimeAsync(60);
        await vi.advanceTimersByTimeAsync(0);
        manager.stopStuckPodWatchdog();

        expect(ctx.containerManager.stop).not.toHaveBeenCalled();
        const refreshed = manager.getSession(pod.id);
        expect(refreshed.status).toBe('running');
      } finally {
        vi.useRealTimers();
      }
    });

    it('is idempotent — calling start twice does not stack timers', () => {
      vi.useFakeTimers();
      try {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        manager.startStuckPodWatchdog({ intervalMs: 1000, thresholdMs: 60_000 });
        manager.startStuckPodWatchdog({ intervalMs: 1000, thresholdMs: 60_000 });
        // Two starts → still only one interval; stop() must clear cleanly.
        manager.stopStuckPodWatchdog();
        manager.stopStuckPodWatchdog(); // should not throw
        expect(ctx.containerManager.stop).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
