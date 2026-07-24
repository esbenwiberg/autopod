import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { registerProfileCommands } from './profile.js';

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  }),
}));

function createProfile(overrides: Record<string, unknown> = {}) {
  return {
    name: 'my-app',
    repoUrl: 'https://github.com/org/repo',
    defaultBranch: 'main',
    template: 'node22',
    buildCommand: 'npm run build',
    validationSetupCommand: 'pip install -e ".[dev]" semgrep',
    startCommand: 'node server.js --port $PORT',
    healthPath: '/',
    healthTimeout: 120,
    smokePages: [],
    maxValidationAttempts: 3,
    defaultModel: 'claude-opus-4-8',
    reviewerModel: 'claude-sonnet-4-6',
    defaultRuntime: 'claude',
    customInstructions: null,
    escalation: null,
    extends: null,
    githubPat: null,
    githubPatExpiresAt: null,
    adoPat: null,
    adoPatExpiresAt: null,
    registryPat: null,
    registryPatExpiresAt: null,
    buildEnv: null,
    mcpServers: [],
    claudeMdSections: [],
    actionPolicy: null,
    outputMode: 'pr',
    modelProvider: 'anthropic',
    providerAccountId: null,
    providerFailover: null,
    pod: {
      agentMode: 'auto',
      output: 'pr',
      validate: true,
      validationSuite: 'thin-with-facts',
      promotable: false,
    },
    warmImageTag: null,
    warmImageBuiltAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createMockClient() {
  return {
    getProfile: vi.fn().mockResolvedValue(createProfile()),
    createProfile: vi.fn().mockImplementation((profile) =>
      Promise.resolve({
        ...createProfile(),
        ...(profile as Record<string, unknown>),
      }),
    ),
    updateProfile: vi.fn().mockResolvedValue(createProfile()),
    setProfileCredentials: vi.fn().mockResolvedValue(createProfile()),
    getGitHubAuthStatus: vi.fn().mockResolvedValue({
      available: true,
      login: 'autopod-dev',
      setup: 'setup',
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

describe('profile commands', () => {
  let program: Command;
  let mockClient: AutopodClient;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const originalEditor = process.env.EDITOR;
  const originalPath = process.env.PATH;
  let tempDirs: string[] = [];
  let exitSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    mockClient = createMockClient();
    registerProfileCommands(program, () => mockClient);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    tempDirs = [];
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy?.mockRestore();
    exitSpy = null;
    process.env.PATH = originalPath;
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if (originalEditor === undefined) {
      process.env.EDITOR = undefined;
    } else {
      process.env.EDITOR = originalEditor;
    }
  });

  it('shows validationSetupCommand in profile details', async () => {
    await program.parseAsync(['node', 'ap', 'profile', 'show', 'my-app']);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('pip install -e ".[dev]"'));
  });

  it('shows the profile validation suite in profile details', async () => {
    await program.parseAsync(['node', 'ap', 'profile', 'show', 'my-app']);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('thin-with-facts'));
  });

  it('shows provider account link in profile details', async () => {
    const getProfile = vi.mocked(mockClient.getProfile);
    getProfile.mockResolvedValueOnce(createProfile({ providerAccountId: 'team-openai' }));

    await program.parseAsync(['node', 'ap', 'profile', 'show', 'my-app']);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('team-openai'));
  });

  it('shows profile failover overrides and explicit disablement', async () => {
    vi.mocked(mockClient.getProfile).mockResolvedValueOnce(
      createProfile({
        providerFailover: {
          targets: [{ providerAccountId: 'backup', runtime: 'codex', model: 'gpt-5' }],
        },
      }),
    );
    await program.parseAsync(['node', 'ap', 'profile', 'show', 'my-app']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('backup:codex:gpt-5'));

    vi.mocked(mockClient.getProfile).mockResolvedValueOnce(
      createProfile({ providerFailover: { targets: [] } }),
    );
    await program.parseAsync(['node', 'ap', 'profile', 'show', 'my-app']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('disabled'));
  });

  it('does not present legacy GitHub PAT status or expiry', async () => {
    vi.mocked(mockClient.getProfile).mockResolvedValueOnce(
      createProfile({ hasGithubPat: true, githubPatExpiresAt: '2026-08-01' }),
    );

    await program.parseAsync(['node', 'ap', 'profile', 'show', 'my-app']);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).not.toContain('GitHub 2026-08-01');
    expect(output).not.toContain('GitHub PAT');
    expect(output).toContain('daemon gh authenticated as autopod-dev');
  });

  it('includes validationSetupCommand in the create template', async () => {
    process.env.EDITOR = 'true';

    await program.parseAsync(['node', 'ap', 'profile', 'create']);

    expect(mockClient.createProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        validationSetupCommand: null,
        providerAccountId: null,
        pod: expect.objectContaining({ validationSuite: 'full' }),
      }),
    );
  });

  it('sets the profile validation suite', async () => {
    await program.parseAsync([
      'node',
      'ap',
      'profile',
      'validation-suite',
      'my-app',
      'deterministic',
    ]);

    expect(mockClient.updateProfile).toHaveBeenCalledWith(
      'my-app',
      expect.objectContaining({
        pod: expect.objectContaining({
          validationSuite: 'deterministic',
          validate: true,
        }),
      }),
    );
  });

  it('preserves validationSetupCommand through edit', async () => {
    process.env.EDITOR = 'true';

    await program.parseAsync(['node', 'ap', 'profile', 'edit', 'my-app']);

    expect(mockClient.updateProfile).toHaveBeenCalledWith(
      'my-app',
      expect.objectContaining({ validationSetupCommand: 'pip install -e ".[dev]" semgrep' }),
    );
  });

  it('captures only the requested Pi provider into profile credentials', async () => {
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
{"anthropic":{"accessToken":"selected"},"openai-codex":{"accessToken":"unrelated"}}
JSON
`);
    tempDirs.push(fakeBin);
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;

    await program.parseAsync(['node', 'ap', 'profile', 'auth-pi', 'my-app', 'anthropic']);

    expect(mockClient.setProfileCredentials).toHaveBeenCalledWith('my-app', {
      defaultRuntime: 'pi',
      modelProvider: 'pi',
      providerCredentials: {
        provider: 'pi',
        providerId: 'anthropic',
        credential: { accessToken: 'selected' },
      },
    });
    expect(fs.readFileSync(modeLog, 'utf-8').trim()).toBe('700');
    const piDir = fs.readFileSync(dirLog, 'utf-8').trim();
    expect(fs.existsSync(piDir)).toBe(false);
  });

  it('leaves profile credentials unchanged when Pi auth has the wrong provider', async () => {
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
      program.parseAsync(['node', 'ap', 'profile', 'auth-pi', 'my-app', 'openai-codex']),
    ).rejects.toThrow('process.exit 1');

    expect(mockClient.setProfileCredentials).not.toHaveBeenCalled();
  });

  it('leaves profile credentials unchanged when Pi auth is malformed', async () => {
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
      program.parseAsync(['node', 'ap', 'profile', 'auth-pi', 'my-app', 'anthropic']),
    ).rejects.toThrow('process.exit 1');

    expect(mockClient.setProfileCredentials).not.toHaveBeenCalled();
  });

  it('leaves profile credentials unchanged when the selected Pi credential is empty', async () => {
    const fakeBin = installFakePi(`
mkdir -p "$PI_CODING_AGENT_DIR"
printf '{"anthropic":{"accessToken":""}}' > "$PI_CODING_AGENT_DIR/auth.json"
`);
    tempDirs.push(fakeBin);
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`);
    });

    await expect(
      program.parseAsync(['node', 'ap', 'profile', 'auth-pi', 'my-app', 'anthropic']),
    ).rejects.toThrow('process.exit 1');

    expect(mockClient.setProfileCredentials).not.toHaveBeenCalled();
  });

  it('leaves profile credentials unchanged when Pi login is cancelled', async () => {
    const fakeBin = installFakePi('exit 130');
    tempDirs.push(fakeBin);
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`);
    });

    await expect(
      program.parseAsync(['node', 'ap', 'profile', 'auth-pi', 'my-app', 'anthropic']),
    ).rejects.toThrow('process.exit 1');

    expect(mockClient.setProfileCredentials).not.toHaveBeenCalled();
  });

  it('leaves profile credentials unchanged when the Pi executable is missing', async () => {
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'autopod-empty-bin-'));
    tempDirs.push(emptyBin);
    process.env.PATH = emptyBin;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`);
    });

    await expect(
      program.parseAsync(['node', 'ap', 'profile', 'auth-pi', 'my-app', 'anthropic']),
    ).rejects.toThrow('process.exit 1');

    expect(mockClient.setProfileCredentials).not.toHaveBeenCalled();
  });

  it('does not submit legacy GitHub PAT fields from profile edit', async () => {
    process.env.EDITOR = 'true';
    vi.mocked(mockClient.getProfile).mockResolvedValueOnce(
      createProfile({ githubPat: 'legacy-value', githubPatExpiresAt: '2026-08-01' }),
    );

    await program.parseAsync(['node', 'ap', 'profile', 'edit', 'my-app']);

    const updates = vi.mocked(mockClient.updateProfile).mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(updates).not.toHaveProperty('githubPat');
    expect(updates).not.toHaveProperty('githubPatExpiresAt');
    expect(updates).toHaveProperty('adoPatExpiresAt');
  });

  it('round-trips profile failover policy through editor updates', async () => {
    process.env.EDITOR = 'true';
    const providerFailover = {
      targets: [{ providerAccountId: 'backup', runtime: 'codex', model: 'gpt-5' }],
    };
    vi.mocked(mockClient.getProfile).mockResolvedValueOnce(createProfile({ providerFailover }));

    await program.parseAsync(['node', 'ap', 'profile', 'edit', 'my-app']);

    const updates = vi.mocked(mockClient.updateProfile).mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(updates.providerFailover).toEqual(providerFailover);
  });
});
