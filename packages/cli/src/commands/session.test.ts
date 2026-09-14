import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    listConfigurations: vi
      .fn()
      .mockResolvedValue([{ id: 'repo', name: 'Repo', kind: 'repository', archived: false }]),
    resolveLaunch: vi.fn().mockResolvedValue({ digest: 'a'.repeat(64) }),
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
    getTaskExecution: vi.fn().mockRejectedValue(new Error('Older daemon: accounting unavailable')),
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
    getProfile: vi.fn().mockImplementation((name: string) =>
      Promise.resolve({
        name,
        repoUrl: `https://github.com/org/${name}`,
      }),
    ),
  } as unknown as AutopodClient;
}

const contractYaml = `contract_version: 1
title: "Brief contract"
depends_on: []
scenarios:
  - id: scenario-cli-spec
    given:
      - "a spec folder exists"
    when:
      - "ap pod create --spec parses it"
    then:
      - "the daemon request carries the contract"
required_facts:
  - id: fact-cli-spec
    proves:
      - scenario-cli-spec
    kind: unit-test
    artifact:
      path: packages/cli/src/commands/session.test.ts
      change: update
    command: npx pnpm --filter @autopod/cli test -- session.test.ts
human_review: []
`;

function createSpecFolder(contractName = 'contract.yaml'): string {
  const root = mkdtempSync(join(tmpdir(), 'autopod-cli-spec-'));
  writeFileSync(join(root, 'brief.md'), '## Task\nBuild from the spec.\n');
  writeFileSync(join(root, contractName), contractYaml);
  writeFileSync(join(root, 'notes.md'), 'Planning context.\n');
  return root;
}

