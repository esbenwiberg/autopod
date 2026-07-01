import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { registerProviderAccountCommands } from './provider-account.js';

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  }),
}));

vi.mock('./provider-auth.js', () => ({
  extractClaudeOauthToken: vi.fn(() => 'env-token'),
  runClaudeSetupToken: vi.fn(async () => 'CLAUDE_CODE_OAUTH_TOKEN=setup-token'),
  runCopilotLogin: vi.fn(async () => 'copilot-token'),
  runOpenAiCodexLogin: vi.fn(async () => '{"token":"codex"}'),
}));

function createAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'team-openai',
    name: 'Team OpenAI',
    provider: 'openai',
    credentials: { provider: 'openai' },
    hasCredentials: true,
    lastAuthenticatedAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createProfile(overrides: Record<string, unknown> = {}) {
  return {
    name: 'my-app',
    modelProvider: 'openai',
    providerAccountId: 'team-openai',
    ...overrides,
  };
}

function createMockClient() {
  return {
    listProviderAccounts: vi.fn().mockResolvedValue([createAccount()]),
    getProviderAccount: vi.fn().mockResolvedValue(createAccount()),
    createProviderAccount: vi.fn().mockResolvedValue(createAccount()),
    updateProviderAccount: vi.fn().mockResolvedValue(createAccount()),
    deleteProviderAccount: vi.fn().mockResolvedValue(undefined),
    linkProviderAccount: vi.fn().mockResolvedValue({
      account: createAccount(),
      profile: createProfile(),
    }),
    unlinkProfileProviderAccount: vi.fn().mockResolvedValue(undefined),
    importProviderAccountFromProfile: vi.fn().mockResolvedValue({
      account: createAccount(),
      linkedProfiles: [createProfile()],
      legacyCredentialsCleared: true,
    }),
  } as unknown as AutopodClient;
}

describe('provider-account commands', () => {
  let program: Command;
  let mockClient: AutopodClient;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const originalClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    mockClient = createMockClient();
    registerProviderAccountCommands(program, () => mockClient);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (originalClaudeToken === undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = undefined;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalClaudeToken;
    }
  });

  it('lists provider accounts with a provider filter', async () => {
    await program.parseAsync(['node', 'ap', 'provider-account', 'ls', '--provider', 'openai']);

    expect(mockClient.listProviderAccounts).toHaveBeenCalledWith({ provider: 'openai' });
    expect(logSpy).toHaveBeenCalled();
  });

  it('creates a provider account and links requested profiles', async () => {
    await program.parseAsync([
      'node',
      'ap',
      'provider-account',
      'create',
      'Team OpenAI',
      '--provider',
      'openai',
      '--id',
      'team-openai',
      '--link-profile',
      'my-app',
    ]);

    expect(mockClient.createProviderAccount).toHaveBeenCalledWith({
      name: 'Team OpenAI',
      id: 'team-openai',
      provider: 'openai',
    });
    // No flag → undefined → daemon default clears the linked profile's inline creds.
    expect(mockClient.linkProviderAccount).toHaveBeenCalledWith('team-openai', 'my-app', {
      clearLegacyCredentials: undefined,
    });
  });

  it('keeps linked profile credentials when --keep-legacy-credentials is passed', async () => {
    await program.parseAsync([
      'node',
      'ap',
      'provider-account',
      'create',
      'Team OpenAI',
      '--provider',
      'openai',
      '--id',
      'team-openai',
      '--link-profile',
      'my-app',
      '--keep-legacy-credentials',
    ]);

    expect(mockClient.linkProviderAccount).toHaveBeenCalledWith('team-openai', 'my-app', {
      clearLegacyCredentials: false,
    });
  });

  it('imports legacy profile credentials into a provider account', async () => {
    await program.parseAsync([
      'node',
      'ap',
      'provider-account',
      'import',
      'legacy-profile',
      '--name',
      'Team OpenAI',
      '--link-profile',
      'my-app',
      '--link-profile',
      'worker',
    ]);

    expect(mockClient.importProviderAccountFromProfile).toHaveBeenCalledWith({
      profileName: 'legacy-profile',
      accountId: undefined,
      accountName: 'Team OpenAI',
      linkProfileNames: ['my-app', 'worker'],
      // No flag → undefined → daemon default clears the owner's imported creds.
      clearLegacyCredentials: undefined,
    });
  });

  it('authenticates a max provider account from an env setup token', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'setup-token';
    vi.mocked(mockClient.getProviderAccount).mockResolvedValueOnce(
      createAccount({ id: 'team-max', provider: 'max' }),
    );

    await program.parseAsync(['node', 'ap', 'provider-account', 'auth', 'team-max']);

    expect(mockClient.updateProviderAccount).toHaveBeenCalledWith('team-max', {
      credentials: {
        provider: 'max',
        authMode: 'setup-token',
        oauthToken: 'setup-token',
      },
    });
  });
});
