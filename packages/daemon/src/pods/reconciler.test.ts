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

function buildDeps(status: 'running' | 'stopped' | 'unknown') {
  const pod = makePod();
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

  return { pod, updates, podRepo, eventBus, sandboxContainerManager, preserveWorkspace };
}

describe('reconcileSandboxSessions', () => {
  it('preserves a still-running sandbox before parking it', async () => {
    const deps = buildDeps('running');

    await reconcileSandboxSessions({ ...deps, logger });

    expect(deps.preserveWorkspace).toHaveBeenCalledWith('pod-1');
    expect(deps.updates).toContainEqual(
      expect.objectContaining({
        status: 'paused',
        pauseReason: 'manual',
        lastCorrectionMessage: expect.stringContaining('workspace was preserved'),
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

  it('resumes and preserves a suspended sandbox before parking it', async () => {
    const deps = buildDeps('stopped');

    await reconcileSandboxSessions({ ...deps, logger });

    expect(deps.sandboxContainerManager.start).toHaveBeenCalledWith('sandbox-1');
    expect(deps.preserveWorkspace).toHaveBeenCalledWith('pod-1');
    expect(deps.updates).toContainEqual(
      expect.objectContaining({
        status: 'paused',
        pauseReason: 'manual',
        lastCorrectionMessage: expect.stringContaining('resumed'),
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

  it('marks an unknown sandbox as killed', async () => {
    const deps = buildDeps('unknown');

    await reconcileSandboxSessions({ ...deps, logger });

    expect(deps.updates).toContainEqual(expect.objectContaining({ status: 'killing' }));
    expect(deps.updates).toContainEqual(expect.objectContaining({ status: 'killed' }));
  });
});
