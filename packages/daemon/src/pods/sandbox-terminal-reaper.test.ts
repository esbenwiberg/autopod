import type { Pod } from '@autopod/shared';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { SandboxContainerManager } from '../containers/sandbox-container-manager.js';
import { createPassingValidationResult } from '../test-utils/mock-helpers.js';
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
  const taskExecutions = { hasActiveRun: vi.fn(() => false) };
  const podRepo = {
    taskExecutions,
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
    start: vi.fn(async () => {}),
  } as unknown as SandboxContainerManager;
  return {
    taskExecutions,
    podRepo,
    sandboxContainerManager,
    reaper: new SandboxTerminalReaper({
      podRepo,
      sandboxContainerManager,
      logger,
    }),
  };
}

describe('SandboxTerminalReaper', () => {
  it('retains a failed artifact source until artifact finalization completes', async () => {
    const failed = pod('failed');
    failed.options = { agentMode: 'auto', output: 'artifact', validate: false };
    const deps = build([failed]);
    await deps.reaper.runSweep();
    expect(deps.sandboxContainerManager.start).not.toHaveBeenCalled();
    expect(deps.sandboxContainerManager.kill).not.toHaveBeenCalled();
    expect(failed.containerId).toBe('sandbox-pod-1');
  });

  it('does not wake or restore failed sandboxes as a side effect of automatic cleanup', async () => {
    const failed = pod('failed');
    failed.lifecycleGeneration = 3;
    const deps = build([failed]);
    await deps.reaper.runSweep();
    expect(deps.sandboxContainerManager.start).not.toHaveBeenCalled();
    expect(deps.sandboxContainerManager.kill).not.toHaveBeenCalled();
    expect(failed.containerId).toBe('sandbox-pod-1');
    expect(failed.status).toBe('failed');
    expect(failed.lifecycleGeneration).toBe(3);
  });

  it('deletes complete and killed sandboxes then clears their container IDs', async () => {
    const complete = pod('complete', 'complete');
    const killed = pod('killed', 'killed');
    const deps = build([complete, killed]);
    await deps.reaper.runSweep();
    expect(deps.sandboxContainerManager.kill).toHaveBeenCalledTimes(2);
    expect(complete.containerId).toBeNull();
    expect(killed.containerId).toBeNull();
  });

  it('never treats repository preservation as proof that failed-pod reports are safe', async () => {
    const failed = pod('failed');
    failed.worktreeCompromised = true;
    failed.preSubmitReview = { status: 'pass' } as Pod['preSubmitReview'];
    const deps = build([failed]);
    await deps.reaper.runSweep();
    expect(deps.sandboxContainerManager.kill).not.toHaveBeenCalled();
    expect(failed.containerId).toBe('sandbox-pod-1');
    await deps.reaper.runSweep();
    expect(deps.sandboxContainerManager.start).not.toHaveBeenCalled();
    expect(deps.podRepo.update).not.toHaveBeenCalled();
    expect(deps.sandboxContainerManager.kill).not.toHaveBeenCalled();
    expect(failed.containerId).toBe('sandbox-pod-1');
    expect(failed.worktreeCompromised).toBe(true);
    expect(failed.preSubmitReview).toEqual({ status: 'pass' });
  });

  it.each(['complete', 'killed'] as const)(
    'retains %s resources until original task execution settles',
    async (status) => {
      const terminal = pod(status);
      const deps = build([terminal]);
      deps.taskExecutions.hasActiveRun.mockReturnValue(true);
      await deps.reaper.runSweep();
      expect(deps.sandboxContainerManager.kill).not.toHaveBeenCalled();
      expect(terminal.containerId).toBe('sandbox-pod-1');
      deps.taskExecutions.hasActiveRun.mockReturnValue(false);
      await deps.reaper.runSweep();
      expect(deps.sandboxContainerManager.kill).toHaveBeenCalledOnce();
    },
  );

  it('retains terminal resources with an unverified validation exit', async () => {
    const terminal = pod('complete');
    terminal.lastValidationResult = {
      ...createPassingValidationResult(terminal.id),
      overall: 'fail',
      infrastructureFailure: {
        phase: 'build',
        code: 'EXEC_EXIT_UNVERIFIED',
        message: 'Original command exit is unverified',
        retryable: false,
      },
    };
    const deps = build([terminal]);
    await deps.reaper.runSweep();
    expect(deps.sandboxContainerManager.kill).not.toHaveBeenCalled();
    expect(terminal.containerId).toBe('sandbox-pod-1');
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
