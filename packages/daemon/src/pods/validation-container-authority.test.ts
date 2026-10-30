import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { StreamingExecResult } from '../interfaces/container-manager.js';
import { createMockContainerManager } from '../test-utils/mock-helpers.js';
import { validationRecoveryFixture } from '../test-utils/validation-recovery-helpers.js';
import {
  captureValidationMutationGuard,
  guardValidationContainer,
} from './validation-recovery-policy.js';
import { createWorkspacePreservation } from './workspace-preservation.js';

// Dispatch fencing must preserve independent caller checks and owned cleanup.
describe('validation container authority composition', () => {
  it('passes preservation ownership into the awaited backend start before checkpointing', async () => {
    const f = validationRecoveryFixture();
    try {
      f.podRepo.update(f.podId, { containerId: null });
      f.podRepo.update(f.podId, { executionTarget: 'sandbox', containerId: 'synthetic-resource' });
      const pod = f.podRepo.getOrThrow(f.podId);
      vi.mocked(f.containerManager.getStatus).mockResolvedValueOnce('stopped');
      vi.mocked(f.containerManager.start).mockImplementationOnce(async (_id, options) => {
        options?.assertCurrent?.();
        await Promise.resolve();
        f.podRepo.incrementLifecycleGeneration(f.podId);
        options?.assertCurrent?.();
      });
      const checkpoint = vi.fn();
      const preservation = createWorkspacePreservation({
        captureAuthority: (expected) => captureValidationMutationGuard(f.podRepo, expected),
        getContainerManager: () => f.containerManager,
        syncWorkspaceBack: vi.fn(),
        sandboxWorkspaceCheckpoint: checkpoint,
        logger: { info: vi.fn() },
        emitActivityStatus: vi.fn(),
      });
      await expect(
        preservation.preservePodWorkspace(pod, 'synthetic preservation'),
      ).rejects.toThrow();
      expect(f.containerManager.start).toHaveBeenCalledWith('synthetic-resource', {
        assertCurrent: expect.any(Function),
      });
      expect(checkpoint).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });

  it('retains supplied and captured assertions at asynchronous start boundaries', async () => {
    const manager = createMockContainerManager();
    const captured = vi.fn();
    let current = true;
    const supplied = vi.fn(() => {
      if (!current) throw new Error('Supplied authority revoked');
    });
    vi.mocked(manager.start).mockImplementationOnce(async (_id, options) => {
      options?.assertCurrent?.();
      await Promise.resolve();
      current = false;
      options?.assertCurrent?.();
    });
    await expect(
      guardValidationContainer(manager, captured).start('synthetic-container', {
        assertCurrent: supplied,
      }),
    ).rejects.toThrow('Supplied authority revoked');
    expect(supplied).toHaveBeenCalledTimes(3);
    expect(captured).toHaveBeenCalledTimes(3);
  });

  it('retains the owned stream handle and exact-exec cleanup after caller revocation', async () => {
    const manager = createMockContainerManager();
    let current = true;
    let observedExit: (code: number) => void = () => {};
    const exitCode = new Promise<number>((resolve) => {
      observedExit = resolve;
    });
    const handle: StreamingExecResult = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode,
      kill: vi.fn(async () => observedExit(7)),
    };
    const supplied = vi.fn();
    vi.mocked(manager.execStreaming).mockImplementationOnce(async (_id, _command, options) => {
      options?.assertCurrent?.();
      current = false; // The backend started before this ownership change.
      return handle;
    });
    manager.terminateRecordedExec = vi.fn(async () => 7);
    const guarded = guardValidationContainer(manager, () => {
      if (!current) throw new Error('Captured authority revoked');
    });
    const stream = await guarded.execStreaming('synthetic-container', ['true'], {
      assertCurrent: supplied,
    });
    expect(stream).toBe(handle);
    expect(supplied).toHaveBeenCalledTimes(2);
    await stream.kill();
    await expect(stream.exitCode).resolves.toBe(7);
    const identity = {
      backend: 'docker' as const,
      containerId: 'synthetic-container',
      execId: 'synthetic-exec',
      pidPath: '/tmp/synthetic.pid',
    };
    await expect(guarded.terminateRecordedExec?.(identity)).resolves.toBe(7);
    expect(manager.terminateRecordedExec).toHaveBeenCalledExactlyOnceWith(identity);
    expect(() => guarded.execStreaming('synthetic-container', ['later'])).toThrow(
      'Captured authority revoked',
    );
  });
});
