import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_HANDOFF_INSTRUCTIONS_LENGTH, type Pod } from '@autopod/shared';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { registerWorkspaceCommands, resolveHandoffInstructions } from './workspace.js';

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
  let terminalSession: ReturnType<typeof vi.fn>;
  let pickProfile: ReturnType<typeof vi.fn>;
  let sleep: ReturnType<typeof vi.fn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    mockClient = createMockClient();
    attachSession = vi.fn().mockResolvedValue(0);
    terminalSession = vi.fn().mockResolvedValue(0);
    pickProfile = vi.fn().mockResolvedValue('picked-profile');
    sleep = vi.fn().mockResolvedValue(undefined);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    registerWorkspaceCommands(program, () => mockClient, {
      runAttachSession: attachSession,
      runTerminalSession: terminalSession,
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

  it('shell attaches to sandbox pods through the daemon terminal session', async () => {
    const sandboxPod = makePod({
      executionTarget: 'sandbox',
      status: 'running',
      containerId: 'sbx-1',
    });
    vi.mocked(mockClient.createSession).mockResolvedValueOnce(sandboxPod);
    vi.mocked(mockClient.getSession).mockResolvedValue(sandboxPod);

    await program.parseAsync(['node', 'ap', 'shell', 'test-profile']);

    expect(mockClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ profileName: 'test-profile', outputMode: 'workspace' }),
    );
    expect(terminalSession).toHaveBeenCalledWith(mockClient, 'abcd1234');
    expect(attachSession).not.toHaveBeenCalled();
  });

  it('attach uses the daemon terminal session for sandbox pods', async () => {
    const sandboxPod = makePod({
      executionTarget: 'sandbox',
      status: 'running',
      containerId: 'sbx-1',
    });
    vi.mocked(mockClient.getSession).mockResolvedValue(sandboxPod);

    await program.parseAsync(['node', 'ap', 'attach', 'abcd1234']);

    expect(terminalSession).toHaveBeenCalledWith(mockClient, 'abcd1234');
    expect(attachSession).not.toHaveBeenCalled();
  });

  it('attach keeps the docker exec path for local pods', async () => {
    await program.parseAsync(['node', 'ap', 'attach', 'abcd1234']);

    expect(attachSession).toHaveBeenCalledWith('autopod-abcd1234');
    expect(terminalSession).not.toHaveBeenCalled();
  });

  it('passes --base-branch through as the request baseBranch (merge base + start point)', async () => {
    await program.parseAsync([
      'node',
      'ap',
      'workspace',
      'test-profile',
      'handoff',
      '--base-branch',
      'pi/feature-x',
    ]);

    expect(mockClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'test-profile',
        outputMode: 'workspace',
        baseBranch: 'pi/feature-x',
      }),
    );
    // start point only — must not leak into startBranch when --base-branch is used.
    const arg = vi.mocked(mockClient.createSession).mock.calls[0]?.[0];
    expect(arg?.startBranch).toBeUndefined();
  });

  it('passes --start-branch through as the request startBranch (PR base stays default)', async () => {
    await program.parseAsync([
      'node',
      'ap',
      'shell',
      'test-profile',
      '--start-branch',
      'pi/feature-x',
    ]);

    expect(mockClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ outputMode: 'workspace', startBranch: 'pi/feature-x' }),
    );
    const arg = vi.mocked(mockClient.createSession).mock.calls[0]?.[0];
    expect(arg?.baseBranch).toBeUndefined();
  });

  it('persists --instructions as trimmed handoffInstructions', async () => {
    await program.parseAsync([
      'node',
      'ap',
      'workspace',
      'test-profile',
      '--instructions',
      '  do the thing  ',
    ]);

    expect(mockClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ handoffInstructions: 'do the thing' }),
    );
  });

  it('reads --instructions-file and persists its trimmed contents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ap-handoff-'));
    const file = join(dir, 'handoff.md');
    await writeFile(file, '\n# Plan\n\nShip it.\n', 'utf8');
    try {
      await program.parseAsync([
        'node',
        'ap',
        'workspace',
        'test-profile',
        '--instructions-file',
        file,
      ]);
      expect(mockClient.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ handoffInstructions: '# Plan\n\nShip it.' }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects --instructions together with --instructions-file, without creating a pod', async () => {
    await expect(
      program.parseAsync([
        'node',
        'ap',
        'workspace',
        'test-profile',
        '--instructions',
        'a',
        '--instructions-file',
        '/tmp/whatever.md',
      ]),
    ).rejects.toThrow(/at most one of --instructions or --instructions-file/i);
    expect(mockClient.createSession).not.toHaveBeenCalled();
  });

  it('rejects empty --instructions without creating a pod', async () => {
    await expect(
      program.parseAsync(['node', 'ap', 'workspace', 'test-profile', '--instructions', '   ']),
    ).rejects.toThrow(/must not be empty/i);
    expect(mockClient.createSession).not.toHaveBeenCalled();
  });

  it('surfaces an actionable error for an unreadable --instructions-file', async () => {
    await expect(
      program.parseAsync([
        'node',
        'ap',
        'workspace',
        'test-profile',
        '--instructions-file',
        join(tmpdir(), 'definitely-does-not-exist-ap-handoff.md'),
      ]),
    ).rejects.toThrow(/Cannot read --instructions-file/i);
    expect(mockClient.createSession).not.toHaveBeenCalled();
  });
});

describe('resolveHandoffInstructions', () => {
  it('returns undefined when neither flag is set (legacy path unchanged)', async () => {
    await expect(resolveHandoffInstructions({})).resolves.toBeUndefined();
  });

  it('trims inline instructions', async () => {
    await expect(resolveHandoffInstructions({ instructions: '  hi  ' })).resolves.toBe('hi');
  });

  it('rejects mutually-exclusive flags', async () => {
    await expect(
      resolveHandoffInstructions({ instructions: 'a', instructionsFile: '/x' }),
    ).rejects.toThrow(/at most one/i);
  });

  it('rejects empty (whitespace-only) instructions', async () => {
    await expect(resolveHandoffInstructions({ instructions: '\n\t ' })).rejects.toThrow(
      /must not be empty/i,
    );
  });

  it('rejects oversized instructions with the size and limit in the message', async () => {
    const big = 'a'.repeat(MAX_HANDOFF_INSTRUCTIONS_LENGTH + 1);
    await expect(resolveHandoffInstructions({ instructions: big })).rejects.toThrow(
      new RegExp(`too large.*${MAX_HANDOFF_INSTRUCTIONS_LENGTH}`, 'i'),
    );
  });

  it('does not include the instruction body in any error message', async () => {
    const secret = 'SUPER-SECRET-HANDOFF-BODY';
    const big = `${secret}${'x'.repeat(MAX_HANDOFF_INSTRUCTIONS_LENGTH)}`;
    let message = '';
    try {
      await resolveHandoffInstructions({ instructions: big });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/too large/i);
    expect(message).not.toContain(secret);
  });
});
