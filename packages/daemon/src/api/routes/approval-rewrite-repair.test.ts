import { rm } from 'node:fs/promises';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { rewriteRepairFixture } from '../../test-utils/approval-rewrite-repair-helpers.js';
import { terminationAuth } from '../../test-utils/termination-reconciliation-helpers.js';
import { errorHandler } from '../error-handler.js';
import { authPlugin } from '../plugins/auth.js';
import { checkpointRecoveryRoutes } from './checkpoint-recovery.js';

it('authenticates and strictly transports rewrite repair preparation/selection; GET is read-only', async () => {
  const f = await rewriteRepairFixture();
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  authPlugin(app, terminationAuth());
  checkpointRecoveryRoutes(app, {
    ...f.manager,
    prepareRewriteRepair: f.recovery.prepareRewriteRepair,
    checkRewriteRepair: f.recovery.checkRewriteRepair,
    getCheckpointRecoveries: f.recovery.list,
  });
  const url = `/pods/${f.podId}/approval-rewrite-repair`;
  const headers = { authorization: 'Bearer human-token' };
  try {
    for (const authorization of [undefined, 'Bearer pod-token'])
      for (const endpoint of [url, `${url}/${f.request.id}/check`])
        expect(
          (
            await app.inject({
              method: 'POST',
              url: endpoint,
              payload: f.request,
              headers: authorization ? { authorization } : {},
            })
          ).statusCode,
        ).toBe(401);
    const before = f.pod();
    expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(200);
    expect(f.pod()).toEqual(before);
    expect(f.cm.getStatus).not.toHaveBeenCalled();
    for (const extra of [
      { actor: f.actor },
      { path: '/tmp/source' },
      { force: true },
      { executionProfileId: 'other' },
      { testBudget: { seconds: 3600 } },
      { result: { overall: 'pass' } },
    ])
      expect(
        (await app.inject({ method: 'POST', url, headers, payload: { ...f.request, ...extra } }))
          .statusCode,
      ).toBe(400);
    const result = await app.inject({ method: 'POST', url, headers, payload: f.request });
    expect(result.statusCode, result.body).toBe(202);
    await f.recovery.wait(f.request.id);
    const op = f.recovery.list(f.podId)[0]!;
    expect(op.prepared).not.toBeNull();
    const input = {
      rewriteId: f.rewriteId,
      failedDispatchId: f.dispatchId,
      expectedGeneration: f.request.expectedGeneration,
      expectedResultHash: f.request.expectedResultHash,
      candidateHead: op.prepared!.head,
      reason: 'Select exact prepared candidate for fresh independent checks',
    };
    for (const extra of [
      { testBudget: { seconds: 1800 } },
      { executionProfileId: 'other' },
      { actor: f.actor },
      { remoteHead: op.prepared!.head },
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${url}/${op.id}/check`,
            headers,
            payload: { ...input, ...extra },
          })
        ).statusCode,
      ).toBe(400);
    const selected = await app.inject({
      method: 'POST',
      url: `${url}/${op.id}/check`,
      headers,
      payload: input,
    });
    expect(selected.statusCode, selected.body).toBe(202);
    expect(selected.json().operation.selected.actor).toEqual({
      type: 'human',
      userId: 'operator-oid',
    });
  } finally {
    await f.recovery.wait(f.request.id);
    await app.close();
    f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
