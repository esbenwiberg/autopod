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

it('accepts explicit operator budget removal and rejects malformed budget changes', async () => {
  const db = createTestDb();
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  app.addHook('onRequest', async (request) => {
    request.user = { oid: 'operator' } as typeof request.user;
  });
  const { services } = createTestConfiguration(db);
  const raiseBudget = vi.fn(
    async () => ({ tokenBudget: null }) as import('@autopod/shared').TaskExecutionSummary,
  );
  configurationRoutes(app, { db, resolution: services, capabilities: () => ({}), raiseBudget });
  try {
    for (const tokenBudget of [0, -1, 1.5, 'off', Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/pods/pod/budget',
            payload: { tokenBudget, expectedBudget: 100 },
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(raiseBudget).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/pods/pod/budget',
          payload: { tokenBudget: null, expectedBudget: 100 },
        })
      ).statusCode,
    ).toBe(200);
    expect(raiseBudget).toHaveBeenCalledExactlyOnceWith('pod', null, 100, 'operator');
  } finally {
    await app.close();
    db.close();
  }
});

it('reconciles reviewer runs with an attributed note and validates reported usage', async () => {
  const db = createTestDb();
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  app.addHook('onRequest', async (request) => {
    request.user = { oid: 'operator' } as typeof request.user;
  });
  const { services } = createTestConfiguration(db);
  const runId = 'review-00000000-0000-4000-8000-000000000001';
  const reviewerRuns = {
    list: vi.fn(() => []),
    reconcile: vi.fn(
      async () =>
        ({ id: runId }) as import('../../validation/reviewer-run-repository.js').ReviewerRunRecord,
    ),
  };
  configurationRoutes(app, { db, resolution: services, capabilities: () => ({}), reviewerRuns });
  const url = `/pods/pod/reviewer-runs/${runId}/reconcile`;
  try {
    expect((await app.inject({ method: 'GET', url: '/pods/pod/reviewer-runs' })).statusCode).toBe(
      200,
    );
    expect(reviewerRuns.list).toHaveBeenCalledExactlyOnceWith('pod');
    for (const payload of [
      {},
      { note: '   ' },
      { note: 'x'.repeat(2001) },
      { note: 'ok', inputTokens: 10 },
      { note: 'ok', inputTokens: -1, outputTokens: 0 },
      { note: 'ok', inputTokens: 1.5, outputTokens: 0 },
      { note: 'ok', usageBasis: 'unknown-accepted' },
    ])
      expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/pods/pod/reviewer-runs/not-a-run/reconcile',
          payload: { note: 'ok' },
        })
      ).statusCode,
    ).toBe(400);
    expect(reviewerRuns.reconcile).not.toHaveBeenCalled();
    await app.inject({ method: 'POST', url, payload: { note: ' timed out ' } });
    await app.inject({
      method: 'POST',
      url,
      payload: { note: 'console', inputTokens: 10, outputTokens: 2 },
    });
    expect(reviewerRuns.reconcile.mock.calls).toEqual([
      ['pod', runId, 'operator', 'timed out', undefined],
      ['pod', runId, 'operator', 'console', { inputTokens: 10, outputTokens: 2 }],
    ]);
  } finally {
    await app.close();
    db.close();
  }
});
