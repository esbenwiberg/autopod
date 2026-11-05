import { randomUUID } from 'node:crypto';
import { AutopodError } from '@autopod/shared';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { createNudgeRepository } from '../../pods/nudge-repository.js';
import { createPodRepository } from '../../pods/pod-repository.js';
import { createTestDb, insertTestProfile } from '../../test-utils/mock-helpers.js';
import { reworkRoutes } from './rework.js';

async function fixture() {
  const db = createTestDb();
  insertTestProfile(db);
  const repo = createPodRepository(db);
  repo.insert({
    id: 'rework-fixture',
    profileName: 'test-profile',
    task: 'Continue',
    status: 'failed',
    model: 'model',
    runtime: 'codex',
    executionTarget: 'local',
    branch: 'fixture',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  const manager = {
    getSession: (id: string) => repo.getOrThrow(id),
    assertCanRework: vi.fn(() => ({}) as { notBefore?: string; authorizationAvailable?: boolean }),
    triggerValidation: vi.fn(async () => {}),
  };
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.user = { oid: 'operator' } as typeof request.user;
  });
  app.setErrorHandler((error, _request, reply) => {
    reply
      .code(error instanceof AutopodError ? error.statusCode : 400)
      .send({ error: error.message });
  });
  reworkRoutes(app, manager, repo, db, () => false);
  await app.ready();
  return {
    app,
    db,
    repo,
    manager,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}
it('inspects eligibility without dispatch; replays the accepted HTTP request without duplicating work', async () => {
  const f = await fixture();
  try {
    const eligibility = await f.app.inject({ url: '/pods/rework-fixture/rework-v1/eligibility' });
    expect(eligibility.json()).toMatchObject({ eligible: true, status: 'eligible', generation: 1 });
    expect(f.manager.triggerValidation).not.toHaveBeenCalled();
    const payload = {
      requestKey: randomUUID(),
      generation: 1,
      guidance: 'Keep the tests and finish the remaining repair.',
    };
    const first = await f.app.inject({
      method: 'POST',
      url: '/pods/rework-fixture/rework-v1',
      payload,
    });
    expect(first.statusCode).toBe(202);
    const replay = await f.app.inject({
      method: 'POST',
      url: '/pods/rework-fixture/rework-v1',
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(f.manager.triggerValidation).toHaveBeenCalledTimes(1);
    expect(createNudgeRepository(f.db).listPending('rework-fixture')).toHaveLength(1);
    const changed = await f.app.inject({
      method: 'POST',
      url: '/pods/rework-fixture/rework-v1',
      payload: { ...payload, guidance: 'Changed' },
    });
    expect(changed.statusCode).toBe(409);
  } finally {
    await f.close();
  }
});
it.each([
  'TASK_RETRY_AUTHORIZATION_REQUIRED',
  'TASK_RETRY_BINDING_CHANGED',
  'TASK_RETRY_BACKOFF_PENDING',
  'CONTINUATION_SOURCE_HELD',
  'GOAL_NATIVE_RESUME_REQUIRED',
])('projects %s and still rechecks admission on POST', async (code) => {
  const f = await fixture();
  try {
    f.manager.assertCanRework.mockImplementation(() => {
      throw new AutopodError('Inspect current facts', code, 409);
    });
    const result = (
      await f.app.inject({ url: '/pods/rework-fixture/rework-v1/eligibility' })
    ).json();
    expect(result.eligible).toBe(false);
    expect(result.status).toBe(
      code === 'TASK_RETRY_AUTHORIZATION_REQUIRED'
        ? 'authorization_needed'
        : code === 'TASK_RETRY_BACKOFF_PENDING'
          ? 'cooldown'
          : 'blocked',
    );
    const response = await f.app.inject({
      method: 'POST',
      url: '/pods/rework-fixture/rework-v1',
      payload: { requestKey: randomUUID(), generation: 1, guidance: 'Retain draft' },
    });
    expect(response.statusCode).toBe(409);
    expect(createNudgeRepository(f.db).hasPending('rework-fixture')).toBe(false);
    expect(f.manager.triggerValidation).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
it('shows recorded grants and bounded cooldowns without consuming or dispatching', async () => {
  const f = await fixture();
  try {
    f.manager.assertCanRework.mockReturnValue({ authorizationAvailable: true });
    expect(
      (await f.app.inject({ url: '/pods/rework-fixture/rework-v1/eligibility' })).json().status,
    ).toBe('grant_recorded');
    f.manager.assertCanRework.mockReturnValue({
      authorizationAvailable: true,
      notBefore: new Date(Date.now() + 30_000).toISOString(),
    });
    expect(
      (await f.app.inject({ url: '/pods/rework-fixture/rework-v1/eligibility' })).json().status,
    ).toBe('cooldown');
    expect(f.manager.triggerValidation).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
