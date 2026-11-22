import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentEvent, SystemEvent } from '@autopod/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderAccountHealthStore } from '../provider-accounts/provider-account-health.js';
import { createProviderAccountStore } from '../provider-accounts/provider-account-store.js';
import { classifyProviderError } from '../runtimes/provider-error-classifier.js';
import { createTestContext } from '../test-utils/mock-helpers.js';
import { createEventRepository } from './event-repository.js';
import { createPodManager } from './pod-manager.js';
import { createProviderAttemptRepository } from './provider-attempt-repository.js';
import { createUnmeasuredUsageAcceptance } from './unmeasured-usage-acceptance.js';

const OUT_OF_CREDITS = 'Credit balance is too low';
const worktrees: string[] = [];
afterEach(() => {
  for (const dir of worktrees.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Real SQLite pod manager with legacy profile failover: source → dead → target. */
function fixture(targets: string[], options: { tokenBudget?: number } = {}) {
  const ctx = createTestContext();
  const attempts = createProviderAttemptRepository(ctx.db);
  ctx.deps.providerAttemptRepo = attempts;
  ctx.deps.eventRepo = createEventRepository(ctx.db);
  const accounts = createProviderAccountStore(ctx.db);
  accounts.create({
    id: 'source',
    name: 'source',
    provider: 'anthropic',
    credentials: { provider: 'anthropic', apiKey: 'source-key' },
  });
  for (const id of ['dead', 'target'])
    accounts.create({
      id,
      name: id,
      provider: 'openai',
      credentials: { provider: 'openai', authJson: `{"key":"${id}"}` },
    });
  const policy = {
    targets: targets.map((providerAccountId) => ({
      providerAccountId,
      runtime: 'codex' as const,
      model: 'gpt-next',
    })),
  };
  // The shared mock profile store has no account link or failover resolution.
  const readProfile = vi.mocked(ctx.profileStore.get).getMockImplementation()!;
  vi.mocked(ctx.profileStore.get).mockImplementation((name) => ({
    ...readProfile(name),
    modelProvider: 'anthropic',
    providerAccountId: 'source',
    providerFailover: policy,
  }));
  Object.assign(ctx.profileStore, {
    resolveProviderFailover: vi.fn(() => ({ policy, source: 'profile' as const })),
  });
  ctx.deps.providerAccountStore = accounts;
  const health = createProviderAccountHealthStore(ctx.db, accounts);
  ctx.deps.providerAccountHealth = health;
  ctx.deps.requeueSessionAfterCurrent = vi.fn();
  ctx.worktreeManager.ensureExcludes = vi.fn(async () => {});
  const worktreePath = mkdtempSync(path.join(tmpdir(), 'autopod-account-failover-'));
  worktrees.push(worktreePath);
  const activity: string[] = [];
  ctx.eventBus.subscribe((event: SystemEvent) => {
    if (event.type === 'pod.agent_activity' && event.event.type === 'status')
      activity.push(event.event.message);
  });
  const manager = createPodManager(ctx.deps);
  const pod = manager.createSession({ profileName: 'test-profile', task: 'Failover' }, 'user-1');
  ctx.enqueuedSessions.length = 0;
  ctx.podRepo.update(pod.id, {
    status: 'running',
    worktreePath,
    containerId: 'source-container',
    ...(options.tokenBudget !== undefined && { tokenBudget: options.tokenBudget }),
  });
  const refuse = (before: AgentEvent[] = []) =>
    manager.consumeAgentEvents(
      pod.id,
      (async function* (): AsyncIterable<AgentEvent> {
        yield* before;
        yield {
          type: 'error',
          timestamp: new Date().toISOString(),
          message: OUT_OF_CREDITS,
          fatal: true,
          classification: classifyProviderError('claude', { message: OUT_OF_CREDITS }),
        };
      })(),
    );
  return { ctx, attempts, health, manager, podId: pod.id, refuse, activity };
}

describe('provider account refusal failover', () => {
  it('settles a zero-usage refusal so the budgeted failover run is admitted (#646)', async () => {
    const f = fixture(['target'], { tokenBudget: 1_000_000 });

    expect(await f.refuse()).toBe('paused');

    const queued = f.manager.getSession(f.podId);
    expect(queued).toMatchObject({
      status: 'queued',
      providerAccountIdSnapshot: 'target',
      tokenTelemetryAccuracy: 'complete',
      phaseTokenUsage: { agent_initial: { inputTokens: 0, outputTokens: 0 } },
    });
    expect(f.activity.join('\n')).toContain(
      'Provider refused attempt #1 (claude/opus) before any model usage; recorded zero token usage.',
    );
    expect(f.ctx.podRepo.taskExecutions?.snapshot(f.podId).budgetCheck?.status).toBe(
      'below_recorded_limit',
    );

    // The failover run starts after re-provisioning and is admitted by the ledger.
    f.ctx.podRepo.update(f.podId, { status: 'running', containerId: 'target-container' });
    const outcome = await f.manager.consumeAgentEvents(
      f.podId,
      (async function* (): AsyncIterable<AgentEvent> {
        yield {
          type: 'complete',
          timestamp: new Date().toISOString(),
          result: 'done',
          totalInputTokens: 10,
          totalOutputTokens: 5,
        };
      })(),
    );
    expect(outcome).toBe('completed');
    expect(
      f.ctx.db.prepare('SELECT outcome FROM task_agent_runs ORDER BY started_at, rowid').all(),
    ).toEqual([{ outcome: 'paused' }, { outcome: 'completed' }]);
    expect(f.attempts.list(f.podId)).toMatchObject([
      { providerAccountId: 'source', outcome: 'failed' },
      { providerAccountId: 'target', outcome: 'completed', inputTokens: 10, outputTokens: 5 },
    ]);
  });

  it('blocks the failover before re-preparation when the refused attempt may have used tokens', async () => {
    const f = fixture(['target'], { tokenBudget: 1_000_000 });

    expect(
      await f.refuse([
        {
          type: 'tool_use',
          timestamp: new Date().toISOString(),
          tool: 'Bash',
          input: { command: 'ls' },
        },
      ]),
    ).toBe('paused');

    const parked = f.manager.getSession(f.podId);
    expect(parked).toMatchObject({
      status: 'paused',
      pauseReason: 'provider_limit',
      providerAccountIdSnapshot: 'source',
      tokenTelemetryAccuracy: 'partial',
    });
    expect(parked.failureReason).toContain(
      `Task token accounting incomplete for pod ${f.podId} provider attempt #1 (claude/opus, failed)`,
    );
    expect(parked.failureReason).toContain(`ap accept-unmeasured-usage ${f.podId}`);
    // No target attempt opened and nothing requeued: no second preparation is spent.
    expect(f.attempts.list(f.podId)).toHaveLength(1);
    expect(f.ctx.deps.requeueSessionAfterCurrent).not.toHaveBeenCalled();
    expect(f.ctx.enqueuedSessions).toEqual([]);
    expect(f.activity.join('\n')).not.toContain('recorded zero token usage');
  });

  it('keeps the budget block for a usage-incomplete refusal', async () => {
    const f = fixture(['target'], { tokenBudget: 1_000_000 });

    await f.refuse([
      {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: 'usage conflict',
        fatal: false,
        usageIncomplete: true,
      },
    ]);

    expect(f.manager.getSession(f.podId)).toMatchObject({
      status: 'paused',
      pauseReason: 'provider_limit',
      tokenTelemetryAccuracy: 'partial',
    });
    expect(f.attempts.list(f.podId)).toHaveLength(1);
  });

  it('continues on the next healthy account, skipping a known-unhealthy one with a receipt', async () => {
    const f = fixture(['dead', 'target']);
    f.health.recordFailure('dead', 'out_of_credits', 'Out of credits', 'earlier-pod');

    expect(await f.refuse()).toBe('paused');

    expect(f.manager.getSession(f.podId)).toMatchObject({
      status: 'queued',
      runtime: 'codex',
      model: 'gpt-next',
      providerAccountIdSnapshot: 'target',
      failureReason: null,
    });
    expect(f.attempts.list(f.podId)).toMatchObject([
      {
        providerAccountId: 'source',
        outcome: 'failed',
        classification: { category: 'auth', definitive: true },
        handoffReference: '.autopod/provider-failover.md',
      },
      { providerAccountId: 'target', outcome: null },
    ]);
    expect(f.health.current('source')).toMatchObject({
      state: 'out_of_credits',
      source: 'observed_failure',
    });
    expect(f.activity.join('\n')).toContain(
      'Provider failover skipped account=dead runtime=codex model=gpt-next: dead: out of credits',
    );
    // The handed-over run is a pause, not a nonretryable worker failure blocking the target.
    expect(f.ctx.db.prepare('SELECT outcome, failure_category FROM task_agent_runs').all()).toEqual(
      [{ outcome: 'paused', failure_category: 'auth' }],
    );
    expect(f.ctx.deps.requeueSessionAfterCurrent).toHaveBeenCalledWith(f.podId);
  });

  it('fails as today when every failover target is known-unhealthy, naming the skipped ones', async () => {
    const f = fixture(['dead']);
    f.health.recordFailure('dead', 'auth_revoked', 'OAuth token revoked', 'earlier-pod');

    expect(await f.refuse()).toBe('failed');

    expect(f.manager.getSession(f.podId)).toMatchObject({
      status: 'failed',
      pauseReason: null,
      failureReason: `Provider account unavailable: ${OUT_OF_CREDITS}`,
    });
    expect(f.attempts.list(f.podId)).toHaveLength(1);
    expect(f.activity.join('\n')).toContain(
      'Provider failover skipped account=dead runtime=codex model=gpt-next: dead: login revoked',
    );
    expect(f.ctx.deps.requeueSessionAfterCurrent).not.toHaveBeenCalled();
  });

  it('settles as failed when the provider-limit teardown cannot be proven', async () => {
    const f = fixture(['target']);
    vi.mocked(f.ctx.containerManager.kill).mockRejectedValue(new Error('kill failed'));

    await f.refuse();

    expect(f.manager.getSession(f.podId)).toMatchObject({
      status: 'failed',
      pauseReason: null,
      containerId: 'source-container',
    });
    expect(f.ctx.deps.requeueSessionAfterCurrent).not.toHaveBeenCalled();
  });
});

describe('owner acceptance of unmeasured usage (#646)', () => {
  const toolUse: AgentEvent = {
    type: 'tool_use',
    timestamp: new Date().toISOString(),
    tool: 'Bash',
    input: { command: 'ls' },
  };
  async function blocked() {
    const f = fixture(['target'], { tokenBudget: 1_000_000 });
    await f.refuse([toolUse]);
    const acceptance = createUnmeasuredUsageAcceptance({
      db: f.ctx.db,
      podRepo: f.ctx.podRepo,
      providerAttemptRepo: f.attempts,
      continueAfterAcceptance: (podId) => f.manager.continueAfterAcceptedUsage(podId),
    });
    const receipts = () => f.ctx.db.prepare('SELECT * FROM unmeasured_usage_acceptances').all();
    return { ...f, acceptance, receipts };
  }
  const REASON = 'Codex refused the account before doing useful work';

  it('records an audited receipt, reconciles accounting and queues the failover', async () => {
    const f = await blocked();

    const result = await f.acceptance.accept(
      f.podId,
      { reason: REASON, attemptOrdinal: 1 },
      { oid: 'user-1' },
    );

    expect(result).toMatchObject({
      continuation: 'queued',
      receipt: {
        podId: f.podId,
        providerAttemptOrdinal: 1,
        acceptedBy: 'user-1',
        authorizationBasis: 'pod_owner',
        reason: REASON,
        priorAccuracy: 'partial',
        recordedInputTokens: 0,
        recordedOutputTokens: 0,
      },
    });
    expect(f.receipts()).toHaveLength(1);
    expect(f.manager.getSession(f.podId)).toMatchObject({
      status: 'queued',
      providerAccountIdSnapshot: 'target',
      tokenTelemetryAccuracy: 'repaired',
      failureReason: null,
    });
    const task = f.ctx.podRepo.taskExecutions?.snapshot(f.podId);
    expect(task?.budgetCheck?.status).toBe('below_recorded_limit');
    expect(task?.diagnostics).toContain(
      `${f.podId}: provider attempt #1 usage accepted as unmeasured by pod owner`,
    );
    expect(f.attempts.list(f.podId)).toMatchObject([
      { providerAccountId: 'source', outcome: 'failed' },
      { providerAccountId: 'target', outcome: null },
    ]);
    expect(f.ctx.enqueuedSessions).toContain(f.podId);
    // The receipt is append-only audit evidence.
    expect(() =>
      f.ctx.db.prepare("UPDATE unmeasured_usage_acceptances SET reason = 'changed reason'").run(),
    ).toThrow('append-only');
    expect(() => f.ctx.db.prepare('DELETE FROM unmeasured_usage_acceptances').run()).toThrow(
      'append-only',
    );
    // The pod now has an active target attempt and reconciled accounting: no second acceptance.
    await expect(
      f.acceptance.accept(f.podId, { reason: REASON }, { oid: 'user-1' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it.each([
    ['another user', 'user-2'],
    ['an admin/operator identity', 'admin'],
    ['an unauthenticated caller', ' '],
  ])('rejects %s with 403 and records nothing', async (_name, oid) => {
    const f = await blocked();

    await expect(f.acceptance.accept(f.podId, { reason: REASON }, { oid })).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });

    expect(f.receipts()).toEqual([]);
    expect(f.manager.getSession(f.podId)).toMatchObject({
      status: 'paused',
      tokenTelemetryAccuracy: 'partial',
    });
  });

  it('rejects a mismatched attempt or a short reason without recording', async () => {
    const f = await blocked();

    await expect(
      f.acceptance.accept(f.podId, { reason: REASON, attemptOrdinal: 2 }, { oid: 'user-1' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PROVIDER_ATTEMPT_MISMATCH' });
    await expect(
      f.acceptance.accept(f.podId, { reason: 'too short' }, { oid: 'user-1' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(f.receipts()).toEqual([]);
  });

  it('refuses when accounting is already settled', async () => {
    const f = fixture(['target'], { tokenBudget: 1_000_000 });
    await f.refuse();
    const acceptance = createUnmeasuredUsageAcceptance({
      db: f.ctx.db,
      podRepo: f.ctx.podRepo,
      providerAttemptRepo: f.attempts,
    });
    // Zero-usage refusal already settled and queued the failover.
    await expect(
      acceptance.accept(f.podId, { reason: REASON }, { oid: 'user-1' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
