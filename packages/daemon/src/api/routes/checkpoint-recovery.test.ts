import { rm } from 'node:fs/promises';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blockedCheckpointOutcomeFixture,
  retainedCheckpointFixture,
} from '../../test-utils/retained-checkpoint-helpers.js';
import { terminationAuth } from '../../test-utils/termination-reconciliation-helpers.js';
import { errorHandler } from '../error-handler.js';
import { authPlugin } from '../plugins/auth.js';
import { checkpointRecoveryRoutes } from './checkpoint-recovery.js';

describe('human-only retained checkpoint selection', () => {
  let f: Awaited<ReturnType<typeof retainedCheckpointFixture>>;
  let app: ReturnType<typeof Fastify>;
  const headers = { authorization: 'Bearer human-token' };
  const endpoint = () => `/pods/${f.podId}/checkpoint-recovery`;
  beforeEach(async () => {
    f = await retainedCheckpointFixture();
    app = Fastify();
    app.setErrorHandler(errorHandler);
    authPlugin(app, terminationAuth());
    checkpointRecoveryRoutes(app, {
      recoverCheckpoint: f.recovery.submit,
      getCheckpointRecoveries: f.recovery.list,
      reconcileCheckpointOutcome: f.recovery.reconcileOutcome,
    });
    await app.ready();
  });
  afterEach(async () => {
    await f.recovery.wait(f.input.id);
    await app.close();
    f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  it('inspects without any provider observation, credential rotation or queue dispatch', async () => {
    const result = await app.inject({ url: endpoint(), headers });
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.json()).toEqual({ operations: [] });
    expect(f.cm.getStatus).not.toHaveBeenCalled();
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  });
  it('requires authentication and refuses caller proof, force, source substitution and actor fields', async () => {
    expect(
      (await app.inject({ method: 'POST', url: endpoint(), payload: f.input })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: endpoint(),
          headers: { authorization: 'Bearer pod-token' },
          payload: f.input,
        })
      ).statusCode,
    ).toBe(401);
    for (const extra of [
      { force: true },
      { actor: f.actor },
      { exitCode: 0 },
      { sourcePath: '/tmp/other' },
      { expectedGeneration: 0 },
      { checkpointHead: 'main' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: endpoint(),
        headers,
        payload: { ...f.input, ...extra },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(f.cm.getStatus).not.toHaveBeenCalled();
  });
  it('strictly authenticates outcome reconciliation and preserves failed checks on replay', async () => {
    const input = await blockedCheckpointOutcomeFixture(f);
    const url = `${endpoint()}/${f.input.id}/reconcile`;
    for (const authorization of [undefined, 'Bearer pod-token']) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: authorization ? { authorization } : {},
        payload: input,
      });
      expect(response.statusCode).toBe(401);
    }
    for (const extra of [
      { force: true },
      { exitCode: 0 },
      { actor: f.actor },
      { sourcePath: '/tmp/other' },
    ])
      expect(
        (await app.inject({ method: 'POST', url, headers, payload: { ...input, ...extra } }))
          .statusCode,
      ).toBe(400);
    const count = vi.mocked(f.ctx.validationEngine.validate).mock.calls.length;
    const response = await app.inject({ method: 'POST', url, headers, payload: input });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().operation).toMatchObject({
      checked: { result: { overall: 'fail' } },
      reconciled: { actor: { type: 'human' } },
    });
    expect((await app.inject({ method: 'POST', url, headers, payload: input })).json()).toEqual(
      response.json(),
    );
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(count);
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.pod().status).toBe('review_required');
  });
  it('returns a durable 202 selection before preparation completes and replays without another operation', async () => {
    let finish: () => void = () => {};
    const pending = new Promise<typeof f.prepared>((resolve) => {
      finish = () => resolve(f.prepared);
    });
    vi.mocked(f.deps.prepare!).mockReturnValue(pending);
    const response = await app.inject({
      method: 'POST',
      url: endpoint(),
      headers,
      payload: f.input,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().operation).toMatchObject({
      id: f.input.id,
      actor: { type: 'human' },
      activated: null,
    });
    const replay = await app.inject({ method: 'POST', url: endpoint(), headers, payload: f.input });
    expect(replay.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));
    finish();
    await f.recovery.wait(f.input.id);
    expect(f.deps.prepare).toHaveBeenCalledTimes(1);
    expect(f.deps.enqueue).toHaveBeenCalledTimes(1);
    expect((await app.inject({ url: endpoint(), headers })).json().operations[0]).toMatchObject({
      activated: { generation: 2 },
      checked: null,
    });
  });
});
