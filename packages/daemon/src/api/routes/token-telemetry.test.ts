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

  it('requires an admin or operator role', async () => {
    const app = await appFor({ run: vi.fn().mockResolvedValue(report) }, ['reader']);
    const response = await app.inject({ method: 'POST', url: '/admin/token-telemetry/repair' });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
