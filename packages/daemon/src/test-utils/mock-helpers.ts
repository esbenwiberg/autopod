import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentEscalationEvent,
  AgentEvent,
  EscalationRequest,
  Runtime,
  RuntimeType,
  ScheduledJob,
  StackTemplate,
  ValidationResult,
} from '@autopod/shared';
import Database from 'better-sqlite3';
import pino from 'pino';
import { vi } from 'vitest';
import type {
  ContainerManager,
  RuntimeRegistry,
  ValidationEngine,
  WorktreeManager,
} from '../interfaces/index.js';
import type { ProfileStore } from '../profiles/index.js';
import { createScheduledJobRepository } from '../scheduled-jobs/scheduled-job-repository.js';
import { createEscalationRepository } from '../sessions/escalation-repository.js';
import type { EscalationRepository } from '../sessions/escalation-repository.js';
import { createEventBus } from '../sessions/event-bus.js';
import type { EventBus } from '../sessions/event-bus.js';
import { createEventRepository } from '../sessions/event-repository.js';
import { createNudgeRepository } from '../sessions/nudge-repository.js';
import type { NudgeRepository } from '../sessions/nudge-repository.js';
import type { SessionManagerDependencies } from '../sessions/session-manager.js';
import { createSessionRepository } from '../sessions/session-repository.js';
import type { SessionRepository } from '../sessions/session-repository.js';

export const logger = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    // Split multi-statement migrations and tolerate "duplicate column" errors
    // that arise from 001_initial.sql already having columns that later
    // ALTER TABLE migrations re-add.
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

export function insertTestProfile(
  db: Database.Database,
  overrides: { name?: string; maxValidationAttempts?: number } = {},
) {
  const name = overrides.name ?? 'test-profile';
  const maxValidationAttempts = overrides.maxValidationAttempts ?? 3;

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
    maxValidationAttempts,
    defaultModel: 'opus',
    defaultRuntime: 'claude',
    escalationConfig: JSON.stringify({
      askHuman: true,
      askAi: { enabled: true, model: 'sonnet', maxCalls: 5 },
      advisor: { enabled: false },
      autoPauseAfter: 3,
      humanResponseTimeout: 3600,
    }),
  });
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

export function createMockRuntime(overrides?: {
  spawn?: Runtime['spawn'];
  resume?: Runtime['resume'];
}): Runtime {
  return {
    type: 'claude',
    spawn: overrides?.spawn ?? vi.fn(async function* () {} as () => AsyncIterable<AgentEvent>),
    resume: overrides?.resume ?? vi.fn(async function* () {} as () => AsyncIterable<AgentEvent>),
    abort: vi.fn(async () => {}),
  };
}

export function createMockContainerManager(): ContainerManager {
  return {
    spawn: vi.fn(async () => 'container-123'),
    kill: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => ''),
    extractDirectoryFromContainer: vi.fn(async () => {}),
    getStatus: vi.fn(async () => 'running' as const),
    execInContainer: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    execStreaming: vi.fn(),
  };
}

export function createMockWorktreeManager(): WorktreeManager {
  return {
    create: vi.fn(async () => ({
      worktreePath: '/tmp/worktree/abc',
      bareRepoPath: '/tmp/bare/abc.git',
    })),
    cleanup: vi.fn(async () => {}),
    getDiffStats: vi.fn(async () => ({ filesChanged: 3, linesAdded: 50, linesRemoved: 10 })),
    getDiff: vi.fn(async () => 'diff --git a/file.ts b/file.ts\n+added line'),
    mergeBranch: vi.fn(async () => {}),
    commitFiles: vi.fn(async () => {}),
    commitPendingChanges: vi.fn(async () => false),
    pushBranch: vi.fn(async () => {}),
    pullBranch: vi.fn(async () => ({ newCommits: false })),
    getCommitLog: vi.fn(async () => 'abc1234 feat: implement feature\ndef5678 fix: edge case'),
  };
}

export function createMockRuntimeRegistry(runtime: Runtime): RuntimeRegistry {
  return {
    get: vi.fn(() => runtime),
  };
}

export function createPassingValidationResult(sessionId: string, attempt = 1): ValidationResult {
  return {
    sessionId,
    attempt,
    timestamp: new Date().toISOString(),
    smoke: {
      status: 'pass',
      build: { status: 'pass', output: '', duration: 100 },
      health: { status: 'pass', url: 'http://localhost:3000', responseCode: 200, duration: 50 },
      pages: [],
    },
    taskReview: null,
    overall: 'pass',
    duration: 5000,
  };
}

export function createFailingValidationResult(sessionId: string, attempt = 1): ValidationResult {
  return {
    sessionId,
    attempt,
    timestamp: new Date().toISOString(),
    smoke: {
      status: 'fail',
      build: { status: 'fail', output: 'Build error: type mismatch', duration: 200 },
      health: { status: 'fail', url: 'http://localhost:3000', responseCode: null, duration: 0 },
      pages: [],
    },
    taskReview: null,
    overall: 'fail',
    duration: 3000,
  };
}

export function createMockValidationEngine(
  resultFactory?: (config: { sessionId: string; attempt: number }) => ValidationResult,
): ValidationEngine {
  const defaultFactory = (config: { sessionId: string; attempt: number }) =>
    createPassingValidationResult(config.sessionId, config.attempt);

  return {
    validate: vi.fn(async (config) => (resultFactory ?? defaultFactory)(config)),
  };
}

