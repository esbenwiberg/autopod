import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentEvent, SystemEvent } from '@autopod/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderAccountHealthStore } from '../provider-accounts/provider-account-health.js';
import { createProviderAccountStore } from '../provider-accounts/provider-account-store.js';
import { classifyProviderError } from '../runtimes/provider-error-classifier.js';
import { createTestContext } from '../test-utils/mock-helpers.js';
import { createPodManager } from './pod-manager.js';
import { createProviderAttemptRepository } from './provider-attempt-repository.js';

const OUT_OF_CREDITS = 'Credit balance is too low';
const worktrees: string[] = [];
afterEach(() => {
  for (const dir of worktrees.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Real SQLite pod manager with legacy profile failover: source → dead → target. */
function fixture(targets: string[]) {
  const ctx = createTestContext();
  const attempts = createProviderAttemptRepository(ctx.db);
  ctx.deps.providerAttemptRepo = attempts;
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
  });
  const refuse = () =>
    manager.consumeAgentEvents(
      pod.id,
      (async function* (): AsyncIterable<AgentEvent> {
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
