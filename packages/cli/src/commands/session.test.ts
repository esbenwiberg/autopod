import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it('passes --ref-repo and --ref-from-profile flags as referenceRepos on start', async () => {
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
      '--ref-from-profile',
      'duck',
    ]);
    expect(mockClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceRepos: [
          { url: 'https://github.com/org/docs-gen' },
          { url: 'https://github.com/org/pipelines.git' },
          { url: 'https://github.com/org/duck', sourceProfile: 'duck' },
        ],
      }),
    );
    const call = (mockClient.createSession as unknown as { mock: { calls: [unknown][] } }).mock
      .calls[0][0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('referenceRepoPat');
  });

  it('exposes local spec files as runtime context for --spec pod creation by default', async () => {
    const specRoot = createSpecFolder();
    createdDirs.push(specRoot);

    await program.parseAsync(['node', 'ap', 'pod', 'create', 'test-profile', '--spec', specRoot]);

    const call = (mockClient.createSession as unknown as { mock: { calls: [unknown][] } }).mock
      .calls[0][0] as Record<string, unknown>;
    expect(call.task).toBe('## Task\nBuild from the spec.');
    expect(call.contract).toEqual(expect.objectContaining({ title: 'Brief contract' }));
    expect(call.specFiles).toBeUndefined();
    const outputRoot = `specs/${specRoot.split('/').at(-1)}`;
    expect(call.specContextFiles).toEqual([
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
      program.parseAsync(['node', 'ap', 'pod', 'create', 'test-profile', '--spec', specRoot]),
    ).rejects.toThrow('spec file symlink not allowed');
    expect(mockClient.createSession).not.toHaveBeenCalled();
  });

  it('accepts contract.yml for --spec pod creation', async () => {
    const specRoot = createSpecFolder('contract.yml');
    createdDirs.push(specRoot);

    await program.parseAsync(['node', 'ap', 'pod', 'create', 'test-profile', '--spec', specRoot]);

    const call = (mockClient.createSession as unknown as { mock: { calls: [unknown][] } }).mock
      .calls[0][0] as Record<string, unknown>;
    expect(call.contract).toEqual(expect.objectContaining({ title: 'Brief contract' }));
  });

  it('includes local spec files for --spec pod creation when opted in', async () => {
    const specRoot = createSpecFolder();
    createdDirs.push(specRoot);

    await program.parseAsync([
      'node',
      'ap',
      'pod',
      'create',
      'test-profile',
      '--spec',
      specRoot,
      '--include-specs',
    ]);

    const call = (mockClient.createSession as unknown as { mock: { calls: [unknown][] } }).mock
      .calls[0][0] as Record<string, unknown>;
    const outputRoot = `specs/${specRoot.split('/').at(-1)}`;
    expect(call.specFiles).toEqual([
      { path: `${outputRoot}/brief.md`, content: '## Task\nBuild from the spec.\n' },
      { path: `${outputRoot}/contract.yaml`, content: contractYaml },
      { path: `${outputRoot}/notes.md`, content: 'Planning context.\n' },
    ]);
    expect(call.specContextFiles).toEqual(call.specFiles);
  });

  it('can disable runtime spec context for --spec pod creation', async () => {
    const specRoot = createSpecFolder();
    createdDirs.push(specRoot);

    await program.parseAsync([
      'node',
      'ap',
      'pod',
      'create',
      'test-profile',
      '--spec',
      specRoot,
      '--no-spec-context',
    ]);

    const call = (mockClient.createSession as unknown as { mock: { calls: [unknown][] } }).mock
      .calls[0][0] as Record<string, unknown>;
    expect(call.specFiles).toBeUndefined();
    expect(call.specContextFiles).toBeUndefined();
  });

  it('omits referenceRepos when no ref flags are passed', async () => {
    await program.parseAsync(['node', 'ap', 'start', 'test-profile', 'do it']);
    const call = (mockClient.createSession as unknown as { mock: { calls: [unknown][] } }).mock
      .calls[0][0] as Record<string, unknown>;
    expect(call.referenceRepos).toBeUndefined();
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
