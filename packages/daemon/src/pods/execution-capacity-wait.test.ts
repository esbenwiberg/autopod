import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { EffectiveLaunchConfig, ExecutionHostCapacity } from '@autopod/shared';
import type Dockerode from 'dockerode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionAuditRepository } from '../actions/audit-repository.js';
import { ExecutionCapacityUnverifiedError } from '../configuration/backend-capabilities.js';
import {
  createHostConfigurationComponents,
  hostConfigurationSettingsSchema,
} from '../configuration/host-components.js';
import { admitLaunch } from '../configuration/launch-admission.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import { createProviderAccountStore } from '../provider-accounts/provider-account-store.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createPassingValidationResult, createTestContext } from '../test-utils/mock-helpers.js';
import { createEventRepository } from './event-repository.js';
import { createPodManager } from './pod-manager.js';

const unverified: ExecutionHostCapacity = {
  state: 'unverified',
  observedAt: null,
  probeFailure: {
    kind: 'timeout',
    message: "Docker call 'configuration.dockerInfo' timed out after 10000ms",
    durationMs: 10_004,
    at: '2026-11-23T10:00:00.000Z',
  },
  reason:
    'Docker host capacity is unverified: the last check timed out after 10004 ms at 2026-11-23T10:00:00.000Z; Docker has not reported it since the daemon started. Launches are admitted and running pods continue; new containers wait in the queue until Docker reports it.',
};

/** A composable-launch pod whose provisioning gate is driven by the test. */
async function fixture() {
  const ctx = createTestContext({ simulatedReworkChangesSource: true });
  const { services, store } = createTestConfiguration(ctx.db);
  const snapshots = createLaunchSnapshotRepository(ctx.db, store);
  const accounts = createProviderAccountStore(ctx.db);
  accounts.create({
    id: 'account',
    name: 'Fixture account',
    provider: 'anthropic',
    credentials: { provider: 'anthropic', apiKey: 'fixture-key' },
  });
  const info = vi.fn(async () => {
    throw new Error('Docker engine is busy');
  });
  const components = createHostConfigurationComponents({
    db: ctx.db,
    logger: ctx.deps.logger,
    pods: ctx.podRepo,
    accounts,
    audit: createActionAuditRepository(ctx.db),
    cipher: { encrypt: (value) => value, decrypt: (value) => value },
    githubAuth: { resolveCredential: vi.fn(), getStatus: vi.fn() },
    azureDevOpsAuth: { getToken: vi.fn() },
    images: { resolveEnvironment: services.resolveEnvironment, buildEnvironmentImage: vi.fn() },
    reviewerManager: () => ctx.containerManager,
    docker: { info } as unknown as Dockerode,
    sandboxEnabled: false,
    sandboxDefaultTier: 'M',
    settings: hostConfigurationSettingsSchema.parse({}),
    podManager: vi.fn(),
    admissionReady: () => ({ ready: true }),
  });
  const gate = vi
    .fn<(_config: EffectiveLaunchConfig) => Promise<void>>()
    .mockRejectedValue(new ExecutionCapacityUnverifiedError(unverified));
  ctx.deps.providerAccountStore = accounts;
  ctx.deps.launchConfiguration = {
    ...components.launchConfiguration,
    assertExecutionCapacity: gate,
    prepareEnvironment: async () => 'fixture',
  };
  const manager = createPodManager(ctx.deps);
  const { podId } = await admitLaunch({
    request: {
      repositoryId: 'repo-a',
      task: 'Docs change after capacity outage',
      selections: { githubAccessId: null },
    },
    actorId: 'operator',
    services: components.resolution,
    snapshots,
    createPod: (config) => {
      if (!manager.createResolvedSession) throw new Error('Missing launch admission');
      return manager.createResolvedSession(config, 'operator').id;
    },
  });
  await setImmediate(); // Drain the after-admission enqueue before counting retries.
  const pod = ctx.podRepo.getOrThrow(podId);
  const eventRepo = createEventRepository(ctx.db);
  const statuses = () =>
    eventRepo
      .getForSession(pod.id, { type: 'pod.agent_activity' })
      .flatMap((stored) =>
        stored.payload.type === 'pod.agent_activity' && stored.payload.event.type === 'status'
          ? [stored.payload.event.message]
          : [],
      );
  const noEffects = () => {
    expect(ctx.worktreeManager.create).not.toHaveBeenCalled();
    expect(ctx.containerManager.spawn).not.toHaveBeenCalled();
    expect(ctx.runtime.spawn).not.toHaveBeenCalled();
  };
  return { ctx, manager, pod, gate, info, statuses, noEffects };
}

