import { WORKSPACE_PRESERVATION_FAILED } from '@autopod/shared';
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
    await f.preservation().preserveWorkspaceAfterAgentFailure('prepare', 'failed');
    expect(trace).toEqual(['preserve']);
    f.common.preservePodWorkspace.mockRejectedValueOnce(new Error('Synthetic preservation'));
    await f.preservation().preserveWorkspaceAfterAgentFailure('prepare', 'failed');
    expect(f.common.cleanupContainer).not.toHaveBeenCalled();
    expect(f.pod().containerId).toBe('container-123');
  });
  it('does not restore a stopped original sandbox for automatic failure cleanup', async () => {
    const f = createWorkspaceFixture();
    f.sandbox();
    vi.mocked(f.cm.getStatus).mockResolvedValue('stopped');
    await f.preservation().preserveWorkspaceAfterAgentFailure('prepare', 'failed');
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
    await f.preservation().preserveWorkspaceAfterAgentFailure('prepare', 'failed');
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
    await f.preservation().preserveWorkspaceAfterAgentFailure('prepare', 'failed');
    expect(f.cm.getStatus).not.toHaveBeenCalled();
    expect(f.common.preservePodWorkspace).not.toHaveBeenCalled();
    expect(f.common.cleanupContainer).not.toHaveBeenCalled();
  });
  it('preserves a local Docker worker workspace and records Source saved (#670)', async () => {
    const f = createWorkspaceFixture();
    f.podRepo.update('prepare', { status: 'failed' });
    await f.preservation().preserveWorkspaceAfterAgentFailure('prepare', 'fatal agent exit');
    expect(f.common.preservePodWorkspace).toHaveBeenCalledTimes(1);
    expect(f.pod().finalization?.sourcePreservedAt).toEqual(expect.any(String));
    expect(f.common.cleanupContainer).not.toHaveBeenCalled();
  });
  it('preserves a stopped local container through the archive path but skips a removed one', async () => {
    const f = createWorkspaceFixture();
    f.podRepo.update('prepare', { status: 'failed' });
    vi.mocked(f.cm.getStatus).mockResolvedValueOnce('stopped');
    await f.preservation().preserveWorkspaceAfterAgentFailure('prepare', 'fatal agent exit');
    expect(f.common.preservePodWorkspace).toHaveBeenCalledTimes(1);
    vi.mocked(f.cm.getStatus).mockResolvedValueOnce('deleted');
    await f.preservation().preserveWorkspaceAfterAgentFailure('prepare', 'fatal agent exit');
    expect(f.common.preservePodWorkspace).toHaveBeenCalledTimes(1);
    expect(f.pod().failureReason ?? '').not.toContain(WORKSPACE_PRESERVATION_FAILED);
  });
  it('records an explicit, actionable failure and retains a local container it could not read', async () => {
    const f = createWorkspaceFixture();
    f.podRepo.update('prepare', {
      status: 'failed',
      failureReason: 'Agent failed: provider error',
    });
    vi.mocked(f.cm.getStatus).mockResolvedValueOnce('unknown');
    await f.preservation().preserveWorkspaceAfterAgentFailure('prepare', 'fatal agent exit');
    expect(f.common.preservePodWorkspace).not.toHaveBeenCalled();
    const reason = f.pod().failureReason ?? '';
    expect(reason.startsWith('Agent failed: provider error')).toBe(true);
    expect(reason).toContain(WORKSPACE_PRESERVATION_FAILED);
    expect(reason).toContain('container-123 retained');
    expect(reason).toContain('ap rework prepare');
    expect(f.pod().containerId).toBe('container-123');
    expect(f.common.cleanupContainer).not.toHaveBeenCalled();
    // A later successful preservation clears the note, keeping the original reason.
    await f.preservation().preserveWorkspaceAfterAgentFailure('prepare', 'fatal agent exit');
    expect(f.pod().failureReason).toBe('Agent failed: provider error');
    expect(f.pod().finalization?.sourcePreservedAt).toEqual(expect.any(String));
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
