import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

function createAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'team-openai',
    name: 'Team OpenAI',
    provider: 'openai',
    credentials: { provider: 'openai' },
    hasCredentials: true,
    failoverPolicy: null,
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

function installFakePi(scriptBody: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopod-test-pi-bin-'));
  const piPath = path.join(dir, 'pi');
  fs.writeFileSync(piPath, `#!/bin/sh\n${scriptBody}\n`, 'utf-8');
  fs.chmodSync(piPath, 0o755);
  return dir;
}

describe('provider-account commands', () => {
  let program: Command;
  let mockClient: AutopodClient;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const originalClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const originalPath = process.env.PATH;
  let tempDirs: string[] = [];
  let exitSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    mockClient = createMockClient();
    registerProviderAccountCommands(program, () => mockClient);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    tempDirs = [];
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy?.mockRestore();
    exitSpy = null;
    process.env.PATH = originalPath;
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  it('creates and replaces ordered failover policies', async () => {
    await program.parseAsync([
      'node',
      'ap',
      'provider-account',
      'create',
      'Primary',
      '--provider',
      'openai',
      '--failover-target',
      'claude-max:claude:opus',
      '--failover-target',
      'copilot:copilot:auto',
      '--max-failover-hops',
      '2',
    ]);
    expect(mockClient.createProviderAccount).toHaveBeenCalledWith({
      name: 'Primary',
      id: undefined,
      provider: 'openai',
      failoverPolicy: {
        targets: [
          { providerAccountId: 'claude-max', runtime: 'claude', model: 'opus' },
          { providerAccountId: 'copilot', runtime: 'copilot', model: 'auto' },
        ],
        maxHops: 2,
      },
    });

    await program.parseAsync([
      'node',
      'ap',
      'provider-account',
      'set-failover',
      'team-openai',
      '--target',
      'copilot:copilot:auto',
      '--target',
      'claude-max:claude:sonnet',
      '--max-hops',
      '1',
    ]);
    expect(mockClient.updateProviderAccount).toHaveBeenCalledWith('team-openai', {
      failoverPolicy: {
        targets: [
          { providerAccountId: 'copilot', runtime: 'copilot', model: 'auto' },
          { providerAccountId: 'claude-max', runtime: 'claude', model: 'sonnet' },
        ],
        maxHops: 1,
      },
    });
  });

  it('clears an account failover policy', async () => {
    await program.parseAsync(['node', 'ap', 'provider-account', 'clear-failover', 'team-openai']);
    expect(mockClient.updateProviderAccount).toHaveBeenCalledWith('team-openai', {
      failoverPolicy: null,
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

  it('captures exactly the requested Pi provider into a provider account', async () => {
    vi.mocked(mockClient.getProviderAccount).mockResolvedValueOnce(
      createAccount({ id: 'team-pi', provider: 'pi' }),
    );
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopod-pi-logs-'));
    tempDirs.push(logDir);
    const dirLog = path.join(logDir, 'dir.txt');
    const modeLog = path.join(logDir, 'mode.txt');
    const fakeBin = installFakePi(`
test "$1" = "/login" || exit 2
test -n "$PI_CODING_AGENT_DIR" || exit 3
echo "$PI_CODING_AGENT_DIR" > "${dirLog}"
if ! stat -f "%Lp" "$PI_CODING_AGENT_DIR" > "${modeLog}" 2>/dev/null; then
  stat -c "%a" "$PI_CODING_AGENT_DIR" > "${modeLog}"
fi
cat > "$PI_CODING_AGENT_DIR/auth.json" <<'JSON'
{"github-copilot":{"accessToken":"selected"},"anthropic":{"accessToken":"unrelated"}}
JSON
`);
    tempDirs.push(fakeBin);
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;

    await program.parseAsync([
      'node',
      'ap',
      'provider-account',
      'auth-pi',
      'team-pi',
      'github-copilot',
    ]);

    expect(mockClient.updateProviderAccount).toHaveBeenCalledWith('team-pi', {
      credentials: {
        provider: 'pi',
        providerId: 'github-copilot',
        credential: { accessToken: 'selected' },
      },
    });
    expect(fs.readFileSync(modeLog, 'utf-8').trim()).toBe('700');
    const piDir = fs.readFileSync(dirLog, 'utf-8').trim();
    expect(fs.existsSync(piDir)).toBe(false);
  });

  it('leaves provider account credentials unchanged when Pi auth has the wrong provider', async () => {
    vi.mocked(mockClient.getProviderAccount).mockResolvedValueOnce(
      createAccount({ id: 'team-pi', provider: 'pi' }),
    );
    const fakeBin = installFakePi(`
mkdir -p "$PI_CODING_AGENT_DIR"
cat > "$PI_CODING_AGENT_DIR/auth.json" <<'JSON'
{"anthropic":{"accessToken":"selected"}}
JSON
`);
    tempDirs.push(fakeBin);
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`);
    });

    await expect(
      program.parseAsync(['node', 'ap', 'provider-account', 'auth-pi', 'team-pi', 'openai-codex']),
    ).rejects.toThrow('process.exit 1');

    expect(mockClient.updateProviderAccount).not.toHaveBeenCalled();
  });

  it('leaves provider account credentials unchanged when Pi auth is malformed', async () => {
    vi.mocked(mockClient.getProviderAccount).mockResolvedValueOnce(
      createAccount({ id: 'team-pi', provider: 'pi' }),
    );
    const fakeBin = installFakePi(`
mkdir -p "$PI_CODING_AGENT_DIR"
printf 'not-json' > "$PI_CODING_AGENT_DIR/auth.json"
`);
    tempDirs.push(fakeBin);
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`);
    });

    await expect(
      program.parseAsync(['node', 'ap', 'provider-account', 'auth-pi', 'team-pi', 'anthropic']),
    ).rejects.toThrow('process.exit 1');

    expect(mockClient.updateProviderAccount).not.toHaveBeenCalled();
  });

  it('leaves provider account credentials unchanged when Pi login is cancelled', async () => {
    vi.mocked(mockClient.getProviderAccount).mockResolvedValueOnce(
      createAccount({ id: 'team-pi', provider: 'pi' }),
    );
    const fakeBin = installFakePi('exit 130');
    tempDirs.push(fakeBin);
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`);
    });

    await expect(
      program.parseAsync(['node', 'ap', 'provider-account', 'auth-pi', 'team-pi', 'anthropic']),
    ).rejects.toThrow('process.exit 1');

    expect(mockClient.updateProviderAccount).not.toHaveBeenCalled();
  });

  it('leaves provider account credentials unchanged when the Pi executable is missing', async () => {
    vi.mocked(mockClient.getProviderAccount).mockResolvedValueOnce(
      createAccount({ id: 'team-pi', provider: 'pi' }),
    );
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'autopod-empty-bin-'));
    tempDirs.push(emptyBin);
    process.env.PATH = emptyBin;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`);
    });

    await expect(
      program.parseAsync(['node', 'ap', 'provider-account', 'auth-pi', 'team-pi', 'anthropic']),
    ).rejects.toThrow('process.exit 1');

    expect(mockClient.updateProviderAccount).not.toHaveBeenCalled();
  });
});
