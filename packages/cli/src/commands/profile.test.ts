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
  } as unknown as AutopodClient;
}

describe('profile commands', () => {
  let program: Command;
  let mockClient: AutopodClient;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const originalEditor = process.env.EDITOR;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    mockClient = createMockClient();
    registerProfileCommands(program, () => mockClient);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
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

  it('includes validationSetupCommand in the create template', async () => {
    process.env.EDITOR = 'true';

    await program.parseAsync(['node', 'ap', 'profile', 'create']);

    expect(mockClient.createProfile).toHaveBeenCalledWith(
      expect.objectContaining({ validationSetupCommand: null }),
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
});
