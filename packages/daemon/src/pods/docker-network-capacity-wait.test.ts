import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { AutopodError } from '@autopod/shared';
import type Dockerode from 'dockerode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockerNetworkManager } from '../containers/docker-network-manager.js';
import { createTestContext } from '../test-utils/mock-helpers.js';
import { createEventRepository } from './event-repository.js';
import { reconcileLocalSessions } from './local-reconciler.js';
import { createPodManager } from './pod-manager.js';
import { createPodQueue } from './pod-queue.js';
import { createPodRepository } from './pod-repository.js';
import { createValidationRepository } from './validation-repository.js';

async function fixture(outputMode: 'pr' | 'workspace' = 'workspace') {
  const ctx = createTestContext();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autopod-subnet-wait-')));
  vi.stubEnv('DATA_DIR', root);
  vi.stubEnv('AUTOPOD_CLAUDE_STATE_DIR', join(root, 'claude-state'));
  const worktreePath = join(root, 'checkout');
  const bareRepoPath = join(root, 'git');
  execFileSync('git', ['init', '-q', '--separate-git-dir', bareRepoPath, worktreePath]);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', worktreePath, ...args])
      .toString()
      .trim();
  const savedFile = join(worktreePath, 'docs.md');
  writeFileSync(savedFile, 'Prepared source\n');
  git('add', 'docs.md');
  git(
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'Fixture',
  );
  const startCommitSha = git('rev-parse', 'HEAD');
  vi.mocked(ctx.worktreeManager.create).mockResolvedValueOnce({
    worktreePath,
    bareRepoPath,
    startCommitSha,
  });
  ctx.db
    .prepare('UPDATE profiles SET network_policy = ? WHERE name = ?')
    .run(JSON.stringify({ enabled: true, mode: 'allow-all', allowedHosts: [] }), 'test-profile');

  let dockerError: Error | null = new Error(
    'all predefined address pools have been fully subnetted',
  );
  const bridgeId = '1'.repeat(64);
  let bridge: { Id: string; Name: string; Labels: Record<string, string>; Driver: string } | null =
    null;
  const createNetwork = vi.fn(async (config: { Name: string; Labels: Record<string, string> }) => {
    if (dockerError) throw dockerError;
    if (bridge) throw new Error('Duplicate fixture bridge allocation');
    bridge = { Id: bridgeId, Name: config.Name, Labels: config.Labels, Driver: 'bridge' };
    return { id: bridgeId };
  });
  const docker = {
    info: async () => ({ ID: 'fixture-docker-engine' }),
    getNetwork: (key: string) => ({
      inspect: async () => {
        if (bridge && (key === bridge.Name || key === bridge.Id)) return bridge;
        throw Object.assign(new Error('absent'), { statusCode: 404 });
      },
    }),
    createNetwork,
    listNetworks: async () => (bridge ? [bridge] : []),
  } as unknown as Dockerode;
  const deps = {
    ...ctx.deps,
    networkManager: new DockerNetworkManager({
      docker,
      managedDatabase: ctx.db,
      logger: ctx.deps.logger,
    }),
  };
  const manager = createPodManager(deps);
  const pod = manager.createSession(
    { profileName: 'test-profile', task: 'Use the prepared checkout', outputMode },
    'operator',
  );
  await setImmediate();
  ctx.enqueuedSessions.length = 0;
  return {
    ctx,
    deps,
    manager,
    pod,
    worktreePath,
    savedFile,
    startCommitSha,
    createNetwork,
    get: () => ctx.podRepo.getOrThrow(pod.id),
    setDockerError: (error: Error | null) => {
      dockerError = error;
    },
    close: () => {
      ctx.db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('Docker subnet exhaustion queue wait', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('releases the queue slot, keeps the prepared checkout and provisions only once when a subnet returns', async () => {
    const f = await fixture();
    try {
      const other = vi.fn();
      const queue = createPodQueue(
        1,
        async (id) => {
          if (id === f.pod.id) await f.manager.processPod(id);
          else other();
        },
        f.deps.logger,
      );
      const before = Date.now();
      queue.enqueue(f.pod.id);
      queue.enqueue('unrelated-work');
      await queue.drain();
      expect(queue.processing).toBe(0);
      expect(other).toHaveBeenCalledOnce();
      expect(f.get()).toMatchObject({
        status: 'queued',
        containerId: null,
        failureReason: null,
        worktreePath: f.worktreePath,
        startCommitSha: f.startCommitSha,
        infrastructureFailure: {
          source: 'docker-network',
          code: 'HOST_NETWORK_CAPACITY',
          attemptCount: 1,
          retryNotBefore: new Date(before + 30_000).toISOString(),
        },
      });
      const activity = createEventRepository(f.ctx.db).getForSession(f.pod.id, {
        type: 'pod.agent_activity',
      });
      expect(JSON.stringify(activity)).toContain(
        'Waiting for a free Docker subnet (HOST_NETWORK_CAPACITY)',
      );
      expect(f.ctx.containerManager.spawn).not.toHaveBeenCalled();
      expect(f.createNetwork).toHaveBeenCalledTimes(2);
      await f.manager.processPod(f.pod.id); // A duplicate/early enqueue must not probe ahead of the deadline.
      expect(f.createNetwork).toHaveBeenCalledTimes(2);
      f.setDockerError(null);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.ctx.enqueuedSessions).toEqual([f.pod.id]);
      queue.enqueue(f.pod.id);
      queue.enqueue(f.pod.id);
      await queue.drain();
      expect(f.createNetwork).toHaveBeenCalledTimes(3);
      expect(f.ctx.worktreeManager.create).toHaveBeenCalledOnce();
      expect(f.ctx.containerManager.spawn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          networkName: `autopod-${f.pod.id}`,
          volumes: expect.arrayContaining([{ host: f.worktreePath, container: '/mnt/worktree' }]),
        }),
      );
      expect(f.get()).toMatchObject({
        status: 'running',
        worktreePath: f.worktreePath,
        startCommitSha: f.startCommitSha,
        infrastructureFailure: null,
      });
      expect(readFileSync(f.savedFile, 'utf8')).toBe('Prepared source\n');
    } finally {
      f.close();
    }
  });

  it('can be killed while queued; the delayed retry never dispatches or allocates', async () => {
    const f = await fixture();
    try {
      await f.manager.processPod(f.pod.id);
      expect(f.get().status).toBe('queued');
      await f.manager.killSession(f.pod.id);
      f.setDockerError(null);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.get().status).toBe('killed');
      expect(f.ctx.enqueuedSessions).toEqual([]);
      expect(f.createNetwork).toHaveBeenCalledTimes(2);
      expect(f.ctx.containerManager.spawn).not.toHaveBeenCalled();
      expect(f.ctx.worktreeManager.cleanup).toHaveBeenCalledExactlyOnceWith(f.worktreePath);
    } finally {
      f.close();
    }
  });

  it('rehydrates the original deadline and source after restart, including an admitted series dependent', async () => {
    const f = await fixture();
    try {
      await f.manager.processPod(f.pod.id);
      const saved = f.get();
      vi.clearAllTimers(); // Lose the old process's in-memory timers.
      const podRepo = createPodRepository(f.ctx.db);
      podRepo.update(f.pod.id, {
        dependsOnPodIds: ['completed-parent'],
        dependencyStartedAt: saved.startedAt,
      });
      const restarted = createPodManager({ ...f.deps, podRepo });
      f.setDockerError(null);
      const result = await reconcileLocalSessions({
        podRepo,
        eventBus: f.ctx.eventBus,
        containerManager: f.ctx.containerManager,
        validationRepo: createValidationRepository(f.ctx.db),
        logger: f.deps.logger,
        enqueueSession: f.deps.enqueueSession,
      });
      restarted.rehydrateDependentSessions();
      expect(result.recovered).toEqual([f.pod.id]);
      expect(podRepo.getOrThrow(f.pod.id).infrastructureFailure).toEqual(
        saved.infrastructureFailure,
      );
      await vi.advanceTimersByTimeAsync(29_999);
      expect(f.ctx.enqueuedSessions).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.ctx.enqueuedSessions).toEqual([f.pod.id]);
      await restarted.processPod(f.pod.id);
      expect(f.get()).toMatchObject({
        status: 'running',
        worktreePath: f.worktreePath,
        startCommitSha: f.startCommitSha,
        infrastructureFailure: null,
      });
      expect(f.ctx.worktreeManager.create).toHaveBeenCalledOnce();
      expect(f.ctx.containerManager.spawn).toHaveBeenCalledOnce();
    } finally {
      f.close();
    }
  });

  it('fails with its source intact after four unsuccessful automatic retries', async () => {
    const f = await fixture();
    try {
      for (const [i, delay] of [30_000, 60_000, 120_000, 300_000].entries()) {
        const now = Date.now();
        await f.manager.processPod(f.pod.id);
        expect(f.get().infrastructureFailure).toMatchObject({
          attemptCount: i + 1,
          retryNotBefore: new Date(now + delay).toISOString(),
        });
        await vi.advanceTimersByTimeAsync(delay);
      }
      await f.manager.processPod(f.pod.id);
      expect(f.get()).toMatchObject({
        status: 'failed',
        worktreePath: f.worktreePath,
        failureReason: expect.stringContaining('HOST_NETWORK_CAPACITY'),
        infrastructureFailure: null,
      });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(f.ctx.enqueuedSessions).toEqual(Array(4).fill(f.pod.id));
      expect(f.ctx.worktreeManager.create).toHaveBeenCalledOnce();
      expect(f.ctx.containerManager.spawn).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('does not retry a permanent Docker network error', async () => {
    const f = await fixture();
    try {
      f.setDockerError(new Error('invalid network configuration: conflicting bridge option'));
      await f.manager.processPod(f.pod.id);
      expect(f.get()).toMatchObject({
        status: 'failed',
        failureReason: expect.stringContaining('invalid network configuration'),
        infrastructureFailure: null,
      });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(f.ctx.enqueuedSessions).toEqual([]);
      expect(f.createNetwork).toHaveBeenCalledOnce();
      expect(f.ctx.containerManager.spawn).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('does not bypass bridge isolation if a legacy profile changes during the wait', async () => {
    const f = await fixture();
    try {
      await f.manager.processPod(f.pod.id);
      f.ctx.db
        .prepare('UPDATE profiles SET network_policy = NULL WHERE name = ?')
        .run('test-profile');
      f.setDockerError(null);
      await vi.advanceTimersByTimeAsync(30_000);
      await f.manager.processPod(f.pod.id);
      expect(f.get()).toMatchObject({
        status: 'failed',
        worktreePath: f.worktreePath,
        failureReason: expect.stringContaining('Repository or network policy changed'),
        infrastructureFailure: null,
      });
      expect(f.createNetwork).toHaveBeenCalledTimes(2);
      expect(f.ctx.containerManager.spawn).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('does not replay startup if the same capacity code occurs after the bridge gate', async () => {
    const f = await fixture();
    try {
      f.setDockerError(null);
      vi.mocked(f.ctx.containerManager.spawn).mockRejectedValueOnce(
        new AutopodError('A later startup fault', 'HOST_NETWORK_CAPACITY', 503),
      );
      await f.manager.processPod(f.pod.id);
      expect(f.get()).toMatchObject({
        status: 'failed',
        failureReason: expect.stringContaining('A later startup fault'),
        infrastructureFailure: null,
      });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(f.ctx.enqueuedSessions).toEqual([]);
      expect(f.createNetwork).toHaveBeenCalledOnce();
      expect(f.ctx.containerManager.spawn).toHaveBeenCalledOnce();
    } finally {
      f.close();
    }
  });

  it('preserves an ordinary validation-only recovery without starting a worker', async () => {
    const f = await fixture('pr');
    try {
      f.ctx.podRepo.update(f.pod.id, {
        worktreePath: f.worktreePath,
        recoveryWorktreePath: f.worktreePath,
        skipAgent: true,
      });
      const check = vi.spyOn(f.manager, 'triggerValidation').mockImplementation(async () => {});
      await f.manager.processPod(f.pod.id);
      expect(f.get()).toMatchObject({
        status: 'queued',
        worktreePath: f.worktreePath,
        skipAgent: true,
        infrastructureFailure: { isRecovery: true },
      });
      expect(check).not.toHaveBeenCalled();
      f.setDockerError(null);
      await vi.advanceTimersByTimeAsync(30_000);
      await f.manager.processPod(f.pod.id);
      expect(f.ctx.worktreeManager.create).not.toHaveBeenCalled();
      expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
      expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
      expect(check).toHaveBeenCalledExactlyOnceWith(f.pod.id, { validationOnly: true });
    } finally {
      f.close();
    }
  });

  it('fails closed instead of fetching new source if the prepared checkout is lost', async () => {
    const f = await fixture();
    try {
      await f.manager.processPod(f.pod.id);
      rmSync(f.worktreePath, { recursive: true });
      f.setDockerError(null);
      await vi.advanceTimersByTimeAsync(30_000);
      await f.manager.processPod(f.pod.id);
      expect(f.get()).toMatchObject({
        status: 'failed',
        failureReason: expect.stringContaining('no new source was fetched'),
      });
      expect(f.ctx.worktreeManager.create).toHaveBeenCalledOnce();
      expect(f.createNetwork).toHaveBeenCalledTimes(2);
    } finally {
      f.close();
    }
  });
});
