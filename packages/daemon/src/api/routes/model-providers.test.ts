import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { modelProviderRoutes } from './model-providers.js';

function buildApp() {
  const app = Fastify();
  modelProviderRoutes(app);
  return app;
}

describe('model provider catalog route', () => {
  it('returns a versioned public catalog with legacy compatibility metadata', async () => {
    const response = await buildApp().inject({ method: 'GET', url: '/model-providers' });

    expect(response.statusCode).toBe(200);
    const catalog = response.json();
    expect(catalog).toMatchObject({
      manifestVersion: 1,
      piCompatibility: {
        packageName: '@earendil-works/pi-coding-agent',
        packageVersion: '0.80.6',
        source: 'pinned-distribution',
      },
    });
    expect(catalog.providers.find(({ id }: { id: string }) => id === 'max')).toMatchObject({
      implementation: { kind: 'legacy', adapterId: 'max' },
    });
    expect(catalog.providers.find(({ id }: { id: string }) => id === 'opencode-zen')).toMatchObject(
      {
        implementation: { kind: 'generic-pi-api', piProviderId: 'opencode' },
        credentialOptions: [expect.objectContaining({ kind: 'api-key' })],
        requiredHosts: ['opencode.ai'],
        policy: { authorization: 'authorization-pending', runnable: false },
      },
    );
  });

  it('returns the exact non-runnable initial posture and user-visible caveats', async () => {
    const response = await buildApp().inject({ method: 'GET', url: '/model-providers' });
    const providers = response.json().providers as Array<{
      id: string;
      policy: {
        authorization: string;
        runnable: boolean;
        caveats: Array<{ kind: string; message: string }>;
      };
    }>;

    expect(
      providers
        .filter(({ id }) => ['opencode-zen', 'opencode-go', 'kimi-code'].includes(id))
        .map(({ id, policy }) => ({
          id,
          authorization: policy.authorization,
          runnable: policy.runnable,
        })),
    ).toEqual([
      { id: 'opencode-zen', authorization: 'authorization-pending', runnable: false },
      { id: 'opencode-go', authorization: 'authorization-pending', runnable: false },
      { id: 'kimi-code', authorization: 'blocked', runnable: false },
    ]);
    expect(
      providers
        .find(({ id }) => id === 'opencode-go')
        ?.policy.caveats.some(({ kind }) => kind === 'metered-fallback'),
    ).toBe(true);
  });

  it('contains public auth metadata but no credential material', async () => {
    const response = await buildApp().inject({ method: 'GET', url: '/model-providers' });
    const body = response.body;

    expect(body).toContain('"credentialOptions"');
    expect(body).not.toMatch(/"credentials"\s*:/);
    expect(body).not.toMatch(/"apiKey"\s*:/);
    expect(body).not.toMatch(/"secret"\s*:/);
    expect(body).not.toMatch(/"token"\s*:/);
  });
});
