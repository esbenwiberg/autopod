import type { PublicProviderCatalog } from '@autopod/shared';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { resolveCatalogProfileSelection } from './profile.js';
import { registerProfileCommands } from './profile.js';
import { registerProviderAccountCommands } from './provider-account.js';

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  }),
}));
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
  afterEach(() => {
    vi.restoreAllMocks();
    process.env.AUTOPOD_PROVIDER_API_KEY = undefined;
  });

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

  it('wires synthetic providers through account and profile commands', async () => {
    const account = {
      id: 'fixture-account',
      name: 'Fixture Account',
      provider: 'fixture-cloud',
      credentials: null,
      hasCredentials: false,
      lastAuthenticatedAt: null,
      lastUsedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const client = {
      getModelProviderCatalog: vi.fn().mockResolvedValue(catalog),
      listProviderAccounts: vi.fn().mockResolvedValue([account]),
      getProviderAccount: vi.fn().mockResolvedValue(account),
      createProviderAccount: vi.fn().mockResolvedValue(account),
      updateProviderAccount: vi.fn().mockResolvedValue({ ...account, hasCredentials: true }),
      updateProfile: vi.fn().mockResolvedValue({ name: 'fixture-profile' }),
    } as unknown as AutopodClient;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const run = async (args: string[]): Promise<void> => {
      const program = new Command();
      program.exitOverride();
      registerProviderAccountCommands(program, () => client);
      registerProfileCommands(program, () => client);
      await program.parseAsync(['node', 'ap', ...args]);
    };

    await run(['provider-account', 'ls', '--provider', 'fixture-cloud']);
    expect(client.listProviderAccounts).toHaveBeenCalledWith({ provider: 'fixture-cloud' });

    await run(['provider-account', 'create', 'Fixture Account', '--provider', 'fixture-cloud']);
    expect(client.createProviderAccount).toHaveBeenCalledWith({
      name: 'Fixture Account',
      id: undefined,
      provider: 'fixture-cloud',
    });

    process.env.AUTOPOD_PROVIDER_API_KEY = 'fixture-secret';
    await run(['provider-account', 'auth-api-key', 'fixture-account']);
    expect(client.updateProviderAccount).toHaveBeenCalledWith('fixture-account', {
      credentials: {
        provider: 'api-key',
        providerId: 'fixture-cloud',
        apiKey: 'fixture-secret',
      },
    });

    await run([
      'profile',
      'set-provider',
      'fixture-profile',
      'fixture-cloud',
      '--model',
      'fixture/model-a',
      '--account',
      'fixture-account',
    ]);
    expect(client.updateProfile).toHaveBeenCalledWith('fixture-profile', {
      modelProvider: 'pi',
      defaultRuntime: 'pi',
      defaultModel: 'fixture/model-a',
      providerAccountId: 'fixture-account',
    });
  });
});
