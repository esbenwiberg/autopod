import type { Pod } from '@autopod/shared';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { SandboxContainerManager } from '../containers/sandbox-container-manager.js';
import type { PodRepository } from './pod-repository.js';
import { SandboxTerminalReaper } from './sandbox-terminal-reaper.js';

const logger = pino({ level: 'silent' });

function pod(status: Pod['status'], id = 'pod-1'): Pod {
  return {
    id,
    status,
    executionTarget: 'sandbox',
    containerId: `sandbox-${id}`,
  } as Pod;
}

function build(pods: Pod[]) {
  const podRepo = {
    list: vi.fn(({ status }: { status: Pod['status'] }) =>
      pods.filter((pod) => pod.status === status),
    ),
    getOrThrow: vi.fn((id: string) => pods.find((pod) => pod.id === id) as Pod),
    update: vi.fn((id: string, changes: Partial<Pod>) => {
      const matchingPod = pods.find((pod) => pod.id === id);
      if (!matchingPod) throw new Error(`pod ${id} missing`);
      Object.assign(matchingPod, changes);
    }),
  } as unknown as PodRepository;
  const sandboxContainerManager = {
    kill: vi.fn(async () => {}),
  } as unknown as SandboxContainerManager;
  const preserveWorkspace = vi.fn(async () => {});
  return {
    podRepo,
    sandboxContainerManager,
    preserveWorkspace,
    reaper: new SandboxTerminalReaper({
      podRepo,
      sandboxContainerManager,
      preserveWorkspace,
      logger,
    }),
  };
}

describe('SandboxTerminalReaper', () => {
  it('deletes complete and killed sandboxes then clears their container IDs', async () => {
    const complete = pod('complete', 'complete');
    const killed = pod('killed', 'killed');
    const deps = build([complete, killed]);
    await deps.reaper.runSweep();
    expect(deps.sandboxContainerManager.kill).toHaveBeenCalledTimes(2);
    expect(complete.containerId).toBeNull();
    expect(killed.containerId).toBeNull();
  });

  it('preserves failed work before deletion and retains it when preservation fails', async () => {
    const failed = pod('failed');
    failed.worktreeCompromised = true;
    failed.preSubmitReview = { status: 'pass' } as Pod['preSubmitReview'];
    const deps = build([failed]);
    deps.preserveWorkspace.mockRejectedValueOnce(new Error('host worktree unavailable'));
    await deps.reaper.runSweep();
    expect(deps.sandboxContainerManager.kill).not.toHaveBeenCalled();
    expect(failed.containerId).toBe('sandbox-pod-1');
    await deps.reaper.runSweep();
    expect(deps.preserveWorkspace).toHaveBeenCalledTimes(2);
    expect(deps.sandboxContainerManager.kill).toHaveBeenCalledWith('sandbox-pod-1');
    expect(failed.containerId).toBeNull();
    expect(failed.worktreeCompromised).toBe(false);
    expect(failed.preSubmitReview).toBeNull();
  });

  it('retains container IDs on deletion errors and retries later', async () => {
    const complete = pod('complete');
    const deps = build([complete]);
    deps.sandboxContainerManager.kill.mockRejectedValueOnce(new Error('timeout'));
    await deps.reaper.runSweep();
    expect(complete.containerId).toBe('sandbox-pod-1');
    await deps.reaper.runSweep();
    expect(deps.sandboxContainerManager.kill).toHaveBeenCalledTimes(2);
    expect(complete.containerId).toBeNull();
  });

  it('retains container IDs after a deletion timeout and permits a later retry', async () => {
    vi.useFakeTimers();
    try {
      const complete = pod('complete');
      const deps = build([complete]);
      let release!: () => void;
      deps.sandboxContainerManager.kill.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const reaper = new SandboxTerminalReaper({
        podRepo: deps.podRepo,
        sandboxContainerManager: deps.sandboxContainerManager,
        preserveWorkspace: deps.preserveWorkspace,
        logger,
        deletionTimeoutMs: 1_000,
      });
      const first = reaper.runSweep();
      await vi.advanceTimersByTimeAsync(1_000);
      await first;
      expect(complete.containerId).toBe('sandbox-pod-1');
      release();
      await reaper.runSweep();
      expect(deps.sandboxContainerManager.kill).toHaveBeenCalledTimes(2);
      expect(complete.containerId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not overlap sweeps', async () => {
    const complete = pod('complete');
    const deps = build([complete]);
    let release!: () => void;
    deps.sandboxContainerManager.kill.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = deps.reaper.runSweep();
    await Promise.resolve();
    await deps.reaper.runSweep();
    expect(deps.sandboxContainerManager.kill).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});
