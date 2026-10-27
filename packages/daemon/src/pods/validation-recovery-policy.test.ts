import { afterEach, describe, expect, it, vi } from 'vitest';
import { validationRecoveryFixture } from '../test-utils/validation-recovery-helpers.js';
import { assertFailedValidationRecoverable } from './validation-recovery-policy.js';

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
