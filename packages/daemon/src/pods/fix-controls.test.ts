import { describe, expect, it } from 'vitest';
import { createFixCycleFixture } from '../test-utils/fix-cycle-helpers.js';
describe('fix operator controls', () => {
  it('requires failed exhausted-attempt state and enforces the twenty-attempt ceiling', async () => {
    const f = createFixCycleFixture();
    await expect(f.controls().extendPrAttempts('prepare', 1)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    f.podRepo.update('prepare', { status: 'failed', mergeBlockReason: 'Other failure' });
    await expect(f.controls().extendPrAttempts('prepare', 1)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    f.podRepo.update('prepare', {
      mergeBlockReason: 'Max PR fix attempts (20) exhausted',
      maxPrFixAttempts: 20,
    });
    await expect(f.controls().extendPrAttempts('prepare', 1)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(f.controlsCaptured.startMergePolling).not.toHaveBeenCalled();
  });
  it('extends the ceiling, clears a stale canonical pointer unless reuse is enabled and resumes the same poller', async () => {
    const f = createFixCycleFixture();
    f.insertFix('failed');
    f.podRepo.update('prepare', {
      status: 'failed',
      mergeBlockReason: 'Max PR fix attempts (3) exhausted',
      maxPrFixAttempts: 3,
    });
    await f.controls().extendPrAttempts('prepare', 2);
    expect(f.pod()).toMatchObject({ status: 'merge_pending', maxPrFixAttempts: 5, fixPodId: null });
    expect(f.controlsCaptured.startMergePolling).toHaveBeenCalledWith('prepare');
    f.controlsCaptured.executionForPod = () => ({ ...f.passContext().profile, reuseFixPod: true });
    f.podRepo.update('prepare', {
      status: 'failed',
      fixPodId: 'fix-child',
      mergeBlockReason: 'Max PR fix attempts (5) exhausted',
    });
    await f.controls().extendPrAttempts('prepare', 1);
    expect(f.pod().fixPodId).toBe('fix-child');
  });
  it('keeps manual spawn admission distinct and trims/defaults messages before exact canonical calls', async () => {
    const f = createFixCycleFixture();
    f.controlsCaptured.maybeSpawnFixSession.mockResolvedValue(undefined);
    await f.controls().spawnFixSession('prepare', '  Repair this  ');
    expect(f.deps.fixFeedbackRepo.peek('prepare')[0]?.message).toBe('Repair this');
    expect(f.controlsCaptured.maybeSpawnFixSession).toHaveBeenCalledWith(
      'prepare',
      expect.objectContaining({ ciFailures: [], reviewComments: [] }),
    );
    await f.controls().spawnFixSession('prepare', ' ');
    expect(f.deps.fixFeedbackRepo.peekLatest('prepare')?.message).toBe(
      'Manual fix pod spawn — address the PR feedback.',
    );
    f.podRepo.update('prepare', { status: 'queued' });
    await expect(f.controls().spawnFixSession('prepare')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });
  it('returns structured terminal/request queue metadata for roots and rejects subfix requests', async () => {
    const f = createFixCycleFixture();
    f.controlsCaptured.maybeSpawnFixSession.mockResolvedValue(undefined);
    f.podRepo.update('prepare', { status: 'queued' });
    await expect(f.controls().requestFixSession('prepare', 'untrimmed request')).resolves.toEqual({
      ok: true,
      queued: true,
      queueLength: 1,
      fixPodId: null,
    });
    f.insertFix('running');
    await expect(f.controls().requestFixSession('fix-child', 'no')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    f.podRepo.update('prepare', { status: 'complete' });
    await expect(f.controls().requestFixSession('prepare', 'ignored')).resolves.toEqual({
      ok: false,
      reason: 'parent_terminal',
    });
    expect(f.deps.fixFeedbackRepo.count('prepare')).toBe(1);
  });
  it('reports a newly exhausted parent after canonical admission and preserves callback rejection identity', async () => {
    const f = createFixCycleFixture();
    f.podRepo.update('prepare', { prFixAttempts: 3, maxPrFixAttempts: 3 });
    await expect(f.controls().requestFixSession('prepare', 'repair')).resolves.toEqual({
      ok: false,
      reason: 'parent_terminal',
    });
    f.podRepo.update('prepare', { status: 'merge_pending' });
    const error = new Error('synthetic admission rejection');
    f.controlsCaptured.maybeSpawnFixSession.mockRejectedValueOnce(error);
    await expect(f.controls().spawnFixSession('prepare', 'repair')).rejects.toBe(error);
    expect(f.deps.fixFeedbackRepo.count('prepare')).toBe(2);
  });
});
