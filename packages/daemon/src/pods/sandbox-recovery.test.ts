import { describe, expect, it, vi } from 'vitest';
import { sandboxRecoveryFixture } from '../test-utils/sandbox-recovery-helpers.js';
import { createSandboxRecovery } from './sandbox-recovery.js';

describe('human sandbox recovery', () => {
  it('inspection observes without resume, worker, validation, deletion or lifecycle side effects', async () => {
    const f = sandboxRecoveryFixture();
    const before = f.pod();
    const status = await f.recovery.inspect('prepare');
    expect(status.resources[0]).toMatchObject({ providerState: 'stopped', abandonBlocked: null });
    expect(status.resources[0]?.startBlocked).toContain('No blind replay');
    expect(status.wakeups[0]?.endedAt).toBeNull();
    expect(f.cm.start).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.deleteSession).not.toHaveBeenCalled();
    expect(f.pod()).toEqual(before);
  });
  it('pending wakeup blocks new Start IDs, even after time passes', async () => {
    const f = sandboxRecoveryFixture();
    for (const id of ['first', 'second'])
      await expect(
        f.recovery.submit('prepare', { ...f.input, id, action: 'start' }, f.actor),
      ).rejects.toThrow('No blind replay');
    expect(f.cm.start).not.toHaveBeenCalled();
  });
  it('fresh provider Running settles the exact wakeup, never starts a worker or changes task status', async () => {
    const f = sandboxRecoveryFixture();
    f.setState('running');
    const status = await f.recovery.inspect('prepare');
    expect(status.wakeups[0]?.settledBy).toBe('observed-running');
    expect(status.resources[0]?.startBlocked).toBeNull();
    expect(f.pod().status).toBe('failed');
    expect(f.cm.start).not.toHaveBeenCalled();
  });
  it('starts a known idle sandbox only; stable replay never starts it twice', async () => {
    const f = sandboxRecoveryFixture(false);
    const before = f.pod();
    const input = { ...f.input, action: 'start' as const, acknowledgeDataLoss: false };
    const first = await f.recovery.submit('prepare', input, f.actor);
    expect(first.operation.completedAt).not.toBeNull();
    expect((await f.recovery.submit('prepare', input, f.actor)).operation.id).toBe(
      first.operation.id,
    );
    expect(f.cm.start).toHaveBeenCalledTimes(1);
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.deleteSession).not.toHaveBeenCalled();
    expect(f.pod()).toEqual(before);
  });
  it('abandonment releases only after confirmed deletion, without settling or deleting original wakeup evidence', async () => {
    const f = sandboxRecoveryFixture();
    const original = f.journal.listForPod('prepare');
    f.cm.kill.mockImplementation(async () => {
      expect(() => f.journal.assertPodReleasable('prepare')).toThrow('abandonment is in progress');
      expect(() => f.journal.assertReleasable(f.sandboxId)).not.toThrow();
      expect(() => f.journal.assertReleasable('different')).not.toThrow();
      f.setState('deleted');
    });
    const result = await f.recovery.submit('prepare', f.input, f.actor);
    expect(result.podDeleted).toBe(true);
    expect(f.podRepo.listReferencedContainerIds()).not.toContain(f.sandboxId);
    expect(f.journal.listForPod('prepare')).toEqual(original);
    expect(f.journal.recovery.list('prepare')[0]).toMatchObject({
      userId: f.actor.userId,
      reason: f.input.reason,
    });
    expect(() => f.journal.assertReleasable(f.sandboxId)).not.toThrow();
    expect(() => f.journal.recovery.assertWakeable(f.sandboxId)).toThrow('abandoned');
    const replay = await f.recovery.submit('prepare', f.input, f.actor);
    expect(replay.podDeleted).toBe(true);
    expect(f.cm.kill).toHaveBeenCalledTimes(1);
  });
  it('lost deletion response retains the operation and source hold; restart can reconcile exact GET 404', async () => {
    const f = sandboxRecoveryFixture();
    f.cm.kill.mockImplementation(async () => {
      f.setState('deleted');
      throw new Error('lost response');
    });
    await expect(f.recovery.submit('prepare', f.input, f.actor)).rejects.toThrow('lost response');
    expect(f.journal.recovery.get(f.input.id)?.completedAt).toBeNull();
    expect(() => f.journal.assertPodReleasable('prepare')).toThrow();
    expect(() => f.journal.assertReleasable(f.sandboxId)).toThrow();
    expect(f.deleteSession).not.toHaveBeenCalled();
    const next = createSandboxRecovery(f.deps);
    const result = await next.submit('prepare', f.input, f.actor);
    expect(result.podDeleted).toBe(true);
    expect(f.cm.kill).toHaveBeenCalledTimes(1);
  });
  it('unconfirmed deletion never authorizes pod deletion; continuing same decision is explicit', async () => {
    const f = sandboxRecoveryFixture();
    f.cm.kill.mockImplementation(async () => {});
    await expect(f.recovery.submit('prepare', f.input, f.actor)).rejects.toThrow(
      'Deletion is not confirmed',
    );
    expect(f.deleteSession).not.toHaveBeenCalled();
    await expect(
      f.recovery.submit('prepare', { ...f.input, id: 'other-id' }, f.actor),
    ).rejects.toThrow('already has an abandonment');
    expect(() => f.recovery.assertAvailable('prepare')).toThrow('in progress');
  });
  it('request ID cannot change actor, target, action or reason', async () => {
    const f = sandboxRecoveryFixture();
    f.cm.kill.mockRejectedValue(new Error('transport unavailable'));
    await expect(f.recovery.submit('prepare', f.input, f.actor)).rejects.toThrow();
    for (const change of [
      { reason: 'A different operator reason' },
      { sandboxId: 'other' },
      { action: 'start' as const },
    ])
      await expect(
        f.recovery.submit('prepare', { ...f.input, ...change }, f.actor),
      ).rejects.toThrow('conflict');
    await expect(
      f.recovery.submit('prepare', f.input, { ...f.actor, userId: 'another-human' }),
    ).rejects.toThrow('conflict');
    expect(f.cm.kill).toHaveBeenCalledTimes(1);
  });
  it('rejects automation, missing data-loss consent, stale generation and wrong provider namespace', async () => {
    const f = sandboxRecoveryFixture();
    await expect(
      f.recovery.submit('prepare', f.input, { type: 'automation', id: 'test' }),
    ).rejects.toThrow('Authenticated human');
    await expect(
      f.recovery.submit('prepare', { ...f.input, acknowledgeDataLoss: false }, f.actor),
    ).rejects.toThrow('acknowledgement');
    await expect(
      f.recovery.submit('prepare', { ...f.input, expectedGeneration: 999 }, f.actor),
    ).rejects.toThrow('generation');
    f.cm.getResourceKey.mockResolvedValue('different-namespace');
    const status = await f.recovery.inspect('prepare');
    expect(status.resources[0]?.abandonBlocked).toContain('different provider namespace');
    await expect(f.recovery.submit('prepare', f.input, f.actor)).rejects.toThrow('namespace');
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
  it('unknown provider readiness blocks startup but explicit loss acceptance can still request deletion', async () => {
    const f = sandboxRecoveryFixture();
    f.setState('unknown');
    const state = await f.recovery.inspect('prepare');
    expect(state.resources[0]?.startBlocked).toContain('unknown');
    expect(state.resources[0]?.abandonBlocked).toBeNull();
    const result = await f.recovery.submit('prepare', f.input, f.actor);
    expect(result.podDeleted).toBe(true);
    expect(f.journal.listForPod('prepare')[0]?.endedAt).toBeNull();
  });
  it('other custody, worker and active-invocation holds remain independent', async () => {
    const f = sandboxRecoveryFixture();
    f.setIdle(false);
    expect((await f.recovery.inspect('prepare')).resources[0]?.abandonBlocked).toContain(
      'still active',
    );
    f.setIdle(true);
    const source = vi.spyOn(f.sourceAdoptions, 'assertDeletable').mockImplementation(() => {
      throw new Error('source custody');
    });
    await expect(f.recovery.submit('prepare', f.input, f.actor)).rejects.toThrow('source custody');
    source.mockRestore();
    vi.spyOn(f.taskExecutions, 'assertCanDelete').mockImplementation(() => {
      throw new Error('worker unknown');
    });
    await expect(f.recovery.submit('prepare', f.input, f.actor)).rejects.toThrow('worker unknown');
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
  it('rechecks ownership after provider await and before deletion dispatch', async () => {
    const f = sandboxRecoveryFixture();
    let count = 0;
    f.cm.getStatus.mockImplementation(async () => {
      if (++count === 2) f.podRepo.incrementLifecycleGeneration('prepare');
      return 'stopped';
    });
    await expect(f.recovery.submit('prepare', f.input, f.actor)).rejects.toThrow('superseded');
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.journal.recovery.get(f.input.id)?.completedAt).toBeNull();
  });
  it('preserves verified resource deletion when ordinary pod cleanup remains blocked', async () => {
    const f = sandboxRecoveryFixture();
    f.deleteSession.mockRejectedValue(new Error('another original resource is held'));
    const result = await f.recovery.submit('prepare', f.input, f.actor);
    expect(result.podDeleted).toBe(false);
    expect(result.cleanupError).toContain('another original resource');
    expect(result.operation.completedAt).not.toBeNull();
    expect(f.pod().status).toBe('failed');
  });
  it('an uncertain start request is never re-dispatched, including after restart', async () => {
    const f = sandboxRecoveryFixture(false);
    f.cm.start.mockRejectedValue(new Error('response lost'));
    const input = { ...f.input, action: 'start' as const };
    await expect(f.recovery.submit('prepare', input, f.actor)).rejects.toThrow('response lost');
    const restarted = createSandboxRecovery(f.deps);
    await expect(restarted.submit('prepare', input, f.actor)).rejects.toThrow('already admitted');
    expect(f.cm.start).toHaveBeenCalledTimes(1);
    f.setState('running');
    const observed = await restarted.inspect('prepare');
    expect(observed.operations[0]?.completedAt).not.toBeNull();
    expect(
      (await restarted.submit('prepare', input, f.actor)).operation.completedAt,
    ).not.toBeNull();
    expect(f.cm.start).toHaveBeenCalledTimes(1);
  });
  it('a stale selection requires a fresh explicit decision, not permanent orphaning or permission to delete a replacement', async () => {
    const f = sandboxRecoveryFixture();
    f.cm.kill.mockRejectedValueOnce(new Error('before provider acceptance'));
    await expect(f.recovery.submit('prepare', f.input, f.actor)).rejects.toThrow();
    f.podRepo.incrementLifecycleGeneration('prepare');
    await expect(f.recovery.submit('prepare', f.input, f.actor)).rejects.toThrow('superseded');
    const inspected = await f.recovery.inspect('prepare');
    expect(inspected.resources[0]?.abandonment).toBeNull();
    const fresh = {
      ...f.input,
      id: 'new-explicit-decision',
      expectedGeneration: f.pod().lifecycleGeneration,
    };
    const result = await f.recovery.submit('prepare', fresh, f.actor);
    expect(result.podDeleted).toBe(true);
    expect(f.journal.recovery.get(f.input.id)?.completedAt).not.toBeNull();
    expect(f.journal.recovery.list('prepare')).toHaveLength(2);
  });
  it('new human ownership requires its own audited confirmation', async () => {
    const f = sandboxRecoveryFixture();
    f.cm.kill.mockRejectedValueOnce(new Error('lost response'));
    await expect(f.recovery.submit('prepare', f.input, f.actor)).rejects.toThrow();
    const nextActor = { ...f.actor, userId: 'another-human' };
    await expect(f.recovery.submit('prepare', f.input, nextActor)).rejects.toThrow('conflict');
    const result = await f.recovery.submit(
      'prepare',
      { ...f.input, id: 'new-human-decision' },
      nextActor,
    );
    expect(result.podDeleted).toBe(true);
    expect(f.journal.recovery.list('prepare').map((r) => r.userId)).toEqual([
      f.actor.userId,
      nextActor.userId,
    ]);
  });
  it('abandonment without a pending wakeup still blocks ordinary cleanup while deletion is unverified', async () => {
    const f = sandboxRecoveryFixture(false);
    f.cm.kill.mockRejectedValue(new Error('unverified'));
    await expect(f.recovery.submit('prepare', f.input, f.actor)).rejects.toThrow();
    expect(() => f.journal.assertPodReleasable('prepare')).toThrow('in progress');
    expect(() => f.journal.assertReleasable(f.sandboxId)).toThrow('exact abandonment owner');
    expect(() => f.podRepo.delete('prepare')).toThrow('in progress');
  });
  it('durable receipts survive SQLite reopen; immutable identities and evidence reject SQL rewriting', async () => {
    const f = sandboxRecoveryFixture(true, true);
    f.deleteSession.mockRejectedValue(new Error('retain pod for inspection'));
    await f.recovery.submit('prepare', f.input, f.actor);
    expect(() => f.db.prepare('DELETE FROM sandbox_recovery_requests').run()).toThrow('retained');
    expect(() =>
      f.db.prepare("UPDATE sandbox_recovery_requests SET reason='rewrite'").run(),
    ).toThrow('immutable');
    expect(() => f.db.prepare('DELETE FROM sandbox_recovery_events').run()).toThrow('retained');
    const reopened = f.reopen();
    const journal = reopened.pods.sandboxWakeups;
    if (!journal) throw new Error('Missing reopened wakeup journal');
    expect(journal.recovery.get(f.input.id)?.completedAt).not.toBeNull();
    expect(journal.listForPod('prepare')[0]?.endedAt).toBeNull();
    expect(journal.retains(f.sandboxId)).toBe(false);
    expect(() => journal.assertPodReleasable('prepare')).not.toThrow();
    expect(journal.recovery.get(f.input.id)?.userId).toBe(f.actor.userId);
  });
});
