import { AutopodError } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { ExecInterruptedError } from '../containers/exec-exit-evidence.js';
import type { ContainerManager, ExecOptions } from '../interfaces/container-manager.js';
import { createArtifactExecutionBoundary } from './artifact-execution-boundary.js';

describe('per-run artifact execution uncertainty fence', () => {
  it('makes a swallowed helper error sticky across further commands and paid-review admission', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('Docker transport lost'));
    const target = { execInContainer: exec, writeFile: vi.fn() } as unknown as ContainerManager;
    const boundary = createArtifactExecutionBoundary(target);
    await boundary.manager.execInContainer('c', ['helper']).catch(() => null);
    await expect(boundary.manager.execInContainer('c', ['build'])).rejects.toMatchObject({
      code: 'EXEC_EXIT_UNVERIFIED',
    });
    expect(() => boundary.assertVerified()).toThrow('unverified termination');
    expect(() => boundary.manager.writeFile('c', '/workspace/x', 'data')).toThrow(
      'unverified termination',
    );
    expect(exec).toHaveBeenCalledOnce();
    expect(target.writeFile).not.toHaveBeenCalled();
  });

  it('binds concrete manager methods to their receiver and retains dispatch guards', async () => {
    class Manager {
      #result = { stdout: 'proof', stderr: '', exitCode: 0 };
      execInContainer = vi.fn(async (_id: string, _command: string[], options: ExecOptions) => {
        options.assertCurrent?.();
        return this.#result;
      });
      readFile() {
        return Promise.resolve(this.#result.stdout);
      }
    }
    const target = new Manager();
    const owner = vi.fn();
    const commandGuard = vi.fn();
    const boundary = createArtifactExecutionBoundary(target as unknown as ContainerManager, owner);
    await expect(
      boundary.manager.execInContainer('c', ['probe'], { assertCurrent: commandGuard }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(boundary.manager.readFile('c', '/workspace/x')).resolves.toBe('proof');
    expect(commandGuard).toHaveBeenCalledOnce();
    expect(owner).toHaveBeenCalled();
    expect(target.execInContainer.mock.calls[0]?.[2].requireObservedExit).toBe(true);
  });

  it('does not let a different validation invocation inherit or erase uncertainty', async () => {
    const target = {
      execInContainer: vi
        .fn()
        .mockRejectedValueOnce(new Error('lost'))
        .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    } as unknown as ContainerManager;
    const first = createArtifactExecutionBoundary(target);
    await expect(first.manager.execInContainer('c', ['first'])).rejects.toMatchObject({
      code: 'EXEC_EXIT_UNVERIFIED',
    });
    const second = createArtifactExecutionBoundary(target);
    await expect(second.manager.execInContainer('c', ['independent'])).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(() => first.assertVerified()).toThrow();
  });

  it('preserves structured interruption evidence and partial output', async () => {
    const error = Object.assign(
      new ExecInterruptedError({ cause: 'timeout', cleanup: 'unverified', timeoutMs: 10 }),
      { partialOutput: 'partial' },
    );
    const target = {
      execInContainer: vi.fn().mockRejectedValue(error),
    } as unknown as ContainerManager;
    await expect(
      createArtifactExecutionBoundary(target).manager.execInContainer('c', ['probe']),
    ).rejects.toBe(error);
  });

  it('rejects invalid adapter exit values, not actual observed command failures', async () => {
    const target = {
      execInContainer: vi
        .fn()
        .mockResolvedValueOnce({ exitCode: null })
        .mockResolvedValue({ exitCode: 1 }),
    } as unknown as ContainerManager;
    await expect(
      createArtifactExecutionBoundary(target).manager.execInContainer('c', ['probe']),
    ).rejects.toBeInstanceOf(AutopodError);
    await expect(
      createArtifactExecutionBoundary(target).manager.execInContainer('c', ['probe']),
    ).resolves.toMatchObject({ exitCode: 1 });
  });
});
