import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pod } from '@autopod/shared';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { SandboxContainerManager } from '../containers/sandbox-container-manager.js';
import type { EventBus } from './event-bus.js';
import type { PodRepository } from './pod-repository.js';
import { reconcileSandboxSessions } from './reconciler.js';

const logger = pino({ level: 'silent' });

function makePod(overrides: Partial<Pod> = {}): Pod {
  return {
    id: 'pod-1',
    profileName: 'sandbox-profile',
    task: 'Build in sandbox',
    status: 'running',
    model: 'opus',
    runtime: 'claude',
    executionTarget: 'sandbox',
    branch: 'autopod/pod-1',
    containerId: 'sandbox-1',
    worktreePath: '/tmp/worktree/pod-1',
    options: { agentMode: 'auto', output: 'pr', validate: true },
    ...overrides,
  } as Pod;
}

function buildDeps(
  status: 'running' | 'stopped' | 'deleted' | 'unknown',
  overrides: Partial<Pod> = {},
) {
  const pod = makePod(overrides);
  const updates: Array<Partial<Pod>> = [];
  const podRepo = {
    list: vi.fn(({ status }: { status: Pod['status'] }) => (pod.status === status ? [pod] : [])),
    update: vi.fn((_podId: string, changes: Partial<Pod>) => {
      updates.push(changes);
      Object.assign(pod, changes);
    }),
  } as unknown as PodRepository;
  const eventBus = {
    emit: vi.fn(),
  } as unknown as EventBus;
  const sandboxContainerManager = {
    getStatus: vi.fn(async () => status),
    start: vi.fn(async () => {}),
  } as unknown as SandboxContainerManager;
  const preserveWorkspace = vi.fn(async () => {});
  const quiesceSandboxAgent = vi.fn(async () => {});
  const suspendSandbox = vi.fn(async () => {});
  const enqueueSession = vi.fn((_podId: string) => {});

  return {
    pod,
    updates,
    podRepo,
    eventBus,
    sandboxContainerManager,
    preserveWorkspace,
    quiesceSandboxAgent,
    suspendSandbox,
    enqueueSession,
  };
}

