import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { repairContinuationRoutes } from './repair-continuation.js';

const hash = 'a'.repeat(64);
const request = {
  version: 1,
  intent: 'qualify_then_code_once',
  id: 'stable-request',
  expectedGeneration: 1,
  expectedResultHash: hash,
  expectedReportSetHash: hash,
  sourceHead: 'a'.repeat(40),
  executionProfileId: 'reviewed',
  expectedExecutionDigest: hash,
  expectedBindingDigest: hash,
  reason: 'Authorize one conditional repair segment',
};
async function fixture(auth = true) {
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    if (auth) req.user = { oid: 'operator' } as NonNullable<typeof req.user>;
  });
  const manager = {
    inspectRepairContinuation: vi.fn(() => ({ available: true })),
    previewRepairContinuation: vi.fn(async () => ({
      configurationOnly: true,
      actualQualification: 'not_run',
      conditionalAttemptEligible: true,
    })),
    authorizeRepairContinuation: vi.fn(async () => ({ state: 'claimed', qualification: null })),
    getRepairContinuation: vi.fn(() => ({ state: 'unknown' })),
  };
  repairContinuationRoutes(
    app,
    manager as unknown as Parameters<typeof repairContinuationRoutes>[1],
  );
  await app.ready();
  return { app, manager };
}
describe('repair-continuation-v1 strict authenticated transport', () => {
  it('allows conditional POST without caller proof and observes the same request after uncertainty', async () => {
    const { app, manager } = await fixture();
    const preview = await app.inject({
      url:
        '/pods/pod/repair-continuation-v1/preview?sourceHead=' +
        request.sourceHead +
        '&executionProfileId=reviewed',
    });
    expect(preview.json()).toMatchObject({
      actualQualification: 'not_run',
      conditionalAttemptEligible: true,
    });
    const accepted = await app.inject({
      method: 'POST',
      url: '/pods/pod/repair-continuation-v1',
      payload: request,
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ state: 'claimed', qualification: null });
    expect(manager.authorizeRepairContinuation).toHaveBeenCalledWith('pod', request, {
      type: 'human',
      userId: 'operator',
    });
    const observed = await app.inject({
      url: '/pods/pod/repair-continuation-v1/requests/stable-request',
    });
    expect(observed.json()).toEqual({ state: 'unknown' });
    expect(manager.authorizeRepairContinuation).toHaveBeenCalledTimes(1);
    expect(observed.headers['cache-control']).toBe('no-store');
    await app.close();
  });
  it('rejects proof/actor/force/grant fields and does not call admission', async () => {
    const { app, manager } = await fixture();
    for (const field of ['actor', 'qualification', 'force', 'retryGrant', 'epoch']) {
      const result = await app.inject({
        method: 'POST',
        url: '/pods/pod/repair-continuation-v1',
        payload: { ...request, [field]: true },
      });
      expect(result.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(manager.authorizeRepairContinuation).not.toHaveBeenCalled();
    await app.close();
  });
  it('requires authenticated human identity even for observation/preview', async () => {
    const { app, manager } = await fixture(false);
    for (const url of [
      '/pods/pod/repair-continuation-v1',
      '/pods/pod/repair-continuation-v1/preview',
      '/pods/pod/repair-continuation-v1/requests/stable-request',
    ])
      expect((await app.inject({ url })).statusCode).toBe(401);
    expect(manager.inspectRepairContinuation).not.toHaveBeenCalled();
    await app.close();
  });
});
