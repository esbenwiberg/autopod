import type { Pod } from '@autopod/shared';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { registerWorkspaceCommands } from './workspace.js';

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  }),
}));

function makePod(overrides: Partial<Pod> = {}): Pod {
  return {
    id: 'abcd1234',
    profileName: 'test-profile',
    task: 'scratch',
    status: 'provisioning',
    model: 'sonnet',
    runtime: 'claude',
    executionTarget: 'local',
    branch: 'autopod/abcd1234',
    containerId: null,
    worktreePath: null,
    validationAttempts: 0,
    maxValidationAttempts: 3,
    lastValidationResult: null,
    pendingEscalation: null,
    escalationCount: 0,
    skipValidation: false,
    createdAt: '2026-06-04T08:00:00.000Z',
    startedAt: null,
    completedAt: null,
    updatedAt: '2026-06-04T08:00:00.000Z',
    userId: 'user1',
    filesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    previewUrl: null,
    outputMode: 'workspace',
    options: {
      agentMode: 'interactive',
      output: 'branch',
      validate: false,
      promotable: true,
    },
    ...overrides,
  } as Pod;
}

function createMockClient() {
  return {
    createSession: vi.fn().mockResolvedValue(makePod()),
    getSession: vi.fn().mockResolvedValue(makePod({ status: 'running', containerId: 'ctr1' })),
    getProfile: vi.fn().mockResolvedValue({ name: 'test-profile', executionTarget: 'local' }),
    listSessions: vi.fn().mockResolvedValue([]),
  } as unknown as AutopodClient;
}

describe('workspace commands', () => {
  let program: Command;
  let mockClient: AutopodClient;
  let attachSession: ReturnType<typeof vi.fn>;
  let pickProfile: ReturnType<typeof vi.fn>;
  let sleep: ReturnType<typeof vi.fn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    mockClient = createMockClient();
    attachSession = vi.fn().mockResolvedValue(0);
    pickProfile = vi.fn().mockResolvedValue('picked-profile');
    sleep = vi.fn().mockResolvedValue(undefined);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    registerWorkspaceCommands(program, () => mockClient, {
      runAttachSession: attachSession,
      pickProfile,
      sleep,
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('creates a workspace pod without attaching by default', async () => {
    await program.parseAsync([
      'node',
      'ap',
      'workspace',
      'test-profile',
      'scratch',
      '--branch',
      'scratch/manual',
      '--pim-group',
      '00000000-0000-0000-0000-000000000000:Admins',
    ]);

    expect(mockClient.createSession).toHaveBeenCalledWith({
      profileName: 'test-profile',
      task: 'scratch',
      outputMode: 'workspace',
      branch: 'scratch/manual',
      pimGroups: [
        {
          groupId: '00000000-0000-0000-0000-000000000000',
          displayName: 'Admins',
        },
      ],
    });
    expect(mockClient.getSession).not.toHaveBeenCalled();
    expect(attachSession).not.toHaveBeenCalled();
  });

  it('shell creates a workspace pod, waits until running, and attaches', async () => {
    await program.parseAsync(['node', 'ap', 'shell', 'test-profile']);

    expect(mockClient.createSession).toHaveBeenCalledWith({
      profileName: 'test-profile',
      task: 'Workspace pod',
      outputMode: 'workspace',
      branch: undefined,
      pimGroups: undefined,
    });
    expect(sleep).toHaveBeenCalledWith(1_500);
    expect(mockClient.getSession).toHaveBeenCalledWith('abcd1234');
    expect(attachSession).toHaveBeenCalledWith('autopod-abcd1234');
  });

  it('shell picks a profile when none is supplied', async () => {
    await program.parseAsync(['node', 'ap', 'shell']);

    expect(pickProfile).toHaveBeenCalledWith(mockClient);
    expect(mockClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'picked-profile',
        task: 'Workspace pod',
        outputMode: 'workspace',
      }),
    );
    expect(attachSession).toHaveBeenCalledWith('autopod-abcd1234');
  });

  it('shell accepts an explicit metadata label', async () => {
    await program.parseAsync(['node', 'ap', 'shell', 'test-profile', '--label', 'debug daemon']);

    expect(mockClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'test-profile',
        task: 'debug daemon',
        outputMode: 'workspace',
      }),
    );
    expect(attachSession).toHaveBeenCalledWith('autopod-abcd1234');
  });

  it('workspace --attach uses the same create-and-attach path', async () => {
    await program.parseAsync(['node', 'ap', 'workspace', 'test-profile', '--attach']);

    expect(mockClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'test-profile',
        task: 'Workspace pod',
        outputMode: 'workspace',
      }),
    );
    expect(mockClient.getSession).toHaveBeenCalledWith('abcd1234');
    expect(attachSession).toHaveBeenCalledWith('autopod-abcd1234');
  });

  it('shell rejects sandbox-profile defaults before creating a workspace pod', async () => {
    vi.mocked(mockClient.getProfile).mockResolvedValueOnce({
      name: 'test-profile',
      executionTarget: 'sandbox',
    } as Awaited<ReturnType<AutopodClient['getProfile']>>);

    await expect(program.parseAsync(['node', 'ap', 'shell', 'test-profile'])).rejects.toThrow(
      /Sandbox interactive pods are not supported/,
    );

    expect(mockClient.createSession).not.toHaveBeenCalled();
    expect(attachSession).not.toHaveBeenCalled();
  });

  it('workspace rejects sandbox-profile defaults before creating an interactive pod', async () => {
    vi.mocked(mockClient.getProfile).mockResolvedValueOnce({
      name: 'test-profile',
      executionTarget: 'sandbox',
    } as Awaited<ReturnType<AutopodClient['getProfile']>>);

    await expect(program.parseAsync(['node', 'ap', 'workspace', 'test-profile'])).rejects.toThrow(
      /Sandbox interactive pods are not supported/,
    );

    expect(mockClient.createSession).not.toHaveBeenCalled();
    expect(attachSession).not.toHaveBeenCalled();
  });
});
