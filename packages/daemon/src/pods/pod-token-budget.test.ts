import { describe, expect, it, vi } from 'vitest';
import {
  completeWithTokensEvent,
  createTestContext,
  statusEvent,
} from '../test-utils/mock-helpers.js';
import { createPodManager } from './pod-manager.js';

// Stubs for child_process (needed by pod-manager imports)
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

/** Insert a profile with a token budget into the test DB. */
function insertBudgetProfile(
  db: import('better-sqlite3').Database,
  opts: {
    name?: string;
    tokenBudget?: number | null;
    tokenBudgetPolicy?: 'soft' | 'hard';
    tokenBudgetWarnAt?: number;
    maxBudgetExtensions?: number | null;
  } = {},
) {
  const name = opts.name ?? 'test-profile';
  db.prepare(`
    INSERT OR REPLACE INTO profiles (
      name, repo_url, default_branch, template, build_command, start_command,
      health_path, health_timeout, validation_pages, max_validation_attempts,
      default_model, default_runtime, escalation_config,
      token_budget, token_budget_policy, token_budget_warn_at, max_budget_extensions
    ) VALUES (
      @name, @repoUrl, @defaultBranch, @template, @buildCommand, @startCommand,
      @healthPath, @healthTimeout, @validationPages, @maxValidationAttempts,
      @defaultModel, @defaultRuntime, @escalationConfig,
      @tokenBudget, @tokenBudgetPolicy, @tokenBudgetWarnAt, @maxBudgetExtensions
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
      askAi: { enabled: false, model: 'sonnet', maxCalls: 5 },
      advisor: { enabled: false },
      autoPauseAfter: 3,
      humanResponseTimeout: 3600,
    }),
    tokenBudget: opts.tokenBudget ?? null,
    tokenBudgetPolicy: opts.tokenBudgetPolicy ?? 'soft',
    tokenBudgetWarnAt: opts.tokenBudgetWarnAt ?? 0.8,
    maxBudgetExtensions: opts.maxBudgetExtensions ?? null,
  });
}

describe('Token budget — createSession', () => {
  it('inherits tokenBudget from profile', () => {
    const ctx = createTestContext();
    insertBudgetProfile(ctx.db, { tokenBudget: 50_000 });

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession({ profileName: 'test-profile', task: 'Do stuff' }, 'user-1');
    expect(pod.tokenBudget).toBe(50_000);
  });

  it('allows per-pod override of tokenBudget', () => {
    const ctx = createTestContext();
    insertBudgetProfile(ctx.db, { tokenBudget: 50_000 });

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Do stuff', tokenBudget: 10_000 },
      'user-1',
    );
    expect(pod.tokenBudget).toBe(10_000);
  });

  it('allows disabling budget with explicit null override', () => {
    const ctx = createTestContext();
    insertBudgetProfile(ctx.db, { tokenBudget: 50_000 });

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Do stuff', tokenBudget: null },
      'user-1',
    );
    expect(pod.tokenBudget).toBeNull();
  });

  it('stores null when profile has no budget and no override', () => {
    const ctx = createTestContext();
    // test-profile from createTestContext has no tokenBudget

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession({ profileName: 'test-profile', task: 'Do stuff' }, 'user-1');
    expect(pod.tokenBudget).toBeNull();
  });
});

describe('Token budget — consumeAgentEvents', () => {
  it('accumulates input and output tokens from complete event', async () => {
    const ctx = createTestContext();
    insertBudgetProfile(ctx.db, { tokenBudget: 100_000 });

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession({ profileName: 'test-profile', task: 'Do stuff' }, 'user-1');
    // consumeAgentEvents expects pod in 'running' state
    ctx.podRepo.update(pod.id, { status: 'running' });

    async function* events() {
      yield statusEvent('Working…');
      yield completeWithTokensEvent(1000, 500);
    }

    await manager.consumeAgentEvents(pod.id, events());

    const updated = ctx.podRepo.getOrThrow(pod.id);
    expect(updated.inputTokens).toBe(1000);
    expect(updated.outputTokens).toBe(500);
  });

  it('emits warning event when usage crosses the warn threshold', async () => {
    const ctx = createTestContext();
    // Budget 10000, warnAt 0.8 → warn at 8000
    insertBudgetProfile(ctx.db, { tokenBudget: 10_000, tokenBudgetWarnAt: 0.8 });

    const emitted: string[] = [];
    ctx.eventBus.subscribe((evt) => {
      emitted.push(evt.type);
    });

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession({ profileName: 'test-profile', task: 'Do stuff' }, 'user-1');
    ctx.podRepo.update(pod.id, { status: 'running' });

    // 8500 tokens total > 8000 warn threshold, < 10000 limit
    async function* events() {
      yield completeWithTokensEvent(5000, 3500);
    }

    await manager.consumeAgentEvents(pod.id, events());

    expect(emitted).toContain('pod.token_budget_warning');
    const updated = ctx.podRepo.getOrThrow(pod.id);
    expect(updated.status).toBe('running'); // not paused — just warned
  });

  it('pauses pod with pauseReason=budget on soft-limit exceeded', async () => {
    const ctx = createTestContext();
    insertBudgetProfile(ctx.db, { tokenBudget: 5_000, tokenBudgetPolicy: 'soft' });

    const emitted: string[] = [];
    ctx.eventBus.subscribe((evt) => {
      emitted.push(evt.type);
    });

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession({ profileName: 'test-profile', task: 'Do stuff' }, 'user-1');
    ctx.podRepo.update(pod.id, { status: 'running' });

    // 6000 tokens total > 5000 budget
    async function* events() {
      yield completeWithTokensEvent(4000, 2000);
    }

    await manager.consumeAgentEvents(pod.id, events());

    const updated = ctx.podRepo.getOrThrow(pod.id);
    expect(updated.status).toBe('paused');
    expect(updated.pauseReason).toBe('budget');
    expect(emitted).toContain('pod.token_budget_exceeded');
  });

  it('fails pod with hard-limit policy when budget exceeded', async () => {
    const ctx = createTestContext();
    insertBudgetProfile(ctx.db, { tokenBudget: 5_000, tokenBudgetPolicy: 'hard' });

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession({ profileName: 'test-profile', task: 'Do stuff' }, 'user-1');
    ctx.podRepo.update(pod.id, { status: 'running' });

    async function* events() {
      yield completeWithTokensEvent(4000, 2000);
    }

    await manager.consumeAgentEvents(pod.id, events());

    const updated = ctx.podRepo.getOrThrow(pod.id);
    expect(updated.status).toBe('failed');
  });

  it('fails pod when maxBudgetExtensions exhausted', async () => {
    const ctx = createTestContext();
    insertBudgetProfile(ctx.db, {
      tokenBudget: 5_000,
      tokenBudgetPolicy: 'soft',
      maxBudgetExtensions: 0,
    });

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession({ profileName: 'test-profile', task: 'Do stuff' }, 'user-1');
    ctx.podRepo.update(pod.id, { status: 'running' });

    async function* events() {
      yield completeWithTokensEvent(4000, 2000);
    }

    await manager.consumeAgentEvents(pod.id, events());

    const updated = ctx.podRepo.getOrThrow(pod.id);
    // maxBudgetExtensions=0 means no extensions allowed → hard stop
    expect(updated.status).toBe('failed');
  });

  it('does not enforce budget when token counts are zero (no token data from runtime)', async () => {
    const ctx = createTestContext();
    insertBudgetProfile(ctx.db, { tokenBudget: 5_000 });

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession({ profileName: 'test-profile', task: 'Do stuff' }, 'user-1');
    ctx.podRepo.update(pod.id, { status: 'running' });

    // completeEvent without token counts → should not pause
    async function* events() {
      yield { type: 'complete' as const, timestamp: new Date().toISOString(), result: 'Done' };
    }

    await manager.consumeAgentEvents(pod.id, events());

    const updated = ctx.podRepo.getOrThrow(pod.id);
    expect(updated.status).toBe('running'); // unchanged — no budget enforcement
  });
});

describe('Token budget — sendMessage approval', () => {
  it('clears pauseReason and increments budgetExtensionsUsed on approval', async () => {
    const ctx = createTestContext();
    insertBudgetProfile(ctx.db, { tokenBudget: 5_000, tokenBudgetPolicy: 'soft' });

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession({ profileName: 'test-profile', task: 'Do stuff' }, 'user-1');

    // Manually put pod into budget-paused state
    ctx.podRepo.update(pod.id, {
      status: 'paused',
      pauseReason: 'budget',
      inputTokens: 4000,
      outputTokens: 2000,
    });

    await manager.sendMessage(pod.id, 'approved');

    const updated = ctx.podRepo.getOrThrow(pod.id);
    expect(updated.pauseReason).toBeNull();
    expect(updated.budgetExtensionsUsed).toBe(1);
  });

  it('rejects approval when maxBudgetExtensions already exhausted', async () => {
    const ctx = createTestContext();
    insertBudgetProfile(ctx.db, {
      tokenBudget: 5_000,
      tokenBudgetPolicy: 'soft',
      maxBudgetExtensions: 1,
    });

    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession({ profileName: 'test-profile', task: 'Do stuff' }, 'user-1');

    // Already used 1 extension
    ctx.podRepo.update(pod.id, {
      status: 'paused',
      pauseReason: 'budget',
      budgetExtensionsUsed: 1,
    });

    await expect(manager.sendMessage(pod.id, 'approved')).rejects.toThrow(
      'maximum budget extensions',
    );
  });
});
