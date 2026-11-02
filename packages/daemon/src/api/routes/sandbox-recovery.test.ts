import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  sandboxRecoveryFixture,
  sandboxValidationAbandonmentFixture,
} from '../../test-utils/sandbox-recovery-helpers.js';
import { terminationAuth } from '../../test-utils/termination-reconciliation-helpers.js';
import { errorHandler } from '../error-handler.js';
import { authPlugin } from '../plugins/auth.js';
import { sandboxRecoveryRoutes } from './sandbox-recovery.js';

describe('human sandbox recovery API', () => {
  let f: ReturnType<typeof sandboxRecoveryFixture>;
  let app: ReturnType<typeof Fastify>;
  const headers = { authorization: 'Bearer human-token' };
  const url = '/pods/prepare/sandbox-recovery';
  beforeEach(async () => {
    f = sandboxRecoveryFixture();
    app = Fastify();
    app.setErrorHandler(errorHandler);
    authPlugin(app, terminationAuth());
    sandboxRecoveryRoutes(app, {
      getSandboxRecovery: (id) => f.recovery.inspect(id),
      recoverSandbox: (id, input, actor) => f.recovery.submit(id, input, actor),
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });
  it('observes fresh state without waking or deleting anything', async () => {
    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().resources[0]).toMatchObject({
      providerState: 'stopped',
      abandonBlocked: null,
    });
    expect(f.cm.start).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
  it('requires a human identity; refuses force, actor and invented provider evidence', async () => {
    for (const auth of [{}, { authorization: 'Bearer pod-token' }])
      expect(
        (await app.inject({ method: 'POST', url, headers: auth, payload: f.input })).statusCode,
      ).toBe(401);
    for (const extra of [
      { force: true },
      { actor: f.actor },
      { providerRejected: true },
      { expectedGeneration: 0 },
    ])
      expect(
        (await app.inject({ method: 'POST', url, headers, payload: { ...f.input, ...extra } }))
          .statusCode,
      ).toBe(400);
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
  it('records authenticated actor and confirmation; returns exact replay receipt after pod deletion', async () => {
    const first = await app.inject({ method: 'POST', url, headers, payload: f.input });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      podDeleted: true,
      operation: { action: 'abandon', id: f.input.id },
    });
    expect(first.json().operation.userId).not.toBe(f.actor.userId);
    const second = await app.inject({ method: 'POST', url, headers, payload: f.input });
    expect(second.statusCode).toBe(200);
    expect(second.json().operation).toEqual(first.json().operation);
    expect(f.cm.kill).toHaveBeenCalledTimes(1);
    expect((await app.inject({ url, headers })).statusCode).toBe(404);
  });
  it('offers explicit abandonment for an exact validation hold, while Start and missing consent remain blocked', async () => {
    const held = sandboxValidationAbandonmentFixture();
    f = held;
    const inspected = await app.inject({ url, headers });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json().resources[0]).toMatchObject({ abandonBlocked: null });
    expect(inspected.json().resources[0].startBlocked).toContain('termination is unverified');
    for (const change of [{ action: 'start' }, { acknowledgeDataLoss: false }]) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { ...held.input, ...change },
      });
      expect(response.statusCode).toBe(409);
    }
    expect(held.cm.kill).not.toHaveBeenCalled();
    const abandoned = await app.inject({ method: 'POST', url, headers, payload: held.input });
    expect(abandoned.statusCode).toBe(200);
    expect(abandoned.json().podDeleted).toBe(true);
    expect(abandoned.json().operation.validationEvidence).toContain(held.dispatch);
    expect(held.cm.start).not.toHaveBeenCalled();
    expect(held.validations.intent(held.dispatch)).toBeNull();
  });
  it('returns 409 rather than replaying an outcome-unknown resume', async () => {
    const response = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { ...f.input, action: 'start' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('SANDBOX_RECOVERY_BLOCKED');
    expect(f.cm.start).not.toHaveBeenCalled();
  });
});
