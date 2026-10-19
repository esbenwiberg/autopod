import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceFixture, result } from '../test-utils/workspace-recovery-helpers.js';
describe('workspace recovery commands', () => {
  it('preserves with original default reason and strictly cleans sidecars before network', async () => {
    const f = createWorkspaceFixture();
    await f.recovery().preserveWorkspace('prepare');
    expect(f.common.preservePodWorkspace).toHaveBeenCalledWith(f.pod(), 'operator recovery');
    const order: string[] = [];
    f.common.killSidecarsForPod.mockImplementationOnce(async () => {
      order.push('sidecars');
    });
    f.common.destroyPodNetwork.mockImplementationOnce(async () => {
      order.push('network');
    });
    await f.recovery().cleanupPodResourcesForRecovery('prepare');
    expect(order).toEqual(['sidecars', 'network']);
    expect(f.common.killSidecarsForPod).toHaveBeenCalledWith('prepare', true);
    expect(f.common.destroyPodNetwork).toHaveBeenCalledWith('prepare', true);
  });
  it('runs the exact sandbox PID termination script only for running attached sandboxes and reports failure', async () => {
    const f = createWorkspaceFixture();
    await f.recovery().quiesceSandboxAgent('prepare');
    expect(f.cm.execInContainer).not.toHaveBeenCalled();
    f.sandbox();
    vi.mocked(f.cm.execInContainer).mockResolvedValueOnce(result('', 70));
    await expect(f.recovery().quiesceSandboxAgent('prepare')).rejects.toThrow('exit 70');
    expect(f.cm.execInContainer).toHaveBeenCalledWith(
      'container-123',
      ['sh', '-c', expect.stringContaining('pid_file=/run/autopod/agent.pid')],
      { timeout: 5000 },
    );
    await f.recovery().suspendSandboxForRecovery('prepare');
    expect(f.cm.stop).toHaveBeenCalledWith('container-123');
  });
  it('requires complete sandbox checkpoint proof before clearing compromise', async () => {
    const f = createWorkspaceFixture();
    f.sandbox();
    f.podRepo.update('prepare', { worktreeCompromised: true });
    const full = await f.common.checkpointSandboxWorkspaceForPod(f.pod());
    f.common.checkpointSandboxWorkspaceForPod.mockResolvedValueOnce({
      ...full,
      materialized: false,
    });
    await expect(f.recovery().recoverWorktree('prepare')).resolves.toMatchObject({
      recovered: false,
    });
    expect(f.pod().worktreeCompromised).toBe(true);
    await expect(f.recovery().recoverWorktree('prepare')).resolves.toMatchObject({
      recovered: true,
    });
    expect(f.pod().worktreeCompromised).toBe(false);
  });
  it('recovers local container source before guarded commit and preserves blockers on failed restore', async () => {
    const f = createWorkspaceFixture();
    f.podRepo.update('prepare', { worktreeCompromised: true });
    f.common.recoverWorktreeFromContainer.mockResolvedValueOnce(true);
    await expect(f.recovery().recoverWorktree('prepare')).resolves.toMatchObject({
      recovered: true,
      message: 'Worktree recovered and committed',
    });
    expect(f.worktreeManager.commitPendingChangesWithGeneratedMessage).toHaveBeenCalledWith(
      f.directory,
      f.pod().task,
      expect.any(Object),
      f.pod().model,
      { maxDeletions: 100 },
    );
    f.podRepo.update('prepare', { worktreeCompromised: true });
    vi.mocked(f.worktreeManager.restoreFromHead).mockResolvedValueOnce({
      restored: false,
      restoredCount: 0,
      reason: 'Unrelated work',
      blockers: [{ status: '??', path: 'retained.txt' }],
    });
    await expect(f.recovery().recoverWorktree('prepare')).resolves.toMatchObject({
      recovered: false,
      blockers: [{ status: '??', path: 'retained.txt' }],
    });
    expect(f.pod().worktreeCompromised).toBe(true);
  });
});
