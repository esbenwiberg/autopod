import { AutopodError } from '@autopod/shared';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { terminationAuth } from '../../test-utils/termination-reconciliation-helpers.js';
import { validationRecoveryFixture } from '../../test-utils/validation-recovery-helpers.js';
import { errorHandler } from '../error-handler.js';
import { authPlugin } from '../plugins/auth.js';
import { validationRecoveryRoutes } from './validation-recovery.js';

describe('validation recovery admission and intent', () => {
  let f: ReturnType<typeof validationRecoveryFixture>;
  let app: ReturnType<typeof Fastify>;
  const headers = { authorization: 'Bearer human-token' };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const url = () => `/pods/${f.podId}/validation-recovery`;
  const post = (action: string, extra = {}) =>
    app.inject({ method: 'POST', url: url(), headers, payload: { action, ...f.input, ...extra } });
  beforeEach(async () => {
    f = validationRecoveryFixture();
    app = Fastify();
    app.setErrorHandler(errorHandler);
    authPlugin(app, terminationAuth());
    validationRecoveryRoutes(app, f.manager);
    await app.ready();
  });
  afterEach(async () => {
    await tick();
    await app.close();
    f.db.close();
  });

  it('offers repair after a successful worker with failed lint, without requiring a worker failure', async () => {
    const result = await app.inject({ url: url(), headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      generation: f.input.expectedGeneration,
      validationTimestamp: f.result.timestamp,
      fixValidation: { allowed: true },
      retryChecks: { allowed: true },
      activeAction: null,
    });
    expect(f.repair).not.toHaveBeenCalled();
    expect(f.revalidate).not.toHaveBeenCalled();
  });

  it('retry checks starts only validation and responds before the work completes', async () => {
    let finish: () => void = () => {};
    f.revalidate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ newCommits: false, result: 'pass' });
        }),
    );
    const result = await post('retry-checks');
    expect(result.statusCode).toBe(202);
    expect(f.revalidate).toHaveBeenCalledExactlyOnceWith(f.podId, {
      force: true,
      checksOnly: true,
    });
    expect(f.repair).not.toHaveBeenCalled();
    expect((await app.inject({ url: url(), headers })).json().activeAction).toBe('retry-checks');
    finish();
    await tick();
    expect((await app.inject({ url: url(), headers })).json().activeAction).toBeNull();
  });

  it('repair requests exactly the existing rework path, not a validation waiver', async () => {
    const before = f.podRepo.getOrThrow(f.podId);
    const result = await post('fix-validation');
    expect(result.statusCode).toBe(202);
    await tick();
    expect(f.repair).toHaveBeenCalledExactlyOnceWith(f.podId, { force: true });
    expect(f.revalidate).not.toHaveBeenCalled();
    expect(f.podRepo.getOrThrow(f.podId)).toEqual(before);
    expect(f.podRepo.workerRetries?.state(f.podId).authorizations).toEqual([]);
  });

  it('coalesces duplicate requests and refuses competing recovery intents', async () => {
    let finish: () => void = () => {};
    f.repair.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    expect((await post('fix-validation')).statusCode).toBe(202);
    expect((await post('fix-validation')).statusCode).toBe(202);
    expect((await post('retry-checks')).statusCode).toBe(409);
    expect(f.repair).toHaveBeenCalledTimes(1);
    finish();
    await tick();
  });

  it.each([{ expectedGeneration: 999 }, { expectedValidationTimestamp: 'older-result' }])(
    'refuses stale source/lifecycle inputs %j',
    async (extra) => {
      const response = await post('retry-checks', extra);
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('STALE_VALIDATION_RECOVERY');
      expect(f.revalidate).not.toHaveBeenCalled();
    },
  );

  it('a replay after a new result cannot dispatch another run', async () => {
    await post('retry-checks');
    await tick();
    f.podRepo.update(f.podId, {
      lastValidationResult: { ...f.result, timestamp: '2026-10-27T18:00:00.000Z' },
    });
    expect((await post('retry-checks')).statusCode).toBe(409);
    expect(f.revalidate).toHaveBeenCalledTimes(1);
  });

  it('retains detached failure details for the UI rather than silently swallowing them', async () => {
    f.repair.mockRejectedValue(
      new AutopodError('Original workspace could not be preserved', 'WORKSPACE_SYNC_FAILED', 409),
    );
    await post('fix-validation');
    await tick();
    const state = (await app.inject({ url: url(), headers })).json();
    expect(state.activeAction).toBeNull();
    expect(state.lastError).toEqual({
      code: 'WORKSPACE_SYNC_FAILED',
      message: 'Original workspace could not be preserved',
    });
  });

  it('surfaces a parked admission denial even when the established workflow returns normally', async () => {
    f.revalidate.mockImplementation(async () => {
      f.podRepo.update(f.podId, {
        failureReason: 'Record a human retry authorization before repeating unchanged checks.',
      });
      return { newCommits: false, result: 'fail' };
    });
    await post('retry-checks');
    await tick();
    expect((await app.inject({ url: url(), headers })).json().lastError).toEqual({
      code: 'RECOVERY_NOT_STARTED',
      message: 'Record a human retry authorization before repeating unchanged checks.',
    });
  });

  it.each(['fix-validation', 'retry-checks'])(
    'refuses unknown validation execution before %s',
    async (action) => {
      f.podRepo.update(f.podId, {
        lastValidationResult: {
          ...f.result,
          infrastructureFailure: {
            phase: 'test',
            code: 'EXEC_EXIT_UNVERIFIED',
            message: 'No exit evidence',
            retryable: false,
          },
        },
      });
      const state = (await app.inject({ url: url(), headers })).json();
      expect(state.fixValidation).toMatchObject({
        allowed: false,
        code: 'VALIDATION_EXECUTION_UNVERIFIED',
      });
      expect(state.retryChecks).toMatchObject({
        allowed: false,
        code: 'VALIDATION_EXECUTION_UNVERIFIED',
      });
      expect((await post(action)).statusCode).toBe(409);
      expect(f.repair).not.toHaveBeenCalled();
      expect(f.revalidate).not.toHaveBeenCalled();
    },
  );

  it.each(['running', 'validated', 'complete'] as const)(
    'refuses %s, never turning retry into publication/merge',
    async (status) => {
      f.podRepo.update(f.podId, { status });
      expect((await post('retry-checks')).statusCode).toBe(409);
      expect(f.revalidate).not.toHaveBeenCalled();
    },
  );

  it('does not offer retry for a passing validation with a downstream delivery failure', async () => {
    f.podRepo.update(f.podId, { lastValidationResult: { ...f.result, overall: 'pass' } });
    expect((await post('retry-checks')).statusCode).toBe(409);
    expect(f.revalidate).not.toHaveBeenCalled();
  });

  it('requires user authentication and rejects client-supplied actor/grants', async () => {
    const anonymous = await app.inject({
      method: 'POST',
      url: url(),
      payload: { action: 'fix-validation', ...f.input },
    });
    expect(anonymous.statusCode).toBe(401);
    expect((await post('fix-validation', { actor: 'spoofed', authorized: true })).statusCode).toBe(
      400,
    );
    expect(f.repair).not.toHaveBeenCalled();
  });
});
