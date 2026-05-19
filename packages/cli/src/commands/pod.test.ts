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
});