export function createMockProfileStore(db: Database.Database): ProfileStore {
  return {
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
        skills: JSON.parse((row.skills as string) ?? '[]'),
        networkPolicy: row.network_policy ? JSON.parse(row.network_policy as string) : null,
        actionPolicy: row.action_policy ? JSON.parse(row.action_policy as string) : null,
        outputMode: (row.output_mode as 'pr' | 'artifact' | 'workspace') ?? 'pr',
        modelProvider: (row.model_provider as 'anthropic' | 'max' | 'foundry') ?? 'anthropic',
        providerCredentials: row.provider_credentials
          ? JSON.parse(row.provider_credentials as string)
          : null,
        testCommand: (row.test_command as string) ?? null,
        prProvider: (row.pr_provider as 'github' | 'ado') ?? 'github',
        adoPat: (row.ado_pat as string) ?? null,
        githubPat: (row.github_pat as string) ?? null,
        privateRegistries: JSON.parse((row.private_registries as string) ?? '[]'),
        registryPat: (row.registry_pat as string) ?? null,
        branchPrefix: (row.branch_prefix as string) ?? 'autopod/',
        containerMemoryGb: (row.container_memory_gb as number | null) ?? null,
        buildTimeout: (row.build_timeout as number | null) ?? 300,
        testTimeout: (row.test_timeout as number | null) ?? 600,
        version: (row.version as number | null) ?? 1,
        workerProfile: (row.worker_profile as string) ?? null,
        tokenBudget: (row.token_budget as number | null) ?? null,
        tokenBudgetWarnAt: (row.token_budget_warn_at as number | null) ?? 0.8,
        tokenBudgetPolicy: (row.token_budget_policy as 'soft' | 'hard' | null) ?? 'soft',
        maxBudgetExtensions: (row.max_budget_extensions as number | null) ?? null,
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
}

export function insertTestScheduledJob(
  db: Database.Database,
  overrides: Partial<ScheduledJob> = {},
): ScheduledJob {
  const repo = createScheduledJobRepository(db);
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  return repo.insert({
    id: overrides.id ?? `job-${Date.now()}`,
    name: overrides.name ?? 'Test Job',
    profileName: overrides.profileName ?? 'test-profile',
    task: overrides.task ?? 'Run the test task',
    cronExpression: overrides.cronExpression ?? '0 9 * * 1',
    enabled: overrides.enabled ?? true,
    nextRunAt: overrides.nextRunAt ?? futureDate,
    lastRunAt: overrides.lastRunAt ?? null,
    lastSessionId: overrides.lastSessionId ?? null,
    catchupPending: overrides.catchupPending ?? false,
  });
}

// ---------------------------------------------------------------------------
// Agent event helpers
// ---------------------------------------------------------------------------

export function statusEvent(message: string): AgentEvent {
  return { type: 'status', timestamp: new Date().toISOString(), message };
}

export function completeEvent(result = 'Done'): AgentEvent {
  return { type: 'complete', timestamp: new Date().toISOString(), result };
}

export function completeWithTokensEvent(
  inputTokens: number,
  outputTokens: number,
  result = 'Done',
): AgentEvent {
  return {
    type: 'complete',
    timestamp: new Date().toISOString(),
    result,
    totalInputTokens: inputTokens,
    totalOutputTokens: outputTokens,
  };
}

export function escalationEvent(
  sessionId: string,
  question = 'What should I do?',
): AgentEscalationEvent {
  return {
    type: 'escalation',
    timestamp: new Date().toISOString(),
    escalationType: 'ask_human',
    payload: {
      id: `esc-${Date.now()}`,
      sessionId,
      type: 'ask_human',
      timestamp: new Date().toISOString(),
      payload: { question },
      response: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Full test context
// ---------------------------------------------------------------------------

export interface TestContext {
  db: Database.Database;
  sessionRepo: SessionRepository;
  escalationRepo: EscalationRepository;
  nudgeRepo: NudgeRepository;
  eventBus: EventBus;
  profileStore: ProfileStore;
  containerManager: ContainerManager;
  worktreeManager: WorktreeManager;
  runtimeRegistry: RuntimeRegistry;
  validationEngine: ValidationEngine;
  runtime: Runtime;
  enqueuedSessions: string[];
  deps: SessionManagerDependencies;
}

export function createTestContext(opts?: {
  validationResultFactory?: (config: { sessionId: string; attempt: number }) => ValidationResult;
  runtime?: Runtime;
  maxValidationAttempts?: number;
}): TestContext {
  const db = createTestDb();
  insertTestProfile(db, { maxValidationAttempts: opts?.maxValidationAttempts });

  const sessionRepo = createSessionRepository(db);
  const eventRepo = createEventRepository(db);
  const escalationRepo = createEscalationRepository(db);
  const nudgeRepo = createNudgeRepository(db);
  const eventBus = createEventBus(eventRepo, logger);
  const profileStore = createMockProfileStore(db);

  const runtime = opts?.runtime ?? createMockRuntime();
  const containerManager = createMockContainerManager();
  const worktreeManager = createMockWorktreeManager();
  const runtimeRegistry = createMockRuntimeRegistry(runtime);
  const validationEngine = createMockValidationEngine(opts?.validationResultFactory);

  const enqueuedSessions: string[] = [];

  const deps: SessionManagerDependencies = {
    sessionRepo,
    escalationRepo,
    nudgeRepo,
    profileStore,
    eventBus,
    containerManagerFactory: { get: vi.fn(() => containerManager) },
    worktreeManager,
    runtimeRegistry,
    validationEngine,
    enqueueSession: (id) => enqueuedSessions.push(id),
    mcpBaseUrl: 'http://localhost:8080',
    daemonConfig: { mcpServers: [], claudeMdSections: [], skills: [] },
    logger,
  };

  return {
    db,
    sessionRepo,
    escalationRepo,
    nudgeRepo,
    eventBus,
    profileStore,
    containerManager,
    worktreeManager,
    runtimeRegistry,
    validationEngine,
    runtime,
    enqueuedSessions,
    deps,
  };
}
