import type { PodGoal } from '@autopod/shared';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { createTestConfiguration } from '../../test-utils/configuration-helpers.js';
import { createTestDb } from '../../test-utils/mock-helpers.js';
import { errorHandler } from '../error-handler.js';
import { configurationRoutes } from './configuration.js';

it('keeps Goal controls revision-bound and refuses objective or budget replacement', async () => {
  const db = createTestDb();
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  const { services } = createTestConfiguration(db);
  const goal = { podId: 'pod', revision: 7, state: 'paused', objective: 'Tests pass' } as PodGoal;
  const control = vi.fn(async () => goal);
  const resume = vi.fn(async () => {});
  configurationRoutes(app, {
    db,
    resolution: services,
    capabilities: () => ({}),
    goals: { get: () => goal, control, resume },
  });
  try {
    expect((await app.inject('/pods/pod/goal')).json()).toEqual(goal);
    for (const extra of [
      { objective: 'Replacement' },
      { tokenBudget: 500 },
      { providerAccountId: 'other' },
    ]) {
      const result = await app.inject({
        method: 'POST',
        url: '/pods/pod/goal/control',
        payload: { intent: 'resume', revision: 7, ...extra },
      });
      expect(result.statusCode).toBe(400);
    }
    expect(resume).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/pods/pod/goal/control',
          payload: { intent: 'resume', revision: 7 },
        })
      ).statusCode,
    ).toBe(200);
    expect(resume).toHaveBeenCalledExactlyOnceWith('pod', 7);
    expect(control).not.toHaveBeenCalled();
    await app.inject({
      method: 'POST',
      url: '/pods/pod/goal/control',
      payload: { intent: 'pause', revision: 7 },
    });
    expect(control).toHaveBeenCalledExactlyOnceWith('pod', 'pause', 7);
  } finally {
    await app.close();
    db.close();
  }
});
