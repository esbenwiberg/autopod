import type { EffectiveLaunchConfig } from '@autopod/shared';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionAuditRepository } from '../actions/audit-repository.js';
import { podRoutes } from '../api/routes/pods.js';
import { createPodManager } from '../pods/pod-manager.js';
import type { PodUpdates } from '../pods/pod-repository.js';
import { unavailableWorkerInputs, workerBindingHash } from '../pods/worker-retry-history.js';
import { createProviderAccountStore } from '../provider-accounts/provider-account-store.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestContext } from '../test-utils/mock-helpers.js';
import { createConfigurationComponents } from './components.js';
import { configurationDigest } from './configuration-digest.js';
import { createConfigurationCredentialStore } from './credential-store.js';
import type { DerivedLaunchInput } from './derive-launch.js';
import { admitLaunch } from './launch-admission.js';
import { launchPodOptions } from './launch-pod-options.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of close.splice(0)) await cleanup();
});

async function fixture() {
  const ctx = createTestContext();
  const configuration = createTestConfiguration(ctx.db);
  const accounts = createProviderAccountStore(ctx.db);
  accounts.create({
    id: 'account',
    name: 'Fixture',
    provider: 'anthropic',
    credentials: { provider: 'anthropic', apiKey: 'fixture-key' },
  });
  const components = createConfigurationComponents({
    db: ctx.db,
    pods: ctx.podRepo,
    logger: ctx.deps.logger,
    accounts,
    credentials: createConfigurationCredentialStore(
      ctx.db,
      { encrypt: (s) => s, decrypt: (s) => s },
      async () => {},
    ),
    images: {
      resolveEnvironment: configuration.services.resolveEnvironment,
      buildEnvironmentImage: vi.fn(),
    },
    github: { get: vi.fn(), mutate: vi.fn(), download: vi.fn() },
    audit: createActionAuditRepository(ctx.db),
    reviewer: { manager: () => ctx.containerManager, image: () => 'fixture-image' },
    ports: configuration.services,
    admissionReady: () => ({ ready: true }),
    podManager: () => manager,
  });
  const manager = createPodManager({
    ...ctx.deps,
    providerAccountStore: accounts,
    launchConfiguration: components.launchConfiguration,
  });
  const insert = (id: string, config: EffectiveLaunchConfig) => {
    ctx.podRepo.insert({
      id,
      profileName: config.profileId,
      task: config.task,
      status: 'queued',
      runtime: config.ai.main.runtime,
      model: config.ai.main.model,
      executionTarget: 'local',
      dispatchRepository: config.repository?.config.remote ?? null,
      branch: config.work.branch ?? 'fixture/repair',
      baseBranch: config.work.baseBranch ?? 'main',
      linkedPodId: config.work.linkedPodId,
      userId: 'operator',
      maxValidationAttempts: 3,
      skipValidation: false,
      options: launchPodOptions(config),
      outputMode: 'pr',
      tokenBudget: 1000,
      providerAccountIdSnapshot: 'account',
      providerIdSnapshot: 'anthropic',
    });
    return id;
  };
  const parent = await admitLaunch({
    request: {
      repositoryId: 'repo-a',
      task: 'Repair the original task',
      selections: { githubAccessId: null },
      work: { branch: 'fixture/repair', baseBranch: 'main' },
    },
    actorId: 'operator',
    services: components.resolution,
    snapshots: components.snapshots,
    createPod: (config) => insert('root', config),
  });
  ctx.podRepo.update('root', {
    status: 'merge_pending',
    prUrl: 'https://github.com/org/repo-a/pull/1',
    maxPrFixAttempts: 3,
  });
  const app = Fastify();
  podRoutes(app, manager, ctx.eventRepo, undefined, ctx.podRepo);
  close.push(async () => {
    await app.close();
    ctx.db.close();
  });
  const request = () =>
    app.inject({
      method: 'POST',
      url: '/pods/root/spawn-fix',
      payload: { message: 'Synthetic review feedback' },
    });
  const child = () => {
    const id = ctx.podRepo.getOrThrow('root').fixPodId;
    if (!id) throw new Error('Missing canonical fix');
    return ctx.podRepo.getOrThrow(id);
  };
  const input = (fixAttempt?: number): DerivedLaunchInput => ({
    source: { podId: 'root', digest: parent.config.digest, kind: 'fix' },
    task: '[PR FIX] Awaiting queued feedback.',
    work: {
      branch: 'fixture/repair',
      baseBranch: 'main',
      linkedPodId: 'root',
      dependsOnPodIds: [],
    },
    ...(fixAttempt === undefined ? {} : { fixAttempt }),
  });
  const derive = (
    value: DerivedLaunchInput,
    create = vi.fn((config: EffectiveLaunchConfig) => insert('direct-child', config)),
  ) => {
    const admit = components.launchConfiguration.admitDerived;
    if (!admit) throw new Error('Missing derived admission');
    return admit(value, create);
  };
  const receipts = () =>
    ctx.db.prepare('SELECT * FROM retained_pod_launch_snapshots ORDER BY pod_id').all();
  return {
    ...ctx,
    ...components,
    services: configuration.services,
    parent,
    insert,
    request,
    child,
    input,
    derive,
    receipts,
  };
}

