import type { PublicProviderCatalog } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { resolveCatalogProfileSelection } from './profile.js';
import {
  canSubmitGenericApiKey,
  catalogProviderModels,
  findCatalogProvider,
} from './provider-account.js';

const catalog: PublicProviderCatalog = {
  manifestVersion: 1,
  piCompatibility: {
    packageName: '@earendil-works/pi-coding-agent',
    packageVersion: '0.80.6',
    source: 'pinned-distribution',
  },
  providers: [
    {
      id: 'fixture-cloud',
      displayName: 'Fixture Cloud',
      description: 'Synthetic generic provider',
      icon: 'unrecognized-presentation-token',
      implementation: { kind: 'generic-pi-api', piProviderId: 'fixture' },
      credentialOptions: [
        {
          kind: 'api-key',
          label: 'Fixture key',
          acquisition: 'Create a fixture key.',
        },
      ],
      modelIds: ['fixture/model-a'],
      requiredHosts: ['api.fixture.invalid'],
      policy: {
        lifecycle: 'experimental',
        authorization: 'supported',
        runnable: true,
        caveats: [{ kind: 'privacy', severity: 'warning', message: 'Review fixture privacy.' }],
      },
    },
    {
      id: 'blocked-fixture',
      displayName: 'Blocked Fixture',
      description: 'Blocked synthetic provider',
      implementation: { kind: 'generic-pi-api', piProviderId: 'blocked-fixture' },
      credentialOptions: [],
      modelIds: [],
      requiredHosts: [],
      policy: {
        lifecycle: 'experimental',
        authorization: 'blocked',
        runnable: false,
        caveats: [
          {
            kind: 'subscription',
            severity: 'blocking',
            message: 'Pending provider authorization.',
          },
        ],
      },
    },
  ],
  models: [
    {
      id: 'fixture/model-a',
      providerId: 'fixture-cloud',
      displayName: 'Fixture Model A',
      lifecycle: 'active',
    },
  ],
};

describe('daemon-driven provider catalog', () => {
  it('discovers a synthetic provider and its models without source enumeration', () => {
    expect(findCatalogProvider(catalog, 'fixture-cloud')).toMatchObject({
      displayName: 'Fixture Cloud',
      implementation: { kind: 'generic-pi-api' },
    });
    expect(catalogProviderModels(catalog, 'fixture-cloud')).toEqual([
      expect.objectContaining({ id: 'fixture/model-a' }),
    ]);
    expect(catalog.providers[0]?.modelIds).toContain('fixture/model-a');
    expect(resolveCatalogProfileSelection(catalog, 'fixture-cloud', 'fixture/model-a')).toEqual({
      modelProvider: 'pi',
      defaultRuntime: 'pi',
      defaultModel: 'fixture/model-a',
    });
  });

  it('exposes policy, credential guidance, and caveats without secrets', () => {
    const provider = findCatalogProvider(catalog, 'blocked-fixture');
    expect(provider?.policy).toMatchObject({ authorization: 'blocked', runnable: false });
    expect(provider?.policy.caveats[0]?.message).toContain('authorization');
    expect(JSON.stringify(catalog)).not.toMatch(/apiKey|secret/i);
    expect(provider).toBeDefined();
    const runnableProvider = catalog.providers[0];
    expect(runnableProvider).toBeDefined();
    if (!provider || !runnableProvider) return;
    expect(canSubmitGenericApiKey(provider)).toBe(false);
    expect(canSubmitGenericApiKey(runnableProvider)).toBe(true);
  });
});
