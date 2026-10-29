import { rm } from 'node:fs/promises';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSourceControllerFixture } from '../../test-utils/source-controller-helpers.js';
import { terminationAuth } from '../../test-utils/termination-reconciliation-helpers.js';
import { errorHandler } from '../error-handler.js';
import { authPlugin } from '../plugins/auth.js';
import { sourceAdoptionRoutes } from './source-adoption.js';

describe('authenticated durable source recovery API', () => {
  let s: Awaited<ReturnType<typeof createSourceControllerFixture>>;
  let app: ReturnType<typeof Fastify>;
  const headers = { authorization: 'Bearer human-token' };
  beforeEach(async () => {
    s = await createSourceControllerFixture();
    app = Fastify();
    app.setErrorHandler(errorHandler);
    authPlugin(app, terminationAuth());
    sourceAdoptionRoutes(app, {
      adoptSource: s.controller.submit,
      getSourceAdoptions: s.controller.list,
    });
    await app.ready();
  });
  afterEach(async () => {
    await s.controller.wait(s.input.id);
    await app.close();
    await rm(s.root, { recursive: true, force: true });
  });
  const url = () => `/pods/${s.podId}/source-adoptions`;
  it('authenticates status and admits only server-derived human identity; duplicate POST merely observes', async () => {
    expect((await app.inject({ method: 'GET', url: url(), headers })).json()).toEqual({
      operations: [],
    });
    const response = await app.inject({ method: 'POST', url: url(), headers, payload: s.input });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toMatchObject({
      actor: { type: 'human', userId: 'operator-oid' },
      delivery: 'not-authorized',
      reports: 'not-released',
    });
    await s.controller.wait(s.input.id);
    const count = s.cm.execStreaming.mock.calls.length;
    const duplicate = await app.inject({ method: 'POST', url: url(), headers, payload: s.input });
    expect(duplicate.statusCode, duplicate.body).toBe(200);
    expect(s.cm.execStreaming).toHaveBeenCalledTimes(count);
    const state = await app.inject({ method: 'GET', url: url(), headers });
    expect(state.json()).toMatchObject({ operations: [{ stage: 'checked', validation: 'pass' }] });
    expect(state.body).not.toContain(s.host);
    expect(state.body).not.toContain(s.root);
  });
  it.each([undefined, 'Bearer worker-hmac-token'])(
    'refuses missing or worker credentials before any source read/mutation (%s)',
    async (authorization) => {
      for (const method of ['GET', 'POST'] as const) {
        const response = await app.inject({
          method,
          url: url(),
          headers: authorization ? { authorization } : {},
          ...(method === 'POST' ? { payload: s.input } : {}),
        });
        expect(response.statusCode).toBe(401);
      }
      expect(s.cm.getResourceKey).not.toHaveBeenCalled();
      expect(s.cm.execStreaming).not.toHaveBeenCalled();
    },
  );
  it.each([
    { actor: { type: 'human', userId: 'spoof' } },
    { worktreePath: '/somewhere' },
    { force: true },
    { expectedGeneration: 0 },
  ])('rejects caller authority/path/force overrides %j', async (extra) => {
    const response = await app.inject({
      method: 'POST',
      url: url(),
      headers,
      payload: { ...s.input, ...extra },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(s.controller.list(s.podId)).toEqual([]);
    expect(s.cm.execStreaming).not.toHaveBeenCalled();
  });
});