describe('Docker host-capacity provisioning gate (#665)', () => {
  afterEach(() => vi.useRealTimers());

  it('waits visibly in the queue with the probe failure, then provisions once capacity verifies', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date'],
      now: Date.parse('2026-11-23T10:00:10.000Z'),
    });
    const f = await fixture();
    try {
      for (const [index, delay] of [30_000, 60_000, 120_000, 300_000, 300_000].entries()) {
        const before = Date.now();
        await f.manager.processPod(f.pod.id);
        const waiting = f.ctx.podRepo.getOrThrow(f.pod.id);
        expect(waiting.status).toBe('queued');
        expect(waiting.failureReason).toBeNull();
        expect(waiting.infrastructureFailure).toEqual({
          source: 'execution-capacity',
          code: 'EXECUTION_CAPACITY_UNVERIFIED',
          probe: unverified.probeFailure,
          diagnostics: unverified.reason,
          attemptCount: index + 1,
          recoveryDisposition: 'automatic_retry_scheduled',
          occurredAt: new Date(before).toISOString(),
          retryNotBefore: new Date(before + delay).toISOString(),
        });
        expect(f.statuses()).toContain(
          `Waiting for Docker host capacity check — retry ${index + 1} at ${new Date(before + delay).toISOString()} (last check timed out after 10004 ms). No new resources were created; kill the pod to cancel.`,
        );
        f.noEffects();
        const enqueued = f.ctx.enqueuedSessions.length;
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(f.ctx.enqueuedSessions).toHaveLength(enqueued);
        await vi.advanceTimersByTimeAsync(1);
        expect(f.ctx.enqueuedSessions).toHaveLength(enqueued + 1);
      }

      f.gate.mockResolvedValueOnce(undefined);
      vi.mocked(f.ctx.worktreeManager.create).mockRejectedValueOnce(
        new Error('stop after gate proof'),
      );
      await f.manager.processPod(f.pod.id);
      expect(f.gate).toHaveBeenCalledTimes(6);
      expect(f.ctx.worktreeManager.create).toHaveBeenCalledOnce();
      expect(f.ctx.podRepo.getOrThrow(f.pod.id).infrastructureFailure).toBeNull();
      expect(f.statuses()).toContain('Docker host capacity verified — provisioning.');
    } finally {
      f.ctx.db.close();
    }
  });

  it('stays cancellable while waiting: kill ends the wait and the timer does not re-enqueue', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const f = await fixture();
    try {
      await f.manager.processPod(f.pod.id);
      expect(f.ctx.podRepo.getOrThrow(f.pod.id).status).toBe('queued');
      const enqueued = f.ctx.enqueuedSessions.length;
      await f.manager.killSession(f.pod.id);
      expect(f.ctx.podRepo.getOrThrow(f.pod.id).status).toBe('killed');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.ctx.enqueuedSessions).toHaveLength(enqueued);
      f.noEffects();
    } finally {
      f.ctx.db.close();
    }
  });

  it('Rework of a pod failed by the old fatal path waits in the queue with its preserved worktree', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const f = await fixture();
    const root = await mkdtemp(join(tmpdir(), 'capacity-rework-'));
    const worktreePath = join(root, 'workspace');
    const savedFile = join(worktreePath, 'docs.md');
    try {
      execFileSync('git', ['init', '--separate-git-dir', join(root, 'gitdir'), worktreePath]);
      await writeFile(savedFile, '# Preserved change\n');
      f.ctx.podRepo.update(f.pod.id, {
        status: 'failed',
        containerId: 'ctr-stranded',
        worktreePath,
        validationAttempts: 1,
        failureReason:
          'Validation failed before checks could complete: Docker capacity is unavailable on this daemon',
      });
      await f.manager.triggerValidation(f.pod.id, { force: true });
      expect(f.ctx.podRepo.getOrThrow(f.pod.id)).toMatchObject({
        status: 'queued',
        recoveryWorktreePath: worktreePath,
      });

      await f.manager.processPod(f.pod.id);
      expect(f.ctx.podRepo.getOrThrow(f.pod.id)).toMatchObject({
        status: 'queued',
        recoveryWorktreePath: worktreePath,
        worktreePath,
        infrastructureFailure: { source: 'execution-capacity', attemptCount: 1 },
      });
      f.noEffects();
      await vi.advanceTimersByTimeAsync(30_000);
      f.gate.mockResolvedValueOnce(undefined);
      vi.mocked(f.ctx.containerManager.spawn).mockRejectedValueOnce(
        new Error('stop after spawn proof'),
      );
      await f.manager.processPod(f.pod.id);
      expect(f.ctx.worktreeManager.create).not.toHaveBeenCalled();
      expect(f.statuses()).toContain('Recovering pod — reusing existing worktree…');
      expect(f.ctx.containerManager.spawn).toHaveBeenCalledOnce();
      expect(await readFile(savedFile, 'utf8')).toBe('# Preserved change\n');
    } finally {
      await rm(root, { recursive: true, force: true });
      f.ctx.db.close();
    }
  });

  it('continues a settled pod into validation feedback when the host-size probe fails', async () => {
    const f = await fixture();
    try {
      f.ctx.podRepo.update(f.pod.id, {
        status: 'running',
        containerId: 'ctr-running',
        worktreePath: '/tmp/worktrees/active',
      });
      const initial = createPassingValidationResult(f.pod.id);
      vi.mocked(f.ctx.validationEngine.validate).mockResolvedValueOnce({
        ...initial,
        overall: 'fail',
        smoke: {
          ...initial.smoke,
          status: 'fail',
          build: { ...initial.smoke.build, status: 'fail' },
        },
      });
      await f.manager.triggerValidation(f.pod.id);
      expect(f.info).toHaveBeenCalledOnce();
      expect(f.gate).not.toHaveBeenCalled();
      expect(f.ctx.runtime.resume).toHaveBeenCalledOnce();
      expect(f.ctx.podRepo.getOrThrow(f.pod.id)).toMatchObject({
        status: 'validated',
        failureReason: null,
        worktreePath: '/tmp/worktrees/active',
        infrastructureFailure: null,
      });
    } finally {
      f.ctx.db.close();
    }
  });

  it('keeps permanent capability errors fatal at the gate', async () => {
    const f = await fixture();
    try {
      f.gate.mockRejectedValueOnce(
        Object.assign(new Error('Memory allocation exceeds the target limit of 8 GB'), {
          code: 'ALLOCATION_UNSUPPORTED',
        }),
      );
      await f.manager.processPod(f.pod.id);
      expect(f.ctx.podRepo.getOrThrow(f.pod.id)).toMatchObject({
        status: 'failed',
        infrastructureFailure: null,
      });
      f.noEffects();
    } finally {
      f.ctx.db.close();
    }
  });
});
