import { afterEach, describe, expect, it, vi } from 'vitest';
import { validationRecoveryFixture } from '../test-utils/validation-recovery-helpers.js';
import {
  assertFailedValidationRecoverable,
  requiresValidationSettlement,
} from './validation-recovery-policy.js';

describe('validation recovery safety', () => {
  const fixtures: ReturnType<typeof validationRecoveryFixture>[] = [];
  const fixture = () => {
    const f = validationRecoveryFixture();
    fixtures.push(f);
    return f;
  };
  afterEach(() => {
    for (const f of fixtures.splice(0)) f.db.close();
  });

  it('fences a reused resource when immutable dispatch custody arrives during an awaited pull', async () => {
    const f = fixture();
    f.revalidate.mockRestore();
    f.podRepo.update(f.podId, { containerId: null });
    f.podRepo.update(f.podId, {
      executionTarget: 'sandbox',
      containerId: '11111111-1111-4111-8111-111111111111',
    });
    vi.mocked(f.worktreeManager.pullBranch).mockImplementationOnce(async () => {
      const retries = f.podRepo.taskRetries;
      const ledger = f.podRepo.validationExecutions;
      if (!retries || !ledger) throw new Error('Missing durable execution ledger');
      const pod = f.podRepo.getOrThrow(f.podId);
      const admission = retries.admit(
        pod.id,
        pod.lifecycleGeneration,
        {
          source: 'a'.repeat(64),
          contract: 'b'.repeat(64),
          commands: 'c'.repeat(64),
          environment: null,
          implementation: null,
        },
        'd'.repeat(64),
        [],
      );
      retries.start(admission.id);
      expect(ledger.dispatch(pod, admission.id, 1, 'test-scope')).not.toBeNull();
      return { newCommits: true };
    });
    const outcome = await f.manager
      .revalidateSession(f.podId, { force: true })
      .catch((error: unknown) => error);
    expect(f.containerManager.start).not.toHaveBeenCalled();
    expect(f.containerManager.execInContainer).not.toHaveBeenCalled();
    expect(f.containerManager.extractDirectoryFromContainer).not.toHaveBeenCalled();
    expect(f.runtime.spawn).not.toHaveBeenCalled();
    expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
    expect(outcome).toBeInstanceOf(Error);
  });

  it('does not offer a validation waiver as recovery', () => {
    const f = fixture();
    f.podRepo.update(f.podId, { skipValidation: true });
    expect(() => assertFailedValidationRecoverable(f.podRepo.getOrThrow(f.podId))).toThrow(
      'bypass is enabled',
    );
  });
  it('requires a pending fact decision to be resolved', () => {
    const f = fixture();
    f.podRepo.update(f.podId, {
      lastValidationResult: {
        ...f.result,
        factValidation: { status: 'pending_human', results: [] },
      },
    });
    expect(() => assertFailedValidationRecoverable(f.podRepo.getOrThrow(f.podId))).toThrow(
      'fact decision',
    );
  });
  it('refuses incomplete cleanup without asserting process termination', () => {
    const f = fixture();
    f.podRepo.update(f.podId, {
      lastValidationResult: {
        ...f.result,
        infrastructureFailure: {
          phase: 'test',
          code: 'EXEC_INTERRUPTED',
          message: 'Interrupted',
          retryable: false,
          execution: { cause: 'timeout', cleanup: 'failed' },
        },
      },
    });
    expect(() => f.manager.assertCanRework(f.podId)).toThrow('termination is unverified');
  });
  it.each([
    ['AZURE_SANDBOX_EXEC_INVALID_RESPONSE', 'confirmed', undefined, true],
    ['VALIDATION_ENGINE_TERMINATION_UNVERIFIED', 'confirmed', undefined, true],
    ['EXEC_EXIT_UNVERIFIED', 'confirmed', undefined, true],
    ['EXEC_EXIT_UNVERIFIED', 'failed', undefined, true],
    ['EXEC_INTERRUPTED', 'unverified', undefined, true],
    ['EXEC_INTERRUPTED', 'confirmed', 1, false],
  ] as const)(
    'retains exit and cleanup semantics for %s/%s',
    (code, cleanup, observedExitCode, required) => {
      const f = fixture();
      f.podRepo.update(f.podId, {
        lastValidationResult: {
          ...f.result,
          infrastructureFailure: {
            phase: 'test',
            code,
            message: 'Interrupted',
            retryable: false,
            execution: { cause: 'timeout', cleanup, observedExitCode },
          },
        },
      });
      expect(requiresValidationSettlement(f.podRepo.getOrThrow(f.podId))).toBe(required);
      expect(f.podRepo.getOrThrow(f.podId).lastValidationResult?.overall).toBe('fail');
    },
  );
  it('checks-only cannot silently re-provision a missing resource through the normal delivery workflow', async () => {
    const f = fixture();
    f.revalidate.mockRestore();
    f.podRepo.update(f.podId, { containerId: null });
    const queued = f.enqueuedSessions.length;
    await expect(
      f.manager.revalidateSession(f.podId, { force: true, checksOnly: true }),
    ).rejects.toMatchObject({ code: 'VALIDATION_RESOURCE_UNAVAILABLE' });
    expect(f.enqueuedSessions).toHaveLength(queued);
    expect(f.runtime.spawn).not.toHaveBeenCalled();
  });
  it('checks-only resource loss after admission parks instead of queuing implicit publication', async () => {
    const f = fixture();
    f.revalidate.mockRestore();
    vi.mocked(f.containerManager.start).mockRejectedValue(
      Object.assign(new Error('Resource deleted'), { statusCode: 404 }),
    );
    const queued = f.enqueuedSessions.length;
    await expect(
      f.manager.revalidateSession(f.podId, { force: true, checksOnly: true }),
    ).resolves.toMatchObject({ result: 'fail' });
    expect(f.podRepo.getOrThrow(f.podId)).toMatchObject({ status: 'failed', containerId: null });
    expect(f.enqueuedSessions).toHaveLength(queued);
    expect(f.runtime.spawn).not.toHaveBeenCalled();
  });
});
