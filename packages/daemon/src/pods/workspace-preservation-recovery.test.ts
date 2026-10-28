import { describe, expect, it, vi } from 'vitest';
import { createPassingValidationResult } from '../test-utils/mock-helpers.js';
import { createWorkspaceFixture } from '../test-utils/workspace-recovery-helpers.js';
describe('workspace preservation recovery', () => {
  it('keeps the original reports even after successful tracked-source preservation', async () => {
    const f = createWorkspaceFixture();
    f.sandbox();
    const trace: string[] = [];
    f.common.preservePodWorkspace.mockImplementationOnce(async () => {
      trace.push('preserve');
    });
    f.common.cleanupContainer.mockImplementationOnce(async () => {
      trace.push('cleanup');
    });
    await f.preservation().preserveSandboxAfterAgentFailure('prepare', 'failed');
    expect(trace).toEqual(['preserve']);
    f.common.preservePodWorkspace.mockRejectedValueOnce(new Error('Synthetic preservation'));
    await f.preservation().preserveSandboxAfterAgentFailure('prepare', 'failed');
    expect(f.common.cleanupContainer).not.toHaveBeenCalled();
    expect(f.pod().containerId).toBe('container-123');
  });
  it('does not restore a stopped original sandbox for automatic failure cleanup', async () => {
    const f = createWorkspaceFixture();
    f.sandbox();
    vi.mocked(f.cm.getStatus).mockResolvedValue('stopped');
    await f.preservation().preserveSandboxAfterAgentFailure('prepare', 'failed');
    expect(f.common.preservePodWorkspace).not.toHaveBeenCalled();
    expect(f.common.cleanupContainer).not.toHaveBeenCalled();
    expect(f.cm.start).not.toHaveBeenCalled();
  });
  it('does not issue checkpoint commands while original worker termination is unresolved', async () => {
    const f = createWorkspaceFixture();
    f.sandbox();
    const ledger = f.podRepo.taskExecutions;
    if (!ledger) throw new Error('Missing fixture ledger');
    vi.spyOn(ledger, 'hasActiveRun').mockReturnValue(true);
    await f.preservation().preserveSandboxAfterAgentFailure('prepare', 'failed');
    expect(f.cm.getStatus).not.toHaveBeenCalled();
    expect(f.common.preservePodWorkspace).not.toHaveBeenCalled();
  });
  it('does not issue checkpoint commands through an unverified validation exit', async () => {
    const f = createWorkspaceFixture();
    f.sandbox();
    f.podRepo.update('prepare', {
      lastValidationResult: {
        ...createPassingValidationResult('prepare'),
        overall: 'fail',
        infrastructureFailure: {
          phase: 'build',
          code: 'EXEC_EXIT_UNVERIFIED',
          message: 'Exit unknown',
          retryable: false,
        },
      },
    });
    await f.preservation().preserveSandboxAfterAgentFailure('prepare', 'failed');
    expect(f.cm.getStatus).not.toHaveBeenCalled();
    expect(f.common.preservePodWorkspace).not.toHaveBeenCalled();
    expect(f.common.cleanupContainer).not.toHaveBeenCalled();
  });
  it('clears compromised/review state only after actual controlled recovery success', async () => {
    const f = createWorkspaceFixture();
    f.podRepo.update('prepare', { worktreeCompromised: true });
    await expect(
      f
        .preservation()
        .tryRecoverAfterWorkspaceSyncFailure(f.pod(), new Error('sync'), 'validation'),
    ).resolves.toBe(false);
    expect(f.pod().worktreeCompromised).toBe(true);
    f.common.recoverWorktreeFromContainer.mockResolvedValueOnce(true);
    await expect(
      f
        .preservation()
        .tryRecoverAfterWorkspaceSyncFailure(f.pod(), new Error('sync'), 'validation'),
    ).resolves.toBe(true);
    expect(f.pod().worktreeCompromised).toBe(false);
    expect(f.common.recoverWorktreeFromContainer).toHaveBeenCalledWith(
      'container-123',
      f.directory,
      f.cm,
      'prepare',
    );
  });
});
