import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { TokenTelemetryRepair } from '../../pods/token-telemetry-repair.js';
import { tokenTelemetryRoutes } from './token-telemetry.js';

async function appFor(repair: TokenTelemetryRepair, roles = ['admin']) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    request.user = { oid: 'operator', roles };
  });
  tokenTelemetryRoutes(app, repair);
  await app.ready();
  return app;
}

const report = {
  mode: 'dry-run' as const,
  startedAt: '2026-07-30T20:00:00.000Z',
  completedAt: '2026-07-30T20:00:01.000Z',
  repairedPods: 1,
  partialPods: 0,
  skippedPods: 0,
  entries: [],
};

describe('token telemetry repair route', () => {
  it('defaults to dry-run and requires an explicit apply confirmation', async () => {
    const run = vi.fn().mockResolvedValue(report);
    const app = await appFor({ run });

    const dryRun = await app.inject({ method: 'POST', url: '/admin/token-telemetry/repair' });
    expect(dryRun.statusCode).toBe(200);
    expect(run).toHaveBeenCalledWith({ apply: false });

    const rejected = await app.inject({
      method: 'POST',
      url: '/admin/token-telemetry/repair',
      payload: { apply: true },
    });
    expect(rejected.statusCode).toBe(400);

    const applied = await app.inject({
      method: 'POST',
      url: '/admin/token-telemetry/repair',
      payload: { apply: true, confirmation: 'APPLY_TOKEN_TELEMETRY_REPAIR' },
    });
    expect(applied.statusCode).toBe(200);
    expect(run).toHaveBeenLastCalledWith({ apply: true });
    await app.close();
  });

  it('binds scoped native repair to authenticated operator and exact preview; never accepts supplied usage', async () => {
    const inspect = vi.fn().mockResolvedValue({ mode: 'preview', expectedBinding: 'a'.repeat(64) });
    const apply = vi.fn().mockResolvedValue({ version: 1 });
    const service = { run: vi.fn(), claudeSession: { inspect, apply } };
    const app = await appFor(service);
    expect(
      (await app.inject({ method: 'GET', url: '/pods/exact/claude-telemetry' })).statusCode,
    ).toBe(200);
    expect(inspect).toHaveBeenCalledWith('exact');
    const request = {
      expectedBinding: 'a'.repeat(64),
      reason: 'Reconcile the exact durable session',
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/pods/exact/claude-telemetry',
          payload: { ...request, inputTokens: 0 },
        })
      ).statusCode,
    ).toBe(400);
    expect(apply).not.toHaveBeenCalled();
    expect(
      (await app.inject({ method: 'POST', url: '/pods/exact/claude-telemetry', payload: request }))
        .statusCode,
    ).toBe(200);
    expect(apply).toHaveBeenCalledWith('exact', request, 'operator');
    await app.close();
    const reader = await appFor(service, ['reader']);
    expect(
      (await reader.inject({ method: 'GET', url: '/pods/exact/claude-telemetry' })).statusCode,
    ).toBe(403);
    expect(
      (
        await reader.inject({
          method: 'POST',
          url: '/pods/exact/claude-telemetry',
          payload: request,
        })
      ).statusCode,
    ).toBe(403);
    await reader.close();
  });

  it('requires an admin or operator role', async () => {
    const app = await appFor({ run: vi.fn().mockResolvedValue(report) }, ['reader']);
    const response = await app.inject({ method: 'POST', url: '/admin/token-telemetry/repair' });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
