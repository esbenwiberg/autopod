import { describe, expect, it } from 'vitest';
import { createWorkspaceFixture } from '../test-utils/workspace-recovery-helpers.js';
import { DeletionGuardError } from '../worktrees/local-worktree-manager.js';
describe('workspace preservation and lifecycle fences', () => {
  it('requires current interactive identity and rejects queued guidance before cleanup', () => {
    const f = createWorkspaceFixture();
    const pod = f.interactive();
    expect(() => f.fences.assertInteractiveCompletionCurrent(pod)).not.toThrow();
    f.deps.nudgeRepo.queue('prepare', 'Pending instruction');
    expect(() => f.fences.assertInteractiveCompletionCurrent(pod)).toThrow('guidance');
    expect(f.fences.ownsArtifactCompletion(pod)).toBe(false);
    expect(f.fences.ownsArtifactCompletion(pod, false, true)).toBe(true);
  });
  it('permits only explicitly allowed removed container and fences replacement generation', () => {
    const f = createWorkspaceFixture();
    const pod = f.interactive();
    f.podRepo.update('prepare', { containerId: null });
    expect(() => f.fences.assertInteractiveCompletionCurrent(pod)).toThrow('superseded');
    expect(() => f.fences.assertInteractiveCompletionCurrent(pod, true)).not.toThrow();
    expect(f.fences.ownsArtifactCompletion(pod, true)).toBe(true);
    f.podRepo.incrementLifecycleGeneration('prepare');
    expect(f.fences.ownsArtifactCompletion(pod, true)).toBe(false);
    expect(() => f.fences.assertInteractiveCompletionCurrent(pod, true)).toThrow('superseded');
  });
  it('recognizes deletion guard errors and parks sync failure with retained resources', () => {
    const f = createWorkspaceFixture();
    f.interactive();
    expect(f.fences.handleDeletionGuardError('prepare', new Error('other'))).toBe(false);
    expect(f.fences.handleDeletionGuardError('prepare', new DeletionGuardError(101, 100))).toBe(
      true,
    );
    expect(f.pod().worktreeCompromised).toBe(true);
    f.fences.parkOnWorktreeSyncFailure('prepare', 'Sync failed');
    expect(f.pod()).toMatchObject({
      status: 'failed',
      containerId: 'container-123',
      worktreePath: f.directory,
    });
    expect(f.deps.eventRepo?.getForSession('prepare')).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'pod.worktree_compromised' })]),
    );
  });
  it('records preservation failure only for its owned lifecycle and retains error identity/code', () => {
    const f = createWorkspaceFixture();
    const pod = f.interactive();
    expect(() => f.fences.failInteractivePreservation(pod, 'Synthetic failure')).toThrow(
      'Original resources retained',
    );
    expect(f.pod().failureReason).toContain('Synthetic failure');
    f.podRepo.incrementLifecycleGeneration('prepare');
    f.podRepo.update('prepare', { failureReason: 'replacement' });
    expect(() => f.fences.failInteractivePreservation(pod, 'Old callback')).toThrow();
    expect(f.pod().failureReason).toBe('replacement');
  });
});