describe('deleted canonical fix admission composition', () => {
  it('admits attempt two after archival without replaying the deleted first child', async () => {
    const f = await fixture();
    expect((await f.request()).statusCode).toBe(202);
    const first = f.child();
    const snapshot = f.snapshots.get(first.id);
    const legacyId = `derived-${configurationDigest(f.input())}`;
    expect(
      f.db.prepare('SELECT request_id FROM pod_launch_snapshots WHERE pod_id=?').get(first.id),
    ).toEqual({ request_id: legacyId });
    f.podRepo.update(first.id, { status: 'failed' });
    f.podRepo.delete(first.id);
    expect(() => f.podRepo.getOrThrow(first.id)).toThrow();
    expect(f.podRepo.getForHistory?.(first.id).id).toBe(first.id);
    expect(f.snapshots.get(first.id)).toEqual(snapshot);
    f.enqueuedSessions.length = 0;
    const result = await f.request();
    expect(result.statusCode, result.body).toBe(202);
    const second = f.child();
    expect(second.id).not.toBe(first.id);
    expect(f.podRepo.getOrThrow('root')).toMatchObject({ prFixAttempts: 2, maxPrFixAttempts: 3 });
    expect(f.enqueuedSessions).toEqual([second.id]);
    expect(f.fixFeedbackRepo.count('root')).toBe(2);
    expect(f.snapshots.get(first.id)).toEqual(snapshot);
    expect(f.snapshots.get(second.id)).toEqual(snapshot);
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });

  it('rejects the retained deleted admission readably before queue/event effects and preserves its audit', async () => {
    const f = await fixture();
    await f.request();
    const first = f.child();
    f.podRepo.update(first.id, { status: 'failed' });
    f.podRepo.delete(first.id);
    const before = f.receipts();
    f.enqueuedSessions.length = 0;
    const events = vi.fn();
    f.eventBus.subscribe(events);
    const create = vi.fn();
    await expect(f.derive(f.input(), create)).rejects.toMatchObject({
      code: 'CONFIG_ADMISSION_POD_DELETED',
      statusCode: 409,
      message: expect.stringContaining('deleted'),
    });
    expect(create).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    expect(f.enqueuedSessions).toEqual([]);
    expect(f.receipts()).toEqual(before);
    expect(f.podRepo.getOrThrow('root')).toMatchObject({
      prFixAttempts: 1,
      maxPrFixAttempts: 3,
      fixPodId: null,
    });
    expect(f.fixFeedbackRepo.count('root')).toBe(1);
  });

  it('replays repeated and concurrent admissions of the same ordinal exactly once', async () => {
    const f = await fixture();
    const create = vi.fn((config: EffectiveLaunchConfig) => f.insert('direct-child', config));
    const input = f.input(1);
    expect(await Promise.all([f.derive(input, create), f.derive(input, create)])).toEqual([
      'direct-child',
      'direct-child',
    ]);
    expect(await f.derive(f.input(), create)).toBe('direct-child');
    expect(create).toHaveBeenCalledOnce();
    expect(f.podRepo.getOrThrow('root')).toMatchObject({
      prFixAttempts: 1,
      fixPodId: 'direct-child',
    });
    await expect(f.derive({ ...input, task: 'Changed request' }, create)).rejects.toMatchObject({
      code: 'CONFIG_SOURCE_CHANGED',
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent public requests for attempt two and preserves all feedback', async () => {
    const f = await fixture();
    await f.request();
    const first = f.child();
    f.podRepo.update(first.id, { status: 'failed' });
    f.podRepo.delete(first.id);
    f.enqueuedSessions.length = 0;
    const events = vi.fn();
    f.eventBus.subscribe(events);
    const responses = await Promise.all([f.request(), f.request(), f.request()]);
    expect(responses.map((r) => r.statusCode)).toEqual([202, 202, 202]);
    const child = f.child();
    expect(responses.map((r) => r.json().fixPodId)).toEqual([child.id, child.id, child.id]);
    expect(f.enqueuedSessions).toEqual([child.id]);
    expect(events.mock.calls.filter(([event]) => event.type === 'pod.created')).toHaveLength(1);
    expect(f.podRepo.getOrThrow('root').prFixAttempts).toBe(2);
    expect(f.fixFeedbackRepo.count('root')).toBe(4);
    expect(await f.derive(f.input(2), vi.fn())).toBe(child.id);
    expect(f.podRepo.list().filter((pod) => pod.linkedPodId === 'root')).toHaveLength(1);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
    4,
    null,
    '2',
  ])('rejects invalid ordinal %s without admitting or mutating the parent', async (ordinal) => {
    const f = await fixture();
    const input = f.input();
    Object.defineProperty(input, 'fixAttempt', { value: ordinal, enumerable: true });
    const before = f.podRepo.getOrThrow('root');
    const create = vi.fn();
    await expect(f.derive(input, create)).rejects.toMatchObject({
      code: 'CONFIG_DERIVATION_INVALID',
    });
    expect(create).not.toHaveBeenCalled();
    expect(f.podRepo.getOrThrow('root')).toEqual(before);
  });

  it('accepts the next ordinal but rejects skipped ordinals, foreign linkage, source digest and non-fix ordinals', async () => {
    const f = await fixture();
    const create = vi.fn();
    await expect(f.derive(f.input(2), create)).rejects.toMatchObject({
      code: 'CONFIG_SOURCE_CHANGED',
    });
    const value = f.input(1);
    await expect(
      f.derive({ ...value, work: { ...value.work, linkedPodId: 'foreign' } }, create),
    ).rejects.toMatchObject({ code: 'CONFIG_SOURCE_CHANGED' });
    await expect(
      f.derive({ ...value, source: { ...value.source, digest: 'f'.repeat(64) } }, create),
    ).rejects.toMatchObject({ code: 'CONFIG_SOURCE_CHANGED' });
    await expect(
      f.derive({ ...value, source: { ...value.source, kind: 'manual-fix' } }, create),
    ).rejects.toMatchObject({ code: 'CONFIG_DERIVATION_INVALID' });
    expect(create).not.toHaveBeenCalled();
    expect((await f.request()).statusCode).toBe(202);
    expect(f.podRepo.getOrThrow('root').prFixAttempts).toBe(1);
  });

  const changes: Array<[string, PodUpdates]> = [
    ['status', { status: 'failed' }],
    ['counter', { prFixAttempts: 1 }],
    ['cap', { maxPrFixAttempts: 2 }],
    ['base', { baseBranch: 'changed' }],
    ['PR URL', { prUrl: 'https://github.com/org/repo-a/pull/2' }],
    ['provider', { providerAccountIdSnapshot: 'changed' }],
  ];
  it.each(changes)(
    'fences %s changes during async preflight and retains queued feedback',
    async (_name, changes) => {
      const f = await fixture();
      vi.mocked(f.services.assertCapabilities).mockImplementationOnce(async () => {
        f.podRepo.update('root', changes);
      });
      const response = await f.request();
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe('CONFIG_SOURCE_CHANGED');
      expect(f.enqueuedSessions).toEqual([]);
      expect(f.fixFeedbackRepo.count('root')).toBe(1);
      expect(f.podRepo.list().filter((p) => p.linkedPodId === 'root')).toEqual([]);
      expect(f.receipts()).toHaveLength(1);
    },
  );

  it.each(['launch_config_digest', 'branch', 'user_id'])(
    'fences a changed %s in the current parent after preflight',
    async (column) => {
      const f = await fixture();
      vi.mocked(f.services.assertCapabilities).mockImplementationOnce(async () => {
        f.db.prepare(`UPDATE pods SET ${column}=? WHERE id='root'`).run('changed');
      });
      const response = await f.request();
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe('CONFIG_SOURCE_CHANGED');
      expect(f.fixFeedbackRepo.count('root')).toBe(1);
      expect(f.enqueuedSessions).toEqual([]);
    },
  );

  it('fences lifecycle generation changes during async preflight', async () => {
    const f = await fixture();
    vi.mocked(f.services.assertCapabilities).mockImplementationOnce(async () => {
      f.podRepo.incrementLifecycleGeneration('root');
    });
    const response = await f.request();
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().code).toBe('CONFIG_SOURCE_CHANGED');
    expect(f.fixFeedbackRepo.count('root')).toBe(1);
    expect(f.enqueuedSessions).toEqual([]);
  });

  it('retains immutable parent membership when a foreign-parent update is attempted in preflight', async () => {
    const f = await fixture();
    const foreign = f.insert('foreign', f.parent.config);
    vi.mocked(f.services.assertCapabilities).mockImplementationOnce(async () => {
      expect(() => f.podRepo.update('root', { linkedPodId: foreign })).toThrow(
        'task membership is immutable',
      );
    });
    expect((await f.request()).statusCode).toBe(202);
    expect(f.podRepo.getOrThrow('root').linkedPodId).toBeNull();
    expect(f.child().linkedPodId).toBe('root');
  });

  it('keeps a live canonical child and recycles it without allocating another admission', async () => {
    const f = await fixture();
    await f.request();
    const first = f.child();
    const before = f.receipts();
    await f.request();
    expect(f.child().id).toBe(first.id);
    expect(f.podRepo.getOrThrow('root').prFixAttempts).toBe(1);
    f.podRepo.update(first.id, { status: 'failed' });
    expect((await f.request()).statusCode).toBe(202);
    expect(f.child()).toMatchObject({ id: first.id, status: 'queued', fixIteration: 1 });
    expect(f.podRepo.getOrThrow('root')).toMatchObject({ prFixAttempts: 2, maxPrFixAttempts: 3 });
    expect(f.receipts()).toEqual(before);
    expect(f.fixFeedbackRepo.count('root')).toBe(3);
    await expect(f.derive(f.input(3), vi.fn())).rejects.toMatchObject({
      code: 'CONFIG_SOURCE_CHANGED',
    });
  });

  it('rejects a foreign canonical pointer and a pointer changed during preflight', async () => {
    for (const duringPreflight of [false, true]) {
      const f = await fixture();
      const foreign = f.insert('foreign', f.parent.config);
      const change = () => f.podRepo.update('root', { fixPodId: foreign });
      if (duringPreflight) {
        vi.mocked(f.services.assertCapabilities).mockImplementationOnce(async () => {
          change();
        });
      } else change();
      const before = f.receipts();
      const response = await f.request();
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe('CONFIG_SOURCE_CHANGED');
      expect(f.podRepo.getOrThrow('root').prFixAttempts).toBe(0);
      expect(f.podRepo.getOrThrow(foreign).linkedPodId).toBeNull();
      expect(f.enqueuedSessions).toEqual([]);
      expect(f.fixFeedbackRepo.count('root')).toBe(1);
      expect(f.receipts()).toEqual(before);
    }
  });

  it('cannot admit a second current child when a canonical pointer has been cleared', async () => {
    const f = await fixture();
    await f.request();
    const child = f.child();
    f.podRepo.update('root', { fixPodId: null });
    f.enqueuedSessions.length = 0;
    const response = await f.request();
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().code).toBe('CONFIG_SOURCE_CHANGED');
    expect(
      f.podRepo
        .list()
        .filter((pod) => pod.linkedPodId === 'root')
        .map((pod) => pod.id),
    ).toEqual([child.id]);
    expect(f.podRepo.getOrThrow('root').prFixAttempts).toBe(1);
    expect(f.enqueuedSessions).toEqual([]);
    expect(f.fixFeedbackRepo.count('root')).toBe(2);
  });

  it('honors cap three after three ordinary attempts and preserves feedback on exhaustion', async () => {
    const f = await fixture();
    for (let ordinal = 1; ordinal <= 3; ordinal++) {
      expect((await f.request()).statusCode).toBe(202);
      expect(f.podRepo.getOrThrow('root')).toMatchObject({
        prFixAttempts: ordinal,
        maxPrFixAttempts: 3,
      });
      f.podRepo.update(f.child().id, { status: 'failed' });
      f.podRepo.delete(f.child().id);
    }
    f.enqueuedSessions.length = 0;
    expect((await f.request()).statusCode).toBe(409);
    expect(f.podRepo.getOrThrow('root')).toMatchObject({
      prFixAttempts: 3,
      maxPrFixAttempts: 3,
      status: 'failed',
      fixPodId: null,
    });
    expect(f.fixFeedbackRepo.count('root')).toBe(4);
    expect(f.enqueuedSessions).toEqual([]);
    expect(f.receipts()).toHaveLength(4);
  });

  it('rolls back a failed insertion with no new receipt/counter and retains feedback for a valid retry', async () => {
    const f = await fixture();
    const insert = vi.spyOn(f.podRepo, 'insert');
    insert.mockImplementationOnce(() => {
      throw new Error('Synthetic insertion failure');
    });
    expect((await f.request()).statusCode).toBe(500);
    expect(f.fixFeedbackRepo.count('root')).toBe(1);
    expect(f.enqueuedSessions).toEqual([]);
    expect(f.podRepo.getOrThrow('root')).toMatchObject({ prFixAttempts: 0, fixPodId: null });
    expect(f.receipts()).toHaveLength(1);
    insert.mockRestore();
    expect((await f.request()).statusCode).toBe(202);
    expect(f.podRepo.getOrThrow('root').prFixAttempts).toBe(1);
    expect(f.fixFeedbackRepo.count('root')).toBe(2);
  });

  it('rolls back the child and parent claim if snapshot admission fails after insertion', async () => {
    const f = await fixture();
    const before = f.receipts();
    f.db.exec(`CREATE TEMP TRIGGER reject_fix_snapshot BEFORE INSERT ON pod_launch_snapshots
      WHEN NEW.pod_id <> 'root'
      BEGIN SELECT RAISE(ABORT, 'Synthetic snapshot admission failure'); END`);
    expect((await f.request()).statusCode).toBe(500);
    expect(f.fixFeedbackRepo.count('root')).toBe(1);
    expect(f.enqueuedSessions).toEqual([]);
    expect(f.podRepo.getOrThrow('root')).toMatchObject({ prFixAttempts: 0, fixPodId: null });
    expect(f.podRepo.list().filter((pod) => pod.linkedPodId === 'root')).toEqual([]);
    expect(f.receipts()).toEqual(before);
    f.db.exec('DROP TRIGGER reject_fix_snapshot');
    expect((await f.request()).statusCode).toBe(202);
    expect(f.podRepo.getOrThrow('root')).toMatchObject({ prFixAttempts: 1, maxPrFixAttempts: 3 });
    expect(f.fixFeedbackRepo.count('root')).toBe(2);
  });

  it('carries the original task, provider, frozen authority, budget and cumulative admissions through deletion', async () => {
    const f = await fixture();
    await f.request();
    const first = f.child();
    const ledger = f.podRepo.taskExecutions;
    const retries = f.podRepo.workerRetries;
    if (!ledger || !retries) throw new Error('Missing task accounting');
    const binding = {
      runtime: first.runtime,
      model: first.model,
      providerAccountId: first.providerAccountIdSnapshot ?? null,
    };
    const run = ledger.beginRun(first.id, first.lifecycleGeneration, 1, binding);
    retries.admit(
      first.id,
      first.lifecycleGeneration,
      unavailableWorkerInputs,
      workerBindingHash(binding),
      [0],
      run,
    );
    retries.start(run);
    ledger.finishRun(run, 'failed', 'transient');
    retries.finish(run, 'transient', 7);
    f.podRepo.update(first.id, {
      status: 'failed',
      inputTokens: 100,
      outputTokens: 20,
      tokenTelemetryAccuracy: 'complete',
    });
    const task = ledger.snapshot(first.id);
    f.podRepo.delete(first.id);
    const history = f.podRepo.getForHistory?.(first.id);
    const audit = f.receipts();
    const attempts = f.db.prepare('SELECT * FROM task_retry_attempts').all();
    const env = f.store.get('environment', 'env');
    f.store.write({
      ...env,
      expectedRevision: env.revision,
      payload: { ...env.payload, template: 'node24' },
    });
    expect((await f.request()).statusCode).toBe(202);
    const second = f.child();
    expect(second).toMatchObject({
      providerAccountIdSnapshot: first.providerAccountIdSnapshot,
      providerIdSnapshot: first.providerIdSnapshot,
      linkedPodId: 'root',
    });
    expect(f.snapshots.get(second.id)).toEqual(f.snapshots.get(first.id));
    expect(ledger.snapshot(second.id)).toMatchObject({
      taskId: task.taskId,
      rootPodId: 'root',
      tokenBudget: 1000,
      recordedTotalTokens: 120,
    });
    expect(retries.state(second.id)).toMatchObject({
      admissionCount: 1,
      executedCount: 1,
      measuredDurationMs: 7,
      transientRetryCount: 0,
    });
    expect(f.podRepo.getForHistory?.(first.id)).toEqual(history);
    expect(f.receipts()).toEqual(expect.arrayContaining(audit));
    expect(f.db.prepare('SELECT * FROM task_retry_attempts').all()).toEqual(attempts);
    const next = ledger.beginRun(second.id, second.lifecycleGeneration, 1, binding);
    expect(
      retries.admit(
        second.id,
        second.lifecycleGeneration,
        unavailableWorkerInputs,
        workerBindingHash(binding),
        [0, 0, 0],
        next,
      ).retryKind,
    ).toBe('transient');
    retries.start(next);
    ledger.finishRun(next, 'failed', 'transient');
    retries.finish(next, 'transient', 9);
    expect(retries.state('root')).toMatchObject({
      admissionCount: 2,
      transientRetryCount: 1,
      backoffsMs: [0],
      measuredDurationMs: 16,
    });
    expect(() =>
      retries.assertCanAdmit(
        second.id,
        second.lifecycleGeneration,
        unavailableWorkerInputs,
        workerBindingHash(binding),
        [0, 0, 0],
      ),
    ).toThrow('budget exhausted');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
});
