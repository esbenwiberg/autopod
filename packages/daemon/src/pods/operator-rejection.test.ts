import { describe, expect, it, vi } from 'vitest';
import { createOperatorFixture } from '../test-utils/operator-helpers.js';
import { AgentContinuationSupersededError } from './continuation-preflight.js';
describe('operator rejection lifetime', () => {
  it('rejects ineligible states before rework or container effects', async () => {
    const f = createOperatorFixture();
    await expect(
      f.rejection().rejectSession.call(f.calls, 'prepare', 'retry'),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(f.rejectionCaptured.beginGoalTaskRework).not.toHaveBeenCalled();
    expect(f.cm.start).not.toHaveBeenCalled();
  });
  it('retains reset/actor feedback and the dynamic network receiver through actual SQLite reopen', async () => {
    const f = createOperatorFixture(true);
    f.podRepo.update('prepare', { status: 'validated', validationAttempts: 2 });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.rejectionCaptured.beginGoalTaskRework.mockImplementationOnce(async () => {
      await gate;
      return false;
    });
    const actor = { type: 'human' as const, userId: 'reviewer', displayName: 'Reviewer' };
    const pending = f
      .rejection()
      .rejectSession.call(f.calls, 'prepare', 'Revise the implementation', actor);
    const refresh = vi.fn(async () => {});
    f.calls.refreshNetworkPolicy = refresh;
    release();
    await pending;
    expect(refresh).toHaveBeenCalledWith('test-profile');
    expect(f.pod()).toMatchObject({
      status: 'running',
      validationAttempts: 0,
      lastValidationResult: null,
    });
    expect(f.pod().lastCorrectionMessage).toContain('Reviewer rejection: Revise');
    expect(f.calls.handleCompletion).toHaveBeenCalledWith('prepare');
    const saved = f.pod();
    const profile = f.profiles.get('test-profile');
    const events = f.db.prepare('SELECT * FROM events WHERE pod_id=? ORDER BY id').all('prepare');
    const next = f.reopen();
    expect(next.pods.getOrThrow('prepare')).toEqual(saved);
    expect(next.profiles.get('test-profile')).toEqual(profile);
    expect(f.db.prepare('SELECT * FROM events WHERE pod_id=? ORDER BY id').all('prepare')).toEqual(
      events,
    );
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('preserves superseded continuation identity and replacement resources', async () => {
    const f = createOperatorFixture();
    f.podRepo.update('prepare', { status: 'validated' });
    const error = new AgentContinuationSupersededError();
    f.rejectionCaptured.taskFeedbackEvents.mockImplementationOnce(async () => {
      f.podRepo.incrementLifecycleGeneration('prepare');
      f.podRepo.update('prepare', { status: 'queued', containerId: 'replacement' });
      throw error;
    });
    await expect(f.rejection().rejectSession.call(f.calls, 'prepare')).rejects.toBe(error);
    expect(f.pod()).toMatchObject({ status: 'queued', containerId: 'replacement' });
  });
  it('fails the original nonterminal lifecycle on an ordinary resume failure and rethrows identity', async () => {
    const f = createOperatorFixture();
    f.podRepo.update('prepare', { status: 'validated' });
    const error = new Error('Synthetic feedback failure');
    f.rejectionCaptured.taskFeedbackEvents.mockRejectedValueOnce(error);
    await expect(f.rejection().rejectSession.call(f.calls, 'prepare')).rejects.toBe(error);
    expect(f.pod().status).toBe('failed');
  });
});
