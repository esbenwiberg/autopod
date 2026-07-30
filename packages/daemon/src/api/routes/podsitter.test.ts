import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../../pods/event-bus.js';
import { createEventRepository } from '../../pods/event-repository.js';
import { createPodsitterRepository } from '../../podsitter/podsitter-repository.js';
import type { PodsitterService } from '../../podsitter/podsitter-service.js';
import { createProviderAccountStore } from '../../provider-accounts/provider-account-store.js';
import { createTestDb, logger } from '../../test-utils/mock-helpers.js';
import { authPlugin } from '../plugins/auth.js';
import { podsitterRoutes } from './podsitter.js';

async function setup(role: 'admin' | 'operator' | 'viewer' = 'admin') {
  const db = createTestDb();
  const providerAccountStore = createProviderAccountStore(db);
  providerAccountStore.create({ id: 'sitter', name: 'Sitter', provider: 'openai' });
  providerAccountStore.updateCredentials('sitter', {
    provider: 'openai',
    authMode: 'chatgpt',
    authJson: '{}',
  });
  const repository = createPodsitterRepository(db);
  const reconcile = vi.fn(async (options?: { readOnly?: boolean }) => ({
    queued: options?.readOnly ? 1 : 0,
    processed: 0,
  }));
  const probe = vi.fn(async () => true);
  const service = {
    start: vi.fn(),
    stop: vi.fn(),
    reconcile,
    probe,
    status: vi.fn(() => ({
      configuration: repository.getConfiguration(),
      activation: null,
      provider: null,
      queueCount: 0,
    })),
  } satisfies PodsitterService;
  const app = Fastify({ logger: false });
  authPlugin(app, {
    validateToken: vi.fn(async () => ({
      oid: 'operator-1',
      preferred_username: 'masked',
      name: 'Operator',
      roles: [role],
      aud: 'test',
      iss: 'test',
      exp: 9999999999,
      iat: 0,
    })),
  });
  const eventBus = createEventBus(createEventRepository(db), logger);
  podsitterRoutes(app, { repository, service, providerAccountStore, eventBus });
  await app.ready();
  return { app, repository, reconcile, probe };
}

const headers = { authorization: 'Bearer test' };
const configuration = {
  enabled: false,
  activation: { mode: 'always' as const },
  authorizedUntil: null,
  profileScope: null,
  decisionTarget: { providerAccountId: 'sitter', runtime: 'codex' as const, model: 'gpt-5' },
  budgets: { maxDecisionsPerWindow: 20, maxActionsPerWindow: 10 },
};

describe('Podsitter routes', () => {
  const apps: Array<Awaited<ReturnType<typeof setup>>['app']> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('requires operator role for mutations while allowing redacted status', async () => {
    const viewer = await setup('viewer');
    apps.push(viewer.app);
    const denied = await viewer.app.inject({
      method: 'PUT',
      url: '/podsitter/config',
      headers,
      payload: configuration,
    });
    expect(denied.statusCode).toBe(403);
    const status = await viewer.app.inject({ method: 'GET', url: '/podsitter', headers });
    expect(status.statusCode).toBe(200);
    expect(status.body).not.toContain('credentials');
  });

  it('validates configuration and changes generation on enable and disable', async () => {
    const harness = await setup();
    apps.push(harness.app);
    const configured = await harness.app.inject({
      method: 'PUT',
      url: '/podsitter/config',
      headers,
      payload: configuration,
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toMatchObject({ enabled: false, generation: 1 });

    const enabled = await harness.app.inject({
      method: 'POST',
      url: '/podsitter/enable',
      headers,
    });
    expect(enabled.json()).toMatchObject({ enabled: true, generation: 2 });
    const disabled = await harness.app.inject({
      method: 'POST',
      url: '/podsitter/disable',
      headers,
    });
    expect(disabled.json()).toMatchObject({ enabled: false, generation: 3 });
  });

  it('keeps inactive checks read-only and exposes probe and paginated history', async () => {
    const harness = await setup('operator');
    apps.push(harness.app);
    await harness.app.inject({
      method: 'PUT',
      url: '/podsitter/config',
      headers,
      payload: configuration,
    });
    const checked = await harness.app.inject({
      method: 'POST',
      url: '/podsitter/check',
      headers,
    });
    expect(checked.json()).toEqual({ queued: 1, processed: 0 });
    expect(harness.reconcile).toHaveBeenCalledWith({ readOnly: true });

    const probed = await harness.app.inject({
      method: 'POST',
      url: '/podsitter/provider/probe',
      headers,
    });
    expect(probed.json()).toEqual({ recovered: true });
    const history = await harness.app.inject({
      method: 'GET',
      url: '/podsitter/decisions?limit=10&offset=0',
      headers,
    });
    expect(history.json()).toEqual({ items: [], total: 0 });
  });

  it('rejects incompatible dedicated targets', async () => {
    const harness = await setup();
    apps.push(harness.app);
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/podsitter/config',
      headers,
      payload: {
        ...configuration,
        decisionTarget: { providerAccountId: 'sitter', runtime: 'claude', model: 'opus' },
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('looks up decision details directly beyond the history page', async () => {
    const harness = await setup();
    apps.push(harness.app);
    vi.spyOn(harness.repository, 'listDecisions').mockImplementation(() => {
      throw new Error('detail route must not scan a bounded page');
    });
    vi.spyOn(harness.repository, 'getDecisionById').mockReturnValue({
      id: 'old-decision',
      attentionId: 'old-attention',
      podId: 'old-pod',
      attentionSignature: 'old-signature',
      configurationGeneration: 1,
      activationWindowId: 'always:g1',
      evidenceHash: 'hash',
      evidenceVersion: 1,
      target: {
        providerAccountId: 'sitter',
        runtime: 'codex',
        model: 'gpt-5',
      },
      decision: null,
      outcome: 'failed',
      failureCode: 'old',
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z',
      executedAt: null,
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/podsitter/decisions/old-decision',
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'old-decision' });
  });
});
