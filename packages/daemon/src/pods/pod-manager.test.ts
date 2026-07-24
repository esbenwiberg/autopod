import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentEvent,
  PodCreatedEvent,
  Profile,
  ProviderAccount,
  ProviderCredentials,
  ReadinessReview,
  ReadinessStatus,
  Runtime,
  RuntimeType,
  StackTemplate,
  ValidationResult,
} from '@autopod/shared';
import {
  AutopodError,
  InvalidStateTransitionError,
  PodNotFoundError,
  WORKSPACE_PI_HANDOFF_PATH,
} from '@autopod/shared';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process so we can control deriveBareRepoPath and recovery-context git calls
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('../providers/memory-reviewer.js', () => ({
  createProfileMemoryReviewer: vi.fn(),
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
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import { createProfileMemoryReviewer } from '../providers/memory-reviewer.js';
import { ResumeSessionNotFoundError } from '../runtimes/claude-runtime.js';
import { DeletionGuardError } from '../worktrees/local-worktree-manager.js';
import { createEscalationRepository } from './escalation-repository.js';
import type { EscalationRepository } from './escalation-repository.js';
import { createEventBus } from './event-bus.js';
import type { EventBus } from './event-bus.js';
import { createEventRepository } from './event-repository.js';
import type { EventRepository } from './event-repository.js';
import { createFixFeedbackRepository } from './fix-feedback-repository.js';
import { createMemoryRepository } from './memory-repository.js';
import { createMemoryUsageRepository } from './memory-usage-repository.js';
import {
  AGENT_ENV_PATH,
  AGENT_SHIM_PATH,
  type PodManagerDependencies,
  createPodManager,
  selectMemoryBriefingForPod,
} from './pod-manager.js';
import { createPodRepository } from './pod-repository.js';
import type { PodRepository } from './pod-repository.js';
import { createValidationRepository } from './validation-repository.js';

const logger = pino({ level: 'silent' });

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForAssertion(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 3_000, interval: 10 });
}

function mockExecFileSuccess(): void {
  mockedExecFile.mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1] as (
      err: Error | null,
      result: { stdout: string; stderr: string },
    ) => void;
    callback(null, { stdout: '', stderr: '' });
    return undefined as never;
  });
}

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
  defaultBranch?: string;
  privateRegistries?: string;
  registryPat?: string;
  registryPatExpiresAt?: string;
  branchPrefix?: string;
  githubPat?: string;
  githubPatExpiresAt?: string;
  adoPat?: string;
  adoPatExpiresAt?: string;
  prProvider?: 'github' | 'ado';
  defaultModel?: string;
  defaultRuntime?: RuntimeType;
  executionTarget?: Profile['executionTarget'];
  warmImageTag?: string | null;
  modelProvider?: Profile['modelProvider'];
  validationSetupCommand?: string | null;
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
      validation_setup_command,
      private_registries, registry_pat, registry_pat_expires_at, branch_prefix,
      pr_provider, github_pat, github_pat_expires_at, ado_pat, ado_pat_expires_at,
      model_provider
    ) VALUES (
      @name, @repoUrl, @defaultBranch, @template, @buildCommand, @startCommand,
      @healthPath, @healthTimeout, @validationPages, @maxValidationAttempts,
      @defaultModel, @defaultRuntime, @escalationConfig,
      @validationSetupCommand,
      @privateRegistries, @registryPat, @registryPatExpiresAt, @branchPrefix,
      @prProvider, @githubPat, @githubPatExpiresAt, @adoPat, @adoPatExpiresAt,
      @modelProvider
    )
  `).run({
    name,
    repoUrl: 'https://github.com/org/repo',
    defaultBranch: opts.defaultBranch ?? 'main',
    template: 'node22',
    buildCommand: 'npm run build',
    startCommand: 'npm start',
    healthPath: '/health',
    healthTimeout: 120,
    validationPages: '[]',
    maxValidationAttempts: 3,
    defaultModel: opts.defaultModel ?? 'opus',
    defaultRuntime: opts.defaultRuntime ?? 'claude',
    validationSetupCommand: opts.validationSetupCommand ?? null,
    escalationConfig: JSON.stringify({
      askHuman: true,
      askAi: { enabled: true, model: 'sonnet', maxCalls: 5 },
      advisor: { enabled: false },
      autoPauseAfter: 3,
      humanResponseTimeout: 3600,
    }),
    privateRegistries: opts.privateRegistries ?? '[]',
    registryPat: opts.registryPat ?? null,
    registryPatExpiresAt: opts.registryPatExpiresAt ?? null,
    branchPrefix: opts.branchPrefix ?? 'autopod/',
    prProvider: opts.prProvider ?? 'github',
    githubPat: opts.githubPat ?? null,
    githubPatExpiresAt: opts.githubPatExpiresAt ?? null,
    adoPat: opts.adoPat ?? null,
    adoPatExpiresAt: opts.adoPatExpiresAt ?? null,
    modelProvider: opts.modelProvider ?? 'anthropic',
  });
}

function insertProviderAccount(
  db: Database.Database,
  id: string,
  provider: NonNullable<Profile['modelProvider']>,
  credentials: unknown,
): void {
  db.prepare(
    `INSERT INTO provider_accounts (
      id, name, provider, credentials, created_at, updated_at
    ) VALUES (
      @id, @name, @provider, @credentials, @now, @now
    )`,
  ).run({
    id,
    name: id,
    provider,
    credentials: credentials ? JSON.stringify(credentials) : null,
    now: new Date().toISOString(),
  });
}

function linkProfileToProviderAccount(
  db: Database.Database,
  profileName: string,
  providerAccountId: string,
): void {
  db.prepare('UPDATE profiles SET provider_account_id = ? WHERE name = ?').run(
    providerAccountId,
    profileName,
  );
}

function createMutableProviderAccountStore(
  id: string,
  provider: NonNullable<Profile['modelProvider']>,
  initialCredentials: ProviderCredentials | null,
): ProviderAccountStore {
  let credentials = initialCredentials;
  const account = (): ProviderAccount => ({
    id,
    name: id,
    provider,
    credentials,
    lastAuthenticatedAt: credentials ? '2026-01-01T00:00:00.000Z' : null,
    lastUsedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  return {
    create: vi.fn(() => account()),
    get: vi.fn((requestedId: string) => {
      if (requestedId !== id) throw new Error(`Unexpected provider account id: ${requestedId}`);
      return account();
    }),
    list: vi.fn(() => [account()]),
    update: vi.fn(() => account()),
    updateCredentials: vi.fn(
      (
        requestedId: string,
        updatedCredentials: ProviderCredentials | null,
        _options?: { authenticatedAt?: string | null; touchLastUsed?: boolean },
      ) => {
        if (requestedId !== id) throw new Error(`Unexpected provider account id: ${requestedId}`);
        credentials = updatedCredentials;
        return account();
      },
    ),
    touchLastUsed: vi.fn(),
    delete: vi.fn(),
    exists: vi.fn((requestedId: string) => requestedId === id),
    listLinkedProfileNames: vi.fn(() => ['test-profile']),
  };
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
    execInContainer: vi.fn(async (_containerId, command) => {
      if (command.join(' ') === 'codex --version') {
        return { stdout: 'codex-cli 0.144.4\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
    execStreaming: vi.fn(),
    attachTerminal: vi.fn(async () => ({
      onData: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
    })),
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
    hasChangesAgainstBase: vi.fn(async () => true),
    getDiff: vi.fn(async () => 'diff --git a/file.ts b/file.ts\n+added line'),
    mergeBranch: vi.fn(async () => {}),
    commitFiles: vi.fn(async () => {}),
    commitPendingChanges: vi.fn(async () => false),
    commitPendingChangesWithGeneratedMessage: vi.fn(async () => false),
    pushBranch: vi.fn(async () => {}),
    ensureRemoteBranch: vi.fn(async ({ branch }) => ({ branch, created: false })),
    pullBranch: vi.fn(async () => ({ newCommits: false })),
    rebaseOntoBase: vi.fn(async () => ({ alreadyUpToDate: false, rebased: true, conflicts: [] })),
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
    createPr: vi.fn(async () => ({
      url: 'https://github.com/org/repo/pull/42',
      usedFallback: false,
    })),
    mergePr: vi.fn(async () => ({ merged: true, autoMergeScheduled: false })),
    getPrStatus: vi.fn(async () => ({
      merged: true,
      open: false,
      blockReason: null,
      ciFailures: [],
      reviewComments: [],
    })),
    replyToReviewFeedback: vi.fn(async () => ({
      posted: 0,
      skipped: 0,
      resolved: 0,
      errors: [],
      resolutionErrors: [],
    })),
  };
}

function makeValidationResult(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    podId: 'test',
    attempt: 1,
    timestamp: new Date().toISOString(),
    smoke: {
      status: 'pass',
      build: { status: 'pass', output: '', duration: 100 },
      health: {
        status: 'pass',
        url: 'http://localhost:3000',
        responseCode: 200,
        duration: 50,
      },
      pages: [],
    },
    taskReview: null,
    overall: 'pass',
    duration: 5000,
    ...overrides,
  };
}

function makeReadinessReview(status: ReadinessStatus, summary?: string): ReadinessReview {
  return {
    status,
    summary: summary ?? `Readiness is ${status}.`,
    computedAt: '2026-06-07T12:00:00.000Z',
    scope: 'pod',
    areas: [
      {
        area: 'validation',
        status,
        title: 'Validation',
        summary: summary ?? `Validation area is ${status}.`,
        sourceRefs: [{ kind: 'validation', label: 'Validation' }],
      },
    ],
    findings:
      status === 'ready'
        ? []
        : [
            {
              id: `${status}-finding`,
              area: 'validation',
              severity: status === 'risky' ? 'error' : 'warning',
              title: `${status} finding`,
              detail: summary ?? `Readiness is ${status}.`,
              sourceRefs: [{ kind: 'validation', label: 'Validation' }],
            },
          ],
    approval: null,
  };
}

function validatedPodUpdates(
  podId: string,
  updates: Parameters<TestContext['podRepo']['update']>[1] = {},
): Parameters<TestContext['podRepo']['update']>[1] {
  return {
    status: 'validated',
    lastValidationResult: makeValidationResult({ podId }),
    ...updates,
  };
}

function makeReviewInfraFailure(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return makeValidationResult({
    overall: 'fail',
    taskReview: null,
    reviewSkipKind: 'review-timeout',
    reviewSkipReason: 'Review timed out: codex review exceeded 300000ms',
    ...overrides,
  });
}

function makeBuildFailure(): ValidationResult {
  return makeValidationResult({
    overall: 'fail',
    smoke: {
      status: 'fail',
      build: { status: 'fail', output: 'TypeScript compile error', duration: 100 },
      health: {
        status: 'pass',
        url: 'http://localhost:3000',
        responseCode: 200,
        duration: 50,
      },
      pages: [],
    },
    reviewSkipKind: 'upstream-failed',
    reviewSkipReason: 'Skipped - earlier validation phases failed',
  });
}

function makeSetupFailure(): ValidationResult {
  return makeValidationResult({
    overall: 'fail',
    setup: {
      status: 'fail',
      output: 'pip install failed\nruff: not found',
      duration: 42,
    },
    smoke: {
      status: 'fail',
      build: {
        status: 'pass',
        output: 'Build phase skipped because validation setup failed',
        duration: 0,
      },
      health: {
        status: 'skip',
        url: 'http://localhost:3000/health',
        responseCode: null,
        duration: 0,
      },
      pages: [],
    },
    lint: { status: 'skip', output: 'Skipped because validation setup failed', duration: 0 },
    sast: { status: 'skip', output: 'Skipped because validation setup failed', duration: 0 },
    test: { status: 'skip', duration: 0 },
    factValidation: { status: 'skip', results: [] },
    taskReview: null,
    reviewSkipKind: 'upstream-failed',
    reviewSkipReason: 'Skipped — validation setup failed',
  });
}

function createMockValidationEngine(result?: Partial<ValidationResult>): ValidationEngine {
  return {
    validate: vi.fn(async (config: Parameters<ValidationEngine['validate']>[0]) =>
      makeValidationResult({ validationSuite: config.validationSuite, ...result }),
    ),
    runAdvisoryBrowserQa: vi.fn(async () => null),
  };
}

function insertApprovedMemory(
  memoryRepo: ReturnType<typeof createMemoryRepository>,
  overrides: {
    id?: string;
    scope?: 'global' | 'profile' | 'pod';
    scopeId?: string | null;
    content?: string;
    path?: string;
  } = {},
) {
  return memoryRepo.insert({
    id: overrides.id ?? 'mem-auth-cli',
    scope: overrides.scope ?? 'profile',
    scopeId: overrides.scopeId ?? 'test-profile',
    path: overrides.path ?? '/workflow/auth-cli.md',
    content:
      overrides.content ?? 'Authentication token refresh CLI memory for automatic ranking tests.',
    rationale: 'Avoid breaking CLI auth refresh behavior.',
    kind: 'workflow',
    tags: ['auth', 'cli'],
    appliesWhen: null,
    avoidWhen: null,
    confidence: 0.9,
    sourceEvidence: [],
    impactSummary: null,
    approved: true,
    createdByPodId: null,
  });
}

function reviewInfrastructureFailureResult(
  reviewSkipKind: 'review-failed' | 'review-timeout' = 'review-timeout',
  overrides: Partial<ValidationResult> = {},
): Partial<ValidationResult> {
  return {
    overall: 'fail',
    smoke: {
      status: 'pass',
      build: { status: 'pass', output: '', duration: 100 },
      health: {
        status: 'pass',
        url: 'http://localhost:3000',
        responseCode: 200,
        duration: 50,
      },
      pages: [],
    },
    test: { status: 'pass', duration: 25, stdout: '', stderr: '' },
    lint: { status: 'pass', output: '', duration: 10 },
    sast: { status: 'skip', output: '', duration: 0 },
    factValidation: { status: 'pass', results: [] },
    taskReview: null,
    reviewSkipKind,
    reviewSkipReason:
      reviewSkipKind === 'review-timeout'
        ? 'Review timed out: Command timed out after 300000ms'
        : 'Review failed: reviewer process exited with code 2',
    ...overrides,
  };
}

interface TestContext {
  db: Database.Database;
  podRepo: PodRepository;
  eventRepo: EventRepository;
  escalationRepo: EscalationRepository;
  eventBus: EventBus;
  profileStore: ProfileStore;
  containerManager: ContainerManager;
  worktreeManager: WorktreeManager;
  runtimeRegistry: RuntimeRegistry;
  validationEngine: ValidationEngine;
  validationRepo: ReturnType<typeof createValidationRepository>;
  prManager: PrManager;
  runtime: Runtime;
  enqueuedSessions: string[];
  fixFeedbackRepo: ReturnType<typeof createFixFeedbackRepository>;
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
  const fixFeedbackRepo = createFixFeedbackRepository(db);
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
        executionTarget: profileOverrides?.executionTarget ?? 'local',
        extends: null,
        warmImageTag: profileOverrides?.warmImageTag ?? null,
        warmImageBuiltAt: null,
        mcpServers: JSON.parse((row.mcp_servers as string) ?? '[]'),
        claudeMdSections: JSON.parse((row.claude_md_sections as string) ?? '[]'),
        networkPolicy: null,
        actionPolicy: null,
        pod:
          row.agent_mode && row.output_target
            ? {
                agentMode: row.agent_mode as Profile['pod'] extends infer P
                  ? P extends { agentMode: infer A }
                    ? A
                    : never
                  : never,
                output: row.output_target as Profile['pod'] extends infer P
                  ? P extends { output: infer O }
                    ? O
                    : never
                  : never,
                validate:
                  row.validate !== null && row.validate !== undefined
                    ? Boolean(row.validate)
                    : undefined,
                validationSuite:
                  row.validation_suite !== null && row.validation_suite !== undefined
                    ? (row.validation_suite as NonNullable<Profile['pod']>['validationSuite'])
                    : undefined,
                advisoryBrowserQaEnabled:
                  row.advisory_browser_qa_enabled !== null &&
                  row.advisory_browser_qa_enabled !== undefined
                    ? Boolean(row.advisory_browser_qa_enabled)
                    : undefined,
                promotable:
                  row.promotable !== null && row.promotable !== undefined
                    ? Boolean(row.promotable)
                    : undefined,
              }
            : null,
        outputMode: 'pr' as const,
        modelProvider: (row.model_provider as Profile['modelProvider']) ?? 'anthropic',
        providerAccountId: (row.provider_account_id as string | null) ?? null,
        providerCredentials: row.provider_credentials
          ? JSON.parse(row.provider_credentials as string)
          : null,
        validationSetupCommand: (row.validation_setup_command as string | null) ?? null,
        testCommand: (row.test_command as string) ?? null,
        prProvider: (row.pr_provider as 'github' | 'ado') ?? 'github',
        adoPat: (row.ado_pat as string) ?? null,
        adoPatExpiresAt: (row.ado_pat_expires_at as string) ?? null,
        githubPat: (row.github_pat as string) ?? null,
        githubPatExpiresAt: (row.github_pat_expires_at as string) ?? null,
        skills: JSON.parse((row.skills as string) ?? '[]'),
        privateRegistries: JSON.parse((row.private_registries as string) ?? '[]'),
        registryPat: (row.registry_pat as string) ?? null,
        registryPatExpiresAt: (row.registry_pat_expires_at as string) ?? null,
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
        preflightConflictPolicy:
          (row.preflight_conflict_policy as 'warn' | 'block' | null | undefined) ?? null,
        skipValidationPhases: row.skip_validation_phases
          ? JSON.parse(row.skip_validation_phases as string)
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
    resolveCredentialOwner: vi.fn((_name: string) => null),
    resolveProviderAccountId: vi.fn((name: string) => {
      const row = db.prepare('SELECT provider_account_id FROM profiles WHERE name = ?').get(name) as
        | { provider_account_id: string | null }
        | undefined;
      return row?.provider_account_id ?? null;
    }),
  };

  const runtime = createMockRuntime();
  const containerManager = createMockContainerManager();
  const worktreeManager = createMockWorktreeManager();
  const runtimeRegistry = createMockRuntimeRegistry(runtime);
  const validationEngine = createMockValidationEngine(validationResult);
  const validationRepo = createValidationRepository(db);
  const prManager = createMockPrManager();

  const enqueuedSessions: string[] = [];

  const deps: PodManagerDependencies = {
    podRepo,
    escalationRepo,
    fixFeedbackRepo,
    eventRepo,
    profileStore,
    githubAuth: {
      resolveCredential: vi.fn(async () => ({
        token: 'daemon-gh-token',
        username: 'x-access-token',
      })),
      getStatus: vi.fn(async () => ({ available: true, login: 'autopod-dev', setup: 'setup' })),
    },
    eventBus,
    containerManagerFactory: { get: vi.fn(() => containerManager) },
    worktreeManager,
    runtimeRegistry,
    validationEngine,
    validationRepo,
    prManagerFactory: () => prManager,
    enqueueSession: (id) => enqueuedSessions.push(id),
    mcpBaseUrl: 'http://localhost:8080',
    daemonConfig: { mcpServers: [], claudeMdSections: [] },
    logger,
  };

  return {
    db,
    podRepo,
    eventRepo,
    escalationRepo,
    eventBus,
    profileStore,
    containerManager,
    worktreeManager,
    runtimeRegistry,
    validationEngine,
    validationRepo,
    prManager,
    runtime,
    enqueuedSessions,
    fixFeedbackRepo,
    deps,
  };
}

describe('PodManager', () => {
  beforeEach(() => {
    mockExecFileSuccess();
  });

  describe('sandbox warm image preflight', () => {
    it('rejects sandbox pods without an ACR warm image before creating a pod row', () => {
      const ctx = createTestContext(undefined, {
        executionTarget: 'sandbox',
        warmImageTag: null,
      });
      const manager = createPodManager(ctx.deps);

      expect(() =>
        manager.createSession({ profileName: 'test-profile', task: 'Needs sandbox' }, 'user-1'),
      ).toThrow(AutopodError);
      expect(ctx.podRepo.list()).toHaveLength(0);
    });

    it('rejects sandbox pods with local-only warm image tags before creating a pod row', () => {
      const ctx = createTestContext(undefined, {
        executionTarget: 'sandbox',
        warmImageTag: 'autopod/test-profile:latest',
      });
      const manager = createPodManager(ctx.deps);

      expect(() =>
        manager.createSession({ profileName: 'test-profile', task: 'Needs sandbox' }, 'user-1'),
      ).toThrow(/ACR-qualified image tag/);
      expect(ctx.podRepo.list()).toHaveLength(0);
    });

    it('allows interactive workspace pods on sandbox when the backend supports terminals', () => {
      const ctx = createTestContext(undefined, {
        executionTarget: 'sandbox',
        warmImageTag: 'example.azurecr.io/autopod/test-profile:latest',
      });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Workspace', outputMode: 'workspace' },
        'user-1',
      );
      expect(pod.executionTarget).toBe('sandbox');
      expect(ctx.podRepo.list()).toHaveLength(1);
    });

    it('rejects interactive sandbox pods when the backend has no terminal support', () => {
      const ctx = createTestContext(undefined, {
        executionTarget: 'sandbox',
        warmImageTag: 'example.azurecr.io/autopod/test-profile:latest',
      });
      Object.assign(ctx.containerManager, { attachTerminal: undefined });
      const manager = createPodManager(ctx.deps);

      expect(() =>
        manager.createSession(
          { profileName: 'test-profile', task: 'Workspace', outputMode: 'workspace' },
          'user-1',
        ),
      ).toThrow(/interactive terminal support/);
      expect(ctx.podRepo.list()).toHaveLength(0);
    });

    it('rejects buffered-only sandbox agent pods before creating a pod row', () => {
      const ctx = createTestContext(undefined, {
        executionTarget: 'sandbox',
        warmImageTag: 'example.azurecr.io/autopod/test-profile:latest',
      });
      Object.assign(ctx.containerManager, { supportsStreamingExec: false });
      const manager = createPodManager(ctx.deps);

      expect(() =>
        manager.createSession({ profileName: 'test-profile', task: 'Needs sandbox' }, 'user-1'),
      ).toThrow(/does not support native streaming exec/);
      expect(ctx.podRepo.list()).toHaveLength(0);
    });

    it('fails legacy buffered-only sandbox agent pods before provisioning work', async () => {
      const ctx = createTestContext(undefined, {
        executionTarget: 'sandbox',
        warmImageTag: 'example.azurecr.io/autopod/test-profile:latest',
      });
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Needs sandbox' },
        'user-1',
      );
      Object.assign(ctx.containerManager, { supportsStreamingExec: false });

      await manager.processPod(pod.id);

      expect(ctx.podRepo.getOrThrow(pod.id).status).toBe('failed');
      expect(ctx.worktreeManager.create).not.toHaveBeenCalled();
      expect(ctx.containerManager.spawn).not.toHaveBeenCalled();
    });

    it('rejects sandbox pods with sidecars before provisioning', () => {
      const ctx = createTestContext(undefined, {
        executionTarget: 'sandbox',
        warmImageTag: 'example.azurecr.io/autopod/test-profile:latest',
      });
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

      expect(() =>
        manager.createSession({ profileName: 'test-profile', task: 'Needs Dagger' }, 'user-1'),
      ).toThrow(/Sidecars are not supported for sandbox execution/);
      expect(ctx.podRepo.list()).toHaveLength(0);
    });
  });

  describe('memory briefing startup', () => {
    it('memory reviewer setup is fail-soft', async () => {
      const ctx = createTestContext();
      const memoryRepo = createMemoryRepository(ctx.db);
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Authentication token refresh CLI',
          skipValidation: true,
        },
        'user-1',
      );
      const profile = ctx.profileStore.get('test-profile');
      const createReviewerClient = vi.fn(async () => {
        throw new Error('expired refresh token');
      });

      const noCandidateResult = await selectMemoryBriefingForPod({
        pod,
        profile,
        memoryRepo,
        logger,
        createReviewerClient,
      });

      expect(noCandidateResult).toEqual({ selected: [], unavailableReason: null });
      expect(createReviewerClient).not.toHaveBeenCalled();

      memoryRepo.insert({
        id: 'mem-auth-refresh',
        scope: 'profile',
        scopeId: 'test-profile',
        path: '/workflow/auth-refresh.md',
        content: 'Authentication token refresh CLI workflow must preserve existing sessions.',
        rationale: null,
        kind: 'workflow',
        tags: ['auth', 'cli'],
        appliesWhen: null,
        avoidWhen: null,
        confidence: 0.9,
        sourceEvidence: [],
        impactSummary: null,
        approved: true,
        createdByPodId: null,
      });

      const fallbackResult = await selectMemoryBriefingForPod({
        pod,
        profile,
        memoryRepo,
        logger,
        createReviewerClient,
      });

      expect(createReviewerClient).toHaveBeenCalledTimes(1);
      expect(fallbackResult.unavailableReason).toBe('reviewer_model_client_unavailable');
      expect(fallbackResult.selected.map((entry) => entry.memory.id)).toEqual(['mem-auth-refresh']);
      expect(fallbackResult.selected[0]?.relevanceReason).toContain('Reviewer ranking unavailable');
    });
  });

  describe('sandbox runtime session state sync', () => {
    it.each([
      {
        runtime: 'claude' as const,
        containerPath: '/home/autopod/.claude/projects',
        hostFolder: 'claude-state',
      },
      {
        runtime: 'codex' as const,
        containerPath: '/home/autopod/.codex/sessions',
        hostFolder: 'codex-state',
      },
    ])('syncs $runtime sandbox session state after agent turns', async (testCase) => {
      const ctx = createTestContext(undefined, {
        defaultRuntime: testCase.runtime,
        executionTarget: 'sandbox',
        warmImageTag: 'example.azurecr.io/autopod/test-profile:latest',
      });
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Persist session state', skipValidation: true },
        'user-1',
      );
      ctx.podRepo.update(pod.id, { status: 'running', containerId: 'sandbox-123' });

      async function* events(): AsyncIterable<AgentEvent> {
        yield {
          type: 'complete',
          timestamp: '2026-07-12T15:00:00.000Z',
          result: 'done',
        };
      }

      await manager.consumeAgentEvents(pod.id, events());

      expect(ctx.containerManager.extractDirectoryFromContainer).toHaveBeenCalledWith(
        'sandbox-123',
        testCase.containerPath,
        path.join(os.homedir(), '.autopod', testCase.hostFolder, pod.id),
      );
    });

    it.each([
      { runtime: 'claude' as const, executionTarget: 'local' as const },
      { runtime: 'copilot' as const, executionTarget: 'sandbox' as const },
    ])(
      'does not extract session state for $runtime on $executionTarget',
      async ({ runtime, executionTarget }) => {
        const ctx = createTestContext(undefined, {
          defaultRuntime: runtime,
          executionTarget,
          warmImageTag:
            executionTarget === 'sandbox' ? 'example.azurecr.io/autopod/test-profile:latest' : null,
        });
        const manager = createPodManager(ctx.deps);
        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'No session sync', skipValidation: true },
          'user-1',
        );
        ctx.podRepo.update(pod.id, { status: 'running', containerId: 'container-123' });

        async function* events(): AsyncIterable<AgentEvent> {
          yield {
            type: 'complete',
            timestamp: '2026-07-12T15:00:00.000Z',
            result: 'done',
          };
        }

        await manager.consumeAgentEvents(pod.id, events());

        expect(ctx.containerManager.extractDirectoryFromContainer).not.toHaveBeenCalled();
      },
    );

    it('sandbox session state sync failure does not fail completed work', async () => {
      const ctx = createTestContext(undefined, {
        defaultRuntime: 'codex',
        executionTarget: 'sandbox',
        warmImageTag: 'example.azurecr.io/autopod/test-profile:latest',
      });
      vi.mocked(ctx.containerManager.extractDirectoryFromContainer).mockRejectedValueOnce(
        new Error('sandbox file API unavailable'),
      );
      const warnSpy = vi.spyOn(logger, 'warn');
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Complete despite sync warning',
          skipValidation: true,
        },
        'user-1',
      );
      ctx.podRepo.update(pod.id, { status: 'running', containerId: 'sandbox-123' });

      async function* events(): AsyncIterable<AgentEvent> {
        yield {
          type: 'task_summary',
          timestamp: '2026-07-12T15:00:00.000Z',
          actualSummary: 'Work completed.',
          deviations: [],
        };
        yield {
          type: 'complete',
          timestamp: '2026-07-12T15:00:01.000Z',
          result: 'done',
        };
      }

      await expect(manager.consumeAgentEvents(pod.id, events())).resolves.toBe('completed');

      expect(ctx.containerManager.extractDirectoryFromContainer).toHaveBeenCalledOnce();
      expect(manager.getSession(pod.id).taskSummary?.actualSummary).toBe('Work completed.');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ podId: pod.id, runtime: 'codex' }),
        'Failed to sync sandbox runtime session state — future recovery may restart fresh',
      );
    });
  });

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
      expect(pod.baseBranch).toBe('main');
    });

    it('accepts a per-pod advisory browser QA option', () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Check advisory QA option',
          options: { agentMode: 'auto', output: 'pr', advisoryBrowserQaEnabled: true },
        },
        'user-1',
      );

      expect(pod.options.advisoryBrowserQaEnabled).toBe(true);
    });

    it('defaults advisory browser QA off when neither profile nor pod opts in', () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Check advisory QA default' },
        'user-1',
      );

      expect(pod.options.advisoryBrowserQaEnabled).toBe(false);
    });

    it('pins omitted baseBranch to the profile default at creation time', () => {
      const ctx = createTestContext(undefined, { defaultBranch: 'release/2.3.10' });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Fix release issue' },
        'user-1',
      );

      expect(pod.baseBranch).toBe('release/2.3.10');
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

    it('stores a separate startBranch while keeping baseBranch as the PR target', () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Implement from spec branch',
          startBranch: 'docs/spec-help-modal',
          baseBranch: 'main',
        },
        'user-1',
      );

      expect(pod.startBranch).toBe('docs/spec-help-modal');
      expect(pod.baseBranch).toBe('main');
    });

    it('creates a workspace pod from a non-default base branch with handoff instructions', () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Workspace pod',
          outputMode: 'workspace',
          baseBranch: 'pi/feature-x',
          handoffInstructions: '  Continue the Pi plan.  ',
        },
        'user-1',
      );

      // Persisted immediately, trimmed, and readable on the freshly created pod.
      expect(manager.getSession(pod.id).handoffInstructions).toBe('Continue the Pi plan.');
      expect(pod.baseBranch).toBe('pi/feature-x');
    });

    it('leaves handoffInstructions null for the unchanged legacy workspace path', () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Workspace pod', outputMode: 'workspace' },
        'user-1',
      );

      expect(manager.getSession(pod.id).handoffInstructions).toBeNull();
    });

    it('persists local spec files for pre-agent branch materialization', () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Implement from local spec',
          specFiles: [{ path: 'specs/help-modal/brief.md', content: '# Brief\n' }],
        },
        'user-1',
      );

      expect(pod.specFiles).toEqual([{ path: 'specs/help-modal/brief.md', content: '# Brief\n' }]);
    });

    it('persists runtime-only spec context files', () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Implement from local spec',
          specContextFiles: [{ path: 'specs/help-modal/plan.md', content: '# Plan\n' }],
        },
        'user-1',
      );

      expect(pod.specContextFiles).toEqual([
        { path: 'specs/help-modal/plan.md', content: '# Plan\n' },
      ]);
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

    it('ignores an expired legacy GitHub PAT during creation', () => {
      const ctx = createTestContext(undefined, {
        prProvider: 'github',
        githubPat: 'ghp_secret',
        githubPatExpiresAt: '2000-01-01',
      });
      const manager = createPodManager(ctx.deps);

      expect(() =>
        manager.createSession({ profileName: 'test-profile', task: 'Do stuff' }, 'user-1'),
      ).not.toThrow();
    });

    it('allows creation when the selected PAT expires soon but has not expired', () => {
      const soon = new Date();
      soon.setDate(soon.getDate() + 1);
      const expiresAt = [
        soon.getFullYear(),
        `${soon.getMonth() + 1}`.padStart(2, '0'),
        `${soon.getDate()}`.padStart(2, '0'),
      ].join('-');
      const ctx = createTestContext(undefined, {
        prProvider: 'github',
        githubPat: 'ghp_secret',
        githubPatExpiresAt: expiresAt,
      });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );

      expect(pod.status).toBe('queued');
    });

    it('blocks creation when registry auth falls back to an expired ADO PAT', () => {
      const ctx = createTestContext(undefined, {
        privateRegistries: JSON.stringify([{ type: 'npm', url: 'https://registry.example.com' }]),
        adoPat: 'ado_secret',
        adoPatExpiresAt: '2000-01-01',
      });
      const manager = createPodManager(ctx.deps);

      expect(() =>
        manager.createSession({ profileName: 'test-profile', task: 'Do stuff' }, 'user-1'),
      ).toThrow(/expired ADO PAT used for registry auth|PAT_EXPIRED/);
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

      const createdEvent = events.find(
        (e): e is PodCreatedEvent =>
          typeof e === 'object' && e !== null && (e as { type?: unknown }).type === 'pod.created',
      );
      expect(createdEvent).toBeDefined();
      expect(createdEvent?.pod.branch).toMatch(/^autopod\//);
      expect(createdEvent?.pod.baseBranch).toBe('main');
    });

    describe('preflight overlap', () => {
      it('emits pod.preflight_overlap when touches overlap an in-flight pod (default warn)', () => {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        manager.createSession(
          {
            profileName: 'test-profile',
            task: 'first',
            touches: ['packages/daemon/src/pods/**'],
          },
          'user-1',
        );

        const events: unknown[] = [];
        ctx.eventBus.subscribe((e) => events.push(e));

        const second = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'second',
            touches: ['packages/daemon/src/pods/pod-manager.ts'],
          },
          'user-2',
        );

        // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union for field access
        const overlap = events.find((e: any) => e.type === 'pod.preflight_overlap');
        expect(overlap).toBeDefined();
        // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union
        expect((overlap as any).podId).toBe(second.id);
        // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union
        expect((overlap as any).conflicts).toHaveLength(1);
      });

      it('blocks pod creation when profile.preflightConflictPolicy is "block"', () => {
        const ctx = createTestContext();
        // Set the policy directly on the existing test profile row.
        ctx.db
          .prepare("UPDATE profiles SET preflight_conflict_policy = 'block' WHERE name = ?")
          .run('test-profile');
        const manager = createPodManager(ctx.deps);

        manager.createSession(
          {
            profileName: 'test-profile',
            task: 'first',
            touches: ['packages/daemon/src/pods/**'],
          },
          'user-1',
        );

        expect(() =>
          manager.createSession(
            {
              profileName: 'test-profile',
              task: 'second',
              touches: ['packages/daemon/src/pods/pod-manager.ts'],
            },
            'user-2',
          ),
        ).toThrow(/PREFLIGHT_CONFLICT|blocked by profile/);
      });

      it('does not block when conflicts exist but pods touch disjoint paths', () => {
        const ctx = createTestContext();
        ctx.db
          .prepare("UPDATE profiles SET preflight_conflict_policy = 'block' WHERE name = ?")
          .run('test-profile');
        const manager = createPodManager(ctx.deps);

        manager.createSession(
          {
            profileName: 'test-profile',
            task: 'first',
            touches: ['packages/daemon/**'],
          },
          'user-1',
        );

        // Different package — block policy must allow.
        expect(() =>
          manager.createSession(
            { profileName: 'test-profile', task: 'second', touches: ['packages/cli/**'] },
            'user-2',
          ),
        ).not.toThrow();
      });
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
      ctx.podRepo.update(pod.id, validatedPodUpdates(pod.id));

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
      ctx.podRepo.update(pod.id, validatedPodUpdates(pod.id));

      const events: unknown[] = [];
      ctx.eventBus.subscribe((e) => events.push(e));

      await manager.approveSession(pod.id);

      // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union for field access
      const completedEvent = events.find((e: any) => e.type === 'pod.completed') as any;
      expect(completedEvent).toBeDefined();
      expect(completedEvent.finalStatus).toBe('complete');
    });

    it('readiness approval enforces manual reason rules and stores approval metadata', async () => {
      const cases: Array<{
        status: ReadinessStatus;
        updates?: Parameters<TestContext['podRepo']['update']>[1];
        reasonRequired: boolean;
      }> = [
        { status: 'ready', reasonRequired: false },
        { status: 'needs_review', reasonRequired: false },
        { status: 'risky', updates: { worktreeCompromised: true }, reasonRequired: true },
        { status: 'waived', updates: { skipValidation: true }, reasonRequired: true },
      ];

      for (const testCase of cases) {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);
        const pod = manager.createSession(
          { profileName: 'test-profile', task: `Approve ${testCase.status}` },
          'user-1',
        );
        ctx.podRepo.update(pod.id, validatedPodUpdates(pod.id, testCase.updates ?? {}));
        if (testCase.status === 'needs_review') {
          ctx.eventBus.emit({
            type: 'pod.firewall_denied',
            timestamp: new Date().toISOString(),
            podId: pod.id,
            sni: 'example.com',
            src: '127.0.0.1',
          });
        }

        if (testCase.reasonRequired) {
          await expect(manager.approveSession(pod.id, { reason: '   ' })).rejects.toMatchObject({
            code: 'READINESS_REASON_REQUIRED',
          });
        }

        const events: unknown[] = [];
        ctx.eventBus.subscribe((event) => events.push(event));
        const reason = testCase.reasonRequired ? `Accept ${testCase.status}` : undefined;
        await manager.approveSession(pod.id, { reason });

        const approved = manager.getSession(pod.id).readinessReview?.approval;
        expect(approved).toMatchObject({
          statusAtApproval: testCase.status,
          scope: 'pod',
          ...(reason ? { reason } : {}),
        });
        expect(approved?.approvedAt).toEqual(expect.any(String));

        const readinessEvent = events.find(
          (event) => (event as { type?: string }).type === 'pod.readiness_approved',
        );
        if (testCase.status === 'ready') {
          expect(readinessEvent).toBeUndefined();
        } else {
          expect(readinessEvent).toMatchObject({
            type: 'pod.readiness_approved',
            podId: pod.id,
            status: testCase.status,
            scope: 'pod',
            ...(reason ? { reason } : {}),
          });
        }
      }
    });

    it('autoApprove readiness skips needs_review, risky, and waived pods', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const ready = manager.createSession({ profileName: 'test-profile', task: 'Ready' }, 'user-1');
      const needsReview = manager.createSession(
        { profileName: 'test-profile', task: 'Review' },
        'user-1',
      );
      const risky = manager.createSession({ profileName: 'test-profile', task: 'Risky' }, 'user-1');
      const waived = manager.createSession(
        { profileName: 'test-profile', task: 'Waived' },
        'user-1',
      );

      for (const pod of [ready, needsReview, risky, waived]) {
        ctx.podRepo.update(pod.id, validatedPodUpdates(pod.id, { autoApprove: true }));
      }
      ctx.eventBus.emit({
        type: 'pod.firewall_denied',
        timestamp: new Date().toISOString(),
        podId: needsReview.id,
        sni: 'example.com',
        src: '127.0.0.1',
      });
      ctx.podRepo.update(risky.id, { worktreeCompromised: true });
      ctx.podRepo.update(waived.id, { skipValidation: true });

      await manager.approveSession(ready.id, { automation: true });
      await expect(
        manager.approveSession(needsReview.id, { automation: true }),
      ).rejects.toMatchObject({
        code: 'READINESS_NOT_READY',
      });
      await expect(manager.approveSession(risky.id, { automation: true })).rejects.toMatchObject({
        code: 'READINESS_NOT_READY',
      });
      await expect(manager.approveSession(waived.id, { automation: true })).rejects.toMatchObject({
        code: 'READINESS_NOT_READY',
      });

      expect(manager.getSession(ready.id).status).toBe('complete');
      expect(manager.getSession(needsReview.id).status).toBe('validated');
      expect(manager.getSession(risky.id).status).toBe('validated');
      expect(manager.getSession(waived.id).status).toBe('validated');

      const bulk = await manager.approveAllValidated();
      expect(bulk.approved).toEqual([]);
      expect(bulk.skipped).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ podId: needsReview.id, status: 'needs_review' }),
          expect.objectContaining({ podId: risky.id, status: 'risky' }),
          expect.objectContaining({ podId: waived.id, status: 'waived' }),
        ]),
      );
    });

    it('single PR readiness approval uses series readiness for the PR-owning pod', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const seriesId = 'series-readiness';
      const member = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Member with risk',
          seriesId,
          prMode: 'single',
        },
        'user-1',
      );
      const owner = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Final PR owner',
          seriesId,
          prMode: 'single',
        },
        'user-1',
      );

      ctx.podRepo.update(member.id, {
        status: 'complete',
        readinessReview: makeReadinessReview('risky', 'Member has a hard release risk.'),
      });
      ctx.podRepo.update(owner.id, {
        ...validatedPodUpdates(owner.id),
        prUrl: 'https://github.com/org/repo/pull/42',
        readinessReview: makeReadinessReview('ready'),
      });

      await expect(manager.approveSession(owner.id)).rejects.toMatchObject({
        code: 'READINESS_REASON_REQUIRED',
      });

      const events: unknown[] = [];
      ctx.eventBus.subscribe((event) => events.push(event));
      await manager.approveSession(owner.id, { reason: 'Series risk accepted' });

      expect(manager.getSession(owner.id).readinessReview?.approval).toMatchObject({
        statusAtApproval: 'risky',
        scope: 'series',
        seriesId,
        reason: 'Series risk accepted',
      });
      expect(
        events.find((event) => (event as { type?: string }).type === 'pod.readiness_approved'),
      ).toMatchObject({
        type: 'pod.readiness_approved',
        podId: owner.id,
        status: 'risky',
        scope: 'series',
        seriesId,
        reason: 'Series risk accepted',
      });
    });

    it('merges PR when prUrl exists', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        ...validatedPodUpdates(pod.id),
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

    it('polls and merges a clean PR when the parent worktree is stale', async () => {
      vi.useFakeTimers();
      try {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);
        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Do stuff' },
          'user-1',
        );
        ctx.podRepo.update(pod.id, {
          status: 'merge_pending',
          prUrl: 'https://github.com/org/repo/pull/42',
          worktreePath: `/tmp/autopod-missing-parent-${pod.id}`,
        });
        vi.mocked(ctx.prManager.getPrStatus)
          .mockResolvedValueOnce({
            merged: false,
            open: true,
            blockReason: null,
            ciFailures: [],
            reviewComments: [],
            reviewDecision: 'APPROVED',
          })
          .mockResolvedValueOnce({
            merged: true,
            open: false,
            blockReason: null,
            ciFailures: [],
            reviewComments: [],
          });
        vi.mocked(ctx.prManager.mergePr).mockResolvedValueOnce({
          merged: true,
          autoMergeScheduled: false,
        });

        // A fresh manager resumes merge polling for persisted merge_pending pods.
        createPodManager(ctx.deps);
        await vi.advanceTimersByTimeAsync(0);

        expect(ctx.prManager.mergePr).toHaveBeenCalledWith({
          prUrl: 'https://github.com/org/repo/pull/42',
        });
        expect(ctx.worktreeManager.rebaseOntoBase).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(60_000);
        expect(manager.getSession(pod.id).status).toBe('complete');
      } finally {
        vi.useRealTimers();
      }
    });

    it('passes squash option to PR merge', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        ...validatedPodUpdates(pod.id),
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
        ...validatedPodUpdates(pod.id),
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

    it('returns to validated when approval-time PR creation retry fails', async () => {
      const ctx = createTestContext();
      (ctx.prManager.createPr as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('gh auth failed'),
      );
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        ...validatedPodUpdates(pod.id),
        worktreePath: '/tmp/wt',
        filesChanged: 1,
      });

      const events: unknown[] = [];
      ctx.eventBus.subscribe((e) => events.push(e));

      await manager.approveSession(pod.id);

      const result = manager.getSession(pod.id);
      expect(result.status).toBe('validated');
      expect(result.prUrl).toBeNull();
      expect(result.completedAt).toBeNull();
      expect(ctx.prManager.mergePr).not.toHaveBeenCalled();
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'pod.completed' }));
      const messages = events.flatMap((event) => {
        if (typeof event !== 'object' || event === null) return [];
        const maybeActivity = event as {
          type?: string;
          event?: { type?: string; message?: string };
        };
        if (
          maybeActivity.type === 'pod.agent_activity' &&
          maybeActivity.event?.type === 'status' &&
          maybeActivity.event.message
        ) {
          return [maybeActivity.event.message];
        }
        return [];
      });
      expect(messages).toContain('PR creation failed: gh auth failed — pod returned to validated');
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
        ...validatedPodUpdates(pod.id),
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

    it('does not forward legacy GitHub PAT into mergeBranch on approval-time PR creation retry', async () => {
      const ctx = createTestContext(undefined, { githubPat: 'ghp_test_pat_12345' });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        ...validatedPodUpdates(pod.id),
        worktreePath: '/tmp/wt',
        filesChanged: 1,
      });

      await manager.approveSession(pod.id);

      expect(ctx.worktreeManager.mergeBranch).toHaveBeenCalledWith(
        expect.objectContaining({ pat: 'daemon-gh-token' }),
      );
    });

    it('does not forward legacy GitHub PAT into mergeBranch on approval-time fallback push', async () => {
      const ctx = createTestContext(undefined, { githubPat: 'ghp_test_pat_67890' });
      ctx.deps.prManagerFactory = undefined;
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        ...validatedPodUpdates(pod.id),
        worktreePath: '/tmp/wt',
        filesChanged: 1,
      });

      await manager.approveSession(pod.id);

      expect(ctx.worktreeManager.mergeBranch).toHaveBeenCalledWith(
        expect.objectContaining({ pat: 'daemon-gh-token' }),
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
        ...validatedPodUpdates(pod.id),
        worktreePath: '/tmp/wt',
        filesChanged: 1,
      });

      await manager.approveSession(pod.id);

      expect(ctx.worktreeManager.mergeBranch).toHaveBeenCalledWith(
        expect.objectContaining({ pat: 'ado_test_pat_xyz' }),
      );
    });

    it('publishes a non-default PR base branch before approval retry creates the PR', async () => {
      const ctx = createTestContext(undefined, {
        prProvider: 'ado',
        adoPat: 'ado_test_pat_xyz',
      });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Do stuff on a workspace base',
          branch: 'feature/child',
          baseBranch: 'feature/workspace-base',
        },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        ...validatedPodUpdates(pod.id),
        worktreePath: '/tmp/wt',
        filesChanged: 1,
        prUrl: null,
      });

      await manager.approveSession(pod.id);

      expect(ctx.worktreeManager.ensureRemoteBranch).toHaveBeenCalledWith({
        worktreePath: '/tmp/wt',
        branch: 'feature/workspace-base',
        sourceRef: 'refs/heads/feature/workspace-base',
        pat: 'ado_test_pat_xyz',
      });
      expect(ctx.prManager.createPr).toHaveBeenCalledWith(
        expect.objectContaining({
          branch: 'feature/child',
          baseBranch: 'feature/workspace-base',
        }),
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

      ctx.podRepo.update(parent.id, validatedPodUpdates(parent.id, { branch: 'feature/parent' }));
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

      ctx.podRepo.update(parent.id, validatedPodUpdates(parent.id));
      ctx.enqueuedSessions.length = 0;

      manager.rehydrateDependentSessions();
      expect(ctx.enqueuedSessions).not.toContain(child.id);

      // Parent reaches complete → worktree released → child can start.
      ctx.podRepo.update(parent.id, { status: 'complete' });
      manager.rehydrateDependentSessions();
      expect(ctx.enqueuedSessions).toContain(child.id);
    });

    it('does not start single-PR dependents on force-approved validated parents', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const parent = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Parent task',
          branch: 'feature/series-root',
          baseBranch: 'release/2026-05',
          seriesId: 'series-single',
          prMode: 'single',
          options: { agentMode: 'auto', output: 'branch' },
        },
        'user-1',
      );
      const child = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Child task',
          dependsOnPodIds: [parent.id],
          seriesId: 'series-single',
          prMode: 'single',
          options: { agentMode: 'auto', output: 'pr' },
        },
        'user-1',
      );

      // Simulate legacy/corrupted rows created before single-mode branch sharing
      // was enforced at creation time.
      ctx.db.prepare('UPDATE pods SET branch = ? WHERE id = ?').run('feature/child', child.id);
      ctx.podRepo.update(parent.id, { status: 'failed' });
      ctx.enqueuedSessions.length = 0;

      await manager.forceApprove(parent.id, 'waive infrastructure-only validation issue');

      expect(ctx.enqueuedSessions).not.toContain(child.id);
      expect(manager.getSession(child.id).status).toBe('queued');

      await manager.approveSession(parent.id, { reason: 'Force-approved parent is acceptable' });

      expect(ctx.enqueuedSessions).toContain(child.id);
      expect(manager.getSession(child.id).baseBranch).toBe('release/2026-05');
    });

    it('rehydrate waits for complete and preserves real base for single-PR dependents', () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const parent = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Parent task',
          branch: 'feature/series-root',
          baseBranch: 'release/2026-05',
          seriesId: 'series-single',
          prMode: 'single',
          options: { agentMode: 'auto', output: 'branch' },
        },
        'user-1',
      );
      const child = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Child task',
          dependsOnPodIds: [parent.id],
          seriesId: 'series-single',
          prMode: 'single',
          options: { agentMode: 'auto', output: 'pr' },
        },
        'user-1',
      );

      ctx.db.prepare('UPDATE pods SET branch = ? WHERE id = ?').run('feature/child', child.id);
      ctx.podRepo.update(parent.id, validatedPodUpdates(parent.id));
      ctx.enqueuedSessions.length = 0;

      manager.rehydrateDependentSessions();
      expect(ctx.enqueuedSessions).not.toContain(child.id);

      ctx.podRepo.update(parent.id, { status: 'complete' });
      manager.rehydrateDependentSessions();

      expect(ctx.enqueuedSessions).toContain(child.id);
      expect(manager.getSession(child.id).baseBranch).toBe('release/2026-05');
    });

    it('inherits the parent branch and base for new single-PR dependents', () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const parent = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Parent task',
          branch: 'feature/series-root',
          baseBranch: 'release/2026-05',
          seriesId: 'series-single',
          prMode: 'single',
          options: { agentMode: 'auto', output: 'branch' },
        },
        'user-1',
      );
      const child = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Child task',
          dependsOnPodIds: [parent.id],
          seriesId: 'series-single',
          prMode: 'single',
          options: { agentMode: 'auto', output: 'pr' },
        },
        'user-1',
      );

      expect(child.branch).toBe('feature/series-root');
      expect(child.baseBranch).toBe('release/2026-05');
    });

    // Regression: the no-changes fast-path used to trust the cached pod.filesChanged
    // (which goes stale after force-approve / human-fix) and skip both the branch
    // push and container→host sync-back. Three pods leaked work this way before we
    // re-checked the worktree and preserved the branch push when the branch still
    // carries accumulated work from an earlier run.
    describe('no-changes fast-path', () => {
      it('refreshes filesChanged from worktree and skips branch push when the whole branch is empty', async () => {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Do stuff' },
          'user-1',
        );
        // Stale cache says 5 files changed, but the worktree actually has zero.
        ctx.podRepo.update(pod.id, {
          ...validatedPodUpdates(pod.id),
          worktreePath: '/tmp/wt',
          filesChanged: 5,
          linesAdded: 100,
          linesRemoved: 50,
        });

        (ctx.worktreeManager.getDiffStats as ReturnType<typeof vi.fn>).mockResolvedValue({
          filesChanged: 0,
          linesAdded: 0,
          linesRemoved: 0,
        });
        (ctx.worktreeManager.hasChangesAgainstBase as ReturnType<typeof vi.fn>).mockResolvedValue(
          false,
        );

        await manager.approveSession(pod.id);

        const completed = manager.getSession(pod.id);
        expect(completed.status).toBe('complete');
        // Stale cache must be corrected on disk.
        expect(completed.filesChanged).toBe(0);
        expect(completed.linesAdded).toBe(0);
        expect(completed.linesRemoved).toBe(0);
        // The branch has no accumulated work either, so do not mint an empty origin branch.
        expect(ctx.worktreeManager.pushBranch).not.toHaveBeenCalled();
        // No PR creation, no merge — fast-path completes directly.
        expect(ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();
        expect(ctx.prManager.createPr).not.toHaveBeenCalled();
        expect(ctx.prManager.mergePr).not.toHaveBeenCalled();
      });

      it('skips fast-path when worktree has real changes despite cached filesChanged=0', async () => {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Do stuff' },
          'user-1',
        );
        // Cached zero — old bug would have taken the fast-path and dropped the branch.
        ctx.podRepo.update(pod.id, {
          ...validatedPodUpdates(pod.id),
          worktreePath: '/tmp/wt',
          filesChanged: 0,
        });

        (ctx.worktreeManager.getDiffStats as ReturnType<typeof vi.fn>).mockResolvedValue({
          filesChanged: 3,
          linesAdded: 50,
          linesRemoved: 10,
        });

        await manager.approveSession(pod.id);

        // Fresh diff stats must be persisted on disk.
        expect(manager.getSession(pod.id).filesChanged).toBe(3);
        // Normal merge path runs — mergeBranch + createPr + mergePr.
        expect(ctx.worktreeManager.mergeBranch).toHaveBeenCalledWith(
          expect.objectContaining({
            worktreePath: '/tmp/wt',
            targetBranch: pod.branch,
          }),
        );
        expect(ctx.prManager.createPr).toHaveBeenCalled();
        expect(ctx.prManager.mergePr).toHaveBeenCalled();
      });

      it('forces workspace pods through normal path even when worktree has zero changes', async () => {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        // Workspace pods edit files inside the container; sync-back must run via mergeBranch.
        // Bypassing the fast-path is the whole point of the !isWorkspacePod guard.
        const pod = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Workspace stuff',
            options: { agentMode: 'interactive', output: 'branch' },
          },
          'user-1',
        );
        ctx.podRepo.update(pod.id, {
          ...validatedPodUpdates(pod.id),
          worktreePath: '/tmp/wt',
          filesChanged: 0,
        });

        (ctx.worktreeManager.getDiffStats as ReturnType<typeof vi.fn>).mockResolvedValue({
          filesChanged: 0,
          linesAdded: 0,
          linesRemoved: 0,
        });

        await manager.approveSession(pod.id);

        // Fast-path block is gated by !isWorkspacePod, so getDiffStats must not run inside approveSession.
        expect(ctx.worktreeManager.getDiffStats).not.toHaveBeenCalled();
        // Fallback push branch (output==='branch' skips PR retry) runs sync-back via mergeBranch.
        expect(ctx.worktreeManager.mergeBranch).toHaveBeenCalledWith(
          expect.objectContaining({ targetBranch: pod.branch }),
        );
      });

      it('falls back to normal merge path when getDiffStats throws', async () => {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Do stuff' },
          'user-1',
        );
        ctx.podRepo.update(pod.id, {
          ...validatedPodUpdates(pod.id),
          worktreePath: '/tmp/wt',
          filesChanged: 0,
        });

        (ctx.worktreeManager.getDiffStats as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error('git error'),
        );

        await manager.approveSession(pod.id);

        // Fail-safe: when we can't determine diff, treat as "may have changes" and merge.
        // Better to push an empty branch than to silently drop user work.
        expect(ctx.worktreeManager.mergeBranch).toHaveBeenCalled();
        expect(manager.getSession(pod.id).status).toBe('complete');
      });

      it('pushes branch with accumulated work before emitting pod.completed', async () => {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Do stuff' },
          'user-1',
        );
        ctx.podRepo.update(pod.id, {
          ...validatedPodUpdates(pod.id),
          worktreePath: '/tmp/wt',
          filesChanged: 0,
        });

        (ctx.worktreeManager.getDiffStats as ReturnType<typeof vi.fn>).mockResolvedValue({
          filesChanged: 0,
          linesAdded: 0,
          linesRemoved: 0,
        });
        (ctx.worktreeManager.hasChangesAgainstBase as ReturnType<typeof vi.fn>).mockResolvedValue(
          true,
        );

        // Track call ordering: pushBranch must run before pod.completed event fires
        // so the branch is durably on origin if the daemon dies between push and emit.
        const order: string[] = [];
        (ctx.worktreeManager.pushBranch as ReturnType<typeof vi.fn>).mockImplementation(
          async () => {
            order.push('push');
          },
        );
        ctx.eventBus.subscribe((e) => {
          // biome-ignore lint/suspicious/noExplicitAny: narrowing discriminated union
          if ((e as any).type === 'pod.completed') order.push('completed');
        });

        await manager.approveSession(pod.id);

        expect(ctx.worktreeManager.pushBranch).toHaveBeenCalledWith('/tmp/wt', pod.branch);
        expect(order).toEqual(['push', 'completed']);
      });
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

      // queued is not a rejectable state — explicit guard fires before any transition
      await expect(manager.rejectSession(pod.id)).rejects.toThrow(AutopodError);
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
    beforeEach(() => {
      vi.mocked(createProfileMemoryReviewer).mockReset();
      vi.mocked(createProfileMemoryReviewer).mockResolvedValue({
        ok: true,
        model: 'reviewer-model',
        reviewer: {
          model: 'reviewer-model',
          generateText: vi.fn().mockResolvedValue(JSON.stringify({ selected: [] })),
        },
      });
    });

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

    it('surfaces secret-safe finding details when the pre-push security scan blocks', async () => {
      const ctx = createTestContext();
      ctx.deps.repoScanner = {
        scan: vi.fn(async (checkpoint) => ({
          podId: 'scan-pod',
          checkpoint,
          startedAt: 1,
          completedAt: 2,
          filesScanned: 1,
          filesSkipped: 0,
          scanIncomplete: false,
          findings:
            checkpoint === 'push'
              ? [
                  {
                    detector: 'secrets' as const,
                    severity: 'critical' as const,
                    file: 'src/config.ts',
                    line: 42,
                    ruleId: '@secretlint/rule-basicauth',
                    snippet: 'http...[REDACTED]',
                  },
                  {
                    detector: 'injection' as const,
                    severity: 'high' as const,
                    file: 'docs/prompt.md',
                    snippet: 'RAW MATCH MUST NOT REACH LOGS',
                  },
                ]
              : [],
          decision: checkpoint === 'push' ? ('block' as const) : ('pass' as const),
          warningSection: null,
        })),
      };
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );

      await manager.processPod(pod.id);

      expect(manager.getSession(pod.id).status).toBe('failed');
      const messages = ctx.eventRepo
        .getForSession(pod.id, { type: 'pod.agent_activity' })
        .map((event) => (event.payload as never as { event?: { message?: string } }).event?.message)
        .filter((message): message is string => Boolean(message));
      expect(messages).toContain('Pre-push security scan blocked: 2 findings.');
      expect(messages).toContain(
        'Security finding 1/2: severity=critical detector=secrets ' +
          'rule=@secretlint/rule-basicauth location=src/config.ts:42',
      );
      expect(messages).toContain(
        'Security finding 2/2: severity=high detector=injection ' +
          'rule=unknown location=docs/prompt.md',
      );
      expect(messages.join('\n')).not.toContain('RAW MATCH MUST NOT REACH LOGS');
      expect(messages.join('\n')).not.toContain('http...[REDACTED]');
    });

    it('persists Codex auth.json back to a linked OpenAI provider account after agent run', async () => {
      const accountId = 'team-openai';
      const oldAuthJson = JSON.stringify({ token: 'old' });
      const freshAuthJson = JSON.stringify({ token: 'fresh' });
      const oldCredentials = {
        provider: 'openai',
        authMode: 'chatgpt',
        authJson: oldAuthJson,
      } satisfies ProviderCredentials;
      const freshCredentials = {
        provider: 'openai',
        authMode: 'chatgpt',
        authJson: freshAuthJson,
      } satisfies ProviderCredentials;

      const runtime = createMockRuntime();
      runtime.type = 'codex';
      const ctx = createTestContext(undefined, {
        defaultModel: 'auto',
        defaultRuntime: 'codex',
        modelProvider: 'openai',
      });
      ctx.deps.runtimeRegistry = createMockRuntimeRegistry(runtime);
      insertProviderAccount(ctx.db, accountId, 'openai', oldCredentials);
      linkProfileToProviderAccount(ctx.db, 'test-profile', accountId);
      const providerAccountStore = createMutableProviderAccountStore(
        accountId,
        'openai',
        oldCredentials,
      );
      ctx.deps.providerAccountStore = providerAccountStore;
      vi.mocked(ctx.containerManager.execInContainer).mockImplementation(
        async (_containerId, command) => {
          const rendered = command.join(' ');
          if (rendered.includes('command -v codex')) {
            return { stdout: '/usr/local/bin/codex\n', stderr: '', exitCode: 0 };
          }
          if (rendered === 'codex --version') {
            return { stdout: 'codex-cli 0.144.4\n', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      );
      vi.mocked(ctx.containerManager.readFile).mockImplementation(
        async (_containerId, filePath) => {
          if (filePath === '/home/autopod/.codex/auth.json') return freshAuthJson;
          return '';
        },
      );

      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Build widget',
          runtime: 'codex',
          skipValidation: true,
        },
        'user-1',
      );

      await manager.processPod(pod.id);

      expect(manager.getSession(pod.id).status).toBe('validated');
      expect(providerAccountStore.touchLastUsed).toHaveBeenCalledWith(accountId);
      expect(providerAccountStore.updateCredentials).toHaveBeenCalledWith(
        accountId,
        freshCredentials,
      );
      expect(ctx.containerManager.writeFile).toHaveBeenCalledWith(
        'container-123',
        '/home/autopod/.codex/auth.json',
        oldAuthJson,
      );
    });

    it('recovers and rewrites fresh Codex auth.json for resume env from provider account', async () => {
      const accountId = 'team-openai';
      const oldAuthJson = JSON.stringify({ token: 'old-resume' });
      const freshAuthJson = JSON.stringify({ token: 'fresh-resume' });
      const oldCredentials = {
        provider: 'openai',
        authMode: 'chatgpt',
        authJson: oldAuthJson,
      } satisfies ProviderCredentials;
      const freshCredentials = {
        provider: 'openai',
        authMode: 'chatgpt',
        authJson: freshAuthJson,
      } satisfies ProviderCredentials;

      const ctx = createTestContext(undefined, {
        defaultModel: 'auto',
        defaultRuntime: 'codex',
        modelProvider: 'openai',
      });
      insertProviderAccount(ctx.db, accountId, 'openai', oldCredentials);
      linkProfileToProviderAccount(ctx.db, 'test-profile', accountId);
      const providerAccountStore = createMutableProviderAccountStore(
        accountId,
        'openai',
        oldCredentials,
      );
      ctx.deps.providerAccountStore = providerAccountStore;
      vi.mocked(ctx.containerManager.readFile).mockImplementation(
        async (_containerId, filePath) => {
          if (filePath === '/home/autopod/.codex/auth.json') return freshAuthJson;
          return '';
        },
      );
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Resume widget',
          runtime: 'codex',
          skipValidation: true,
        },
        'user-1',
      );
      ctx.podRepo.update(pod.id, { containerId: 'container-123' });

      const env = await manager.getReviewerExecEnv(ctx.podRepo.getOrThrow(pod.id));

      expect(env).toEqual(expect.objectContaining({ POD_ID: pod.id }));
      expect(providerAccountStore.updateCredentials).toHaveBeenCalledWith(
        accountId,
        freshCredentials,
      );
      expect(ctx.containerManager.writeFile).toHaveBeenCalledWith(
        'container-123',
        '/home/autopod/.codex/auth.json',
        freshAuthJson,
      );
    });

    it('completes no-change pods directly without validation readiness', async () => {
      const ctx = createTestContext();
      (ctx.worktreeManager.getDiffStats as ReturnType<typeof vi.fn>).mockResolvedValue({
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
      });
      const manager = createPodManager(ctx.deps);
      const events: unknown[] = [];
      ctx.eventBus.subscribe((event) => events.push(event));

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Deploy existing app', skipValidation: false },
        'user-1',
      );

      await manager.processPod(pod.id);

      const processed = manager.getSession(pod.id);
      expect(processed.status).toBe('complete');
      expect(processed.completedAt).not.toBeNull();
      expect(processed.readinessReview).toBeNull();
      expect(processed.lastValidationResult).toBeNull();
      expect(processed.filesChanged).toBe(0);
      expect(ctx.validationEngine.validate).not.toHaveBeenCalled();

      expect(events).not.toContainEqual(
        expect.objectContaining({ type: 'pod.status_changed', newStatus: 'validating' }),
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: 'pod.status_changed', newStatus: 'validated' }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'pod.completed',
          podId: pod.id,
          finalStatus: 'complete',
          summary: expect.objectContaining({ filesChanged: 0 }),
        }),
      );
    });

    it('prepares provider credentials and agent shim before automatic memory ranking', async () => {
      const ctx = createTestContext();
      const memoryRepo = createMemoryRepository(ctx.db);
      const usageRepo = createMemoryUsageRepository(ctx.db);
      ctx.deps.memoryRepo = memoryRepo;
      ctx.deps.memoryUsageRepo = usageRepo;
      insertApprovedMemory(memoryRepo);

      const reviewer = {
        model: 'reviewer-model',
        generateText: vi.fn().mockResolvedValue(
          JSON.stringify({
            selected: [{ id: 'mem-auth-cli', reason: 'Relevant to auth refresh CLI work.' }],
          }),
        ),
      };
      vi.mocked(createProfileMemoryReviewer).mockResolvedValueOnce({
        ok: true,
        model: 'reviewer-model',
        reviewer,
      });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Add authentication token refresh for the CLI',
          skipValidation: true,
        },
        'user-1',
      );

      await manager.processPod(pod.id);

      expect(createProfileMemoryReviewer).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(String),
        expect.any(Object),
        {
          container: {
            podId: pod.id,
            containerId: 'container-123',
            containerManager: ctx.containerManager,
            env: expect.objectContaining({ POD_ID: pod.id }),
            timeoutMs: 20_000,
          },
        },
      );
      const envWriteOrder = vi.mocked(ctx.containerManager.writeFile).mock.invocationCallOrder[
        vi
          .mocked(ctx.containerManager.writeFile)
          .mock.calls.findIndex((call) => call[1] === AGENT_ENV_PATH)
      ];
      const shimWriteOrder = vi.mocked(ctx.containerManager.writeFile).mock.invocationCallOrder[
        vi
          .mocked(ctx.containerManager.writeFile)
          .mock.calls.findIndex((call) => call[1] === AGENT_SHIM_PATH)
      ];
      const reviewerCreateOrder = vi.mocked(createProfileMemoryReviewer).mock
        .invocationCallOrder[0];
      expect(envWriteOrder).toBeLessThan(reviewerCreateOrder);
      expect(shimWriteOrder).toBeLessThan(reviewerCreateOrder);
      const envFileWrite = vi
        .mocked(ctx.containerManager.writeFile)
        .mock.calls.find((call) => call[1] === AGENT_ENV_PATH);
      expect(String(envFileWrite?.[2])).toContain(`export POD_ID='${pod.id}'`);
      expect(String(envFileWrite?.[2])).toContain(
        "export AUTOPOD_VALIDATION_BASE_REF='abc1234567890abcdef1234567890abcdef1234'",
      );
      expect(ctx.containerManager.execInContainer).toHaveBeenCalledWith(
        'container-123',
        ['chmod', '0400', AGENT_ENV_PATH],
        { timeout: 5_000 },
      );
      expect(ctx.containerManager.execInContainer).toHaveBeenCalledWith(
        'container-123',
        ['chmod', '0500', AGENT_SHIM_PATH],
        { timeout: 5_000 },
      );
      expect(reviewer.generateText).toHaveBeenCalledTimes(1);
    });

    it('uses owner-neutral agent shim modes for sandbox pods', async () => {
      const ctx = createTestContext(undefined, {
        executionTarget: 'sandbox',
        warmImageTag: 'example.azurecr.io/autopod/test:latest',
      });
      const memoryRepo = createMemoryRepository(ctx.db);
      ctx.deps.memoryRepo = memoryRepo;
      insertApprovedMemory(memoryRepo);
      vi.mocked(createProfileMemoryReviewer).mockResolvedValueOnce({
        ok: false,
        reason: 'container_reviewer_unavailable: timeout',
      });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Smoke sandbox shim modes',
          skipValidation: true,
        },
        'user-1',
      );

      await manager.processPod(pod.id);

      expect(ctx.containerManager.execInContainer).toHaveBeenCalledWith(
        'container-123',
        ['chmod', '0444', AGENT_ENV_PATH],
        { timeout: 5_000 },
      );
      expect(ctx.containerManager.execInContainer).toHaveBeenCalledWith(
        'container-123',
        ['chmod', '0555', AGENT_SHIM_PATH],
        { timeout: 5_000 },
      );
      const repairCall = ctx.containerManager.execInContainer.mock.calls.find(
        ([, command, options]) => command[0] === 'sh' && options?.user === 'root',
      );
      expect(repairCall?.[2]).toEqual({ timeout: 10_000, user: 'root' });
      expect(repairCall?.[1][2]).toContain(
        "chown -R autopod:autopod '/home/autopod/.claude' '/home/autopod/.autopod'",
      );
    });

    it('emits pod activity when memory ranking uses deterministic fallback', async () => {
      const ctx = createTestContext();
      const memoryRepo = createMemoryRepository(ctx.db);
      const usageRepo = createMemoryUsageRepository(ctx.db);
      ctx.deps.memoryRepo = memoryRepo;
      ctx.deps.memoryUsageRepo = usageRepo;
      insertApprovedMemory(memoryRepo);
      vi.mocked(createProfileMemoryReviewer).mockResolvedValueOnce({
        ok: false,
        reason:
          'container_reviewer_unavailable: timeout; daemon_reviewer_unavailable: no_credentials',
      });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Add authentication token refresh for the CLI',
          skipValidation: true,
        },
        'user-1',
      );

      await manager.processPod(pod.id);

      const usage = usageRepo.listByPod(pod.id);
      expect(usage.map((event) => event.kind)).toEqual(['selected', 'injected']);
      expect(usage[0]?.relevanceReason).toContain('deterministic keyword prefilter');

      const statusMessages = ctx.eventRepo
        .getForSession(pod.id, { type: 'pod.agent_activity' })
        .map((event) => (event.payload as never as { event?: { message?: string } }).event?.message)
        .filter(Boolean);
      expect(statusMessages).toContain(
        'Memory reviewer unavailable (container_reviewer_unavailable: timeout; daemon_reviewer_unavailable: no_credentials); using deterministic keyword fallback.',
      );
    });

    it('starts the worktree from startBranch while keeping baseBranch as PR target', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Add feature from spec branch',
          startBranch: 'docs/spec-help-modal',
          baseBranch: 'main',
          skipValidation: true,
        },
        'user-1',
      );

      await manager.processPod(pod.id);

      expect(ctx.worktreeManager.create).toHaveBeenCalledWith(
        expect.objectContaining({
          branch: pod.branch,
          startBranch: 'docs/spec-help-modal',
          baseBranch: 'main',
        }),
      );
    });

    it('mirrors handoff instructions into /workspace/.autopod/pi-handoff.md during provisioning (local)', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Workspace pod',
          outputMode: 'workspace',
          handoffInstructions: 'INITIAL PI HANDOFF',
        },
        'user-1',
      );

      await manager.processPod(pod.id);

      expect(ctx.containerManager.writeFile).toHaveBeenCalledWith(
        'container-123',
        WORKSPACE_PI_HANDOFF_PATH,
        expect.stringContaining('INITIAL PI HANDOFF'),
      );
      // In-container info/exclude so an in-container `git add -A` can't sweep it in.
      const excludeCall = vi
        .mocked(ctx.containerManager.execInContainer)
        .mock.calls.find((c) =>
          (c[1] as string[]).some(
            (a) => typeof a === 'string' && a.includes('.autopod/pi-handoff.md'),
          ),
        );
      expect(excludeCall).toBeDefined();
    });

    it('mirrors handoff instructions into the workspace on the sandbox target (mocked Azure)', async () => {
      const ctx = createTestContext(undefined, {
        executionTarget: 'sandbox',
        warmImageTag: 'example.azurecr.io/autopod/test-profile:latest',
      });
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Workspace pod',
          outputMode: 'workspace',
          handoffInstructions: 'SANDBOX PI HANDOFF',
        },
        'user-1',
      );

      await manager.processPod(pod.id);

      expect(ctx.containerManager.writeFile).toHaveBeenCalledWith(
        'container-123',
        WORKSPACE_PI_HANDOFF_PATH,
        expect.stringContaining('SANDBOX PI HANDOFF'),
      );
    });

    it('writes no pi-handoff.md when the workspace pod has no handoff instructions', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Workspace pod', outputMode: 'workspace' },
        'user-1',
      );

      await manager.processPod(pod.id);

      const wrotePiHandoff = vi
        .mocked(ctx.containerManager.writeFile)
        .mock.calls.some((c) => c[1] === WORKSPACE_PI_HANDOFF_PATH);
      expect(wrotePiHandoff).toBe(false);
    });

    it('materializes local spec files onto the pod branch before agent work starts', async () => {
      const ctx = createTestContext();
      const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'autopod-spec-files-'));
      (ctx.worktreeManager.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        worktreePath,
        bareRepoPath: '/tmp/bare/abc.git',
        startCommitSha: 'abc1234567890abcdef1234567890abcdef1234',
      });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Add feature from local spec',
          specFiles: [{ path: 'specs/help-modal/brief.md', content: '# Brief\n' }],
          skipValidation: true,
        },
        'user-1',
      );

      await manager.processPod(pod.id);

      expect(fs.readFileSync(path.join(worktreePath, 'specs/help-modal/brief.md'), 'utf8')).toBe(
        '# Brief\n',
      );
      expect(ctx.worktreeManager.commitFiles).toHaveBeenCalledWith(
        worktreePath,
        ['specs/help-modal/brief.md'],
        'docs(spec): add pod spec files',
      );
    });

    it('mounts runtime-only spec context and series artifacts outside the worktree', async () => {
      const ctx = createTestContext();
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopod-spec-context-'));
      const previousDataDir = process.env.DATA_DIR;
      process.env.DATA_DIR = dataDir;
      const manager = createPodManager(ctx.deps);

      try {
        const pod = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Add feature from local spec',
            specContextFiles: [{ path: 'specs/help-modal/plan.md', content: '# Plan\n' }],
            seriesId: 'help-modal',
            seriesName: 'Help modal',
            skipValidation: true,
          },
          'user-1',
        );

        await manager.processPod(pod.id);

        const mountedContextPath = path.join(dataDir, 'spec-context', pod.id);
        expect(
          fs.readFileSync(path.join(mountedContextPath, 'specs/help-modal/plan.md'), 'utf8'),
        ).toBe('# Plan\n');
        const spawnCall = vi.mocked(ctx.containerManager.spawn).mock.calls.at(-1)?.[0];
        expect(spawnCall?.volumes).toEqual(
          expect.arrayContaining([
            {
              host: mountedContextPath,
              container: '/autopod/spec',
              readOnly: true,
            },
            {
              host: path.join(dataDir, 'pod-artifacts', 'help-modal'),
              container: '/autopod/artifacts',
            },
          ]),
        );
      } finally {
        if (previousDataDir === undefined) {
          process.env.DATA_DIR = undefined;
        } else {
          process.env.DATA_DIR = previousDataDir;
        }
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it('fails when the agent reports an execution-environment blocker on completion', async () => {
      const ctx = createTestContext();
      (ctx.runtime.spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async function* (): AsyncIterable<AgentEvent> {
          yield {
            type: 'complete',
            timestamp: new Date().toISOString(),
            result:
              'I am blocked by the execution environment: ' +
              'bwrap: No permissions to create a new namespace.',
          };
        },
      );
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );

      await manager.processPod(pod.id);

      const processed = manager.getSession(pod.id);
      expect(processed.status).toBe('failed');
      expect(processed.lastCorrectionMessage).toContain('bwrap cannot create a namespace');
      expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
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
      expect(vi.mocked(ctx.containerManager.spawn).mock.calls[0]?.[0].env).toMatchObject({
        AUTOPOD_POD_ID: pod.id,
        AUTOPOD_HEAD_BRANCH: pod.branch,
        AUTOPOD_BASE_BRANCH: 'main',
        AUTOPOD_PR_BASE_REF: 'origin/main',
        AUTOPOD_VALIDATION_BASE_REF: 'abc1234567890abcdef1234567890abcdef1234',
        AUTOPOD_START_COMMIT_SHA: 'abc1234567890abcdef1234567890abcdef1234',
      });
      expect(ctx.runtime.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            AUTOPOD_POD_ID: pod.id,
            AUTOPOD_HEAD_BRANCH: pod.branch,
            AUTOPOD_BASE_BRANCH: 'main',
            AUTOPOD_PR_BASE_REF: 'origin/main',
            AUTOPOD_VALIDATION_BASE_REF: 'abc1234567890abcdef1234567890abcdef1234',
            AUTOPOD_START_COMMIT_SHA: 'abc1234567890abcdef1234567890abcdef1234',
          }),
        }),
      );
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

    describe('network_policy_resolved snapshot', () => {
      it('writes allow-all when profile has no network policy', async () => {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Normal task', skipValidation: true },
          'user-1',
        );

        await manager.processPod(pod.id);

        const after = manager.getSession(pod.id);
        expect(after.networkPolicyResolved).toBe('allow-all');
      });

      it('writes restricted when profile resolves network policy to restricted', async () => {
        const ctx = createTestContext();

        // Patch profileStore to return a profile with network policy enabled
        const originalGet = vi.mocked(ctx.profileStore.get).getMockImplementation();
        if (!originalGet) throw new Error('profileStore.get has no mock implementation');
        vi.mocked(ctx.profileStore.get).mockImplementation((name: string) => ({
          ...originalGet(name),
          networkPolicy: { enabled: true, mode: 'restricted' as const, allowedHosts: [] },
        }));

        const manager = createPodManager(ctx.deps);
        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Restricted task', skipValidation: true },
          'user-1',
        );

        await manager.processPod(pod.id);

        const after = manager.getSession(pod.id);
        expect(after.networkPolicyResolved).toBe('restricted');
      });

      it('does not overwrite network_policy_resolved on recovery/resume', async () => {
        const ctx = createTestContext();

        // Patch profile to have a different policy so we can detect overwriting
        const originalGet = vi.mocked(ctx.profileStore.get).getMockImplementation();
        if (!originalGet) throw new Error('profileStore.get has no mock implementation');
        vi.mocked(ctx.profileStore.get).mockImplementation((name: string) => ({
          ...originalGet(name),
          networkPolicy: { enabled: true, mode: 'restricted' as const, allowedHosts: [] },
        }));

        const manager = createPodManager(ctx.deps);
        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Recovery task', skipValidation: true },
          'user-1',
        );

        // Simulate a pod that was already provisioned (column already set to deny-all from
        // original provisioning) now being resumed with a different live policy
        ctx.podRepo.update(pod.id, { networkPolicyResolved: 'deny-all' });

        await manager.processPod(pod.id);

        // Should NOT be overwritten — deny-all from original provisioning is preserved
        const after = manager.getSession(pod.id);
        expect(after.networkPolicyResolved).toBe('deny-all');
      });
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

      it('skips agent spawn during recovery when the prior run already emitted complete', async () => {
        const ctx = createTestContext();
        setupExecFileMock({ bareRepoPath: '/tmp/bare/recovered.git' });

        const manager = createPodManager(ctx.deps);
        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Continue feature', skipValidation: true },
          'user-1',
        );

        ctx.eventBus.emit({
          type: 'pod.agent_activity',
          timestamp: '2026-01-01T00:00:00.000Z',
          podId: pod.id,
          event: {
            type: 'complete',
            timestamp: '2026-01-01T00:00:00.000Z',
            result: 'Agent finished before daemon restart',
          },
        });
        ctx.podRepo.update(pod.id, {
          recoveryWorktreePath: '/tmp/worktree/existing',
        });

        await manager.processPod(pod.id);

        expect(ctx.runtime.spawn).not.toHaveBeenCalled();
        expect(ctx.runtime.resume).not.toHaveBeenCalled();
        expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
        const updated = manager.getSession(pod.id);
        expect(updated.status).toBe('validated');
        expect(updated.worktreePath).toBe('/tmp/worktree/existing');
      });

      it('does not skip recovery spawn when a prior complete was followed by a fatal error', async () => {
        const ctx = createTestContext();
        setupExecFileMock({ bareRepoPath: '/tmp/bare/recovered.git' });

        const manager = createPodManager(ctx.deps);
        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Continue feature', skipValidation: true },
          'user-1',
        );

        ctx.eventBus.emit({
          type: 'pod.agent_activity',
          timestamp: '2026-01-01T00:00:00.000Z',
          podId: pod.id,
          event: {
            type: 'complete',
            timestamp: '2026-01-01T00:00:00.000Z',
            result: 'Agent printed complete before the runtime failed',
          },
        });
        ctx.eventBus.emit({
          type: 'pod.agent_activity',
          timestamp: '2026-01-01T00:00:01.000Z',
          podId: pod.id,
          event: {
            type: 'error',
            timestamp: '2026-01-01T00:00:01.000Z',
            message: 'Codex process exited with code 137',
            fatal: true,
          },
        });
        ctx.podRepo.update(pod.id, {
          recoveryWorktreePath: '/tmp/worktree/existing',
        });

        await manager.processPod(pod.id);

        expect(ctx.runtime.spawn).toHaveBeenCalled();
        expect(ctx.runtime.resume).not.toHaveBeenCalled();
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

      it('fails a rework run that exits without file changes', async () => {
        const ctx = createTestContext(undefined, {});
        setupExecFileMock({ gitLog: 'abc1234 Previous broken work' });
        (ctx.worktreeManager.getDiffStats as ReturnType<typeof vi.fn>).mockResolvedValue({
          filesChanged: 0,
          linesAdded: 0,
          linesRemoved: 0,
        });

        const manager = createPodManager(ctx.deps);
        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Fix the bug' },
          'user-1',
        );

        ctx.podRepo.update(pod.id, {
          recoveryWorktreePath: '/tmp/worktree/existing',
          reworkReason: 'Your previous attempt failed. Review what went wrong and try again.',
        });

        await manager.processPod(pod.id);

        const updated = manager.getSession(pod.id);
        expect(updated.status).toBe('failed');
        expect(updated.lastCorrectionMessage).toBe('Rework produced no file changes.');
        expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
      });

      it('completes a scheduled rework run cleanly without file changes', async () => {
        const ctx = createTestContext(undefined, {});
        setupExecFileMock({ gitLog: 'abc1234 Previous scan run' });
        (ctx.worktreeManager.getDiffStats as ReturnType<typeof vi.fn>).mockResolvedValue({
          filesChanged: 0,
          linesAdded: 0,
          linesRemoved: 0,
        });
        ctx.db
          .prepare(`
            INSERT INTO scheduled_job_templates (id, name, prompt)
            VALUES ('tmpl-clean-scan', 'Daily vuln scan', 'Run the daily vuln scan')
          `)
          .run();
        ctx.db
          .prepare(`
            INSERT INTO scheduled_jobs (
              id, name, template_id, profile_name, task, cron_expression, next_run_at
            ) VALUES (
              'job-clean-scan', 'Daily vuln scan', 'tmpl-clean-scan', 'test-profile', 'Run the daily vuln scan',
              '0 9 * * *', '2030-01-01T00:00:00.000Z'
            )
          `)
          .run();

        const manager = createPodManager(ctx.deps);
        const pod = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Daily vuln scan',
            scheduledJobId: 'job-clean-scan',
          },
          'scheduler',
        );

        ctx.podRepo.update(pod.id, {
          recoveryWorktreePath: '/tmp/worktree/existing',
          reworkReason: 'Your previous attempt failed. Review what went wrong and try again.',
        });

        await manager.processPod(pod.id);

        const updated = manager.getSession(pod.id);
        expect(updated.status).toBe('complete');
        expect(updated.completedAt).not.toBeNull();
        expect(updated.readinessReview).toBeNull();
        expect(updated.lastCorrectionMessage).toBeNull();
        expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
      });

      it('falls back to fresh spawn when Claude resume reports session-not-found mid-stream', async () => {
        const runtime = createMockRuntime();
        (runtime as Record<string, unknown>).setClaudeSessionId = vi.fn();

        // Realistic failure mode: Claude prints "No conversation found …" to
        // stderr, the runtime's stream wrapper throws ResumeSessionNotFoundError
        // mid-iteration. Pod-manager catches that specific error and falls
        // through to a fresh spawn with recovery context.
        runtime.resume = vi.fn(async function* (): AsyncGenerator<AgentEvent> {
          throw new ResumeSessionNotFoundError('test-pod', 'claude-ses-expired');
          // biome-ignore lint/correctness/noUnreachable: required for AsyncGenerator return type
          yield {} as AgentEvent;
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

        // Stale claudeSessionId should be cleared so future recoveries don't
        // loop trying to resume the same nonexistent conversation.
        const updated = manager.getSession(pod.id);
        expect(updated.claudeSessionId).toBeNull();

        // Pod should still complete (not crash)
        expect(updated.status).toBe('validated');
      });

      it('does NOT fall back when resume fails with a non-session-not-found error', async () => {
        const runtime = createMockRuntime();
        (runtime as Record<string, unknown>).setClaudeSessionId = vi.fn();

        // Container died / network blew up / etc. — re-spawning in the same
        // (possibly broken) container is not the right answer. The error must
        // propagate so the pod fails properly.
        runtime.resume = vi.fn(async function* (): AsyncGenerator<AgentEvent> {
          throw new Error('Container is no longer running');
          // biome-ignore lint/correctness/noUnreachable: required for AsyncGenerator return type
          yield {} as AgentEvent;
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
          claudeSessionId: 'claude-ses-valid',
        });

        await manager.processPod(pod.id);

        // Spawn must NOT have been called — non-session-not-found errors propagate.
        expect(runtime.resume).toHaveBeenCalled();
        expect(runtime.spawn).not.toHaveBeenCalled();
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

    it('passes the effective advisory browser QA setting to validation', async () => {
      const ctx = createTestContext({ overall: 'pass' });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Add feature',
          options: { agentMode: 'auto', output: 'pr', advisoryBrowserQaEnabled: true },
        },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        worktreePath: '/tmp/wt',
      });

      await manager.triggerValidation(pod.id);

      expect(ctx.validationEngine.validate).toHaveBeenCalledWith(
        expect.objectContaining({ advisoryBrowserQaEnabled: true }),
        expect.any(Function),
        expect.any(AbortSignal),
        expect.any(Object),
      );
    });

    it('uses a profile default thin-with-facts validation suite', async () => {
      const ctx = createTestContext({ overall: 'pass' });
      ctx.db
        .prepare(
          `UPDATE profiles
           SET agent_mode = 'auto', output_target = 'pr', validate = 1, validation_suite = 'thin-with-facts'
           WHERE name = 'test-profile'`,
        )
        .run();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      expect(pod.options.validationSuite).toBe('thin-with-facts');
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        worktreePath: '/tmp/wt',
      });

      await manager.triggerValidation(pod.id);

      expect(ctx.validationEngine.validate).toHaveBeenCalledWith(
        expect.objectContaining({
          validationSuite: 'thin-with-facts',
          skipPhases: ['sast', 'pages', 'review', 'advisory'],
        }),
        expect.any(Function),
        expect.any(AbortSignal),
        expect.any(Object),
      );
      expect(manager.getSession(pod.id).lastValidationResult?.validationSuite).toBe(
        'thin-with-facts',
      );
    });

    it('allows a pod to override the profile validation suite', async () => {
      const ctx = createTestContext({ overall: 'pass' });
      ctx.db
        .prepare(
          `UPDATE profiles
           SET agent_mode = 'auto', output_target = 'pr', validate = 1, validation_suite = 'full'
           WHERE name = 'test-profile'`,
        )
        .run();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Add feature',
          options: { validationSuite: 'thin-with-facts' },
        },
        'user-1',
      );
      expect(pod.options.validationSuite).toBe('thin-with-facts');
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        worktreePath: '/tmp/wt',
      });

      await manager.triggerValidation(pod.id);

      expect(ctx.validationEngine.validate).toHaveBeenCalledWith(
        expect.objectContaining({
          validationSuite: 'thin-with-facts',
          skipPhases: ['sast', 'pages', 'review', 'advisory'],
        }),
        expect.any(Function),
        expect.any(AbortSignal),
        expect.any(Object),
      );
    });

    it('keeps legacy PR pods on full validation when no suite is configured', async () => {
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

      expect(ctx.validationEngine.validate).toHaveBeenCalledWith(
        expect.objectContaining({
          validationSuite: 'full',
          skipPhases: [],
        }),
        expect.any(Function),
        expect.any(AbortSignal),
        expect.any(Object),
      );
    });

    it('passes diff-scoped validation base context to validation commands', async () => {
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
        startCommitSha: 'parent-tip-sha',
      });

      await manager.triggerValidation(pod.id);

      const validateConfig = vi.mocked(ctx.validationEngine.validate).mock.calls[0]?.[0];
      expect(validateConfig?.extraExecEnv).toMatchObject({
        AUTOPOD_POD_ID: pod.id,
        AUTOPOD_HEAD_BRANCH: pod.branch,
        AUTOPOD_BASE_BRANCH: 'main',
        AUTOPOD_PR_BASE_REF: 'origin/main',
        AUTOPOD_VALIDATION_BASE_REF: 'parent-tip-sha',
        AUTOPOD_START_COMMIT_SHA: 'parent-tip-sha',
      });
    });

    it('readiness refresh updates after deferred advisory finishes', async () => {
      const ctx = createTestContext({ overall: 'pass' });
      const manager = createPodManager(ctx.deps);
      const advisory = deferred<NonNullable<ValidationResult['advisoryBrowserQa']>>();
      const advisoryResult: NonNullable<ValidationResult['advisoryBrowserQa']> = {
        status: 'fail',
        reasoning: 'Advisory issue does not block.',
        observations: [],
        screenshots: [],
        durationMs: 25,
        tokenUsage: {
          inputTokens: 3000,
          cachedInputTokens: 2000,
          outputTokens: 250,
          costUsd: 0.12,
        },
      };
      const runAdvisoryBrowserQa = ctx.validationEngine.runAdvisoryBrowserQa;
      if (!runAdvisoryBrowserQa) {
        throw new Error('Expected validation engine to expose advisory runner');
      }
      vi.mocked(runAdvisoryBrowserQa).mockImplementationOnce(
        async (_config, _result, _onProgress, _signal, callbacks) => {
          callbacks?.onPhaseStarted?.('advisory');
          const result = await advisory.promise;
          callbacks?.onPhaseCompleted?.('advisory', 'pass', result);
          return result;
        },
      );

      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Add feature',
          options: { agentMode: 'auto', output: 'pr', advisoryBrowserQaEnabled: true },
        },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        worktreePath: '/tmp/wt',
      });

      const events: unknown[] = [];
      ctx.eventBus.subscribe((event) => events.push(event));

      const validationPromise = manager.triggerValidation(pod.id);
      await waitForAssertion(() => {
        expect(ctx.prManager.createPr).toHaveBeenCalled();
        expect(manager.getSession(pod.id).status).toBe('validated');
        expect(ctx.containerManager.stop).not.toHaveBeenCalled();
      });
      expect(ctx.validationRepo.getForSession(pod.id)).toHaveLength(1);
      expect(ctx.validationRepo.getForSession(pod.id)[0]?.result.advisoryBrowserQa).toBeUndefined();
      expect(manager.getSession(pod.id).readinessReview).toMatchObject({
        status: 'needs_review',
        areas: expect.arrayContaining([
          expect.objectContaining({ area: 'advisory_qa', status: 'not_available' }),
        ]),
        findings: expect.arrayContaining([
          expect.objectContaining({ id: 'advisory-qa-in-flight' }),
        ]),
      });

      const completedBeforeAdvisory = events.filter(
        (event) => (event as { type?: string }).type === 'pod.validation_completed',
      );
      expect(completedBeforeAdvisory).toHaveLength(1);

      advisory.resolve(advisoryResult);
      await validationPromise;

      expect(ctx.containerManager.stop).toHaveBeenCalledWith('ctr-1');
      expect(manager.getSession(pod.id).lastValidationResult?.advisoryBrowserQa).toEqual(
        advisoryResult,
      );
      expect(manager.getSession(pod.id).readinessReview).toMatchObject({
        status: 'needs_review',
        areas: expect.arrayContaining([
          expect.objectContaining({ area: 'advisory_qa', status: 'needs_review' }),
        ]),
        findings: expect.arrayContaining([expect.objectContaining({ id: 'advisory-qa-concern' })]),
      });
      expect(manager.getSession(pod.id).phaseTokenUsage?.advisory).toEqual({
        inputTokens: 3000,
        cachedInputTokens: 2000,
        outputTokens: 250,
        costUsd: 0.12,
      });
      expect(
        events.filter((event) => (event as { type?: string }).type === 'pod.validation_completed'),
      ).toHaveLength(1);
      expect(
        events.some(
          (event) =>
            (event as { type?: string; phase?: string }).type ===
              'pod.validation_phase_completed' &&
            (event as { phase?: string }).phase === 'advisory',
        ),
      ).toBe(true);
    });

    it('approval waits for advisory QA before applying readiness rules', async () => {
      const ctx = createTestContext({ overall: 'pass' });
      const manager = createPodManager(ctx.deps);
      const advisory = deferred<NonNullable<ValidationResult['advisoryBrowserQa']>>();
      const advisoryResult: NonNullable<ValidationResult['advisoryBrowserQa']> = {
        status: 'pass',
        reasoning: 'Ready after advisory.',
        observations: [],
        screenshots: [],
        durationMs: 42,
      };
      const runAdvisoryBrowserQa = ctx.validationEngine.runAdvisoryBrowserQa;
      if (!runAdvisoryBrowserQa) {
        throw new Error('Expected validation engine to expose advisory runner');
      }
      vi.mocked(runAdvisoryBrowserQa).mockImplementationOnce(
        async (_config, _result, _onProgress, _signal, callbacks) => {
          callbacks?.onPhaseStarted?.('advisory');
          const result = await advisory.promise;
          callbacks?.onPhaseCompleted?.('advisory', 'pass', result);
          return result;
        },
      );

      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Add feature',
          options: { agentMode: 'auto', output: 'pr', advisoryBrowserQaEnabled: true },
        },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        worktreePath: '/tmp/wt',
      });

      const validationPromise = manager.triggerValidation(pod.id);
      await waitForAssertion(() => {
        expect(ctx.prManager.createPr).toHaveBeenCalled();
        expect(manager.getSession(pod.id).status).toBe('validated');
      });

      const approvalPromise = manager.approveSession(pod.id);
      await new Promise((resolve) => setImmediate(resolve));

      expect(ctx.prManager.mergePr).not.toHaveBeenCalled();
      expect(manager.getSession(pod.id).status).toBe('validated');
      expect(manager.getSession(pod.id).readinessReview).toMatchObject({
        status: 'needs_review',
        findings: expect.arrayContaining([
          expect.objectContaining({ id: 'advisory-qa-in-flight' }),
        ]),
      });

      advisory.resolve(advisoryResult);
      await approvalPromise;
      await validationPromise;

      expect(ctx.prManager.mergePr).toHaveBeenCalledWith(
        expect.objectContaining({ prUrl: 'https://github.com/org/repo/pull/42' }),
      );
      expect(manager.getSession(pod.id).status).toBe('complete');
      expect(manager.getSession(pod.id).readinessReview).toMatchObject({
        status: 'ready',
        areas: expect.arrayContaining([
          expect.objectContaining({ area: 'advisory_qa', status: 'ready' }),
        ]),
      });
      expect(ctx.containerManager.kill).toHaveBeenCalledWith('ctr-1');
      expect(manager.getSession(pod.id).lastValidationResult?.advisoryBrowserQa).toEqual(
        advisoryResult,
      );
    });

    it('deferred advisory persistence does not clobber a newer validation result', async () => {
      const ctx = createTestContext({ overall: 'pass' });
      const manager = createPodManager(ctx.deps);
      const advisory = deferred<NonNullable<ValidationResult['advisoryBrowserQa']>>();
      const advisoryResult: NonNullable<ValidationResult['advisoryBrowserQa']> = {
        status: 'pass',
        reasoning: 'Attempt one advisory.',
        observations: [],
        screenshots: [],
        durationMs: 19,
      };
      const runAdvisoryBrowserQa = ctx.validationEngine.runAdvisoryBrowserQa;
      if (!runAdvisoryBrowserQa) {
        throw new Error('Expected validation engine to expose advisory runner');
      }
      vi.mocked(runAdvisoryBrowserQa).mockImplementationOnce(
        async (_config, _result, _onProgress, _signal, callbacks) => {
          callbacks?.onPhaseStarted?.('advisory');
          const result = await advisory.promise;
          callbacks?.onPhaseCompleted?.('advisory', 'pass', result);
          return result;
        },
      );

      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Add feature',
          options: { agentMode: 'auto', output: 'pr', advisoryBrowserQaEnabled: true },
        },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        worktreePath: '/tmp/wt',
      });

      const validationPromise = manager.triggerValidation(pod.id);
      await waitForAssertion(() => {
        expect(manager.getSession(pod.id).status).toBe('validated');
        expect(ctx.validationRepo.getForSession(pod.id)).toHaveLength(1);
      });

      const firstResult = manager.getSession(pod.id).lastValidationResult;
      if (!firstResult) {
        throw new Error('Expected first validation result');
      }
      const newerResult: ValidationResult = {
        ...firstResult,
        attempt: 2,
        timestamp: new Date().toISOString(),
        advisoryBrowserQa: undefined,
      };
      ctx.podRepo.update(pod.id, { lastValidationResult: newerResult });

      advisory.resolve(advisoryResult);
      await validationPromise;

      expect(manager.getSession(pod.id).lastValidationResult?.attempt).toBe(2);
      expect(manager.getSession(pod.id).lastValidationResult?.advisoryBrowserQa).toBeUndefined();
      const storedHistory = ctx.validationRepo.getForSession(pod.id);
      expect(storedHistory).toHaveLength(1);
      expect(storedHistory[0]?.attempt).toBe(1);
      expect(storedHistory[0]?.result.attempt).toBe(1);
      expect(storedHistory[0]?.result.advisoryBrowserQa).toEqual(advisoryResult);
    });

    it('revalidation creates the PR before advisory finishes', async () => {
      const ctx = createTestContext({ overall: 'pass' });
      const manager = createPodManager(ctx.deps);
      const advisory = deferred<NonNullable<ValidationResult['advisoryBrowserQa']>>();
      const advisoryResult: NonNullable<ValidationResult['advisoryBrowserQa']> = {
        status: 'pass',
        reasoning: 'Looks good after resume.',
        observations: [],
        screenshots: [],
        durationMs: 31,
      };
      const runAdvisoryBrowserQa = ctx.validationEngine.runAdvisoryBrowserQa;
      if (!runAdvisoryBrowserQa) {
        throw new Error('Expected validation engine to expose advisory runner');
      }
      vi.mocked(runAdvisoryBrowserQa).mockImplementationOnce(
        async (_config, _result, _onProgress, _signal, callbacks) => {
          callbacks?.onPhaseStarted?.('advisory');
          const result = await advisory.promise;
          callbacks?.onPhaseCompleted?.('advisory', 'pass', result);
          return result;
        },
      );

      const pod = manager.createSession(
        {
          profileName: 'test-profile',
          task: 'Resume feature',
          options: { agentMode: 'auto', output: 'pr', advisoryBrowserQaEnabled: true },
        },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'failed',
        failureReason: 'Agent failed: stale reason',
        containerId: 'ctr-1',
        worktreePath: '/tmp/wt',
      });

      const events: unknown[] = [];
      ctx.eventBus.subscribe((event) => events.push(event));

      const revalidationPromise = manager.revalidateSession(pod.id, { force: true });
      await waitForAssertion(() => {
        expect(ctx.prManager.createPr).toHaveBeenCalled();
        expect(manager.getSession(pod.id).status).toBe('validated');
        expect(ctx.containerManager.stop).not.toHaveBeenCalled();
      });
      expect(ctx.validationRepo.getForSession(pod.id)).toHaveLength(1);
      expect(ctx.validationRepo.getForSession(pod.id)[0]?.result.advisoryBrowserQa).toBeUndefined();

      const completedBeforeAdvisory = events.filter(
        (event) => (event as { type?: string }).type === 'pod.validation_completed',
      );
      expect(completedBeforeAdvisory).toHaveLength(1);

      advisory.resolve(advisoryResult);
      await expect(revalidationPromise).resolves.toEqual({ newCommits: false, result: 'pass' });

      expect(ctx.containerManager.stop).toHaveBeenCalledWith('ctr-1');
      expect(manager.getSession(pod.id).lastValidationResult?.advisoryBrowserQa).toEqual(
        advisoryResult,
      );
      const storedHistory = ctx.validationRepo.getForSession(pod.id);
      expect(storedHistory).toHaveLength(1);
      expect(storedHistory[0]?.result.advisoryBrowserQa).toEqual(advisoryResult);
      expect(
        events.filter((event) => (event as { type?: string }).type === 'pod.validation_completed'),
      ).toHaveLength(1);
      expect(
        events.some(
          (event) =>
            (event as { type?: string; phase?: string }).type ===
              'pod.validation_phase_completed' &&
            (event as { phase?: string }).phase === 'advisory',
        ),
      ).toBe(true);
    });

    it('recovers from live container when workspace sync fails before validation', async () => {
      const ctx = createTestContext({ overall: 'pass' });
      (ctx.containerManager.execInContainer as ReturnType<typeof vi.fn>).mockImplementation(
        async (_containerId, command: string[]) => {
          if (
            command[0] === 'sh' &&
            command[1] === '-c' &&
            String(command[2]).includes('/mnt/worktree')
          ) {
            throw new Error('docker exec failed');
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      );
      (
        ctx.containerManager.extractDirectoryFromContainer as ReturnType<typeof vi.fn>
      ).mockRejectedValueOnce(new Error('archive fallback failed'));
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
      expect(result.worktreeCompromised).toBe(false);
      expect(result.status).toBe('validated');
      expect(ctx.validationEngine.validate).toHaveBeenCalled();
      expect(
        vi.mocked(ctx.containerManager.extractDirectoryFromContainer).mock.calls.length,
      ).toBeGreaterThanOrEqual(2);
      expect(mockedExecFile).toHaveBeenCalledWith(
        'git',
        ['reset', '--mixed', 'HEAD'],
        { cwd: '/tmp/wt' },
        expect.any(Function),
      );
    });

    it('re-provisions a fresh container (validation-only) when a force resume cannot sync the reused container', async () => {
      const hostHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const containerHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      // Host worktree HEAD is the recovered auto-commit; the reused (cold) container
      // reports a divergent HEAD that is neither ancestor of the other.
      mockedExecFile.mockImplementation((...args: unknown[]) => {
        const gitArgs = Array.isArray(args[1]) ? (args[1] as string[]) : [];
        const callback = args[args.length - 1] as (
          err: Error | null,
          result: { stdout: string; stderr: string },
        ) => void;
        const stdout = gitArgs[0] === 'rev-parse' && gitArgs[1] === 'HEAD' ? `${hostHead}\n` : '';
        callback(null, { stdout, stderr: '' });
        return undefined as never;
      });

      const ctx = createTestContext({ overall: 'pass' });
      ctx.containerManager.execInContainer = vi.fn(async (_containerId, command) => {
        if (command[0] === 'git' && command[3] === 'rev-parse') {
          return { stdout: `${containerHead}\n`, stderr: '', exitCode: 0 };
        }
        if (command[0] === 'git' && command[3] === 'merge-base') {
          // Neither direction is an ancestor → true divergence on the reused container.
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'failed',
        containerId: 'ctr-stale',
        worktreePath: '/tmp/wt',
      });

      const result = await manager.revalidateSession(pod.id, { force: true });

      expect(result).toEqual({ newCommits: false, result: 'fail' });
      const refreshed = manager.getSession(pod.id);
      // Fresh re-provision for validation-only — NOT parked as compromised.
      expect(refreshed.worktreeCompromised).toBe(false);
      expect(refreshed.status).toBe('queued');
      expect(refreshed.containerId).toBeNull();
      expect(refreshed.skipAgent).toBe(true);
      expect(refreshed.recoveryWorktreePath).toBe('/tmp/wt');
      // We did not fall back to validating against the stale container.
      expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
    });

    it('resets a stale validation container to host HEAD instead of mirroring it back', async () => {
      const hostHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const containerHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      mockedExecFile.mockImplementation((...args: unknown[]) => {
        const gitArgs = Array.isArray(args[1]) ? (args[1] as string[]) : [];
        const callback = args[args.length - 1] as (
          err: Error | null,
          result: { stdout: string; stderr: string },
        ) => void;
        const stdout = gitArgs[0] === 'rev-parse' && gitArgs[1] === 'HEAD' ? `${hostHead}\n` : '';
        callback(null, { stdout, stderr: '' });
        return undefined as never;
      });

      const ctx = createTestContext({ overall: 'pass' });
      ctx.containerManager.execInContainer = vi.fn(async (_containerId, command) => {
        if (command[0] === 'git' && command[3] === 'rev-parse') {
          return { stdout: `${containerHead}\n`, stderr: '', exitCode: 0 };
        }
        if (command[0] === 'git' && command[3] === 'status') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command[0] === 'git' && command[3] === 'merge-base') {
          return {
            stdout: '',
            stderr: '',
            exitCode: command[5] === containerHead && command[6] === hostHead ? 0 : 1,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });
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

      expect(ctx.containerManager.execInContainer).toHaveBeenCalledWith(
        'ctr-1',
        ['git', '-C', '/workspace', 'reset', '--hard', hostHead],
        { timeout: 30_000 },
      );
      expect(ctx.containerManager.execInContainer).toHaveBeenCalledWith(
        'ctr-1',
        ['git', '-C', '/workspace', 'clean', '-fd'],
        { timeout: 30_000 },
      );
      const execCalls = vi.mocked(ctx.containerManager.execInContainer).mock.calls;
      const resetIndex = execCalls.findIndex(
        ([, command]) => command[0] === 'git' && command[3] === 'reset',
      );
      const firstDestructiveSyncIndex = execCalls.findIndex(
        ([, command]) =>
          command[0] === 'sh' &&
          command[1] === '-c' &&
          String(command[2]).includes('/mnt/worktree'),
      );
      expect(firstDestructiveSyncIndex === -1 || resetIndex < firstDestructiveSyncIndex).toBe(true);
      expect(ctx.validationEngine.validate).toHaveBeenCalled();
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

    it('uses the pod-pinned baseBranch even if the profile default changes before PR creation', async () => {
      const ctx = createTestContext({ overall: 'pass' }, { defaultBranch: 'release/2.3.10' });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Patch release branch' },
        'user-1',
      );
      expect(pod.baseBranch).toBe('release/2.3.10');

      ctx.db
        .prepare("UPDATE profiles SET default_branch = 'main' WHERE name = 'test-profile'")
        .run();
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        worktreePath: '/tmp/wt',
      });

      await manager.triggerValidation(pod.id);

      expect(ctx.prManager.createPr).toHaveBeenCalledWith(
        expect.objectContaining({
          podId: pod.id,
          baseBranch: 'release/2.3.10',
        }),
      );
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

    it('retries review infrastructure failures without agent rework', async () => {
      vi.useFakeTimers();
      try {
        const ctx = createTestContext();
        vi.mocked(ctx.validationEngine.validate)
          .mockResolvedValueOnce({
            podId: 'test',
            attempt: 1,
            timestamp: new Date().toISOString(),
            duration: 5000,
            ...reviewInfrastructureFailureResult('review-timeout'),
          } as ValidationResult)
          .mockResolvedValueOnce({
            podId: 'test',
            attempt: 1,
            timestamp: new Date().toISOString(),
            smoke: {
              status: 'pass',
              build: { status: 'pass', output: '', duration: 100 },
              health: {
                status: 'pass',
                url: 'http://localhost:3000',
                responseCode: 200,
                duration: 50,
              },
              pages: [],
            },
            taskReview: {
              status: 'pass',
              reasoning: 'Looks good',
              issues: [],
              model: 'gpt-5',
              screenshots: [],
              diff: '+done',
            },
            overall: 'pass',
            duration: 5000,
          });
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Add feature' },
          'user-1',
        );
        ctx.podRepo.update(pod.id, {
          status: 'running',
          containerId: 'ctr-1',
          worktreePath: '/tmp/wt',
          validationAttempts: 0,
        });

        const validationPromise = manager.triggerValidation(pod.id);
        await vi.waitFor(() => expect(ctx.validationEngine.validate).toHaveBeenCalledTimes(1));
        await vi.advanceTimersByTimeAsync(10_000);
        await validationPromise;

        expect(ctx.validationEngine.validate).toHaveBeenCalledTimes(2);
        expect(ctx.runtime.resume).not.toHaveBeenCalled();
        const result = manager.getSession(pod.id);
        expect(result.status).toBe('validated');
        expect(result.validationAttempts).toBe(1);
        expect(result.lastCorrectionMessage).toBeNull();

        const messages = ctx.eventRepo
          .getForSession(pod.id, { type: 'pod.agent_activity' })
          .map((event) => {
            const payload = event.payload as { event?: { message?: unknown } };
            return payload.event?.message;
          });
        expect(messages).toContain('Review infrastructure failure — retrying in 10s (1/3)');
      } finally {
        vi.useRealTimers();
      }
    });

    it('moves to review_required after review infrastructure retries exhaust', async () => {
      vi.useFakeTimers();
      try {
        const ctx = createTestContext(reviewInfrastructureFailureResult('review-failed'));
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

        const validationPromise = manager.triggerValidation(pod.id);
        await vi.waitFor(() => expect(ctx.validationEngine.validate).toHaveBeenCalledTimes(1));
        await vi.advanceTimersByTimeAsync(10_000);
        await vi.waitFor(() => expect(ctx.validationEngine.validate).toHaveBeenCalledTimes(2));
        await vi.advanceTimersByTimeAsync(30_000);
        await vi.waitFor(() => expect(ctx.validationEngine.validate).toHaveBeenCalledTimes(3));
        await vi.advanceTimersByTimeAsync(90_000);
        await validationPromise;

        expect(ctx.validationEngine.validate).toHaveBeenCalledTimes(4);
        expect(ctx.runtime.resume).not.toHaveBeenCalled();
        const result = manager.getSession(pod.id);
        expect(result.status).toBe('review_required');
        expect(result.status).not.toBe('awaiting_input');
        expect(result.validationAttempts).toBe(1);
        expect(result.pendingEscalation).toBeNull();
        expect(ctx.escalationRepo.listBySession(pod.id)).toHaveLength(0);
        expect(result.lastCorrectionMessage).toBeNull();

        const messages = ctx.eventRepo
          .getForSession(pod.id, { type: 'pod.agent_activity' })
          .map((event) => {
            const payload = event.payload as { event?: { message?: unknown } };
            return payload.event?.message;
          });
        expect(messages).toContain(
          'Review infrastructure failed after 3 retries — needs human review',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not retry deterministic reviewer invalid-request failures', async () => {
      const ctx = createTestContext(
        reviewInfrastructureFailureResult('review-failed', {
          reviewSkipReason:
            'Review failed: {"type":"invalid_request_error","message":"The model requires a newer version of Codex."}',
        }),
      );
      ctx.deps.reviewInfrastructureRetryBackoffMs = [0];
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

      expect(ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
      expect(ctx.runtime.resume).not.toHaveBeenCalled();
      expect(manager.getSession(pod.id).status).toBe('review_required');
    });

    it('moves pending fact deviations to review_required without retrying the agent', async () => {
      const ctx = createTestContext({
        overall: 'fail',
        factValidation: {
          status: 'pending_human',
          results: [
            {
              factId: 'fact-swift-only',
              proves: ['swift-helper-readable'],
              kind: 'unit-test',
              artifactPath:
                'packages/desktop/Tests/AutopodUITests/ThroughputTimeInStatusDisplayTests.swift',
              command: 'swift test --filter ThroughputTimeInStatusDisplayTests',
              passed: false,
              status: 'pending_human',
              reasoning:
                'Fact deviation request is pending human decision. Requested action: waived.',
            },
          ],
        },
      });
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

      expect(ctx.runtime.resume).not.toHaveBeenCalled();
      const result = manager.getSession(pod.id);
      expect(result.status).toBe('review_required');
      expect(result.validationAttempts).toBe(1);
    });

    it('retries unavailable fact commands so the agent can report factDeviations', async () => {
      const ctx = createTestContext({
        overall: 'fail',
        factValidation: {
          status: 'pending_human',
          results: [
            {
              factId: 'fact-swift-only',
              proves: ['swift-helper-readable'],
              kind: 'unit-test',
              artifactPath:
                'packages/desktop/Tests/AutopodUITests/ThroughputTimeInStatusDisplayTests.swift',
              command: 'swift test --filter ThroughputTimeInStatusDisplayTests',
              passed: false,
              status: 'pending_human',
              exitCode: 127,
              reasoning:
                'Fact fact-swift-only needs human decision: required fact command `swift` is unavailable in the validation container.',
              stderr: 'sh: 1: swift: not found',
            },
          ],
        },
      });
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

      const resumeCalls = vi.mocked(ctx.runtime.resume).mock.calls;
      expect(resumeCalls[0]?.[1]).toContain('Required Fact Deviation Requests Needed');
      expect(resumeCalls[0]?.[1]).toContain('"factId": "fact-swift-only"');
      expect(resumeCalls[0]?.[1]).toContain('Do not report these as ordinary plan deviations');
    });

    it('retries review infrastructure failures without agent rework', async () => {
      const ctx = createTestContext();
      ctx.deps.reviewInfrastructureRetryBackoffMs = [0];
      vi.mocked(ctx.validationEngine.validate)
        .mockResolvedValueOnce(makeReviewInfraFailure())
        .mockResolvedValueOnce(makeValidationResult());
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        worktreePath: '/tmp/wt',
        validationAttempts: 0,
      });

      await manager.triggerValidation(pod.id);

      expect(ctx.validationEngine.validate).toHaveBeenCalledTimes(2);
      expect(ctx.runtime.resume).not.toHaveBeenCalled();
      const result = manager.getSession(pod.id);
      expect(result.status).toBe('validated');
      expect(result.validationAttempts).toBe(1);
    });

    it('moves to review_required after review infrastructure retries exhaust', async () => {
      const ctx = createTestContext();
      ctx.deps.reviewInfrastructureRetryBackoffMs = [0, 0, 0];
      vi.mocked(ctx.validationEngine.validate).mockResolvedValue(makeReviewInfraFailure());
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        worktreePath: '/tmp/wt',
        validationAttempts: 0,
      });

      await manager.triggerValidation(pod.id);

      expect(ctx.validationEngine.validate).toHaveBeenCalledTimes(4);
      expect(ctx.runtime.resume).not.toHaveBeenCalled();
      const result = manager.getSession(pod.id);
      expect(result.status).toBe('review_required');
      expect(result.pendingEscalation).toBeNull();
      expect(result.validationAttempts).toBe(1);
    });

    it('keeps ordinary validation failures on correction feedback path', async () => {
      const ctx = createTestContext();
      vi.mocked(ctx.validationEngine.validate).mockResolvedValue(makeBuildFailure());
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

      expect(ctx.validationEngine.validate).toHaveBeenCalledTimes(3);
      expect(ctx.runtime.resume).toHaveBeenCalledTimes(2);
      const result = manager.getSession(pod.id);
      expect(result.status).toBe('review_required');
      expect(result.validationAttempts).toBe(3);
    });

    it('passes setup command into validation and summarizes setup failures first', async () => {
      const ctx = createTestContext(makeSetupFailure(), {
        validationSetupCommand: 'pip install -e ".[dev]" semgrep',
      });
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

      expect(ctx.validationEngine.validate).toHaveBeenCalledWith(
        expect.objectContaining({
          validationSetupCommand: 'pip install -e ".[dev]" semgrep',
          buildTimeout: 300_000,
        }),
        expect.any(Function),
        expect.any(AbortSignal),
        expect.any(Object),
      );
      const messages = ctx.eventRepo
        .getForSession(pod.id, { type: 'pod.agent_activity' })
        .map((event) => {
          const payload = event.payload as { event?: { message?: unknown } };
          return payload.event?.message;
        });
      expect(messages).toContain(
        'Validation fail — setup: fail, lint: skip, sast: skip, build: skip, tests: skip, health: skip, pages: skip, facts: skip, review: skip',
      );

      const resumeMessage = vi.mocked(ctx.runtime.resume).mock.calls[0]?.[1];
      expect(resumeMessage).toContain('### Setup Errors');
      expect(resumeMessage).toContain('pip install failed');
      expect(resumeMessage?.indexOf('### Setup Errors')).toBeLessThan(
        resumeMessage?.indexOf('### Original Task') ?? Number.POSITIVE_INFINITY,
      );
    });

    it('emits setup phase completion events from validation callbacks', async () => {
      const ctx = createTestContext(undefined, {
        validationSetupCommand: 'pip install -e ".[dev]" semgrep',
      });
      vi.mocked(ctx.validationEngine.validate).mockImplementationOnce(
        async (_config, _onProgress, _signal, callbacks) => {
          const setupResult = { status: 'pass' as const, output: 'setup ok', duration: 12 };
          callbacks?.onPhaseStarted?.('setup');
          callbacks?.onPhaseCompleted?.('setup', 'pass', setupResult);
          return makeValidationResult({ setup: setupResult });
        },
      );
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

      const events: unknown[] = [];
      ctx.eventBus.subscribe((event) => events.push(event));

      await manager.triggerValidation(pod.id);

      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'pod.validation_phase_started',
          phase: 'setup',
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'pod.validation_phase_completed',
          phase: 'setup',
          phaseStatus: 'pass',
          setupResult: { status: 'pass', output: 'setup ok', duration: 12 },
        }),
      );
    });

    it('approves a pending fact waiver and revalidates with the decision', async () => {
      const ctx = createTestContext({
        overall: 'pass',
        factValidation: {
          status: 'pass',
          results: [
            {
              factId: 'fact-swift-only',
              proves: ['swift-helper-readable'],
              kind: 'unit-test',
              artifactPath:
                'packages/desktop/Tests/AutopodUITests/ThroughputTimeInStatusDisplayTests.swift',
              command: 'swift test --filter ThroughputTimeInStatusDisplayTests',
              passed: true,
              status: 'waived',
              reasoning: 'Fact deviation approved by human as waive.',
            },
          ],
        },
      });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      const pendingReasoning =
        'Fact fact-swift-only needs human decision: required fact command `swift` is unavailable in the validation container.';
      ctx.podRepo.update(pod.id, {
        status: 'review_required',
        containerId: 'ctr-1',
        worktreePath: '/tmp/worktree/abc',
        taskSummary: {
          actualSummary: 'Updated the Swift helper.',
          deviations: [],
        },
        lastValidationResult: {
          podId: pod.id,
          attempt: 1,
          timestamp: new Date().toISOString(),
          smoke: {
            status: 'pass',
            build: { status: 'pass', output: '', duration: 100 },
            health: {
              status: 'pass',
              url: 'http://localhost:3000',
              responseCode: 200,
              duration: 50,
            },
            pages: [],
          },
          taskReview: null,
          overall: 'fail',
          duration: 5000,
          factValidation: {
            status: 'pending_human',
            results: [
              {
                factId: 'fact-swift-only',
                proves: ['swift-helper-readable'],
                kind: 'unit-test',
                artifactPath:
                  'packages/desktop/Tests/AutopodUITests/ThroughputTimeInStatusDisplayTests.swift',
                command: 'swift test --filter ThroughputTimeInStatusDisplayTests',
                passed: false,
                status: 'pending_human',
                reasoning: pendingReasoning,
              },
            ],
          },
        },
      });

      await manager.approveFactWaiver(pod.id, 'fact-swift-only', 'Swift is unavailable here');

      const validateConfig = vi.mocked(ctx.validationEngine.validate).mock.calls[0]?.[0];
      expect(validateConfig?.taskSummary?.factDeviations).toEqual([
        {
          factId: 'fact-swift-only',
          action: 'waive',
          decision: 'approved_waive',
          reason: 'Swift is unavailable here',
          whyImpossible: pendingReasoning,
        },
      ]);
      expect(manager.getSession(pod.id).status).toBe('validated');
    });

    it.each([
      { historicalStatus: 'pending_human' as const, historicalPassed: false },
      { historicalStatus: 'waived' as const, historicalPassed: true },
    ])(
      'restores a $historicalStatus fact waiver from history after an interrupted retry replaces the latest result',
      async ({ historicalStatus, historicalPassed }) => {
        const ctx = createTestContext({
          overall: 'pass',
          factValidation: {
            status: 'pass',
            results: [
              {
                factId: 'fact-swift-only',
                proves: ['swift-helper-readable'],
                kind: 'unit-test',
                artifactPath: 'packages/desktop/Tests/AutopodUITests/ProfileEditorTests.swift',
                command: 'swift test --filter ProfileEditorTests',
                passed: true,
                status: 'waived',
                reasoning: 'Fact deviation approved by human as waive.',
              },
            ],
          },
        });
        const manager = createPodManager(ctx.deps);
        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Update profile UI' },
          'user-1',
        );
        const pendingReasoning =
          'Fact fact-swift-only needs human decision: swift is unavailable in the validation container.';
        const pendingResult: ValidationResult = {
          podId: pod.id,
          attempt: 1,
          timestamp: new Date().toISOString(),
          smoke: {
            status: 'pass',
            build: { status: 'pass', output: '', duration: 100 },
            health: {
              status: 'pass',
              url: 'http://localhost:3000',
              responseCode: 200,
              duration: 50,
            },
            pages: [],
          },
          test: { status: 'pass', duration: 100 },
          taskReview: null,
          overall: 'fail',
          duration: 5000,
          factValidation: {
            status: historicalStatus === 'waived' ? 'pass' : 'pending_human',
            results: [
              {
                factId: 'fact-swift-only',
                proves: ['swift-helper-readable'],
                kind: 'unit-test',
                artifactPath: 'packages/desktop/Tests/AutopodUITests/ProfileEditorTests.swift',
                command: 'swift test --filter ProfileEditorTests',
                passed: historicalPassed,
                status: historicalStatus,
                reasoning: pendingReasoning,
              },
            ],
          },
        };
        ctx.validationRepo.insert(pod.id, 1, pendingResult);
        ctx.podRepo.update(pod.id, {
          status: 'failed',
          containerId: 'ctr-1',
          worktreePath: '/tmp/worktree/abc',
          taskSummary: { actualSummary: 'Updated the profile UI.', deviations: [] },
          lastValidationResult: {
            podId: pod.id,
            attempt: 2,
            timestamp: new Date().toISOString(),
            smoke: {
              status: 'fail',
              build: { status: 'skip', output: '', duration: 0 },
              health: { status: 'fail', url: '', responseCode: null, duration: 0 },
              pages: [],
            },
            test: { status: 'skip', duration: 0 },
            taskReview: null,
            reviewSkipReason: 'Validation interrupted by user',
            reviewSkipKind: 'upstream-failed',
            overall: 'fail',
            duration: 1000,
            factValidation: { status: 'skip', results: [] },
          },
        });

        await manager.approveFactWaiver(pod.id, 'fact-swift-only', 'Swift is unavailable here');

        const validateConfig = vi.mocked(ctx.validationEngine.validate).mock.calls[0]?.[0];
        expect(validateConfig?.taskSummary?.factDeviations).toEqual([
          expect.objectContaining({
            factId: 'fact-swift-only',
            action: 'waive',
            decision: 'approved_waive',
            whyImpossible: pendingReasoning,
          }),
        ]);
        expect(manager.getSession(pod.id).status).toBe('validated');
      },
    );

    it('records a pending fact waiver during agent rework for the next validation', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      const pendingReasoning =
        'Fact fact-swift-only needs human decision: required fact command `swift` is unavailable in the validation container.';
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        taskSummary: {
          actualSummary: 'Updated the Swift helper.',
          deviations: [],
          factDeviations: [
            {
              factId: 'fact-swift-only',
              action: 'waive',
              reason: 'Swift is unavailable in the validation image',
              whyImpossible: pendingReasoning,
            },
          ],
        },
        lastValidationResult: {
          podId: pod.id,
          attempt: 1,
          timestamp: new Date().toISOString(),
          smoke: {
            status: 'pass',
            build: { status: 'pass', output: '', duration: 100 },
            health: {
              status: 'pass',
              url: 'http://localhost:3000',
              responseCode: 200,
              duration: 50,
            },
            pages: [],
          },
          taskReview: null,
          overall: 'fail',
          duration: 5000,
          factValidation: {
            status: 'pending_human',
            results: [
              {
                factId: 'fact-swift-only',
                proves: ['swift-helper-readable'],
                kind: 'unit-test',
                artifactPath:
                  'packages/desktop/Tests/AutopodUITests/ThroughputTimeInStatusDisplayTests.swift',
                command: 'swift test --filter ThroughputTimeInStatusDisplayTests',
                passed: false,
                status: 'pending_human',
                exitCode: 127,
                reasoning: pendingReasoning,
              },
            ],
          },
        },
      });

      const result = await manager.approveFactWaiver(
        pod.id,
        'fact-swift-only',
        'Swift is unavailable here',
      );

      expect(result).toEqual({ newCommits: false, result: 'fail' });
      expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
      const updated = manager.getSession(pod.id);
      expect(updated.status).toBe('running');
      expect(updated.taskSummary?.factDeviations).toEqual([
        {
          factId: 'fact-swift-only',
          action: 'waive',
          decision: 'approved_waive',
          reason: 'Swift is unavailable here',
          whyImpossible: pendingReasoning,
        },
      ]);
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

    it('keeps ordinary validation failures on correction feedback path', async () => {
      const ctx = createTestContext({
        overall: 'fail',
        smoke: {
          status: 'fail',
          build: { status: 'fail', output: 'TypeScript build failed', duration: 100 },
          health: {
            status: 'skip',
            url: 'http://localhost:3000',
            responseCode: null,
            duration: 0,
          },
          pages: [],
        },
        taskReview: null,
        reviewSkipKind: 'upstream-failed',
        reviewSkipReason: 'Skipped — earlier validation phases failed',
      });
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

      expect(ctx.runtime.resume).toHaveBeenCalledTimes(2);
      expect(ctx.validationEngine.validate).toHaveBeenCalledTimes(3);
      const firstCorrection = vi.mocked(ctx.runtime.resume).mock.calls[0]?.[1];
      expect(firstCorrection).toContain('Build Errors');
      expect(firstCorrection).toContain('TypeScript build failed');
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
        lastValidationResult: makeValidationResult({
          podId: pod.id,
          attempt: 3,
          overall: 'fail',
          taskReview: {
            status: 'fail',
            reasoning: 'Review found actionable issues',
            issues: ['Hardcoded color in overview.css'],
            model: 'gpt-5',
            screenshots: [],
            diff: '+changed',
          },
        }),
      });

      await manager.triggerValidation(pod.id, { force: true });

      const result = manager.getSession(pod.id);
      // Pod should be re-queued for fresh provisioning, not validated in-place
      expect(result.status).toBe('queued');
      expect(result.containerId).toBeNull();
      expect(result.validationAttempts).toBe(0);
      expect(result.failureReason).toBeNull();
      expect(result.recoveryWorktreePath).toBe('/tmp/worktrees/test-branch');
      // claudeSessionId should be cleared so we get a fresh spawn, not a stale resume
      expect(result.claudeSessionId).toBeNull();
      // reworkReason should be set to signal rework (not crash recovery)
      expect(result.reworkReason).toBeTruthy();
      expect(result.reworkReason).toContain('Validation Failed');
      expect(result.reworkReason).toContain('Hardcoded color in overview.css');
      expect(ctx.enqueuedSessions).toContain(pod.id);
      // Old container should be killed
      expect(ctx.containerManager.kill).toHaveBeenCalledWith('ctr-1');
    });

    it('re-queues force rework when sandbox container deletion never resolves', async () => {
      vi.useFakeTimers();
      try {
        const ctx = createTestContext(undefined, {
          executionTarget: 'sandbox',
          warmImageTag: 'registry.azurecr.io/autopod/test-profile:latest',
        });
        const manager = createPodManager(ctx.deps);
        vi.mocked(ctx.containerManager.kill).mockReturnValue(new Promise(() => {}));

        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Add feature' },
          'user-1',
        );
        ctx.podRepo.update(pod.id, {
          status: 'failed',
          containerId: 'sandbox-1',
          worktreePath: '/tmp/worktrees/test-branch',
          validationAttempts: 3,
        });

        let settled = false;
        const rework = manager.triggerValidation(pod.id, { force: true }).then(() => {
          settled = true;
        });

        await vi.advanceTimersByTimeAsync(15_001);
        await Promise.resolve();

        expect(settled).toBe(true);
        await rework;
        expect(manager.getSession(pod.id).status).toBe('queued');
        expect(ctx.enqueuedSessions).toContain(pod.id);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not reuse stale worktree state when force retrying a setup-only failure', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Daily log scan' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'failed',
        containerId: 'ctr-1',
        worktreePath: '/tmp/worktrees/stale-branch',
        completedAt: '2026-06-29T19:30:20.858Z',
        filesChanged: 7,
        linesAdded: 166,
        linesRemoved: 5,
        commitCount: 2,
        lastCommitAt: '2026-06-29T10:17:11+00:00',
        startCommitSha: 'old-start-sha',
      });

      await manager.triggerValidation(pod.id, { force: true });

      const result = manager.getSession(pod.id);
      expect(result.status).toBe('queued');
      expect(result.containerId).toBeNull();
      expect(result.worktreePath).toBeNull();
      expect(result.recoveryWorktreePath).toBeNull();
      expect(result.completedAt).toBeNull();
      expect(result.filesChanged).toBe(0);
      expect(result.linesAdded).toBe(0);
      expect(result.linesRemoved).toBe(0);
      expect(result.commitCount).toBe(0);
      expect(result.lastCommitAt).toBeNull();
      expect(result.startCommitSha).toBeNull();
      expect(ctx.enqueuedSessions).toContain(pod.id);
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

    it('primes durable Pi session and config before reply resume after restart', async () => {
      const ctx = createTestContext(undefined, { defaultRuntime: 'pi' });
      const piRuntime = {
        ...createMockRuntime(),
        type: 'pi' as const,
        setPiSessionId: vi.fn(),
        setPiResumeConfig: vi.fn(),
      };
      ctx.deps.runtimeRegistry = createMockRuntimeRegistry(piRuntime);
      ctx.deps.sessionTokenIssuer = { generate: vi.fn(() => 'pod-token') };
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Do stuff', runtime: 'pi' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'awaiting_input',
        containerId: 'ctr-1',
        piSessionId: 'pi-session-1',
        pendingEscalation: null,
      });

      await manager.sendMessage(pod.id, 'continue please');

      expect(piRuntime.setPiSessionId).toHaveBeenCalledWith(pod.id, 'pi-session-1');
      expect(piRuntime.setPiResumeConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          podId: pod.id,
          containerId: 'ctr-1',
          customInstructions: 'resume',
          mcpServers: expect.arrayContaining([
            expect.objectContaining({
              type: 'http',
              name: 'escalation',
              headers: { Authorization: 'Bearer pod-token' },
            }),
          ]),
        }),
      );
      expect(piRuntime.resume).toHaveBeenCalledWith(pod.id, 'continue please', 'ctr-1', undefined);
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
        expect(pod.baseBranch).toBe('main');
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

      it('runs git clean -fd in /workspace during provisioning to strip image-baked untracked files', async () => {
        // Regression: the warm Docker image is built with `git clone --depth 1` of the
        // base branch at image-build time, then runs pre-warm install + build, then
        // strips /workspace/.git. Source files from that older clone stay in /workspace.
        // The pod-start worktree mirror is additive (never deletes), so any file dropped
        // from the branch since image-build survives as an untracked file. Workspace pods
        // then commit those stale files via syncWorkspaceBack +
        // `git add -A`, contaminating the branch. `git clean -fd` after `git restore .`
        // is the upstream guard.
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

        const cleanCalls = ctx.containerManager.execInContainer.mock.calls.filter(
          ([, cmd]) =>
            Array.isArray(cmd) && cmd[0] === 'git' && cmd.includes('clean') && cmd.includes('-fd'),
        );
        expect(cleanCalls.length).toBeGreaterThanOrEqual(1);
        // Must run inside /workspace (the container's overlayfs copy), not /mnt/worktree.
        expect(cleanCalls[0]?.[1]).toEqual(['git', '-C', '/workspace', 'clean', '-fd']);
        // Must NOT include `-x` — gitignored caches (node_modules, bin/, obj/, dist/)
        // are required for subsequent build phases to keep their incremental state.
        expect(cleanCalls[0]?.[1]).not.toContain('-x');
        expect(cleanCalls[0]?.[1]).not.toContain('-fdx');
      });

      it('populates /workspace without copying host dependency or tooling caches', async () => {
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

        const populateCall = ctx.containerManager.execInContainer.mock.calls.find(([, cmd]) => {
          if (!Array.isArray(cmd) || cmd[0] !== 'sh' || cmd[1] !== '-c') return false;
          return String(cmd[2]).includes("cd '/mnt/worktree'");
        });
        expect(populateCall).toBeDefined();
        const script = String(populateCall?.[1][2]);
        expect(script).not.toContain("-name '.git'");
        expect(script).toContain("-name 'node_modules'");
        expect(script).toContain("-name '.serena'");
        expect(script).toContain("-name '.roslyn-codelens'");
        expect(script).toContain('-prune -o');
        expect(script).toContain('target=$1\nshift\nfor rel do\n');
        expect(script).not.toContain('for rel do;');
        expect(script).not.toContain('then;');
        expect(script).not.toContain('else;');
      });
    });

    describe('handoff persistence', () => {
      function createRunningWorkspace(ctx: TestContext) {
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
          containerId: 'ctr-workspace',
          worktreePath: '/tmp/worktree/abc',
          startedAt: new Date().toISOString(),
        });
        return { manager, pod };
      }

      it('blocks handoff when workspace sync fails and preserves the interactive container', async () => {
        const ctx = createTestContext({ overall: 'pass' });
        const { manager, pod } = createRunningWorkspace(ctx);
        await manager.promoteToAuto(pod.id, 'pr', { skipAgent: true });
        vi.mocked(ctx.containerManager.execInContainer).mockRejectedValue(
          new Error('docker exec failed'),
        );
        vi.mocked(ctx.containerManager.extractDirectoryFromContainer).mockRejectedValue(
          new Error('archive fallback failed'),
        );

        await manager.processPod(pod.id);

        const result = manager.getSession(pod.id);
        expect(result.status).toBe('failed');
        expect(result.containerId).toBe('ctr-workspace');
        expect(result.worktreePath).toBe('/tmp/worktree/abc');
        expect(result.options.agentMode).toBe('interactive');
        expect(result.skipAgent).toBe(false);
        expect(result.lastCorrectionMessage).toContain('Workspace handoff failed');
        expect(ctx.containerManager.stop).not.toHaveBeenCalled();
        expect(ctx.worktreeManager.commitPendingChanges).not.toHaveBeenCalled();
        expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
        expect(ctx.prManager.createPr).not.toHaveBeenCalled();
      });

      it('blocks handoff when auto-committing the synced workspace fails', async () => {
        const ctx = createTestContext({ overall: 'pass' });
        const { manager, pod } = createRunningWorkspace(ctx);
        await manager.promoteToAuto(pod.id, 'pr', { skipAgent: true });
        vi.mocked(ctx.worktreeManager.commitPendingChanges).mockRejectedValueOnce(
          new Error('pre-commit failed'),
        );

        await manager.processPod(pod.id);

        const result = manager.getSession(pod.id);
        expect(result.status).toBe('failed');
        expect(result.containerId).toBe('ctr-workspace');
        expect(result.options.agentMode).toBe('interactive');
        expect(ctx.containerManager.stop).not.toHaveBeenCalled();
        expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
        expect(ctx.prManager.createPr).not.toHaveBeenCalled();
      });

      it('blocks submit-as-is handoff when no committed workspace changes are found', async () => {
        const ctx = createTestContext({ overall: 'pass' });
        const { manager, pod } = createRunningWorkspace(ctx);
        await manager.promoteToAuto(pod.id, 'pr', { skipAgent: true });
        vi.mocked(ctx.worktreeManager.commitPendingChanges).mockResolvedValueOnce(false);
        vi.mocked(ctx.worktreeManager.getDiffStats).mockResolvedValueOnce({
          filesChanged: 0,
          linesAdded: 0,
          linesRemoved: 0,
        });

        await manager.processPod(pod.id);

        const result = manager.getSession(pod.id);
        expect(result.status).toBe('failed');
        expect(result.lastCorrectionMessage).toContain('no committed workspace changes');
        expect(result.containerId).toBe('ctr-workspace');
        expect(ctx.containerManager.stop).not.toHaveBeenCalled();
        expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
        expect(ctx.prManager.createPr).not.toHaveBeenCalled();
      });

      function createRunningWorkspaceWithHandoff(ctx: TestContext, handoff: string) {
        const manager = createPodManager(ctx.deps);
        const pod = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'Workspace pod',
            outputMode: 'workspace',
            handoffInstructions: handoff,
          },
          'user-1',
        );
        ctx.podRepo.update(pod.id, {
          status: 'running',
          containerId: 'ctr-workspace',
          worktreePath: '/tmp/worktree/abc',
          startedAt: new Date().toISOString(),
        });
        return { manager, pod };
      }

      it('reuses the creation-time handoff when promotion supplies no instructions', async () => {
        const ctx = createTestContext({ overall: 'pass' });
        const { manager, pod } = createRunningWorkspaceWithHandoff(ctx, 'INITIAL PI HANDOFF');

        await manager.promoteToAuto(pod.id, 'pr');

        expect(manager.getSession(pod.id).handoffInstructions).toBe('INITIAL PI HANDOFF');
      });

      it('replaces the creation-time handoff with an explicit promotion-time correction', async () => {
        const ctx = createTestContext({ overall: 'pass' });
        const { manager, pod } = createRunningWorkspaceWithHandoff(ctx, 'INITIAL PI HANDOFF');

        await manager.promoteToAuto(pod.id, 'pr', { instructions: 'PROMOTION CORRECTION' });

        // Deterministic replacement rule — no concatenation, no duplication.
        expect(manager.getSession(pod.id).handoffInstructions).toBe('PROMOTION CORRECTION');
      });

      it('composes handoffContext from the persisted handoff with distinct, labeled sections and keeps the branch', async () => {
        const ctx = createTestContext({ overall: 'pass' });
        const { manager, pod } = createRunningWorkspaceWithHandoff(ctx, 'INITIAL PI HANDOFF');
        const originalBranch = manager.getSession(pod.id).branch;
        // A committed delta so the handoff isn't blocked as "no changes".
        vi.mocked(ctx.worktreeManager.commitPendingChanges).mockResolvedValue(true);

        await manager.promoteToAuto(pod.id, 'pr');
        await manager.processPod(pod.id);

        const result = manager.getSession(pod.id);
        expect(result.branch).toBe(originalBranch);
        expect(result.handoffContext).toContain('### Handoff instructions');
        expect(result.handoffContext).toContain('INITIAL PI HANDOFF');
        expect(result.handoffContext).toContain('### Session summary');
      });

      it('submit-as-is opens a PR after validation but does not auto-merge', async () => {
        const ctx = createTestContext({ overall: 'pass' });
        const { manager, pod } = createRunningWorkspace(ctx);
        ctx.podRepo.update(pod.id, { autoApprove: true });

        await manager.promoteToAuto(pod.id, 'pr', { skipAgent: true });
        expect(manager.getSession(pod.id).autoApprove).toBe(false);

        await manager.processPod(pod.id);

        const result = manager.getSession(pod.id);
        expect(result.status).toBe('validated');
        expect(result.prUrl).toBe('https://github.com/org/repo/pull/42');
        expect(ctx.prManager.createPr).toHaveBeenCalled();
        expect(ctx.prManager.mergePr).not.toHaveBeenCalled();
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

    it('falls back to profile default branch when stored baseBranch equals feature branch', async () => {
      const ctx = createTestContext();
      const { manager, pod } = await setupCompletePodForRetry(ctx);
      ctx.podRepo.update(pod.id, { baseBranch: pod.branch });

      await manager.retryCreatePr(pod.id);

      expect(ctx.prManager.createPr).toHaveBeenCalledWith(
        expect.objectContaining({
          branch: pod.branch,
          baseBranch: 'main',
        }),
      );
    });
  });

  describe('spawnFixSession / requestFixSession — queue-driven fix pods', () => {
    /** Create a root pod and drive it to `merge_pending` with a PR. */
    function mergePendingRoot(ctx: TestContext, manager: ReturnType<typeof createPodManager>) {
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Original work' },
        'user-1',
      );
      for (const status of [
        'provisioning',
        'running',
        'validating',
        'validated',
        'approved',
        'merging',
        'merge_pending',
      ] as const) {
        ctx.podRepo.update(pod.id, { status });
      }
      ctx.podRepo.update(pod.id, {
        prUrl: 'https://github.com/org/repo/pull/42',
        worktreePath: '/tmp/worktree/abc',
      });
      return manager.getSession(pod.id);
    }

    it('spawns the canonical fix pod and enqueues the feedback message', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const root = mergePendingRoot(ctx, manager);

      await manager.spawnFixSession(root.id, 'please use option B');

      const fixPod = ctx.podRepo.list({}).find((p) => p.linkedPodId === root.id);
      expect(fixPod, 'a fix pod should be created').toBeDefined();
      expect(fixPod?.status).toBe('queued');
      // Task is a placeholder — the real task is built from the drained queue
      // when the fix pod transitions to `running`.
      expect(fixPod?.task).toBe('[PR FIX] Awaiting queued feedback.');
      expect(ctx.enqueuedSessions).toContain(fixPod?.id);

      // The message sits in the parent-keyed queue, not on the pod row.
      expect(ctx.fixFeedbackRepo.count(root.id)).toBe(1);
      expect(ctx.fixFeedbackRepo.peek(root.id)[0]?.message).toBe('please use option B');

      // Audit trail attaches to the parent.
      const reread = manager.getSession(root.id);
      expect(reread.fixPodId).toBe(fixPod?.id);
      expect(reread.prFixAttempts).toBe(1);
    });

    it('does not spawn a second fix pod while one is alive — just queues the message', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const root = mergePendingRoot(ctx, manager);

      await manager.spawnFixSession(root.id, 'first message');
      await manager.spawnFixSession(root.id, 'second message');
      await manager.spawnFixSession(root.id, 'third message');

      const fixPods = ctx.podRepo.list({}).filter((p) => p.linkedPodId === root.id);
      expect(fixPods, 'exactly one canonical fix pod').toHaveLength(1);
      expect(ctx.fixFeedbackRepo.count(root.id)).toBe(3);
      // prFixAttempts only bumps on the spawn, not on subsequent queue appends.
      expect(manager.getSession(root.id).prFixAttempts).toBe(1);
    });

    it('recycles a terminal fix pod via complete → queued instead of spawning a new child', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const root = mergePendingRoot(ctx, manager);

      await manager.spawnFixSession(root.id, 'round one');
      const firstFix = ctx.podRepo.list({}).find((p) => p.linkedPodId === root.id);
      expect(firstFix).toBeDefined();
      if (!firstFix) throw new Error('fix pod missing');

      // Drain the queue (as processPod would) and drive the fix pod terminal.
      ctx.fixFeedbackRepo.drain(root.id);
      ctx.podRepo.update(firstFix.id, { status: 'complete' });

      await manager.spawnFixSession(root.id, 'round two');

      const fixPods = ctx.podRepo.list({}).filter((p) => p.linkedPodId === root.id);
      expect(fixPods, 'same row recycled — still one fix pod').toHaveLength(1);
      const recycled = fixPods[0];
      expect(recycled?.id).toBe(firstFix.id);
      expect(recycled?.status).toBe('queued');
      expect(recycled?.fixIteration).toBe(1);
      expect(ctx.fixFeedbackRepo.count(root.id)).toBe(1);
      expect(manager.getSession(root.id).prFixAttempts).toBe(2);
    });

    it('recycled fix pod shows parent attempt in task and startup marker', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const root = mergePendingRoot(ctx, manager);

      await manager.spawnFixSession(root.id, 'round one');
      const firstFix = ctx.podRepo.list({}).find((p) => p.linkedPodId === root.id);
      if (!firstFix) throw new Error('fix pod missing');
      ctx.fixFeedbackRepo.drain(root.id);
      ctx.podRepo.update(firstFix.id, { status: 'complete' });

      await manager.spawnFixSession(root.id, 'round two');
      const recycled = ctx.podRepo.getOrThrow(firstFix.id);
      expect(recycled.fixIteration).toBe(1);
      expect(manager.getSession(root.id).prFixAttempts).toBe(2);

      await manager.processPod(recycled.id);

      const processedFix = manager.getSession(recycled.id);
      expect(processedFix.task).toContain('needs fixes (attempt 2, iteration 1)');
      const markerMessages = ctx.eventRepo
        .getForSession(recycled.id, { type: 'pod.agent_activity' })
        .map((event) => {
          const payload = event.payload as { event?: { message?: unknown } };
          return payload.event?.message;
        })
        .filter((message): message is string => typeof message === 'string');
      expect(markerMessages).toContain('Starting fix iteration 1, parent attempt 2/3');
    });

    it('recycles a merge_pending fix pod whose pushed fix did not unblock the PR', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const root = mergePendingRoot(ctx, manager);

      await manager.spawnFixSession(root.id, 'round one');
      const firstFix = ctx.podRepo.list({}).find((p) => p.linkedPodId === root.id);
      if (!firstFix) throw new Error('fix pod missing');

      // Fix pod ran, drained the queue, pushed its fix, and is now sitting in
      // merge_pending waiting for the PR to merge — but the PR is still
      // failing CI, so a new feedback summary lands and triggers recycling.
      ctx.fixFeedbackRepo.drain(root.id);
      ctx.podRepo.update(firstFix.id, { status: 'merge_pending' });

      await manager.spawnFixSession(root.id, 'round two — still broken');

      const fixPods = ctx.podRepo.list({}).filter((p) => p.linkedPodId === root.id);
      expect(fixPods, 'same row recycled — no second fix pod row').toHaveLength(1);
      const recycled = fixPods[0];
      expect(recycled?.id).toBe(firstFix.id);
      expect(recycled?.status).toBe('queued');
      expect(recycled?.fixIteration).toBe(1);
      expect(ctx.fixFeedbackRepo.count(root.id)).toBe(1);
      expect(manager.getSession(root.id).prFixAttempts).toBe(2);
    });

    it('does not recycle a fix pod parked after validated delivery failed', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const root = mergePendingRoot(ctx, manager);

      await manager.spawnFixSession(root.id, 'round one');
      const firstFix = ctx.podRepo.list({}).find((p) => p.linkedPodId === root.id);
      if (!firstFix) throw new Error('fix pod missing');

      ctx.fixFeedbackRepo.drain(root.id);
      ctx.podRepo.update(firstFix.id, {
        status: 'awaiting_input',
        mergeBlockReason: 'Validated fix could not be pushed: ssh: connection refused',
      });

      await manager.spawnFixSession(root.id, 'round two — same stale PR feedback');

      const fixPods = ctx.podRepo.list({}).filter((p) => p.linkedPodId === root.id);
      expect(fixPods, 'same parked fix pod — no second row').toHaveLength(1);
      expect(fixPods[0]?.id).toBe(firstFix.id);
      expect(fixPods[0]?.status).toBe('awaiting_input');
      expect(fixPods[0]?.fixIteration).toBe(0);
      expect(ctx.fixFeedbackRepo.count(root.id)).toBe(1);
      expect(manager.getSession(root.id).prFixAttempts).toBe(1);
      expect(ctx.enqueuedSessions.filter((id) => id === firstFix.id)).toHaveLength(1);
    });

    it('parks a validated fix pod when its final branch push fails', async () => {
      const ctx = createTestContext({ overall: 'pass' });
      const manager = createPodManager(ctx.deps);
      const root = mergePendingRoot(ctx, manager);

      await manager.spawnFixSession(root.id, 'round one');
      const fixPod = ctx.podRepo.list({}).find((p) => p.linkedPodId === root.id);
      if (!fixPod) throw new Error('fix pod missing');

      ctx.fixFeedbackRepo.drain(root.id);
      ctx.podRepo.update(fixPod.id, {
        status: 'running',
        containerId: 'ctr-fix',
        worktreePath: '/tmp/worktree/abc',
        prUrl: root.prUrl,
        branch: root.branch,
        baseBranch: 'main',
      });
      (ctx.worktreeManager.pushBranch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('ssh: connection refused'),
      );
      const events: unknown[] = [];
      ctx.eventBus.subscribe((event) => events.push(event));

      await manager.triggerValidation(fixPod.id);

      const refreshed = manager.getSession(fixPod.id);
      expect(refreshed.status).toBe('awaiting_input');
      expect(refreshed.mergeBlockReason).toBe(
        'Validated fix could not be pushed: ssh: connection refused',
      );
      expect(ctx.worktreeManager.pushBranch).toHaveBeenCalled();
      expect(ctx.prManager.mergePr).not.toHaveBeenCalled();
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: 'pod.completed', podId: fixPod.id }),
      );
      const messages = events.flatMap((event) => {
        if (typeof event !== 'object' || event === null) return [];
        const maybeActivity = event as {
          type?: string;
          podId?: string;
          event?: { type?: string; message?: string };
        };
        if (
          maybeActivity.type === 'pod.agent_activity' &&
          maybeActivity.podId === fixPod.id &&
          maybeActivity.event?.type === 'status' &&
          maybeActivity.event.message
        ) {
          return [maybeActivity.event.message];
        }
        return [];
      });
      expect(messages).toContain(
        'Fix branch push failed — awaiting operator retry; no AI retry started: ssh: connection refused',
      );
      expect(messages).not.toContain('Fix pod complete — parent poller owns the merge');
    });

    it('fails the parent via requestFixSession when max PR fix attempts are exhausted', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const root = mergePendingRoot(ctx, manager);
      // requestFixSession (the API path) does not bump the cap — unlike the
      // operator-driven spawnFixSession — so the cap guard actually fires.
      ctx.podRepo.update(root.id, { maxPrFixAttempts: 1, prFixAttempts: 1 });

      const result = await manager.requestFixSession(root.id, 'one more please');

      expect(result).toEqual({ ok: false, reason: 'parent_terminal' });
      expect(manager.getSession(root.id).status).toBe('failed');
      expect(ctx.podRepo.list({}).some((p) => p.linkedPodId === root.id)).toBe(false);
    });

    it('requestFixSession returns a structured queue state for the API', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const root = mergePendingRoot(ctx, manager);

      const first = await manager.requestFixSession(root.id, 'fix the lint');
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.queued).toBe(true);
        expect(first.queueLength).toBe(1);
        expect(first.fixPodId).toBeTypeOf('string');
      }

      const second = await manager.requestFixSession(root.id, 'and the types');
      expect(second).toMatchObject({ ok: true, queued: true, queueLength: 2 });
      if (first.ok && second.ok) {
        expect(second.fixPodId).toBe(first.fixPodId);
      }
    });

    it('requestFixSession reports parent_terminal for a complete parent', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const root = mergePendingRoot(ctx, manager);
      ctx.podRepo.update(root.id, { status: 'complete' });

      const result = await manager.requestFixSession(root.id, 'too late');
      expect(result).toEqual({ ok: false, reason: 'parent_terminal' });
      // Nothing queued, no fix pod spawned.
      expect(ctx.fixFeedbackRepo.count(root.id)).toBe(0);
      expect(ctx.podRepo.list({}).some((p) => p.linkedPodId === root.id)).toBe(false);
    });

    it('spawnFixSession rejects a terminal parent with 409', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const root = mergePendingRoot(ctx, manager);
      ctx.podRepo.update(root.id, { status: 'complete' });

      await expect(manager.spawnFixSession(root.id)).rejects.toMatchObject({
        statusCode: 409,
      });
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
        'merge_pending',
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
        'merge_pending',
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
      const messages = ctx.eventRepo
        .getForSession(pod.id, { type: 'pod.agent_activity' })
        .map((event) => {
          const payload = event.payload as { event?: { message?: unknown } };
          return payload.event?.message;
        });
      expect(messages).toContain('Branch push failed: ssh: connection refused');
    });

    it('parks as failed on DeletionGuardError instead of validating compromised work', async () => {
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
      expect(result.status).toBe('failed');
      expect(ctx.prManager.createPr).not.toHaveBeenCalled();
    });

    it('fails validation before review when protected operational files changed out of scope', async () => {
      const ctx = createTestContext({ overall: 'pass' });
      (ctx.worktreeManager.getDiff as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        'diff --git a/.husky/pre-commit b/.husky/pre-commit\n' +
          '--- a/.husky/pre-commit\n' +
          '+++ b/.husky/pre-commit\n' +
          '@@ -1 +1 @@\n' +
          '-old\n' +
          '+new\n',
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
      expect(result.status).toBe('failed');
      expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
    });

    it('stops worker completion before validation when auto-commit hits the deletion guard', async () => {
      const ctx = createTestContext({ overall: 'pass' });
      (
        ctx.worktreeManager.commitPendingChangesWithGeneratedMessage as ReturnType<typeof vi.fn>
      ).mockRejectedValueOnce(new DeletionGuardError(1405, 0));

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
      (ctx.containerManager.getStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce('stopped');

      await manager.handleCompletion(pod.id);

      const result = manager.getSession(pod.id);
      expect(result.worktreeCompromised).toBe(true);
      expect(result.status).toBe('failed');
      expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
    });

    it('recovers from live container when workspace sync fails before auto-commit', async () => {
      const ctx = createTestContext({ overall: 'pass' });
      (ctx.containerManager.execInContainer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('docker exec failed'),
      );
      (
        ctx.containerManager.extractDirectoryFromContainer as ReturnType<typeof vi.fn>
      ).mockRejectedValueOnce(new Error('archive fallback failed'));

      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Add feature' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        worktreePath: '/tmp/wt',
        worktreeCompromised: true,
      });

      await manager.handleCompletion(pod.id);

      const result = manager.getSession(pod.id);
      expect(result.worktreeCompromised).toBe(false);
      expect(result.status).toBe('validated');
      expect(ctx.worktreeManager.commitPendingChangesWithGeneratedMessage).toHaveBeenCalledWith(
        '/tmp/wt',
        'Add feature',
        expect.any(Object),
        'opus',
        { maxDeletions: 100 },
      );
      expect(ctx.validationEngine.validate).toHaveBeenCalled();
      expect(ctx.containerManager.extractDirectoryFromContainer).toHaveBeenCalledTimes(2);
      expect(ctx.containerManager.extractDirectoryFromContainer).toHaveBeenCalledWith(
        'ctr-1',
        '/workspace',
        '/tmp/wt',
        expect.arrayContaining(['.git', 'node_modules']),
      );
    });

    it('syncs workspace back without mirroring container dependency or tooling caches', async () => {
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

      await manager.handleCompletion(pod.id);

      const syncCall = ctx.containerManager.execInContainer.mock.calls.find(([, cmd]) => {
        if (!Array.isArray(cmd) || cmd[0] !== 'sh' || cmd[1] !== '-c') return false;
        return String(cmd[2]).includes('STAGING="/mnt/worktree/.autopod-sync-');
      });
      expect(syncCall).toBeDefined();
      const script = String(syncCall?.[1][2]);
      expect(script).toContain("-name '.git'");
      expect(script).toContain("-name 'node_modules'");
      expect(script).toContain("-name '.serena'");
      expect(script).toContain("-name '.roslyn-codelens'");
      expect(script).toContain("! -path '*/.git'");
      expect(script).toContain("! -path '*/.git/*'");
      expect(script).toContain("! -path '*/node_modules'");
      expect(script).toContain("! -path '*/node_modules/*'");
      expect(script).toContain("! -path '*/.serena'");
      expect(script).toContain("! -path '*/.roslyn-codelens/*'");
      expect(script).toContain('target=$1\nshift\nfor rel do\n');
      expect(script).not.toContain('for rel do;');
      expect(script).not.toContain('then;');
      expect(script).not.toContain('else;');
      expect(ctx.containerManager.extractDirectoryFromContainer).not.toHaveBeenCalled();
    });

    it('uses sandbox extraction for sync-back instead of the uploaded /mnt/worktree snapshot', async () => {
      const ctx = createTestContext(
        { overall: 'pass' },
        {
          executionTarget: 'sandbox',
          warmImageTag: 'example.azurecr.io/autopod/test-profile:latest',
        },
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

      await manager.handleCompletion(pod.id);

      const syncScriptCall = ctx.containerManager.execInContainer.mock.calls.find(([, cmd]) => {
        if (!Array.isArray(cmd) || cmd[0] !== 'sh' || cmd[1] !== '-c') return false;
        return String(cmd[2]).includes('/mnt/worktree/.autopod-sync-');
      });
      expect(syncScriptCall).toBeUndefined();
      expect(ctx.containerManager.extractDirectoryFromContainer).toHaveBeenCalledWith(
        'ctr-1',
        '/workspace',
        '/tmp/wt',
        expect.arrayContaining(['.git', 'node_modules']),
      );
      expect(ctx.containerManager.extractDirectoryFromContainer).toHaveBeenCalledWith(
        'ctr-1',
        '/workspace/.git',
        expect.stringContaining('autopod-git-'),
      );
    });

    it('starts a daemon host-port preview proxy for sandbox pods', async () => {
      const ctx = createTestContext(undefined, {
        executionTarget: 'sandbox',
        warmImageTag: 'example.azurecr.io/autopod/test-profile:latest',
      });
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Preview sandbox' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        previewUrl: null,
      });

      ctx.containerManager.execInContainer = vi.fn(async (_containerId, command) => {
        if (command[0] === 'node') {
          return {
            stdout: JSON.stringify({
              statusCode: 200,
              statusMessage: 'OK',
              headers: { 'content-type': 'text/plain; charset=utf-8' },
              bodyBase64: Buffer.from('sandbox preview ok').toString('base64'),
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        const script = command[2] ?? '';
        if (String(script).includes('autopod-supervisor.pid')) {
          return { stdout: '123\n', stderr: '', exitCode: 0 };
        }
        if (String(script).includes('kill -0 123')) {
          return { stdout: '1\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      const { previewUrl } = await manager.startPreview(pod.id);
      expect(previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const response = await fetch(previewUrl);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('sandbox preview ok');

      await expect(manager.previewStatus(pod.id)).resolves.toMatchObject({
        running: true,
        reachable: true,
        restartCount: 0,
        lastError: null,
        previewUrl,
      });

      await manager.stopPreview(pod.id);
      expect(ctx.containerManager.stop).toHaveBeenCalledWith('ctr-1');
    });

    it('refreshes the host linked-worktree index after promoting container commits', async () => {
      const ctx = createTestContext({ overall: 'pass' });
      const oldSha = '1111111111111111111111111111111111111111';
      const bareRepoPath = '/tmp/bare/repo.git';
      const resetCalls: unknown[][] = [];

      mockedExecFile.mockImplementation((...args: unknown[]) => {
        const gitArgs = args[1] as string[];
        const callback = args[args.length - 1] as (
          err: Error | null,
          result: { stdout: string; stderr: string },
        ) => void;
        if (gitArgs[0] === 'rev-parse' && gitArgs[1] === '--git-common-dir') {
          callback(null, { stdout: bareRepoPath, stderr: '' });
        } else if (gitArgs[0] === '--git-dir' && gitArgs[2] === 'rev-parse') {
          callback(null, { stdout: `${oldSha}\n`, stderr: '' });
        } else if (gitArgs[0] === 'reset') {
          resetCalls.push(args);
          callback(null, { stdout: '', stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return undefined as never;
      });

      (ctx.containerManager.execInContainer as ReturnType<typeof vi.fn>).mockImplementation(
        async (_containerId: string, cmd: string[]) => {
          const command = cmd.join(' ');
          if (command.includes('/workspace/.git/objects/info/alternates')) {
            return { stdout: `${bareRepoPath}\n`, stderr: '', exitCode: 0 };
          }
          if (command.includes('rev-parse --abbrev-ref HEAD')) {
            return { stdout: 'feature/test\n', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
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

      await manager.handleCompletion(pod.id);

      expect(ctx.containerManager.execInContainer).toHaveBeenCalledWith(
        'ctr-1',
        ['git', 'config', '--global', '--add', 'safe.directory', '/workspace'],
        { timeout: 5_000 },
      );
      expect(ctx.containerManager.execInContainer).toHaveBeenCalledWith(
        'ctr-1',
        ['git', 'config', '--global', '--add', 'safe.directory', bareRepoPath],
        { timeout: 5_000 },
      );
      expect(ctx.containerManager.execInContainer).toHaveBeenCalledWith(
        'ctr-1',
        [
          'git',
          '-c',
          'safe.directory=/workspace',
          '-c',
          `safe.directory=${bareRepoPath}`,
          '-C',
          '/workspace',
          'rev-parse',
          '--abbrev-ref',
          'HEAD',
        ],
        expect.objectContaining({ timeout: 30_000 }),
      );
      expect(resetCalls).toContainEqual([
        'git',
        ['reset', '--mixed', 'HEAD'],
        { cwd: '/tmp/wt' },
        expect.any(Function),
      ]);
      expect(manager.getSession(pod.id).worktreeCompromised).toBe(false);
    });

    it('stops worker completion before auto-commit when workspace sync fails', async () => {
      const ctx = createTestContext({ overall: 'pass' });
      (ctx.containerManager.execInContainer as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('docker exec failed'),
      );
      (
        ctx.containerManager.extractDirectoryFromContainer as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error('archive fallback failed'));

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

      await manager.handleCompletion(pod.id);

      const result = manager.getSession(pod.id);
      expect(result.worktreeCompromised).toBe(true);
      expect(result.status).toBe('failed');
      expect(ctx.worktreeManager.commitPendingChangesWithGeneratedMessage).not.toHaveBeenCalled();
      expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
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

    function setupParkedFixDeliveryFailure(
      ctx: TestContext,
      status: 'awaiting_input' | 'failed' = 'awaiting_input',
    ) {
      const manager = createPodManager(ctx.deps);
      const parent = manager.createSession(
        { profileName: 'test-profile', task: 'Original work' },
        'user-1',
      );
      ctx.podRepo.update(parent.id, {
        status: 'merge_pending',
        prUrl: 'https://github.com/org/repo/pull/42',
        worktreePath: '/tmp/worktree/parent',
      });
      const fix = manager.createSession(
        { profileName: 'test-profile', task: '[PR FIX] Address review feedback' },
        'user-1',
      );
      ctx.podRepo.update(fix.id, {
        status,
        linkedPodId: parent.id,
        branch: parent.branch,
        prUrl: parent.prUrl,
        worktreePath: '/tmp/worktree/fix',
        lastValidationResult: makeValidationResult({ podId: fix.id }),
        mergeBlockReason: 'Validated fix could not be pushed: ssh: stale info',
      });
      ctx.podRepo.update(parent.id, { fixPodId: fix.id });
      return { manager, parent, fix };
    }

    it('retries delivery for a validated fix pod parked in awaiting_input', async () => {
      const ctx = createTestContext(undefined, { githubPat: 'test-pat' });
      const { manager, fix } = setupParkedFixDeliveryFailure(ctx);

      const result = await manager.resumePod(fix.id);

      expect(result).toEqual({ action: 'retry-fix-delivery' });
      expect(ctx.worktreeManager.pullBranch).toHaveBeenCalledWith(
        '/tmp/worktree/fix',
        'daemon-gh-token',
      );
      expect(ctx.worktreeManager.rebaseOntoBase).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: '/tmp/worktree/fix',
          baseBranch: 'main',
        }),
      );
      expect(ctx.worktreeManager.pushBranch).toHaveBeenCalledWith(
        '/tmp/worktree/fix',
        fix.branch,
        expect.objectContaining({ force: true }),
      );
      const refreshed = manager.getSession(fix.id);
      expect(refreshed.status).toBe('complete');
      expect(refreshed.mergeBlockReason).toBeNull();
    });

    it('retries delivery for an already-failed fix pod with the delivery marker', async () => {
      const ctx = createTestContext();
      const { manager, fix } = setupParkedFixDeliveryFailure(ctx, 'failed');

      const result = await manager.resumePod(fix.id);

      expect(result).toEqual({ action: 'retry-fix-delivery' });
      expect(ctx.worktreeManager.pushBranch).toHaveBeenCalled();
      expect(manager.getSession(fix.id).status).toBe('complete');
    });

    it('parks without pushing when the remote fix branch has diverged', async () => {
      const ctx = createTestContext();
      const { manager, fix } = setupParkedFixDeliveryFailure(ctx);
      (ctx.worktreeManager.pullBranch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Not possible to fast-forward'),
      );

      const result = await manager.resumePod(fix.id);

      expect(result).toEqual({ action: 'retry-fix-delivery' });
      expect(ctx.worktreeManager.rebaseOntoBase).not.toHaveBeenCalled();
      expect(ctx.worktreeManager.pushBranch).not.toHaveBeenCalled();
      const refreshed = manager.getSession(fix.id);
      expect(refreshed.status).toBe('awaiting_input');
      expect(refreshed.mergeBlockReason).toBe(
        'Validated fix could not be pushed: Not possible to fast-forward',
      );
    });

    it('re-parks a validated fix pod when retry delivery fails again', async () => {
      const ctx = createTestContext();
      const { manager, fix } = setupParkedFixDeliveryFailure(ctx);
      (ctx.worktreeManager.pushBranch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('stale info'),
      );

      const result = await manager.resumePod(fix.id);

      expect(result).toEqual({ action: 'retry-fix-delivery' });
      const refreshed = manager.getSession(fix.id);
      expect(refreshed.status).toBe('awaiting_input');
      expect(refreshed.mergeBlockReason).toBe('Validated fix could not be pushed: stale info');
    });

    it('does not let ordinary awaiting_input pods use resume', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Needs human answer' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'awaiting_input',
        worktreePath: '/tmp/worktree/abc',
      });

      await expect(manager.resumePod(pod.id)).rejects.toMatchObject({
        code: 'INVALID_STATE',
        statusCode: 409,
      });
    });

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

    it('Path 2: missing container during forced revalidation requeues validation-only', async () => {
      const ctx = createTestContext();
      const { manager, pod } = setupFailedPod(ctx, {
        validationOverall: 'fail',
        containerId: 'container-missing',
      });
      vi.mocked(ctx.containerManager.start).mockRejectedValueOnce(
        Object.assign(new Error('No such container'), { statusCode: 404 }),
      );

      const result = await manager.revalidateSession(pod.id, { force: true });

      expect(result).toEqual({ newCommits: false, result: 'fail' });
      const refreshed = manager.getSession(pod.id);
      expect(refreshed.status).toBe('queued');
      expect(refreshed.skipAgent).toBe(true);
      expect(refreshed.containerId).toBeNull();
      expect(refreshed.recoveryWorktreePath).toBe('/tmp/worktree/abc');
      expect(refreshed.validationAttempts).toBe(0);
      expect(refreshed.lastValidationResult).toBeNull();
      expect(ctx.enqueuedSessions).toEqual([pod.id, pod.id]);
      expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
      expect(ctx.runtime.spawn).not.toHaveBeenCalled();
      expect(ctx.runtime.resume).not.toHaveBeenCalled();
    });

    it('Path 2: forced revalidation syncs container workspace before host-side validation', async () => {
      const ctx = createTestContext();
      const { manager, pod } = setupFailedPod(ctx, {
        validationOverall: 'fail',
        prUrl: null,
      });

      const result = await manager.revalidateSession(pod.id, { force: true });

      expect(result).toEqual({ newCommits: false, result: 'pass' });
      const syncCall = ctx.containerManager.execInContainer.mock.calls.find(([, cmd]) => {
        if (!Array.isArray(cmd) || cmd[0] !== 'sh' || cmd[1] !== '-c') return false;
        return String(cmd[2]).includes('/mnt/worktree');
      });
      expect(syncCall).toBeDefined();
      const syncOrder = ctx.containerManager.execInContainer.mock.invocationCallOrder.find(
        (_order, index) => ctx.containerManager.execInContainer.mock.calls[index] === syncCall,
      );
      const validateOrder = ctx.validationEngine.validate.mock.invocationCallOrder[0];
      expect(syncOrder).toBeDefined();
      expect(validateOrder).toBeDefined();
      expect(syncOrder).toBeLessThan(validateOrder as number);
    });

    it('Path 2: retries review infrastructure failures during forced revalidation', async () => {
      const ctx = createTestContext();
      ctx.deps.reviewInfrastructureRetryBackoffMs = [0];
      vi.mocked(ctx.validationEngine.validate)
        .mockResolvedValueOnce(makeReviewInfraFailure())
        .mockResolvedValueOnce(makeValidationResult());
      const { manager, pod } = setupFailedPod(ctx, {
        validationOverall: 'fail',
        prUrl: null,
      });

      const result = await manager.revalidateSession(pod.id, { force: true });

      expect(result).toEqual({ newCommits: false, result: 'pass' });
      expect(ctx.validationEngine.validate).toHaveBeenCalledTimes(2);
      expect(ctx.runtime.spawn).not.toHaveBeenCalled();
      expect(ctx.runtime.resume).not.toHaveBeenCalled();
      expect(manager.getSession(pod.id).status).toBe('validated');
    });

    it('Path 2: ignores legacy GitHub PAT when pulling during forced revalidation', async () => {
      const ctx = createTestContext(undefined, { githubPat: 'test-github-pat' });
      const { manager, pod } = setupFailedPod(ctx, {
        validationOverall: 'fail',
        containerId: null,
      });

      await manager.revalidateSession(pod.id, { force: true });

      expect(ctx.worktreeManager.pullBranch).toHaveBeenCalledWith(
        '/tmp/worktree/abc',
        'daemon-gh-token',
      );
    });

    it('Path 2: forced revalidation without new commits uses validation-only status text', async () => {
      const ctx = createTestContext();
      const { manager, pod } = setupFailedPod(ctx, {
        validationOverall: 'fail',
      });
      const events: unknown[] = [];
      ctx.eventBus.subscribe((e) => events.push(e));

      await manager.revalidateSession(pod.id, { force: true });

      const messages = events.flatMap((e) => {
        if (typeof e !== 'object' || e === null) return [];
        const maybeActivity = e as {
          type?: string;
          event?: { type?: string; message?: string };
        };
        if (
          maybeActivity.type === 'pod.agent_activity' &&
          maybeActivity.event?.type === 'status' &&
          maybeActivity.event.message
        ) {
          return [maybeActivity.event.message];
        }
        return [];
      });
      expect(messages).toContain('Resuming — revalidating with existing worktree');
      expect(messages).toContain('Starting full validation-only resume…');
      expect(messages).toContain('Starting revalidation…');
      expect(messages).not.toContain('New commits detected — starting full validation…');
      expect(messages).not.toContain('Starting revalidation (human fix)…');
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

  describe('forceApprove — validation waivers', () => {
    function setupFailedFactPod(ctx: TestContext) {
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Migrate frontend WorkPackage reads' },
        'user-1',
      );
      const validationResult: ValidationResult = {
        podId: pod.id,
        attempt: 2,
        timestamp: '2026-05-20T10:00:00.000Z',
        smoke: {
          status: 'pass',
          build: { status: 'pass', output: '', duration: 42_000 },
          health: {
            status: 'pass',
            url: 'http://127.0.0.1:3000/health',
            responseCode: 200,
            duration: 100,
          },
          pages: [],
        },
        factValidation: {
          status: 'fail',
          results: [
            {
              factId: 'fact-workpackages-page-v2',
              proves: ['workpackages-page'],
              kind: 'browser-test',
              artifactPath: 'Client/tests/parallel/workpackages/workpackages.spec.ts',
              command: 'npx playwright test tests/parallel/workpackages/workpackages.spec.ts',
              passed: false,
              status: 'fail',
              reasoning: 'command exited 1',
            },
          ],
        },
        taskReview: null,
        overall: 'fail',
        duration: 63_000,
      };
      ctx.podRepo.update(pod.id, {
        status: 'provisioning',
        worktreePath: '/tmp/worktree/abc',
        containerId: 'container-xyz',
        lastValidationResult: validationResult,
      });
      ctx.podRepo.update(pod.id, { status: 'running' });
      ctx.podRepo.update(pod.id, { status: 'validating' });
      ctx.podRepo.update(pod.id, { status: 'failed' });
      return { manager, pod };
    }

    it('records failed phases and fact ids when a failed pod is approved anyway', async () => {
      const ctx = createTestContext();
      const { manager, pod } = setupFailedFactPod(ctx);

      await manager.forceApprove(pod.id, 'manual inspection passed after harness failure');

      const refreshed = manager.getSession(pod.id);
      expect(refreshed.status).toBe('validated');
      expect(refreshed.lastCorrectionMessage).toBe(
        '[FORCE APPROVED] manual inspection passed after harness failure',
      );
      expect(refreshed.validationWaiver).toMatchObject({
        waivedBy: 'human',
        reason: 'manual inspection passed after harness failure',
        attempt: 2,
        failedPhases: ['facts'],
        failedFactIds: ['fact-workpackages-page-v2'],
      });
      expect(refreshed.validationWaiver?.waivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('describes force approval after a passing validation as accepting existing proof', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Recover post-validation push failure' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'provisioning',
        worktreePath: '/tmp/worktree/abc',
        containerId: 'container-xyz',
        lastValidationResult: {
          podId: pod.id,
          attempt: 2,
          timestamp: '2026-05-20T10:00:00.000Z',
          smoke: {
            status: 'pass',
            build: { status: 'pass', output: '', duration: 42_000 },
            health: {
              status: 'pass',
              url: 'http://127.0.0.1:3000/health',
              responseCode: 200,
              duration: 100,
            },
            pages: [],
          },
          factValidation: { status: 'pass', results: [] },
          taskReview: null,
          overall: 'pass',
          duration: 63_000,
        } satisfies ValidationResult,
      });
      ctx.podRepo.update(pod.id, { status: 'running' });
      ctx.podRepo.update(pod.id, { status: 'validating' });
      ctx.podRepo.update(pod.id, { status: 'failed' });
      const events: unknown[] = [];
      ctx.eventBus.subscribe((event) => events.push(event));

      await manager.forceApprove(pod.id, 'post-validation push failed');

      const refreshed = manager.getSession(pod.id);
      expect(refreshed.status).toBe('validated');
      expect(refreshed.validationWaiver).toBeNull();
      expect(refreshed.readinessReview?.areas).toEqual(
        expect.arrayContaining([expect.objectContaining({ area: 'validation', status: 'ready' })]),
      );
      const messages = events.flatMap((event) => {
        if (typeof event !== 'object' || event === null) return [];
        const maybeActivity = event as {
          type?: string;
          event?: { type?: string; message?: string };
        };
        if (
          maybeActivity.type === 'pod.agent_activity' &&
          maybeActivity.event?.type === 'status' &&
          maybeActivity.event.message
        ) {
          return [maybeActivity.event.message];
        }
        return [];
      });
      expect(messages).toContain('Force approved — existing validation pass accepted by human');
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

    it('kills the underlying container as part of the override', async () => {
      const ctx = createTestContext();
      const { manager, pod } = setupFailedPod(ctx, { containerId: 'container-stuck' });

      await manager.forceComplete(pod.id);

      expect(ctx.containerManager.kill).toHaveBeenCalledWith('container-stuck');
    });

    it('still completes when the container kill fails (best-effort cleanup)', async () => {
      const ctx = createTestContext();
      const { manager, pod } = setupFailedPod(ctx);
      (ctx.containerManager.kill as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('container already gone'),
      );

      await manager.forceComplete(pod.id, 'cleanup');

      const refreshed = manager.getSession(pod.id);
      expect(refreshed.status).toBe('complete');
      expect(refreshed.forceCompletedReason).toBe('cleanup');
    });

    it('does not call container.kill when the pod has no containerId', async () => {
      const ctx = createTestContext();
      const { manager, pod } = setupFailedPod(ctx, { containerId: null });

      await manager.forceComplete(pod.id);

      expect(ctx.containerManager.kill).not.toHaveBeenCalled();
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

    it('triggers queued series dependents — admin override must advance the series', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const parent = manager.createSession(
        { profileName: 'test-profile', task: 'Parent' },
        'user-1',
      );
      const child = manager.createSession(
        { profileName: 'test-profile', task: 'Child', dependsOnPodIds: [parent.id] },
        'user-1',
      );
      ctx.podRepo.update(parent.id, {
        status: 'provisioning',
        worktreePath: '/tmp/worktree/parent',
        containerId: 'container-parent',
        startedAt: new Date().toISOString(),
      });
      ctx.podRepo.update(parent.id, { status: 'running' });
      ctx.podRepo.update(parent.id, { status: 'failed' });

      ctx.enqueuedSessions.length = 0;
      await manager.forceComplete(parent.id, 'unstick the series');

      expect(ctx.enqueuedSessions).toContain(child.id);
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

    it('force-fails a stuck validating pod while preserving its worktree for resume', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'do thing' },
        'user-1',
      );
      ctx.podRepo.update(pod.id, {
        status: 'provisioning',
        worktreePath: '/tmp/worktree/abc',
        containerId: 'container-gone',
        startedAt: new Date().toISOString(),
      });
      ctx.podRepo.update(pod.id, { status: 'running' });
      ctx.podRepo.update(pod.id, { status: 'validating' });
      (ctx.containerManager.stop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('container already gone'),
      );

      const result = await manager.kickPod(pod.id, 'validation wedged after deploy');

      expect(result).toEqual({ action: 'failed' });
      expect(ctx.containerManager.stop).toHaveBeenCalledWith('container-gone');
      const refreshed = manager.getSession(pod.id);
      expect(refreshed.status).toBe('failed');
      expect(refreshed.worktreePath).toBe('/tmp/worktree/abc');
      expect(refreshed.kickedReason).toBe('validation wedged after deploy');
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

    it('leaves a pod with a fresh MCP heartbeat alone when agent events are stale', async () => {
      vi.useFakeTimers();
      try {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'run full self-validation' },
          'user-1',
        );
        const stale = new Date(Date.now() - 35 * 60 * 1000).toISOString();
        const freshHeartbeat = new Date(Date.now() - 60 * 1000).toISOString();
        ctx.podRepo.update(pod.id, {
          status: 'provisioning',
          worktreePath: '/tmp/worktree/active-validation',
          containerId: 'container-validating',
          startedAt: stale,
        });
        ctx.podRepo.update(pod.id, {
          status: 'running',
          lastAgentEventAt: stale,
          lastHeartbeatAt: freshHeartbeat,
        });

        manager.startStuckPodWatchdog({ intervalMs: 50, thresholdMs: 30 * 60 * 1000 });
        await vi.advanceTimersByTimeAsync(60);
        await vi.advanceTimersByTimeAsync(0);
        manager.stopStuckPodWatchdog();

        expect(ctx.containerManager.stop).not.toHaveBeenCalled();
        expect(manager.getSession(pod.id).status).toBe('running');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not auto-fail interactive workspace pods even when silent', async () => {
      vi.useFakeTimers();
      try {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          {
            profileName: 'test-profile',
            task: 'workspace session',
            options: { agentMode: 'interactive', output: 'branch' },
          },
          'user-1',
        );
        // Wedge into running with a stale lastAgentEventAt — for an auto pod
        // the watchdog would kill this; for an interactive pod it must not.
        const stale = new Date(Date.now() - 35 * 60 * 1000).toISOString();
        ctx.podRepo.update(pod.id, {
          status: 'provisioning',
          worktreePath: '/tmp/worktree/ws',
          containerId: 'container-workspace',
          startedAt: stale,
        });
        ctx.podRepo.update(pod.id, { status: 'running', lastAgentEventAt: stale });

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

    it('does not auto-fail a recovered pod whose lastAgentEventAt is stale from a prior run', async () => {
      // Repro: the original Claude run died overnight (lastAgentEventAt is 8h old).
      // Recovery re-provisions the container and transitions the pod through
      // queued → provisioning → running, refreshing `startedAt` along the way.
      // The fresh `startedAt` must take precedence over the stale `lastAgentEventAt`,
      // otherwise the watchdog kills the pod the moment it enters 'running' again.
      vi.useFakeTimers();
      try {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'do thing' },
          'user-1',
        );
        const ancient = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(); // 8h ago
        const fresh = new Date(Date.now() - 30 * 1000).toISOString(); // 30s ago — current run
        ctx.podRepo.update(pod.id, {
          status: 'provisioning',
          worktreePath: '/tmp/worktree/recovered',
          containerId: 'container-recovered',
          startedAt: fresh,
        });
        // Stale lastAgentEventAt left over from the prior life of this pod.
        ctx.podRepo.update(pod.id, { status: 'running', lastAgentEventAt: ancient });

        manager.startStuckPodWatchdog({ intervalMs: 50, thresholdMs: 30 * 60 * 1000 });
        await vi.advanceTimersByTimeAsync(60);
        await vi.advanceTimersByTimeAsync(0);
        manager.stopStuckPodWatchdog();

        expect(ctx.containerManager.stop).not.toHaveBeenCalled();
        expect(manager.getSession(pod.id).status).toBe('running');
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

    // -------------------------------------------------------------------------
    // Wake grace window tests
    //
    // Design note: pods are created AFTER emitting host.resumed so the
    // wake-recovery reconciler (which runs async on host.resumed) doesn't see
    // them and interfere with the pod state under test. The reconciler kills
    // pods whose worktrees don't exist on disk; by creating them after the
    // event we test the watchdog grace window in isolation.
    // -------------------------------------------------------------------------

    it('normal tick (no wake): 4h stale pod transitions to failed', async () => {
      vi.useFakeTimers();
      try {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession({ profileName: 'test-profile', task: 'stale' }, 'user-1');
        const stale = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
        ctx.podRepo.update(pod.id, {
          status: 'provisioning',
          worktreePath: '/tmp/wt',
          containerId: 'c1',
          startedAt: stale,
        });
        ctx.podRepo.update(pod.id, { status: 'running', lastAgentEventAt: stale });

        manager.startStuckPodWatchdog({ intervalMs: 50, thresholdMs: 30 * 60 * 1000 });
        await vi.advanceTimersByTimeAsync(60);
        await vi.advanceTimersByTimeAsync(0);
        manager.stopStuckPodWatchdog();

        expect(manager.getSession(pod.id).status).toBe('failed');
      } finally {
        vi.useRealTimers();
      }
    });

    it('wake grace: tick 5 s after host.resumed skips a stale pod', async () => {
      vi.useFakeTimers();
      try {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession({ profileName: 'test-profile', task: 'stale' }, 'user-1');
        const stale = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
        ctx.podRepo.update(pod.id, {
          status: 'provisioning',
          worktreePath: '/tmp/wt',
          containerId: 'c2',
          startedAt: stale,
        });
        ctx.podRepo.update(pod.id, { status: 'running', lastAgentEventAt: stale });
        // Mark as 'sandbox' so the wake-recovery reconciler (which only processes
        // 'local' pods) doesn't touch this pod and interfere with the status.
        ctx.db.prepare('UPDATE pods SET execution_target = ? WHERE id = ?').run('sandbox', pod.id);

        manager.startStuckPodWatchdog({ intervalMs: 200, thresholdMs: 30 * 60 * 1000 });

        // Emit host.resumed at T=0 — sets lastWakeAt; reconciler skips 'sandbox' pod.
        ctx.eventBus.emit({
          type: 'host.resumed',
          timestamp: new Date().toISOString(),
          sleptMs: 300_000,
          detector: 'tick-gap',
          reconciledPodIds: [],
        });

        // Advance 5 s (within the 60 s grace window); watchdog tick must skip.
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.advanceTimersByTimeAsync(0);
        manager.stopStuckPodWatchdog();

        // Pod must still be running — watchdog skipped during grace window.
        expect(manager.getSession(pod.id).status).toBe('running');
        expect(ctx.containerManager.stop).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('wake grace expires: tick 65 s after host.resumed fails the stale pod', async () => {
      vi.useFakeTimers();
      try {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession({ profileName: 'test-profile', task: 'stale' }, 'user-1');
        // lastAgentEventAt is 4 h ago; startedAt also stale so the watchdog's
        // max(primary) reference is still old even after 65 s of fake-time advance.
        const stale = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
        ctx.podRepo.update(pod.id, {
          status: 'provisioning',
          worktreePath: '/tmp/wt',
          containerId: 'c3',
          startedAt: stale,
        });
        ctx.podRepo.update(pod.id, { status: 'running', lastAgentEventAt: stale });
        ctx.db.prepare('UPDATE pods SET execution_target = ? WHERE id = ?').run('sandbox', pod.id);

        manager.startStuckPodWatchdog({ intervalMs: 200, thresholdMs: 30 * 60 * 1000 });

        // Emit wake at T=0 — reconciler skips 'sandbox' pod.
        ctx.eventBus.emit({
          type: 'host.resumed',
          timestamp: new Date().toISOString(),
          sleptMs: 300_000,
          detector: 'tick-gap',
          reconciledPodIds: [],
        });

        // Advance 65 s — beyond the 60 s grace window, so the next tick is normal.
        await vi.advanceTimersByTimeAsync(65_000);
        await vi.advanceTimersByTimeAsync(0);
        manager.stopStuckPodWatchdog();

        expect(manager.getSession(pod.id).status).toBe('failed');
      } finally {
        vi.useRealTimers();
      }
    });

    it('wake grace: multiple wake events each refresh the window', async () => {
      vi.useFakeTimers();
      try {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession({ profileName: 'test-profile', task: 'stale' }, 'user-1');
        const stale = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
        ctx.podRepo.update(pod.id, {
          status: 'provisioning',
          worktreePath: '/tmp/wt',
          containerId: 'c4',
          startedAt: stale,
        });
        ctx.podRepo.update(pod.id, { status: 'running', lastAgentEventAt: stale });
        ctx.db.prepare('UPDATE pods SET execution_target = ? WHERE id = ?').run('sandbox', pod.id);

        manager.startStuckPodWatchdog({ intervalMs: 200, thresholdMs: 30 * 60 * 1000 });

        // First wake at T=0.
        ctx.eventBus.emit({
          type: 'host.resumed',
          timestamp: '2026-01-01T00:00:00.000Z',
          sleptMs: 300_000,
          detector: 'tick-gap',
          reconciledPodIds: [],
        });

        // Second wake at T=50s (within first grace window but before it expires).
        await vi.advanceTimersByTimeAsync(50_000);
        ctx.eventBus.emit({
          type: 'host.resumed',
          timestamp: '2026-01-01T00:01:00.000Z',
          sleptMs: 10_000,
          detector: 'tick-gap',
          reconciledPodIds: [],
        });

        // Advance another 55 s (T=105 s total, 55 s after second wake).
        // The second wake refreshed the window → 55 s < 60 s → still in grace.
        await vi.advanceTimersByTimeAsync(55_000);
        await vi.advanceTimersByTimeAsync(0);
        manager.stopStuckPodWatchdog();

        // Pod must still be running — second wake kept the grace window alive.
        expect(manager.getSession(pod.id).status).toBe('running');
        expect(ctx.containerManager.stop).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('wake grace: no wake events ever — existing watchdog behaviour unchanged', async () => {
      vi.useFakeTimers();
      try {
        const ctx = createTestContext();
        const manager = createPodManager(ctx.deps);

        const pod = manager.createSession({ profileName: 'test-profile', task: 'stale' }, 'user-1');
        const stale = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
        ctx.podRepo.update(pod.id, {
          status: 'provisioning',
          worktreePath: '/tmp/wt',
          containerId: 'c5',
          startedAt: stale,
        });
        ctx.podRepo.update(pod.id, { status: 'running', lastAgentEventAt: stale });

        // No host.resumed emitted. Watchdog should behave exactly as before.
        manager.startStuckPodWatchdog({ intervalMs: 50, thresholdMs: 30 * 60 * 1000 });
        await vi.advanceTimersByTimeAsync(60);
        await vi.advanceTimersByTimeAsync(0);
        manager.stopStuckPodWatchdog();

        expect(manager.getSession(pod.id).status).toBe('failed');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('phaseTokenUsage per-attempt bucket writes', () => {
    it('initial run writes agent_initial', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Initial task', skipValidation: true },
        'user-1',
      );

      (ctx.runtime.spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async function* (): AsyncIterable<AgentEvent> {
          yield {
            type: 'complete',
            timestamp: new Date().toISOString(),
            result: 'done',
            totalInputTokens: 1000,
            totalOutputTokens: 500,
          };
        },
      );

      await manager.processPod(pod.id);

      const result = manager.getSession(pod.id);
      expect(result.phaseTokenUsage?.agent_initial).toEqual({
        inputTokens: 1000,
        outputTokens: 500,
      });
    });

    it('one rework writes agent_rework_1 without trampling agent_initial', async () => {
      const ctx = createTestContext({ overall: 'fail' });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Rework task' },
        'user-1',
      );

      // Simulate that the initial agent run already completed and wrote agent_initial
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        validationAttempts: 0,
        phaseTokenUsage: { agent_initial: { inputTokens: 1000, outputTokens: 500 } },
      });

      // First resume (after attempt 1 fails) emits 300/200 tokens
      (ctx.runtime.resume as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async function* (): AsyncIterable<AgentEvent> {
          yield {
            type: 'complete',
            timestamp: new Date().toISOString(),
            result: 'rework done',
            totalInputTokens: 300,
            totalOutputTokens: 200,
          };
        },
      );

      await manager.triggerValidation(pod.id);

      const result = manager.getSession(pod.id);
      // agent_initial must be unchanged
      expect(result.phaseTokenUsage?.agent_initial).toEqual({
        inputTokens: 1000,
        outputTokens: 500,
      });
      // agent_rework_1 must have the rework tokens
      expect(result.phaseTokenUsage?.agent_rework_1).toEqual({
        inputTokens: 300,
        outputTokens: 200,
      });
    });

    it('does not report rework success when the validation retry runtime fails', async () => {
      const ctx = createTestContext({ overall: 'fail' });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Retry failure task' },
        'user-1',
      );

      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        validationAttempts: 0,
      });

      (ctx.runtime.resume as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async function* (): AsyncIterable<AgentEvent> {
          yield {
            type: 'error',
            timestamp: new Date().toISOString(),
            message: 'Codex process exited with code 137',
            fatal: true,
          };
        },
      );

      await manager.triggerValidation(pod.id);

      const messages = ctx.eventRepo
        .getForSession(pod.id)
        .flatMap((stored) =>
          stored.payload.type === 'pod.agent_activity' && stored.payload.event.type === 'status'
            ? [stored.payload.event.message]
            : [],
        );
      expect(messages).not.toContain('Agent finished applying fixes');
      expect(manager.getSession(pod.id).status).toBe('failed');
    });

    it('multiple complete events in one attempt accumulate into the same bucket', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Multi-event task', skipValidation: true },
        'user-1',
      );

      (ctx.runtime.spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async function* (): AsyncIterable<AgentEvent> {
          yield {
            type: 'complete',
            timestamp: new Date().toISOString(),
            result: 'first',
            totalInputTokens: 600,
            totalOutputTokens: 400,
          };
          yield {
            type: 'complete',
            timestamp: new Date().toISOString(),
            result: 'second',
            totalInputTokens: 400,
            totalOutputTokens: 100,
          };
        },
      );

      await manager.processPod(pod.id);

      const result = manager.getSession(pod.id);
      // Both events accumulate into agent_initial (same attempt=0)
      expect(result.phaseTokenUsage?.agent_initial).toEqual({
        inputTokens: 1000,
        outputTokens: 500,
      });
    });

    it('does not recount replayed duplicate complete events', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Replay task', skipValidation: true },
        'user-1',
      );
      const replayed: AgentEvent = {
        type: 'complete',
        timestamp: '2026-06-01T05:10:09.085Z',
        result: 'already counted',
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        costUsd: 0.25,
      };
      ctx.podRepo.update(pod.id, {
        status: 'running',
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 0.25,
        phaseTokenUsage: { agent_initial: { inputTokens: 1000, outputTokens: 500, costUsd: 0.25 } },
      });
      ctx.eventRepo.insert({
        type: 'pod.agent_activity',
        timestamp: replayed.timestamp,
        podId: pod.id,
        event: replayed,
      });

      async function* events(): AsyncIterable<AgentEvent> {
        yield replayed;
        yield {
          type: 'complete',
          timestamp: '2026-06-01T05:11:09.085Z',
          result: 'new completion',
          totalInputTokens: 200,
          totalOutputTokens: 50,
          costUsd: 0.1,
        };
      }

      await manager.consumeAgentEvents(pod.id, events());

      const result = manager.getSession(pod.id);
      expect(result.inputTokens).toBe(1200);
      expect(result.outputTokens).toBe(550);
      expect(result.costUsd).toBeCloseTo(0.35);
      expect(result.phaseTokenUsage?.agent_initial).toEqual({
        inputTokens: 1200,
        outputTokens: 550,
        costUsd: 0.35,
      });
      const completeEvents = ctx.eventRepo
        .getForSession(pod.id, { type: 'pod.agent_activity' })
        .filter(
          (stored) =>
            stored.payload.type === 'pod.agent_activity' &&
            stored.payload.event.type === 'complete',
        );
      expect(completeEvents).toHaveLength(2);
    });

    it('existing review writes still land under phaseTokenUsage.review and do not trample agent buckets', async () => {
      const ctx = createTestContext({
        overall: 'pass',
        taskReview: {
          status: 'pass' as const,
          issues: [],
          reasoning: 'Looks good',
          model: 'claude-3-5-sonnet',
          screenshots: [],
          diff: '',
          tokenUsage: {
            inputTokens: 2000,
            outputTokens: 150,
            cachedInputTokens: 1200,
            costUsd: 0.42,
          },
        },
      });
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Review task' },
        'user-1',
      );

      // Pre-set agent_initial so we can confirm it is preserved
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'ctr-1',
        phaseTokenUsage: { agent_initial: { inputTokens: 1000, outputTokens: 500 } },
      });

      await manager.triggerValidation(pod.id);

      const result = manager.getSession(pod.id);
      // Review tokens must be present
      expect(result.phaseTokenUsage?.review).toEqual({
        inputTokens: 2000,
        outputTokens: 150,
        cachedInputTokens: 1200,
        costUsd: 0.42,
      });
      // agent_initial must be untouched
      expect(result.phaseTokenUsage?.agent_initial).toEqual({
        inputTokens: 1000,
        outputTokens: 500,
      });
    });

    it('recovery-case: pod with prior phaseTokenUsage starts next write at agent_rework_3', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Recovered task', skipValidation: true },
        'user-1',
      );

      // Simulate a re-queued pod with two prior rework cycles already completed
      ctx.podRepo.update(pod.id, {
        phaseTokenUsage: {
          agent_initial: { inputTokens: 100, outputTokens: 50 },
          agent_rework_2: { inputTokens: 200, outputTokens: 100 },
        },
      });

      (ctx.runtime.spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async function* (): AsyncIterable<AgentEvent> {
          yield {
            type: 'complete',
            timestamp: new Date().toISOString(),
            result: 'recovered',
            totalInputTokens: 400,
            totalOutputTokens: 300,
          };
        },
      );

      await manager.processPod(pod.id);

      const result = manager.getSession(pod.id);
      // Must write to agent_rework_3 (= deriveAgentAttempt({agent_initial, agent_rework_2}) = 1+2=3)
      expect(result.phaseTokenUsage?.agent_rework_3).toEqual({
        inputTokens: 400,
        outputTokens: 300,
      });
      // Prior buckets must be preserved
      expect(result.phaseTokenUsage?.agent_initial).toEqual({ inputTokens: 100, outputTokens: 50 });
      expect(result.phaseTokenUsage?.agent_rework_2).toEqual({
        inputTokens: 200,
        outputTokens: 100,
      });
    });

    it('null phaseTokenUsage starts at attempt 0 (agent_initial)', async () => {
      const ctx = createTestContext();
      const manager = createPodManager(ctx.deps);

      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Fresh task', skipValidation: true },
        'user-1',
      );

      // Ensure phaseTokenUsage is null (it already is for a new pod, but be explicit)
      ctx.podRepo.update(pod.id, { phaseTokenUsage: null });

      (ctx.runtime.spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async function* (): AsyncIterable<AgentEvent> {
          yield {
            type: 'complete',
            timestamp: new Date().toISOString(),
            result: 'done',
            totalInputTokens: 1000,
            totalOutputTokens: 500,
          };
        },
      );

      await manager.processPod(pod.id);

      const result = manager.getSession(pod.id);
      expect(result.phaseTokenUsage?.agent_initial).toEqual({
        inputTokens: 1000,
        outputTokens: 500,
      });
      // No rework keys should exist
      expect(result.phaseTokenUsage?.agent_rework_1).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Wake-recovery integration tests (brief 02)
// ---------------------------------------------------------------------------

describe('wake recovery — host.resumed subscription', () => {
  it('emits a completed host.resumed event with reconciledPodIds after reconcile', async () => {
    const ctx = createTestContext();
    const manager = createPodManager(ctx.deps);
    manager.startStuckPodWatchdog();

    const emittedEvents: unknown[] = [];
    ctx.eventBus.subscribe((e) => {
      if (e.type === 'host.resumed') emittedEvents.push(e);
    });

    // Emit initial event (as sleep-detector would) — no running pods so recovered=[]
    ctx.eventBus.emit({
      type: 'host.resumed',
      timestamp: '2026-01-01T00:00:00.000Z',
      sleptMs: 300_000,
      detector: 'tick-gap',
      reconciledPodIds: [],
    });

    // Let the async reconcile settle
    await new Promise((r) => setTimeout(r, 10));

    // Two events: initial + completed re-publish
    expect(emittedEvents.length).toBeGreaterThanOrEqual(2);
    // Last event should have the same timestamp (de-dupe key) and populated reconciledPodIds
    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const lastEvent = emittedEvents[emittedEvents.length - 1] as any;
    expect(lastEvent.type).toBe('host.resumed');
    expect(lastEvent.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(Array.isArray(lastEvent.reconciledPodIds)).toBe(true);

    manager.stopStuckPodWatchdog();
  });

  it('de-dupes: same event timestamp only triggers reconcile once', async () => {
    const ctx = createTestContext();
    const manager = createPodManager(ctx.deps);
    manager.startStuckPodWatchdog();

    const hostResumedEvents: unknown[] = [];
    ctx.eventBus.subscribe((e) => {
      if (e.type === 'host.resumed') hostResumedEvents.push(e);
    });

    const ts = '2026-01-01T01:00:00.000Z';
    // Emit twice with the same timestamp (simulates duplicate detection or re-publish loop)
    ctx.eventBus.emit({
      type: 'host.resumed',
      timestamp: ts,
      sleptMs: 200_000,
      detector: 'tick-gap',
      reconciledPodIds: [],
    });
    ctx.eventBus.emit({
      type: 'host.resumed',
      timestamp: ts,
      sleptMs: 200_000,
      detector: 'tick-gap',
      reconciledPodIds: [],
    });

    await new Promise((r) => setTimeout(r, 10));

    // Exactly 3 events on the bus: 2 raw emits + 1 completed re-publish from a single
    // reconcile run. If dedup were broken, the second raw emit would trigger a second
    // reconcile and we'd see 4 events; if dedup also failed on re-publishes we'd spiral.
    expect(hostResumedEvents.length).toBe(3);

    manager.stopStuckPodWatchdog();
  });
});

describe('wake recovery — validationAttempts skip', () => {
  it('does not increment validationAttempts when lastRecoveryTrigger === wake', async () => {
    const ctx = createTestContext();
    const manager = createPodManager(ctx.deps);

    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Add feature' },
      'user-1',
    );
    ctx.podRepo.update(pod.id, {
      status: 'running',
      containerId: 'ctr-1',
      validationAttempts: 2,
      lastRecoveryTrigger: 'wake',
    });

    await manager.triggerValidation(pod.id);

    const result = manager.getSession(pod.id);
    // Wake-recovery: attempt held at 2 (not incremented to 3)
    expect(result.validationAttempts).toBe(2);
    // Flag cleared after first validation entry
    expect(result.lastRecoveryTrigger).toBeNull();
    // Pod reached validated (mock validation passes)
    expect(result.status).toBe('validated');
  });

  it('clears lastRecoveryTrigger after the first validation entry', async () => {
    const ctx = createTestContext();
    const manager = createPodManager(ctx.deps);

    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Add feature' },
      'user-1',
    );
    ctx.podRepo.update(pod.id, {
      status: 'running',
      containerId: 'ctr-1',
      validationAttempts: 1,
      lastRecoveryTrigger: 'wake',
    });

    await manager.triggerValidation(pod.id);

    // Flag is one-shot — cleared after the validation entry
    const result = manager.getSession(pod.id);
    expect(result.lastRecoveryTrigger).toBeNull();
  });

  it('increments validationAttempts normally when lastRecoveryTrigger is null', async () => {
    const ctx = createTestContext();
    const manager = createPodManager(ctx.deps);

    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Add feature' },
      'user-1',
    );
    ctx.podRepo.update(pod.id, {
      status: 'running',
      containerId: 'ctr-1',
      validationAttempts: 1,
      // lastRecoveryTrigger intentionally null (default)
    });

    await manager.triggerValidation(pod.id);

    const result = manager.getSession(pod.id);
    expect(result.validationAttempts).toBe(2);
  });

  it('increments validationAttempts normally when lastRecoveryTrigger is restart', async () => {
    const ctx = createTestContext();
    const manager = createPodManager(ctx.deps);

    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Add feature' },
      'user-1',
    );
    ctx.podRepo.update(pod.id, {
      status: 'running',
      containerId: 'ctr-1',
      validationAttempts: 1,
      lastRecoveryTrigger: 'restart',
    });

    await manager.triggerValidation(pod.id);

    const result = manager.getSession(pod.id);
    expect(result.validationAttempts).toBe(2);
  });
});

describe('wake recovery — wake-correction postscript', () => {
  function setupExecFileMockLocal() {
    mockedExecFile.mockImplementation((...args: unknown[]) => {
      const gitArgs = args[1] as string[];
      const callback = args[args.length - 1] as (
        err: Error | null,
        result: { stdout: string; stderr: string },
      ) => void;
      if (gitArgs[0] === 'rev-parse' && gitArgs[1] === '--git-common-dir') {
        callback(null, { stdout: '/tmp/bare/repo.git', stderr: '' });
      } else if (gitArgs[0] === 'log') {
        callback(null, { stdout: 'abc1234 Previous work', stderr: '' });
      } else {
        callback(null, { stdout: '', stderr: '' });
      }
      return undefined as never;
    });
  }

  it('appends wake-correction postscript for non-Claude runtime in wake recovery', async () => {
    const runtime = createMockRuntime();
    runtime.type = 'codex';

    const ctx = createTestContext();
    ctx.deps.runtimeRegistry = createMockRuntimeRegistry(runtime);

    setupExecFileMockLocal();

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      {
        profileName: 'test-profile',
        task: 'Build the widget',
        runtime: 'codex',
        skipValidation: true,
      },
      'user-1',
    );

    ctx.podRepo.update(pod.id, {
      recoveryWorktreePath: '/tmp/worktree/existing',
      lastRecoveryTrigger: 'wake',
    });

    await manager.processPod(pod.id);

    const spawnCall = vi.mocked(runtime.spawn).mock.calls[0];
    const task = spawnCall?.[0]?.task;
    expect(task).toContain('interrupted by a host sleep');
    expect(task).toContain('git log');
    expect(task).toContain('git diff main');
  });

  it('does NOT append wake-correction postscript for Claude runtime (has session context)', async () => {
    const runtime = createMockRuntime();
    (runtime as Record<string, unknown>).setClaudeSessionId = vi.fn();

    const ctx = createTestContext();
    ctx.deps.runtimeRegistry = createMockRuntimeRegistry(runtime);

    setupExecFileMockLocal();

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Build the widget', skipValidation: true },
      'user-1',
    );

    // Claude with session ID → goes through resume path, not the non-Claude spawn path
    ctx.podRepo.update(pod.id, {
      recoveryWorktreePath: '/tmp/worktree/existing',
      claudeSessionId: 'claude-ses-abc',
      lastRecoveryTrigger: 'wake',
    });

    await manager.processPod(pod.id);

    // Claude uses resume, not spawn — verify no postscript in resume message
    const resumeCall = vi.mocked(runtime.resume).mock.calls[0];
    const resumeMessage = resumeCall?.[1] as string;
    expect(resumeMessage).not.toContain('interrupted by a host sleep');
  });

  it('does NOT append postscript when lastRecoveryTrigger is not wake', async () => {
    const runtime = createMockRuntime();
    runtime.type = 'codex';

    const ctx = createTestContext();
    ctx.deps.runtimeRegistry = createMockRuntimeRegistry(runtime);

    setupExecFileMockLocal();

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      {
        profileName: 'test-profile',
        task: 'Build the widget',
        runtime: 'codex',
        skipValidation: true,
      },
      'user-1',
    );

    ctx.podRepo.update(pod.id, {
      recoveryWorktreePath: '/tmp/worktree/existing',
      lastRecoveryTrigger: 'restart', // not wake
    });

    await manager.processPod(pod.id);

    const spawnCall = vi.mocked(runtime.spawn).mock.calls[0];
    const task = spawnCall?.[0]?.task;
    expect(task).not.toContain('interrupted by a host sleep');
  });
});

describe('worker startup diagnostics', () => {
  function statusMessages(ctx: TestContext, podId: string): string[] {
    return ctx.eventRepo
      .getForSession(podId, { type: 'pod.agent_activity' })
      .map((event) => {
        const payload = event.payload as { event?: { message?: unknown } };
        return payload.event?.message;
      })
      .filter((message): message is string => typeof message === 'string');
  }

  it('logs provider, runtime, and model before spawning the worker', async () => {
    const runtime = createMockRuntime();
    runtime.type = 'codex';
    const ctx = createTestContext(undefined, {
      defaultModel: 'auto',
      defaultRuntime: 'codex',
      modelProvider: 'openai',
    });
    ctx.deps.runtimeRegistry = createMockRuntimeRegistry(runtime);
    vi.mocked(ctx.containerManager.execInContainer).mockImplementation(
      async (_containerId, command) => {
        const rendered = command.join(' ');
        if (rendered.includes('command -v codex')) {
          return { stdout: '/usr/local/bin/codex\n', stderr: '', exitCode: 0 };
        }
        if (rendered === 'codex --version') {
          return { stdout: 'codex-cli 0.144.4\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Build widget', runtime: 'codex', skipValidation: true },
      'user-1',
    );

    await manager.processPod(pod.id);

    expect(statusMessages(ctx, pod.id)).toContain(
      'Starting worker: provider=openai, runtime=codex, model=auto',
    );
    expect(runtime.spawn).toHaveBeenCalled();
    const spawnConfig = vi.mocked(runtime.spawn).mock.calls[0]?.[0];
    expect(spawnConfig?.env.CODEX_HOME).toBe('/home/autopod/.codex');
    expect(spawnConfig?.customInstructions).toContain('report_plan');
    expect(spawnConfig?.customInstructions).toContain('report_task_summary');
  });

  it('fails before spawn when the runtime CLI is missing from the image', async () => {
    const runtime = createMockRuntime();
    runtime.type = 'codex';
    const ctx = createTestContext(undefined, {
      defaultModel: 'auto',
      defaultRuntime: 'codex',
      modelProvider: 'openai',
    });
    ctx.deps.runtimeRegistry = createMockRuntimeRegistry(runtime);
    vi.mocked(ctx.containerManager.execInContainer).mockImplementation(
      async (_containerId, command) => {
        if (command.join(' ').includes('command -v codex')) {
          return { stdout: '', stderr: 'codex: not found', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Build widget', runtime: 'codex', skipValidation: true },
      'user-1',
    );

    await manager.processPod(pod.id);

    expect(manager.getSession(pod.id).status).toBe('failed');
    expect(runtime.spawn).not.toHaveBeenCalled();
    expect(statusMessages(ctx, pod.id)).toContain(
      'Agent CLI missing: codex is not installed in this image. Rebuild the codex base/warm image. codex: not found',
    );
  });

  it('fails before spawn when the Codex CLI is below the supported compatibility floor', async () => {
    const runtime = createMockRuntime();
    runtime.type = 'codex';
    const ctx = createTestContext(undefined, {
      defaultModel: 'auto',
      defaultRuntime: 'codex',
      modelProvider: 'openai',
    });
    ctx.deps.runtimeRegistry = createMockRuntimeRegistry(runtime);
    vi.mocked(ctx.containerManager.execInContainer).mockImplementation(
      async (_containerId, command) => {
        const rendered = command.join(' ');
        if (rendered.includes('command -v codex')) {
          return { stdout: '/usr/local/bin/codex\n', stderr: '', exitCode: 0 };
        }
        if (rendered === 'codex --version') {
          return { stdout: 'codex-cli 0.144.3\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Build widget', runtime: 'codex', skipValidation: true },
      'user-1',
    );

    await manager.processPod(pod.id);

    const failed = manager.getSession(pod.id);
    expect(failed.status).toBe('failed');
    expect(runtime.spawn).not.toHaveBeenCalled();
    expect(failed.failureReason).toContain(
      'Codex CLI 0.144.3 is incompatible; Autopod requires 0.144.4 or newer',
    );
  });

  it('persists a sanitized fatal runtime failure reason', async () => {
    const runtime = createMockRuntime();
    vi.mocked(runtime.spawn).mockImplementation(async function* () {
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: 'Codex turn aborted with token ghp_1234567890abcdefghijklmnopqrstuvwxyz1234',
        fatal: true,
      };
    });
    const ctx = createTestContext();
    ctx.deps.runtimeRegistry = createMockRuntimeRegistry(runtime);
    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Build widget', skipValidation: true },
      'user-1',
    );

    await manager.processPod(pod.id);

    const failed = manager.getSession(pod.id);
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toContain('Agent failed: Codex turn aborted');
    expect(failed.failureReason).toContain('[API_KEY_REDACTED]');
    expect(failed.failureReason).not.toContain('ghp_1234567890');
  });

  it('pre-agent setup failure emits a visible fatal activity', async () => {
    const runtime = createMockRuntime();
    const ctx = createTestContext();
    ctx.deps.runtimeRegistry = createMockRuntimeRegistry(runtime);
    vi.mocked(ctx.containerManager.writeFile).mockRejectedValueOnce(
      new Error('failed to write config with token ghp_1234567890abcdefghijklmnopqrstuvwxyz1234'),
    );

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Build widget', skipValidation: true },
      'user-1',
    );

    await manager.processPod(pod.id);

    expect(manager.getSession(pod.id).status).toBe('failed');
    expect(runtime.spawn).not.toHaveBeenCalled();
    const errorEvents = ctx.eventRepo
      .getForSession(pod.id, { type: 'pod.agent_activity' })
      .map((event) => {
        const payload = event.payload as {
          event?: { type?: string; message?: unknown; fatal?: boolean };
        };
        return payload.event;
      })
      .filter((event) => event?.type === 'error');

    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]?.fatal).toBe(true);
    expect(errorEvents[0]?.message).toContain('Pod setup failed before the agent could finish');
    expect(errorEvents[0]?.message).not.toContain('ghp_1234567890');
    expect(errorEvents[0]?.message).toContain('[API_KEY_REDACTED]');
  });
});

describe('updateFromBase', () => {
  /** Advance a pod to a parked terminal state reachable from the normal flow. */
  function setupParkedPod(
    ctx: TestContext,
    status: 'failed' | 'review_required',
    opts: { worktreePath?: string | null; worktreeCompromised?: boolean } = {},
  ) {
    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Build widget' },
      'user-1',
    );
    ctx.podRepo.update(pod.id, {
      status: 'provisioning',
      worktreePath: opts.worktreePath === undefined ? '/tmp/worktree/abc' : opts.worktreePath,
      containerId: 'container-xyz',
      startedAt: new Date().toISOString(),
    });
    ctx.podRepo.update(pod.id, { status: 'running' });
    ctx.podRepo.update(pod.id, { status: 'validating' });
    if (status === 'review_required') {
      ctx.podRepo.update(pod.id, { status: 'review_required' });
    } else {
      ctx.podRepo.update(pod.id, { status: 'failed' });
    }
    if (opts.worktreeCompromised) {
      ctx.podRepo.update(pod.id, { worktreeCompromised: true });
    }
    return { manager, pod };
  }

  it('failed + clean rebase returns rebased and starts validation asynchronously', async () => {
    const ctx = createTestContext();
    vi.mocked(ctx.worktreeManager.rebaseOntoBase).mockResolvedValue({
      alreadyUpToDate: false,
      rebased: true,
      conflicts: [],
    });
    const { manager, pod } = setupParkedPod(ctx, 'failed');
    const triggerSpy = vi.spyOn(manager, 'triggerValidation').mockResolvedValue(undefined);

    const result = await manager.updateFromBase(pod.id);

    expect(result).toEqual({
      ok: true,
      action: 'rebased',
      baseBranch: 'main',
      validation: 'started',
    });
    // Validation starts via setImmediate — flush it
    await new Promise((r) => setImmediate(r));
    expect(triggerSpy).toHaveBeenCalledWith(pod.id);
  });

  it('review_required + clean rebase returns rebased and starts validation asynchronously', async () => {
    const ctx = createTestContext();
    vi.mocked(ctx.worktreeManager.rebaseOntoBase).mockResolvedValue({
      alreadyUpToDate: false,
      rebased: true,
      conflicts: [],
    });
    const { manager, pod } = setupParkedPod(ctx, 'review_required');
    const triggerSpy = vi.spyOn(manager, 'triggerValidation').mockResolvedValue(undefined);

    const result = await manager.updateFromBase(pod.id);

    expect(result).toEqual({
      ok: true,
      action: 'rebased',
      baseBranch: 'main',
      validation: 'started',
    });
    await new Promise((r) => setImmediate(r));
    expect(triggerSpy).toHaveBeenCalledWith(pod.id);
  });

  it('alreadyUpToDate returns already_up_to_date and does not start validation', async () => {
    const ctx = createTestContext();
    vi.mocked(ctx.worktreeManager.rebaseOntoBase).mockResolvedValue({
      alreadyUpToDate: true,
      rebased: true,
      conflicts: [],
    });
    const { manager, pod } = setupParkedPod(ctx, 'failed');
    const triggerSpy = vi.spyOn(manager, 'triggerValidation').mockResolvedValue(undefined);

    const result = await manager.updateFromBase(pod.id);

    expect(result).toEqual({ ok: true, action: 'already_up_to_date', baseBranch: 'main' });
    await new Promise((r) => setImmediate(r));
    expect(triggerSpy).not.toHaveBeenCalled();
  });

  it('conflict returns { ok: false, action: conflict } with file paths and does not write mergeBlockReason', async () => {
    const ctx = createTestContext();
    vi.mocked(ctx.worktreeManager.rebaseOntoBase).mockResolvedValue({
      alreadyUpToDate: false,
      rebased: false,
      conflicts: ['packages/foo/package.json', 'pnpm-lock.yaml'],
    });
    const { manager, pod } = setupParkedPod(ctx, 'failed');

    const result = await manager.updateFromBase(pod.id);

    expect(result).toEqual({
      ok: false,
      action: 'conflict',
      baseBranch: 'main',
      conflicts: ['packages/foo/package.json', 'pnpm-lock.yaml'],
    });
    const refreshed = manager.getSession(pod.id);
    expect(refreshed.mergeBlockReason).toBeNull();
    // Pod stays in failed — still reviewable
    expect(refreshed.status).toBe('failed');
  });

  it('clean rebase resets validationAttempts to 0 so follow-up starts as attempt 1', async () => {
    const ctx = createTestContext();
    vi.mocked(ctx.worktreeManager.rebaseOntoBase).mockResolvedValue({
      alreadyUpToDate: false,
      rebased: true,
      conflicts: [],
    });
    const { manager, pod } = setupParkedPod(ctx, 'failed');
    ctx.podRepo.update(pod.id, { validationAttempts: 2 });
    vi.spyOn(manager, 'triggerValidation').mockResolvedValue(undefined);

    await manager.updateFromBase(pod.id);

    expect(manager.getSession(pod.id).validationAttempts).toBe(0);
  });

  it('next pushBranch after clean rebase uses { force: true }, then clears the allowance', async () => {
    const ctx = createTestContext({ overall: 'pass' });
    vi.mocked(ctx.worktreeManager.rebaseOntoBase).mockResolvedValue({
      alreadyUpToDate: false,
      rebased: true,
      conflicts: [],
    });
    const { manager, pod } = setupParkedPod(ctx, 'failed');

    // Set the force allowance via updateFromBase (spy on triggerValidation to avoid running it)
    vi.spyOn(manager, 'triggerValidation').mockResolvedValue(undefined);
    await manager.updateFromBase(pod.id);

    // Advance pod to validated with a PR so approveSession runs the pushBranch path
    ctx.podRepo.update(pod.id, { status: 'running' });
    ctx.podRepo.update(pod.id, { status: 'validating' });
    ctx.podRepo.update(pod.id, validatedPodUpdates(pod.id));
    ctx.podRepo.update(pod.id, { prUrl: 'https://github.com/org/repo/pull/42' });

    await manager.approveSession(pod.id);

    const pushCalls = vi.mocked(ctx.worktreeManager.pushBranch).mock.calls;
    // The pre-merge pushBranch call must use force: true
    expect(pushCalls[0]?.[2]).toMatchObject({ force: true });

    // A second approveSession (no update-from-base in between) must NOT use force
    vi.mocked(ctx.worktreeManager.pushBranch).mockClear();
    ctx.podRepo.update(pod.id, { status: 'complete' });
    ctx.podRepo.update(pod.id, { status: 'queued' });
    ctx.podRepo.update(pod.id, { status: 'provisioning' });
    ctx.podRepo.update(pod.id, { status: 'running' });
    ctx.podRepo.update(pod.id, { status: 'validating' });
    ctx.podRepo.update(pod.id, validatedPodUpdates(pod.id));

    await manager.approveSession(pod.id);

    expect(vi.mocked(ctx.worktreeManager.pushBranch).mock.calls[0]?.[2]?.force).toBeFalsy();
  });

  it('validating pod returns queued_after_abort immediately', async () => {
    const ctx = createTestContext();
    const { manager, pod } = setupParkedPod(ctx, 'failed');
    ctx.podRepo.update(pod.id, { status: 'running' });
    ctx.podRepo.update(pod.id, { status: 'validating' });

    const result = await manager.updateFromBase(pod.id);

    expect(result).toEqual({ ok: true, action: 'queued_after_abort' });
  });

  it('validating pod abort handoff: unwind runs rebase and starts follow-up validation on clean rebase', async () => {
    // The validation engine is mocked to call updateFromBase mid-run (simulating the abort race)
    // then return a fail result. The retry path should detect the pending intent and run rebase.
    const ctx = createTestContext({ overall: 'fail' });
    vi.mocked(ctx.worktreeManager.rebaseOntoBase).mockResolvedValue({
      alreadyUpToDate: false,
      rebased: true,
      conflicts: [],
    });

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Build widget' },
      'user-1',
    );
    ctx.podRepo.update(pod.id, {
      status: 'running',
      containerId: 'ctr-1',
      worktreePath: '/tmp/wt',
      validationAttempts: 0,
    });

    // When the validation engine runs, call updateFromBase to plant the intent.
    // This simulates the abort request arriving mid-validation.
    vi.mocked(ctx.validationEngine.validate).mockImplementationOnce(async () => {
      await manager.updateFromBase(pod.id); // pod is 'validating' here → stores intent
      return {
        podId: pod.id,
        attempt: 1,
        timestamp: new Date().toISOString(),
        smoke: {
          status: 'fail' as const,
          build: { status: 'fail' as const, output: 'fail', duration: 0 },
          health: { status: 'fail' as const, url: '', responseCode: null, duration: 0 },
          pages: [],
        },
        taskReview: null,
        overall: 'fail' as const,
        duration: 0,
      };
    });

    const triggerSpy = vi.spyOn(manager, 'triggerValidation');

    await manager.triggerValidation(pod.id);

    // The retry path consumed the intent, ran the rebase, and scheduled follow-up
    await new Promise((r) => setImmediate(r));
    expect(ctx.worktreeManager.rebaseOntoBase).toHaveBeenCalled();
    // Flush setImmediate so follow-up triggerValidation fires
    await new Promise((r) => setImmediate(r));
    // triggerValidation was called again (the follow-up)
    expect(triggerSpy).toHaveBeenCalledTimes(2);
  });

  it('alreadyUpToDate after abort transitions pod to failed without starting follow-up validation', async () => {
    const ctx = createTestContext({ overall: 'fail' });
    vi.mocked(ctx.worktreeManager.rebaseOntoBase).mockResolvedValue({
      alreadyUpToDate: true,
      rebased: true,
      conflicts: [],
    });

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Build widget' },
      'user-1',
    );
    ctx.podRepo.update(pod.id, {
      status: 'running',
      containerId: 'ctr-1',
      worktreePath: '/tmp/wt',
      validationAttempts: 0,
    });

    vi.mocked(ctx.validationEngine.validate).mockImplementationOnce(async () => {
      await manager.updateFromBase(pod.id);
      return {
        podId: pod.id,
        attempt: 1,
        timestamp: new Date().toISOString(),
        smoke: {
          status: 'fail' as const,
          build: { status: 'fail' as const, output: 'fail', duration: 0 },
          health: { status: 'fail' as const, url: '', responseCode: null, duration: 0 },
          pages: [],
        },
        taskReview: null,
        overall: 'fail' as const,
        duration: 0,
      };
    });

    const triggerSpy = vi.spyOn(manager, 'triggerValidation');

    await manager.triggerValidation(pod.id);
    await new Promise((r) => setImmediate(r));

    // The unwind ran the rebase but found nothing to update — pod parked in failed.
    expect(ctx.worktreeManager.rebaseOntoBase).toHaveBeenCalled();
    expect(manager.getSession(pod.id).status).toBe('failed');
    // Only the original triggerValidation call — no follow-up scheduled.
    expect(triggerSpy).toHaveBeenCalledTimes(1);
  });

  it('conflict after abort transitions validating pod to review_required', async () => {
    const ctx = createTestContext({ overall: 'fail' });
    vi.mocked(ctx.worktreeManager.rebaseOntoBase).mockResolvedValue({
      alreadyUpToDate: false,
      rebased: false,
      conflicts: ['src/index.ts'],
    });

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Build widget' },
      'user-1',
    );
    ctx.podRepo.update(pod.id, {
      status: 'running',
      containerId: 'ctr-1',
      worktreePath: '/tmp/wt',
      validationAttempts: 2, // last attempt → max-attempts path
    });

    // Plant the intent during validation (as the abort would)
    vi.mocked(ctx.validationEngine.validate).mockImplementationOnce(async () => {
      await manager.updateFromBase(pod.id);
      return {
        podId: pod.id,
        attempt: 3,
        timestamp: new Date().toISOString(),
        smoke: {
          status: 'fail' as const,
          build: { status: 'fail' as const, output: 'fail', duration: 0 },
          health: { status: 'fail' as const, url: '', responseCode: null, duration: 0 },
          pages: [],
        },
        taskReview: null,
        overall: 'fail' as const,
        duration: 0,
      };
    });

    await manager.triggerValidation(pod.id);
    // Allow the async runUpdateFromBaseAfterAbort to complete
    await new Promise((r) => setImmediate(r));

    const refreshed = manager.getSession(pod.id);
    expect(refreshed.status).toBe('review_required');
    expect(refreshed.mergeBlockReason).toBeNull();
  });

  it('validation success clears pending intent so a later revalidation does not unexpectedly rebase', async () => {
    // Abort signal can arrive after the validation engine has already produced a pass.
    // The intent must not linger on a 'validated' pod that later re-enters validation
    // (e.g., after rejection), or the next failure would consume a stale rebase request.
    const ctx = createTestContext({ overall: 'pass' });
    vi.mocked(ctx.worktreeManager.rebaseOntoBase).mockResolvedValue({
      alreadyUpToDate: false,
      rebased: true,
      conflicts: [],
    });

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Build widget' },
      'user-1',
    );
    ctx.podRepo.update(pod.id, {
      status: 'running',
      containerId: 'ctr-1',
      worktreePath: '/tmp/wt',
      validationAttempts: 0,
    });

    // First validation: plant the intent mid-run (the abort race), then succeed.
    vi.mocked(ctx.validationEngine.validate).mockImplementationOnce(async () => {
      await manager.updateFromBase(pod.id);
      return {
        podId: pod.id,
        attempt: 1,
        timestamp: new Date().toISOString(),
        smoke: {
          status: 'pass' as const,
          build: { status: 'pass' as const, output: 'ok', duration: 0 },
          health: { status: 'pass' as const, url: '', responseCode: 200, duration: 0 },
          pages: [],
        },
        taskReview: null,
        overall: 'pass' as const,
        duration: 0,
      };
    });

    await manager.triggerValidation(pod.id);

    expect(manager.getSession(pod.id).status).toBe('validated');
    // The success path doesn't consume intents, so no rebase yet.
    expect(ctx.worktreeManager.rebaseOntoBase).not.toHaveBeenCalled();

    // Simulate the pod re-entering validation (e.g., after rejection).
    ctx.podRepo.update(pod.id, { status: 'rejected' });
    ctx.podRepo.update(pod.id, { status: 'running' });
    ctx.podRepo.update(pod.id, { validationAttempts: 0 });

    // Second validation fails — would consume any lingering intent on the retry path.
    vi.mocked(ctx.validationEngine.validate).mockImplementationOnce(async () => ({
      podId: pod.id,
      attempt: 1,
      timestamp: new Date().toISOString(),
      smoke: {
        status: 'fail' as const,
        build: { status: 'fail' as const, output: 'fail', duration: 0 },
        health: { status: 'fail' as const, url: '', responseCode: null, duration: 0 },
        pages: [],
      },
      taskReview: null,
      overall: 'fail' as const,
      duration: 0,
    }));

    await manager.triggerValidation(pod.id);
    await new Promise((r) => setImmediate(r));

    // The first run's intent should have been cleared on success — no rebase fired.
    expect(ctx.worktreeManager.rebaseOntoBase).not.toHaveBeenCalled();
  });

  it('invalid status returns INVALID_STATE 409', async () => {
    const ctx = createTestContext();
    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Build widget' },
      'user-1',
    );
    // Pod is in 'queued' — ineligible

    await expect(manager.updateFromBase(pod.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      statusCode: 409,
    });
  });

  it('missing worktree returns INVALID_STATE 400', async () => {
    const ctx = createTestContext();
    const { manager, pod } = setupParkedPod(ctx, 'failed', { worktreePath: null });

    await expect(manager.updateFromBase(pod.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      statusCode: 400,
    });
  });

  it('compromised worktree returns WORKTREE_COMPROMISED 409', async () => {
    const ctx = createTestContext();
    const { manager, pod } = setupParkedPod(ctx, 'failed', { worktreeCompromised: true });

    await expect(manager.updateFromBase(pod.id)).rejects.toMatchObject({
      code: 'WORKTREE_COMPROMISED',
      statusCode: 409,
    });
  });
});