describe('pod commands', () => {
  let program: Command;
  let mockClient: AutopodClient;
  const createdDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride(); // Throw instead of process.exit
    mockClient = createMockClient();
    registerPodCommands(program, () => mockClient);
  });

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects removed profile-first run syntax with an actionable replacement', async () => {
    await expect(
      program.parseAsync(['node', 'ap', 'run', 'test-profile', 'build the thing']),
    ).rejects.toThrow('ap run --repo');
    expect(mockClient.createSession).not.toHaveBeenCalled();
  });

  it('passes --sidecar instance IDs through the shared launch preview', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await program.parseAsync([
        'node',
        'ap',
        'run',
        '--repo',
        'repo',
        '--task',
        'Build',
        '--sidecar',
        'dagger',
        '--preview',
        '--json',
      ]);
      expect(mockClient.resolveLaunch).toHaveBeenCalledWith(
        expect.objectContaining({ requiredSidecarIds: ['dagger'] }),
      );
      expect(mockClient.createSession).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
    }
  });

  it('accepts multiple --sidecar flags on start', async () => {
    await program.parseAsync([
      'node',
      'ap',
      'start',
      '--repo',
      'repo',
      '--task',
      'Do it',
      '--sidecar',
      'dagger',
      '--sidecar',
      'postgres',
      '--preview',
      '--json',
    ]);
    expect(mockClient.resolveLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ requiredSidecarIds: ['dagger', 'postgres'] }),
    );
    expect(mockClient.createSession).not.toHaveBeenCalled();
  });

  it('preserves profile sidecar defaults when none are specified', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await program.parseAsync([
        'node',
        'ap',
        'run',
        '--repo',
        'repo',
        '--task',
        'Build',
        '--preview',
        '--json',
      ]);
      expect(mockClient.resolveLaunch).toHaveBeenCalledOnce();
      expect(mockClient.resolveLaunch.mock.calls[0]?.[0]).not.toHaveProperty('requiredSidecarIds');
    } finally {
      output.mockRestore();
    }
  });

  it('selects enrolled read-only reference snapshots on start', async () => {
    await program.parseAsync([
      'node',
      'ap',
      'start',
      '--repo',
      'repo',
      '--task',
      'Audit',
      '--reference',
      'Repo=main',
      '--preview',
      '--json',
    ]);
    expect(mockClient.resolveLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceRepositories: [{ repositoryId: 'repo', ref: 'main', access: 'read' }],
      }),
    );
    expect(mockClient.createSession).not.toHaveBeenCalled();
  });

  it('exposes local spec files as runtime context for --spec pod creation by default', async () => {
    const specRoot = createSpecFolder();
    createdDirs.push(specRoot);

    await program.parseAsync([
      'node',
      'ap',
      'pod',
      'create',
      '--repo',
      'Repo',
      '--preview',
      '--json',
      '--spec',
      specRoot,
    ]);

    const call = (mockClient.resolveLaunch as unknown as { mock: { calls: [unknown][] } }).mock
      .calls[0][0] as Record<string, unknown>;
    expect(call.task).toBe('## Task\nBuild from the spec.');
    expect((call.work as Record<string, unknown>).contract).toEqual(
      expect.objectContaining({ title: 'Brief contract' }),
    );
    expect((call.work as Record<string, unknown>).specFiles).toBeUndefined();
    const outputRoot = `specs/${specRoot.split('/').at(-1)}`;
    expect((call.work as Record<string, unknown>).specContextFiles).toEqual([
      { path: `${outputRoot}/brief.md`, content: '## Task\nBuild from the spec.\n' },
      { path: `${outputRoot}/contract.yaml`, content: contractYaml },
      { path: `${outputRoot}/notes.md`, content: 'Planning context.\n' },
    ]);
  });

  it('rejects symlinked files in --spec pod context', async () => {
    const specRoot = createSpecFolder();
    const outside = mkdtempSync(join(tmpdir(), 'autopod-cli-spec-secret-'));
    createdDirs.push(specRoot, outside);
    writeFileSync(join(outside, 'secret.txt'), 'do-not-send\n');
    symlinkSync(join(outside, 'secret.txt'), join(specRoot, 'leak.txt'));

    await expect(
      program.parseAsync([
        'node',
        'ap',
        'pod',
        'create',
        '--repo',
        'Repo',
        '--preview',
        '--json',
        '--spec',
        specRoot,
      ]),
    ).rejects.toThrow('spec file symlink not allowed');
    expect(mockClient.createSession).not.toHaveBeenCalled();
  });

  it('accepts contract.yml for --spec pod creation', async () => {
    const specRoot = createSpecFolder('contract.yml');
    createdDirs.push(specRoot);

    await program.parseAsync([
      'node',
      'ap',
      'pod',
      'create',
      '--repo',
      'Repo',
      '--preview',
      '--json',
      '--spec',
      specRoot,
    ]);

    const call = (mockClient.resolveLaunch as unknown as { mock: { calls: [unknown][] } }).mock
      .calls[0][0] as Record<string, unknown>;
    expect((call.work as Record<string, unknown>).contract).toEqual(
      expect.objectContaining({ title: 'Brief contract' }),
    );
  });

  it('includes local spec files for --spec pod creation when opted in', async () => {
    const specRoot = createSpecFolder();
    createdDirs.push(specRoot);

    await program.parseAsync([
      'node',
      'ap',
      'pod',
      'create',
      '--repo',
      'Repo',
      '--preview',
      '--json',
      '--spec',
      specRoot,
      '--include-specs',
    ]);

    const call = (mockClient.resolveLaunch as unknown as { mock: { calls: [unknown][] } }).mock
      .calls[0][0] as Record<string, unknown>;
    const outputRoot = `specs/${specRoot.split('/').at(-1)}`;
    expect((call.work as Record<string, unknown>).specFiles).toEqual([
      { path: `${outputRoot}/brief.md`, content: '## Task\nBuild from the spec.\n' },
      { path: `${outputRoot}/contract.yaml`, content: contractYaml },
      { path: `${outputRoot}/notes.md`, content: 'Planning context.\n' },
    ]);
    expect((call.work as Record<string, unknown>).specContextFiles).toEqual(
      (call.work as Record<string, unknown>).specFiles,
    );
  });

  it('can disable runtime spec context for --spec pod creation', async () => {
    const specRoot = createSpecFolder();
    createdDirs.push(specRoot);

    await program.parseAsync([
      'node',
      'ap',
      'pod',
      'create',
      '--repo',
      'Repo',
      '--preview',
      '--json',
      '--spec',
      specRoot,
      '--no-spec-context',
    ]);

    const call = (mockClient.resolveLaunch as unknown as { mock: { calls: [unknown][] } }).mock
      .calls[0][0] as Record<string, unknown>;
    expect((call.work as Record<string, unknown>).specFiles).toBeUndefined();
    expect((call.work as Record<string, unknown>).specContextFiles).toBeUndefined();
  });

  it('omits referenceRepos when no ref flags are passed', async () => {
    await program.parseAsync([
      'node',
      'ap',
      'start',
      '--repo',
      'Repo',
      '--task',
      'do it',
      '--preview',
      '--json',
    ]);
    const call = (mockClient.resolveLaunch as unknown as { mock: { calls: [unknown][] } }).mock
      .calls[0][0] as Record<string, unknown>;
    expect(call.referenceRepositories).toEqual([]);
    expect(call).not.toHaveProperty('referenceRepoPat');
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

  it('passes bounded compact multi-status options to the client', async () => {
    await program.parseAsync([
      'node',
      'ap',
      'ls',
      '--status',
      'running,failed',
      '--limit',
      '10',
      '--compact',
      '--json',
    ]);
    expect(mockClient.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'running,failed',
        limit: 10,
        compact: true,
      }),
    );
  });

  it('renders compact records without requiring JSON', async () => {
    (mockClient.listSessions as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: 'compact1',
        profileName: 'test',
        status: 'running',
        title: 'Compact title',
        startedAt: null,
        completedAt: null,
      },
    ]);

    await program.parseAsync(['node', 'ap', 'ls', '--compact']);
    expect(mockClient.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ compact: true }),
    );
  });

  it('rejects a non-positive ls limit with an actionable error', async () => {
    await expect(program.parseAsync(['node', 'ap', 'ls', '--limit', '0'])).rejects.toThrow(
      'limit must be a positive integer',
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

  it('passes approve reason to the daemon client', async () => {
    await program.parseAsync([
      'node',
      'ap',
      'approve',
      'abcd1234',
      '--reason',
      'accepted denied egress',
    ]);
    expect(mockClient.approveSession).toHaveBeenCalledWith('abcd1234', {
      reason: 'accepted denied egress',
    });
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

  it('prints approve all readiness skipped pods', async () => {
    (mockClient.approveAllValidated as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      approved: ['abcd1234'],
      skipped: [
        {
          podId: 'efgh5678',
          status: 'needs_review',
          reason: 'Advisory QA concern',
        },
        {
          podId: 'ijkl9012',
          status: 'risky',
          reason: 'validation failed; pass --reason for manual approval',
        },
      ],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['node', 'ap', 'approve', '--all-validated']);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Approved: abcd1234');
    expect(output).toContain('Skipped:');
    expect(output).toContain('efgh5678 needs_review - Advisory QA concern');
    expect(output).toContain(
      'ijkl9012 risky - validation failed; pass --reason for manual approval',
    );
    logSpy.mockRestore();
  });

  it('registers kill --all-failed', async () => {
    await program.parseAsync(['node', 'ap', 'kill', '--all-failed']);
    expect(mockClient.killAllFailed).toHaveBeenCalled();
  });
});
