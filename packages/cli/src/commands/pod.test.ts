import { AutopodError } from '@autopod/shared';
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { registerPodCommands } from './pod.js';

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
    listSessions: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockResolvedValue({
      id: 'abcd1234',
      profileName: 'test',
      task: 'do things',
      status: 'validated',
      model: 'opus',
      runtime: 'claude',
      branch: 'ap/abcd1234',
      containerId: 'ctr1',
      worktreePath: null,
      validationAttempts: 1,
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
      readinessReview: null,
    }),
    getSessionEvents: vi.fn().mockResolvedValue([
      {
        type: 'status',
        timestamp: '2026-06-02T08:00:00.000Z',
        message: 'Creating worktree...',
      },
    ]),
    getSessionLogs: vi.fn().mockResolvedValue('build log output'),
    updateFromBase: vi.fn().mockResolvedValue({ ok: true, action: 'queued_after_abort' }),
  } as unknown as AutopodClient;
}

describe('update-from-base command', () => {
  let program: Command;
  let mockClient: AutopodClient;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    mockClient = createMockClient();
    registerPodCommands(program, () => mockClient);
  });

  it('registers update-from-base <id>', async () => {
    await program.parseAsync(['node', 'ap', 'update-from-base', 'abcd1234']);
    expect(mockClient.updateFromBase).toHaveBeenCalledWith('abcd1234');
  });

  it('resolves short ID before calling updateFromBase', async () => {
    const fullId = 'abcd1234';
    (mockClient.listSessions as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: fullId }]);
    await program.parseAsync(['node', 'ap', 'update-from-base', 'abcd']);
    expect(mockClient.listSessions).toHaveBeenCalled();
    expect(mockClient.updateFromBase).toHaveBeenCalledWith(fullId);
  });

  it('rebased: prints base branch and exits 0', async () => {
    (mockClient.updateFromBase as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      action: 'rebased',
      baseBranch: 'main',
      validation: 'started',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync(['node', 'ap', 'update-from-base', 'abcd1234']);
    expect(logSpy).toHaveBeenCalledWith('Rebased onto main. Validation restarted.');
    logSpy.mockRestore();
  });

  it('queued_after_abort: prints queued message and exits 0', async () => {
    (mockClient.updateFromBase as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      action: 'queued_after_abort',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync(['node', 'ap', 'update-from-base', 'abcd1234']);
    expect(logSpy).toHaveBeenCalledWith(
      'Validation is stopping. Update from base will run before the next validation step.',
    );
    logSpy.mockRestore();
  });

  it('already_up_to_date: prints no validation started and exits 0', async () => {
    (mockClient.updateFromBase as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      action: 'already_up_to_date',
      baseBranch: 'main',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync(['node', 'ap', 'update-from-base', 'abcd1234']);
    expect(logSpy).toHaveBeenCalledWith(
      'Pod abcd1234 already contains latest main. No validation started.',
    );
    logSpy.mockRestore();
  });

  it('INVALID_STATE: AutopodError propagates instead of being swallowed', async () => {
    const daemonError = new AutopodError(
      "Cannot run update-from-base on pod abcd1234 in status 'running'",
      'INVALID_STATE',
      409,
    );
    (mockClient.updateFromBase as ReturnType<typeof vi.fn>).mockRejectedValueOnce(daemonError);
    await expect(program.parseAsync(['node', 'ap', 'update-from-base', 'abcd1234'])).rejects.toBe(
      daemonError,
    );
  });

  it('conflict: prints all conflicted files and exits 1', async () => {
    (mockClient.updateFromBase as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      action: 'conflict',
      baseBranch: 'main',
      conflicts: ['packages/foo/package.json', 'pnpm-lock.yaml'],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    try {
      await program.parseAsync(['node', 'ap', 'update-from-base', 'abcd1234']);
    } catch {
      // process.exit throws in tests
    }
    expect(logSpy).toHaveBeenCalledWith('Rebase conflict while updating from main:');
    expect(logSpy).toHaveBeenCalledWith('  packages/foo/package.json');
    expect(logSpy).toHaveBeenCalledWith('  pnpm-lock.yaml');
    expect(exitSpy).toHaveBeenCalledWith(1);
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('prints non-follow logs from persisted events', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['node', 'ap', 'logs', 'abcd1234']);

    expect(mockClient.getSessionEvents).toHaveBeenCalledWith('abcd1234');
    expect(mockClient.getSessionLogs).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain(
      'Creating worktree...',
    );
    logSpy.mockRestore();
  });

  it('prints compact readiness when present', async () => {
    (mockClient.getSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'abcd1234',
      profileName: 'test',
      task: 'do things',
      status: 'validated',
      model: 'opus',
      runtime: 'claude',
      branch: 'ap/abcd1234',
      containerId: 'ctr1',
      worktreePath: null,
      validationAttempts: 1,
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
      readinessReview: {
        status: 'needs_review',
        summary: '2 findings before approval',
        computedAt: '2026-06-07T12:00:00.000Z',
        scope: 'pod',
        areas: [],
        findings: [
          {
            id: 'network-denied-egress',
            area: 'network',
            severity: 'warning',
            title: 'Denied egress observed',
            detail: 'Operator should inspect network events.',
            sourceRefs: [{ kind: 'event', label: 'Network events' }],
          },
        ],
      },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['node', 'ap', 'status', 'abcd1234']);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Readiness: needs_review - 2 findings before approval');
    expect(output).not.toContain('Denied egress observed');
    expect(output).not.toContain('Operator should inspect network events.');
    logSpy.mockRestore();
  });

  it('prints readiness pending when missing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['node', 'ap', 'status', 'abcd1234']);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Readiness: pending/unavailable');
    logSpy.mockRestore();
  });
});
