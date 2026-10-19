import { describe, expect, it } from 'vitest';
import { createWorkspaceFixture } from '../test-utils/workspace-recovery-helpers.js';
describe('workspace preservation recovery', () => {
  it('preserves a failed sandbox before terminal cleanup and retains it on preservation failure', async () => {
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
    expect(trace).toEqual(['preserve', 'cleanup']);
    f.common.preservePodWorkspace.mockRejectedValueOnce(new Error('Synthetic preservation'));
    await f.preservation().preserveSandboxAfterAgentFailure('prepare', 'failed');
    expect(f.common.cleanupContainer).toHaveBeenCalledOnce();
    expect(f.pod().containerId).toBe('container-123');
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
