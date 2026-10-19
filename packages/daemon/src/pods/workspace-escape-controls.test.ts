import { describe, expect, it } from 'vitest';
import { createWorkspaceFixture } from '../test-utils/workspace-recovery-helpers.js';
describe('workspace operator escape controls', () => {
  it('clears stale queue entry and requeues with operator audit reason', async () => {
    const f = createWorkspaceFixture();
    f.podRepo.update('prepare', { status: 'queued' });
    await expect(
      f.escape().kickPod('prepare', ' repair ', { type: 'human', userId: 'operator' }),
    ).resolves.toEqual({ action: 'requeued' });
    expect(f.common.clearStuckQueueEntry).toHaveBeenCalledWith('prepare');
    expect(f.common.enqueueSession).toHaveBeenCalledWith('prepare');
    expect(f.pod().kickedReason).toBe('repair');
  });
  it('aborts validation and stops retained container before force-failing an active pod', async () => {
    const f = createWorkspaceFixture();
    const controller = new AbortController();
    f.common.validationAbortControllers.set('prepare', controller);
    await expect(f.escape().kickPod('prepare')).resolves.toEqual({ action: 'failed' });
    expect(controller.signal.aborted).toBe(true);
    expect(f.cm.stop).toHaveBeenCalledWith('container-123');
    expect(f.pod()).toMatchObject({ status: 'failed', containerId: 'container-123' });
  });
  it('force-completes only failed work and advances dependents after terminal cleanup', async () => {
    const f = createWorkspaceFixture();
    await expect(f.escape().forceComplete('prepare')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    f.podRepo.update('prepare', { status: 'failed' });
    await f.escape().forceComplete('prepare', ' accepted ', { type: 'automation', id: 'operator' });
    expect(f.cm.kill).toHaveBeenCalledWith('container-123');
    expect(f.pod()).toMatchObject({ status: 'complete', forceCompletedReason: 'accepted' });
    expect(f.common.maybeTriggerDependents).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'prepare', status: 'complete' }),
    );
  });
});
