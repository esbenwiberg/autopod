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
    expect(createPodManager(ctx.deps).getSession(pod.id).failureReason).toBe(
      'Token budget reached after coding completed (6000/5000 tokens used). Adjust the task budget, then retry checks; no interrupted coding worker remains.',
    );
    expect(updated.pauseReason).toBeNull();
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
    expect(updated.failureReason).toBe(
      'Token budget reached after coding completed (6000/5000 tokens used). Adjust the task budget, then retry checks; no interrupted coding worker remains.',
    );
    expect(updated.pauseReason).toBeNull();
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

describe('Token budget — first-class pause approval', () => {
  function budgetPausedPod(maxBudgetExtensions: number | null = null, budgetExtensionsUsed = 0) {
    const ctx = createTestContext();
    insertBudgetProfile(ctx.db, {
      tokenBudget: 5_000,
      tokenBudgetPolicy: 'soft',
      maxBudgetExtensions,
    });
    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession({ profileName: 'test-profile', task: 'Do stuff' }, 'user-1');
    ctx.podRepo.update(pod.id, { status: 'paused', pauseReason: 'budget', budgetExtensionsUsed });
    return { ctx, manager, podId: pod.id };
  }
  const human = { type: 'human' as const, userId: 'user-1' };
  function pendingCompletion() {
    let settle!: { resolve: () => void; reject: (err: Error) => void };
    const promise = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
    return { promise, ...settle };
  }

  it('records the approval and returns before background validation finishes', async () => {
    const { ctx, manager, podId } = budgetPausedPod();
    const completion = pendingCompletion();
    const handleCompletion = vi
      .spyOn(manager, 'handleCompletion')
      .mockReturnValue(completion.promise);

    const result = await manager.approveBudgetPause(podId, human, { backgroundCompletion: true });

    expect(result).toEqual({
      action: 'continue-budget',
      budgetExtensionsUsed: 1,
      maxBudgetExtensions: null,
      validation: 'started',
    });
    expect(handleCompletion).toHaveBeenCalledExactlyOnceWith(podId);
    const approved = ctx.podRepo.getOrThrow(podId);
    expect(approved).toMatchObject({ status: 'running', pauseReason: null });
    expect(approved.budgetExtensionsUsed).toBe(1);
    completion.resolve();
    await completion.promise;
  });

  it('records a failure from the background completion on the pod', async () => {
    const { ctx, manager, podId } = budgetPausedPod();
    const completion = pendingCompletion();
    vi.spyOn(manager, 'handleCompletion').mockReturnValue(completion.promise);

    await manager.approveBudgetPause(podId, human, { backgroundCompletion: true });
    expect(ctx.podRepo.getOrThrow(podId).status).toBe('running');
    completion.reject(new Error('validation container vanished'));

    await vi.waitFor(() => expect(ctx.podRepo.getOrThrow(podId).status).toBe('failed'));
    expect(ctx.podRepo.getOrThrow(podId).failureReason).toBe(
      'Validation after budget approval failed: validation container vanished',
    );
  });

  it('still awaits and rethrows completion failures for in-process callers', async () => {
    const { ctx, manager, podId } = budgetPausedPod();
    vi.spyOn(manager, 'handleCompletion').mockRejectedValue(new Error('boom'));

    await expect(manager.approveBudgetPause(podId, human)).rejects.toThrow('boom');
    expect(ctx.podRepo.getOrThrow(podId).status).toBe('failed');
  });

  it('keeps the maxBudgetExtensions limit', async () => {
    const { ctx, manager, podId } = budgetPausedPod(1, 1);
    const handleCompletion = vi.spyOn(manager, 'handleCompletion');

    await expect(
      manager.approveBudgetPause(podId, human, { backgroundCompletion: true }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect(handleCompletion).not.toHaveBeenCalled();
    expect(ctx.podRepo.getOrThrow(podId)).toMatchObject({
      status: 'paused',
      pauseReason: 'budget',
      budgetExtensionsUsed: 1,
    });
  });

  it('rejects pods that are not paused on their token budget', async () => {
    const { ctx, manager, podId } = budgetPausedPod();
    ctx.podRepo.update(podId, { pauseReason: 'manual' });

    await expect(manager.approveBudgetPause(podId, human)).rejects.toMatchObject({
      code: 'NOT_BUDGET_PAUSED',
      message: expect.stringContaining('pause reason: manual'),
    });
  });

  it('keeps native Goal pods on the Goal control', async () => {
    const { ctx, podId } = budgetPausedPod();
    const goalManager = createPodManager({
      ...ctx.deps,
      launchConfiguration: { read: () => ({ intent: 'goal' }) },
    } as unknown as Parameters<typeof createPodManager>[0]);

    await expect(goalManager.approveBudgetPause(podId, human)).rejects.toMatchObject({
      code: 'GOAL_NATIVE_RESUME_REQUIRED',
      message: expect.stringContaining('--resume'),
    });
    expect(ctx.podRepo.getOrThrow(podId).budgetExtensionsUsed).toBe(0);
  });

  it('lets Resume approve a budget-paused pod without waiting for validation', async () => {
    const { ctx, manager, podId } = budgetPausedPod();
    vi.spyOn(manager, 'handleCompletion').mockReturnValue(new Promise(() => {}));

    await expect(
      manager.resumePod(podId, { backgroundValidation: true, actor: human }),
    ).resolves.toEqual({ action: 'continue-budget' });
    expect(ctx.podRepo.getOrThrow(podId)).toMatchObject({ status: 'running', pauseReason: null });
  });

  it('names the right command when Resume does not apply to a paused pod', async () => {
    const { ctx, manager, podId } = budgetPausedPod();
    ctx.podRepo.update(podId, { pauseReason: 'manual' });
    await expect(manager.resumePod(podId)).rejects.toThrow(`run: ap tell ${podId}`);
    ctx.podRepo.update(podId, { pauseReason: 'provider_limit' });
    await expect(manager.resumePod(podId)).rejects.toThrow(`ap continue-provider ${podId}`);
  });

  it('keeps ap tell as a compatible, non-blocking approval path', async () => {
    const { ctx, manager, podId } = budgetPausedPod();
    vi.spyOn(manager, 'handleCompletion').mockReturnValue(new Promise(() => {}));

    await manager.sendMessage(podId, 'approved', human, { backgroundCompletion: true });

    expect(ctx.podRepo.getOrThrow(podId)).toMatchObject({
      status: 'running',
      pauseReason: null,
      budgetExtensionsUsed: 1,
    });
  });
});
