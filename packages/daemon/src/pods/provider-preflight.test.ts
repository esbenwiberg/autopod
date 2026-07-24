import {
  type CompiledProviderManifest,
  type Profile,
  type ProviderAccount,
  type ProviderCredentials,
  createProviderCatalog,
} from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import { resolveProviderPreflight } from './provider-preflight.js';

function manifest(
  overrides: Partial<CompiledProviderManifest['providers'][number]['policy']> = {},
  modelLifecycle: CompiledProviderManifest['models'][number]['lifecycle'] = 'active',
): CompiledProviderManifest {
  return createProviderCatalog({
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
        description: 'Synthetic manifest-only test provider.',
        implementation: { kind: 'generic-pi-api', piProviderId: 'fixture' },
        credentialOptions: [
          { kind: 'api-key', label: 'Fixture key', acquisition: 'Created by the test.' },
        ],
        modelIds: ['fixture/reviewed-model'],
        requiredHosts: ['api.fixture.example'],
        policy: {
          lifecycle: 'active',
          authorization: 'supported',
          runnable: true,
          caveats: [],
          ...overrides,
        },
      },
      {
        id: 'other-cloud',
        displayName: 'Other Cloud',
        description: 'Second synthetic provider for inherited mismatch coverage.',
        implementation: { kind: 'generic-pi-api', piProviderId: 'other' },
        credentialOptions: [
          { kind: 'api-key', label: 'Other key', acquisition: 'Created by the test.' },
        ],
        modelIds: ['other/reviewed-model'],
        requiredHosts: ['api.other.example'],
        policy: {
          lifecycle: 'active',
          authorization: 'supported',
          runnable: true,
          caveats: [],
        },
      },
    ],
    models: [
      {
        id: 'fixture/reviewed-model',
        providerId: 'fixture-cloud',
        displayName: 'Reviewed fixture model',
        lifecycle: modelLifecycle,
      },
      {
        id: 'other/reviewed-model',
        providerId: 'other-cloud',
        displayName: 'Other reviewed model',
        lifecycle: 'active',
      },
    ],
  });
}

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: 'fixture-profile',
    defaultRuntime: 'pi',
    defaultModel: 'fixture/reviewed-model',
    modelProvider: 'pi',
    providerAccountId: 'fixture-account',
    providerCredentials: null,
    ...overrides,
  } as Profile;
}

function account(
  overrides: Partial<ProviderAccount> & { credentials?: ProviderCredentials | null } = {},
): ProviderAccount {
  return {
    id: 'fixture-account',
    name: 'Fixture account',
    provider: 'fixture-cloud',
    credentials: {
      provider: 'api-key',
      providerId: 'fixture-cloud',
      apiKey: 'test-key-value',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastAuthenticatedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

function accountStore(value: ProviderAccount): ProviderAccountStore {
  return {
    get: (id) => {
      if (id !== value.id) throw new Error('not found');
      return value;
    },
  } as ProviderAccountStore;
}

function resolve(profileValue = profile(), accountValue = account(), manifestValue = manifest()) {
  return resolveProviderPreflight(profileValue, undefined, undefined, {
    providerAccountStore: accountStore(accountValue),
    manifest: manifestValue,
  });
}

function expectCode(run: () => unknown, code: string): void {
  expect(run).toThrow(expect.objectContaining({ code }));
}

describe('resolveProviderPreflight', () => {
  it('resolves a synthetic manifest provider through the existing Pi runtime', () => {
    const result = resolve();

    expect(result).toMatchObject({
      runtime: 'pi',
      model: 'fixture/reviewed-model',
      manifestProvider: { id: 'fixture-cloud' },
      account: { id: 'fixture-account' },
    });
  });

  it('requires a linked account for a reviewed generic model', () => {
    expectCode(
      () =>
        resolveProviderPreflight(profile({ providerAccountId: null }), undefined, undefined, {
          manifest: manifest(),
        }),
      'PROVIDER_ACCOUNT_REQUIRED',
    );
  });

  it('rejects an account selected from a different inherited provider model', () => {
    expectCode(
      () => resolve(profile({ defaultModel: 'other/reviewed-model' })),
      'PROVIDER_ACCOUNT_PROVIDER_MISMATCH',
    );
  });

  it('rejects credentials whose provider identity differs from the account', () => {
    expectCode(
      () =>
        resolve(
          profile(),
          account({
            credentials: {
              provider: 'api-key',
              providerId: 'other-cloud',
              apiKey: 'test-key-value',
            },
          }),
        ),
      'PROVIDER_CREDENTIAL_MISMATCH',
    );
  });

  it('rejects missing provider credentials', () => {
    expectCode(
      () => resolve(profile(), account({ credentials: null })),
      'PROVIDER_CREDENTIALS_MISSING',
    );
  });

  it('rejects unknown provider-qualified models without falling back', () => {
    expectCode(
      () => resolve(profile({ defaultModel: 'fixture/unreviewed-model' })),
      'PROVIDER_MODEL_UNKNOWN',
    );
  });

  it.each([
    [{ authorization: 'blocked', runnable: false } as const, 'PROVIDER_BLOCKED'],
    [
      { authorization: 'authorization-pending', runnable: false } as const,
      'PROVIDER_AUTHORIZATION_PENDING',
    ],
    [{ lifecycle: 'deprecated' } as const, 'PROVIDER_DEPRECATED'],
  ])('rejects provider policy %j with stable code %s', (policy, code) => {
    expectCode(() => resolve(profile(), account(), manifest(policy)), code);
  });

  it('rejects a deprecated provider model', () => {
    expectCode(
      () => resolve(profile(), account(), manifest({}, 'deprecated')),
      'PROVIDER_MODEL_DEPRECATED',
    );
  });

  it('rejects a manifest reviewed against a different Pi distribution', () => {
    const incompatible = structuredClone(manifest());
    incompatible.piCompatibility.packageVersion = '999.0.0';

    expectCode(
      () => resolve(profile(), account(), incompatible),
      'PROVIDER_PI_CATALOG_INCOMPATIBLE',
    );
  });

  it('rejects a generic provider configured with a non-Pi runtime', () => {
    expectCode(() => resolve(profile({ defaultRuntime: 'claude' })), 'PROVIDER_RUNTIME_MISMATCH');
  });

  it('preserves legacy provider runtime and model resolution', () => {
    const result = resolveProviderPreflight(
      profile({
        defaultRuntime: 'claude',
        defaultModel: 'claude-opus-4-7',
        modelProvider: 'anthropic',
        providerAccountId: null,
      }),
      undefined,
      undefined,
    );

    expect(result).toMatchObject({
      runtime: 'claude',
      model: 'claude-opus-4-7',
      manifestProvider: null,
    });
  });

  it('preserves a linked legacy Pi OAuth account', () => {
    const piAccount = account({
      provider: 'pi',
      credentials: {
        provider: 'pi',
        providerId: 'anthropic',
        credential: { access: 'opaque-test-value' },
      },
    });
    const result = resolveProviderPreflight(
      profile({ defaultModel: 'anthropic/claude-sonnet-4-6' }),
      undefined,
      undefined,
      { providerAccountStore: accountStore(piAccount) },
    );

    expect(result).toMatchObject({
      runtime: 'pi',
      model: 'anthropic/claude-sonnet-4-6',
      account: { provider: 'pi' },
      manifestProvider: null,
    });
  });
});