describe('reconcileSandboxSessions', () => {
  it('re-queues interrupted provisioning once with its surviving worktree', async () => {
    const worktreePath = await mkdtemp(path.join(tmpdir(), 'autopod-reconcile-'));
    const deps = buildDeps('unknown', {
      status: 'provisioning',
      containerId: null,
      worktreePath,
      recoveryWorktreePath: null,
      recoveryCount: 0,
    });

    try {
      await reconcileSandboxSessions({ ...deps, logger });
      await reconcileSandboxSessions({ ...deps, logger });

      expect(deps.updates).toContainEqual(
        expect.objectContaining({
          status: 'queued',
          containerId: null,
          worktreePath,
          recoveryWorktreePath: worktreePath,
          recoveryCount: 1,
          lastRecoveryTrigger: 'restart',
        }),
      );
      expect(deps.enqueueSession).toHaveBeenCalledTimes(1);
      expect(deps.enqueueSession).toHaveBeenCalledWith('pod-1');
      expect(deps.sandboxContainerManager.getStatus).not.toHaveBeenCalled();
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('safely restarts provisioning when the daemon crashed before recording a worktree', async () => {
    const deps = buildDeps('unknown', {
      status: 'provisioning',
      containerId: null,
      worktreePath: null,
      recoveryWorktreePath: null,
      recoveryCount: 1,
      skipAgent: true,
    });

    await reconcileSandboxSessions({ ...deps, logger });

    expect(deps.updates).toContainEqual(
      expect.objectContaining({
        status: 'queued',
        containerId: null,
        worktreePath: null,
        recoveryWorktreePath: null,
        recoveryCount: 2,
        lastRecoveryTrigger: 'restart',
      }),
    );
    expect(deps.pod.skipAgent).toBe(true);
    expect(deps.enqueueSession).toHaveBeenCalledOnce();
    expect(deps.sandboxContainerManager.getStatus).not.toHaveBeenCalled();
  });

  it('fails interrupted provisioning after the bounded restart-recovery cap', async () => {
    const deps = buildDeps('unknown', {
      status: 'provisioning',
      containerId: null,
      worktreePath: null,
      recoveryWorktreePath: null,
      recoveryCount: 3,
    });

    await reconcileSandboxSessions({ ...deps, logger });

    expect(deps.updates).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        failureReason: expect.stringContaining('recovery limit'),
      }),
    );
    expect(deps.enqueueSession).not.toHaveBeenCalled();
  });

  it('quiesces, preserves, and suspends a still-running sandbox before parking it', async () => {
    const deps = buildDeps('running');

    await reconcileSandboxSessions({ ...deps, logger });

    expect(deps.quiesceSandboxAgent).toHaveBeenCalledWith('pod-1');
    expect(deps.preserveWorkspace).toHaveBeenCalledWith('pod-1');
    expect(deps.suspendSandbox).toHaveBeenCalledWith('pod-1');
    expect(deps.updates).toContainEqual(
      expect.objectContaining({
        status: 'paused',
        pauseReason: 'manual',
        lastCorrectionMessage: expect.stringContaining('sandbox is suspended'),
        lastRecoveryTrigger: 'restart',
      }),
    );
  });

  it('preserves an already-paused sandbox left by an earlier restart', async () => {
    const deps = buildDeps('running');
    deps.pod.status = 'paused';

    await reconcileSandboxSessions({ ...deps, logger });

    expect(deps.preserveWorkspace).toHaveBeenCalledWith('pod-1');
    expect(deps.updates).toContainEqual(
      expect.objectContaining({ status: 'paused', pauseReason: 'manual' }),
    );
  });

  it('resumes, quiesces, preserves, and suspends a stopped sandbox before parking it', async () => {
    const deps = buildDeps('stopped');

    await reconcileSandboxSessions({ ...deps, logger });

    expect(deps.sandboxContainerManager.start).toHaveBeenCalledWith('sandbox-1');
    expect(deps.quiesceSandboxAgent).toHaveBeenCalledWith('pod-1');
    expect(deps.preserveWorkspace).toHaveBeenCalledWith('pod-1');
    expect(deps.suspendSandbox).toHaveBeenCalledWith('pod-1');
    expect(deps.updates).toContainEqual(
      expect.objectContaining({
        status: 'paused',
        pauseReason: 'manual',
        lastCorrectionMessage: expect.stringContaining('sandbox is suspended'),
        lastRecoveryTrigger: 'restart',
      }),
    );
  });

  it('retains the sandbox and fails closed when preservation fails', async () => {
    const deps = buildDeps('running');
    deps.preserveWorkspace.mockRejectedValueOnce(new Error('sync unavailable'));

    await reconcileSandboxSessions({ ...deps, logger });

    expect(deps.updates).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        lastCorrectionMessage: expect.stringContaining('sandbox was retained'),
      }),
    );
    expect(deps.updates).not.toContainEqual(expect.objectContaining({ status: 'killed' }));
  });

  it('parks an unknown sandbox for recovery without killing it', async () => {
    const deps = buildDeps('unknown');

    await reconcileSandboxSessions({ ...deps, logger });

    expect(deps.updates).toContainEqual(
      expect.objectContaining({
        status: 'paused',
        lastCorrectionMessage: expect.stringContaining('status is unavailable'),
      }),
    );
    expect(deps.updates).not.toContainEqual(expect.objectContaining({ status: 'killing' }));
    expect(deps.updates).not.toContainEqual(expect.objectContaining({ status: 'killed' }));
  });

  it('marks a confirmed deleted sandbox as killed without attempting preservation', async () => {
    const deps = buildDeps('deleted');
    deps.pod.status = 'paused';

    await reconcileSandboxSessions({ ...deps, logger });

    expect(deps.sandboxContainerManager.start).not.toHaveBeenCalled();
    expect(deps.preserveWorkspace).not.toHaveBeenCalled();
    expect(deps.updates).toContainEqual(expect.objectContaining({ status: 'killed' }));
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pod.status_changed',
        previousStatus: 'paused',
        newStatus: 'killed',
      }),
    );
  });
});
