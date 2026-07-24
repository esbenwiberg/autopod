import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG, PROVIDER_MANIFEST_VERSION, createProviderCatalog } from '../index.js';
import type { CompiledProviderManifest } from '../types/provider-catalog.js';

function syntheticManifest(): CompiledProviderManifest {
  return {
    manifestVersion: PROVIDER_MANIFEST_VERSION,
    piCompatibility: {
      packageName: '@example/pi',
      packageVersion: '1.2.3',
      source: 'pinned-distribution',
    },
    providers: [
      {
        id: 'fixture-cloud',
        displayName: 'Fixture Cloud',
        description: 'A manifest-only test provider.',
        implementation: { kind: 'generic-pi-api', piProviderId: 'fixture' },
        credentialOptions: [
          {
            kind: 'api-key',
            label: 'Fixture key',
            acquisition: 'Create a key in the fixture console.',
          },
        ],
        modelIds: ['fixture/reviewed-model'],
        requiredHosts: ['api.fixture.example'],
        policy: {
          lifecycle: 'active',
          authorization: 'supported',
          runnable: true,
          caveats: [{ kind: 'spend', severity: 'warning', message: 'Fixture usage is metered.' }],
        },
      },
    ],
    models: [
      {
        id: 'fixture/reviewed-model',
        providerId: 'fixture-cloud',
        displayName: 'Reviewed Model',
        lifecycle: 'active',
      },
    ],
  };
}

function firstProvider(manifest: CompiledProviderManifest) {
  const provider = manifest.providers[0];
  if (!provider) throw new Error('Synthetic manifest has no provider');
  return provider;
}

function firstModel(manifest: CompiledProviderManifest) {
  const model = manifest.models[0];
  if (!model) throw new Error('Synthetic manifest has no model');
  return model;
}

describe('provider catalog validation', () => {
  it('constructs a generic Pi provider solely from validated manifest data', () => {
    const catalog = createProviderCatalog(syntheticManifest());

    expect(catalog.manifestVersion).toBe(1);
    expect(catalog.providers[0]).toMatchObject({
      id: 'fixture-cloud',
      implementation: { kind: 'generic-pi-api', piProviderId: 'fixture' },
      credentialOptions: [{ kind: 'api-key' }],
      modelIds: ['fixture/reviewed-model'],
      requiredHosts: ['api.fixture.example'],
      policy: { authorization: 'supported', runnable: true },
    });
  });

  it('rejects duplicate provider and model IDs deterministically', () => {
    const duplicateProvider = syntheticManifest();
    duplicateProvider.providers.push(structuredClone(firstProvider(duplicateProvider)));
    expect(() => createProviderCatalog(duplicateProvider)).toThrow(
      "Invalid provider manifest: duplicate provider ID 'fixture-cloud'",
    );

    const duplicateModel = syntheticManifest();
    duplicateModel.models.push(structuredClone(firstModel(duplicateModel)));
    expect(() => createProviderCatalog(duplicateModel)).toThrow(
      "Invalid provider manifest: duplicate model ID 'fixture/reviewed-model'",
    );
  });

  it.each(['127.0.0.1', 'metadata.googleapis.com', 'service.internal'])(
    'rejects unsafe required host %s',
    (host) => {
      const manifest = syntheticManifest();
      firstProvider(manifest).requiredHosts = [host];

      expect(() => createProviderCatalog(manifest)).toThrow(
        `Invalid provider manifest: provider 'fixture-cloud' has unsafe required host '${host}'`,
      );
    },
  );

  it('rejects unknown model references', () => {
    const manifest = syntheticManifest();
    firstProvider(manifest).modelIds = ['fixture/not-reviewed'];

    expect(() => createProviderCatalog(manifest)).toThrow(
      "Invalid provider manifest: provider 'fixture-cloud' references unknown model 'fixture/not-reviewed'",
    );
  });

  it('rejects unsupported credential mechanisms', () => {
    const manifest = syntheticManifest();
    const credential = firstProvider(manifest).credentialOptions[0];
    if (!credential) throw new Error('Synthetic manifest has no credential');
    credential.kind = 'oauth-device-code' as 'api-key';

    expect(() => createProviderCatalog(manifest)).toThrow(
      "Invalid provider manifest: provider 'fixture-cloud' uses unsupported credential kind 'oauth-device-code'",
    );
  });

  it('compiles legacy compatibility and non-runnable launch posture', () => {
    expect(PROVIDER_CATALOG.providers.find(({ id }) => id === 'max')?.implementation).toEqual({
      kind: 'legacy',
      adapterId: 'max',
    });
    expect(
      PROVIDER_CATALOG.providers
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
  });
});
