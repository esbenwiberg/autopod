import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { registerPodCommands } from './pod.js';

// Mock ora to avoid TTY issues in tests
vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  }),
}));

function createMockClient() {
  return {
    createSession: vi.fn().mockResolvedValue({
      id: 'abcd1234',
      profileName: 'test',
      task: 'do things',
      status: 'queued',
      model: 'opus',
      runtime: 'claude',
      branch: 'ap/abcd1234',
      containerId: null,
      worktreePath: null,
      validationAttempts: 0,
      maxValidationAttempts: 3,
      lastValidationResult: null,
      pendingEscalation: null,
      escalationCount: 0,
      skipValidation: false,
      createdAt: '2024-01-01T00:00:00Z',
      startedAt: null,
      completedAt: null,
      updatedAt: '2024-01-01T00:00:00Z',
      userId: 'user1',
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
      previewUrl: null,
    }),
    listSessions: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockResolvedValue({
      id: 'abcd1234',
      profileName: 'test',
      task: 'do things',
      status: 'running',
      model: 'opus',
      runtime: 'claude',
      branch: 'ap/abcd1234',
      containerId: 'ctr1',
      worktreePath: null,
      validationAttempts: 0,
      maxValidationAttempts: 3,
      lastValidationResult: null,
      pendingEscalation: null,
      escalationCount: 0,
      skipValidation: false,
      createdAt: '2024-01-01T00:00:00Z',
      startedAt: '2024-01-01T00:00:01Z',
      completedAt: null,
      updatedAt: '2024-01-01T00:00:01Z',
      userId: 'user1',
      filesChanged: 5,
      linesAdded: 100,
      linesRemoved: 20,
      previewUrl: null,
    }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    triggerValidation: vi.fn().mockResolvedValue(undefined),
    approveSession: vi.fn().mockResolvedValue(undefined),
    rejectSession: vi.fn().mockResolvedValue(undefined),
    killSession: vi.fn().mockResolvedValue(undefined),
    getSessionLogs: vi.fn().mockResolvedValue('some log output'),
    approveAllValidated: vi.fn().mockResolvedValue({ approved: ['a', 'b'] }),
    killAllFailed: vi.fn().mockResolvedValue({ killed: ['c'] }),
  } as unknown as AutopodClient;
}

describe('pod commands', () => {
  let program: Command;
  let mockClient: AutopodClient;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride(); // Throw instead of process.exit
    mockClient = createMockClient();
    registerPodCommands(program, () => mockClient);
  });

  it('registers run command that calls createSession', async () => {
    await program.parseAsync(['node', 'ap', 'run', 'test-profile', 'build the thing']);
    expect(mockClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: 'test-profile',
        task: 'build the thing',
      }),
    );
  });

  it('passes --sidecar flags as requireSidecars on run', async () => {
    await program.parseAsync([
      'node',
      'ap',
      'run',
      'test-profile',
      'build the thing',
      '--sidecar',
      'dagger',
    ]);
    expect(mockClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ requireSidecars: ['dagger'] }),
    );
  });

  it('accepts multiple --sidecar flags on start', async () => {
    await program.parseAsync([
      'node',
      'ap',
      'start',
      'test-profile',
      'do it',
      '-s',
      'dagger',
      '-s',
      'postgres',
    ]);
    expect(mockClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ requireSidecars: ['dagger', 'postgres'] }),
    );
  });

  it('omits requireSidecars when no --sidecar flags are passed', async () => {
    await program.parseAsync(['node', 'ap', 'run', 'test-profile', 'do it']);
    const call = (mockClient.createSession as unknown as { mock: { calls: [unknown][] } }).mock
      .calls[0][0] as Record<string, unknown>;
    expect(call.requireSidecars).toBeUndefined();
  });

  it('passes --ref-repo flags as referenceRepos on start', async () => {
    await program.parseAsync([
      'node',
      'ap',
      'start',
      'test-profile',
      'audit',
      '--ref-repo',
      'https://github.com/org/docs-gen',
      '--ref-repo',
      'https://github.com/org/pipelines.git',
      '--ref-repo-pat',
      'ghp_secret',
    ]);
    expect(mockClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceRepos: [
          { url: 'https://github.com/org/docs-gen' },
          { url: 'https://github.com/org/pipelines.git' },
        ],
        referenceRepoPat: 'ghp_secret',
      }),
    );
  });

  it('omits referenceRepos when no --ref-repo flags are passed', async () => {
    await program.parseAsync(['node', 'ap', 'start', 'test-profile', 'do it']);
    const call = (mockClient.createSession as unknown as { mock: { calls: [unknown][] } }).mock
      .calls[0][0] as Record<string, unknown>;
    expect(call.referenceRepos).toBeUndefined();
    expect(call.referenceRepoPat).toBeUndefined();
  });

  it('registers ls command that calls listSessions', async () => {
    await program.parseAsync(['node', 'ap', 'ls']);
    expect(mockClient.listSessions).toHaveBeenCalled();
  });

  it('registers ls command with filters', async () => {
    await program.parseAsync(['node', 'ap', 'ls', '-s', 'running', '-p', 'myproj']);
    expect(mockClient.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'running', profile: 'myproj' }),
    );
  });

  it('registers status command that calls getSession', async () => {
    await program.parseAsync(['node', 'ap', 'status', 'abcd1234']);
    expect(mockClient.getSession).toHaveBeenCalledWith('abcd1234');
  });

  it('registers tell command that calls sendMessage', async () => {
    await program.parseAsync(['node', 'ap', 'tell', 'abcd1234', 'hey there']);
    expect(mockClient.sendMessage).toHaveBeenCalledWith('abcd1234', 'hey there');
  });

  it('registers approve command that calls approveSession', async () => {
    await program.parseAsync(['node', 'ap', 'approve', 'abcd1234', '--squash']);
    expect(mockClient.approveSession).toHaveBeenCalledWith('abcd1234', { squash: true });
  });

  it('registers reject command that calls rejectSession', async () => {
    await program.parseAsync(['node', 'ap', 'reject', 'abcd1234', 'needs work']);
    expect(mockClient.rejectSession).toHaveBeenCalledWith('abcd1234', 'needs work');
  });

  it('registers kill command that calls killSession', async () => {
    await program.parseAsync(['node', 'ap', 'kill', 'abcd1234']);
    expect(mockClient.killSession).toHaveBeenCalledWith('abcd1234');
  });

  it('registers approve --all-validated', async () => {
    await program.parseAsync(['node', 'ap', 'approve', '--all-validated']);
    expect(mockClient.approveAllValidated).toHaveBeenCalled();
  });

  it('registers kill --all-failed', async () => {
    await program.parseAsync(['node', 'ap', 'kill', '--all-failed']);
    expect(mockClient.killAllFailed).toHaveBeenCalled();
  });
});
