import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApprovalFixture } from '../test-utils/approval-helpers.js';
import { createSourcePublicationLedger } from './source-publication-ledger.js';
const fixtures: ReturnType<typeof createApprovalFixture>[] = [];
function fixture(disk = false) {
  const f = createApprovalFixture(disk);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const f of fixtures.splice(0).reverse()) f.close();
});

describe('complete approval workflow', () => {
  it('publishes changed source through real durable admission before completion and cleanup', async () => {
    const f = fixture();
    f.validated();
    const ledger = f.podRepo.sourcePublications;
    if (!ledger) throw new Error('Missing publication fixture');
    const admit = vi.spyOn(ledger, 'admit');
    await f.workflow().approveSession('prepare');
    expect(f.pod().status).toBe('complete');
    expect(f.worktreeManager.mergeBranch).toHaveBeenCalledOnce();
    expect(admit).toHaveBeenCalledOnce();
    const id = admit.mock.results[0]?.value;
    if (typeof id !== 'string') throw new Error('Missing publication id');
    expect(ledger.get(id)?.state).toBe('confirmed');
    expect(f.pod().readinessReview?.approval?.actor).toEqual({
      type: 'automation',
      id: 'direct-pod-manager',
    });
    expect(f.mainCaptured.cleanupContainerAfterAdvisorySettles).toHaveBeenCalledOnce();
    expect(f.mainCaptured.maybeTriggerDependents).toHaveBeenCalledOnce();
  });
  it('skips source push only when the whole unchanged branch is proven empty', async () => {
    const f = fixture();
    f.validated();
    vi.mocked(f.worktreeManager.getDiffStats).mockResolvedValueOnce({
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
    });
    const hasChanges = f.worktreeManager.hasChangesAgainstBase;
    if (!hasChanges) throw new Error('Missing branch comparison fixture');
    vi.mocked(hasChanges).mockResolvedValueOnce(false);
    await f.workflow().approveSession('prepare');
    expect(f.pod().status).toBe('complete');
    expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
  });
  it('blocks stale approval after the advisory/readiness wait without publishing or cleaning resources', async () => {
    const f = fixture();
    f.validated();
    const original = f.mainCaptured.resolveApprovalReadiness;
    f.mainCaptured.resolveApprovalReadiness = async (...args) => {
      const readiness = await original(...args);
      f.podRepo.incrementLifecycleGeneration('prepare');
      return readiness;
    };
    await expect(f.workflow().approveSession('prepare')).rejects.toMatchObject({
      code: 'STALE_APPROVAL',
    });
    expect(f.pod().status).toBe('validated');
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.mainCaptured.cleanupContainerAfterAdvisorySettles).not.toHaveBeenCalled();
  });
  it('persists confirmed publication/readiness/events through actual private SQLite close and reopen', async () => {
    const f = fixture(true);
    f.validated();
    const ledger = f.podRepo.sourcePublications;
    if (!ledger) throw new Error('Missing ledger');
    const admit = vi.spyOn(ledger, 'admit');
    const profile = f.profiles.get('test-profile');
    await f.workflow().approveSession('prepare');
    const pod = f.pod();
    const id = admit.mock.results[0]?.value;
    if (typeof id !== 'string') throw new Error('Missing admitted id');
    const publication = ledger.get(id);
    const rows = f.db.prepare('SELECT * FROM events WHERE pod_id=? ORDER BY id').all('prepare');
    const next = f.reopen();
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
    expect(next.pods.getOrThrow('prepare')).toEqual(pod);
    expect(createSourcePublicationLedger(f.db).get(id)).toEqual(publication);
    expect(f.db.prepare('SELECT * FROM events WHERE pod_id=? ORDER BY id').all('prepare')).toEqual(
      rows,
    );
    expect(next.profiles.get('test-profile')).toEqual(profile);
  });
  it('retains blocked approval identity and resources through private SQLite reopen', async () => {
    const f = fixture(true);
    f.validated();
    f.podRepo.update('prepare', { worktreePath: null });
    const profile = f.profiles.get('test-profile');
    await expect(
      f.workflow().approveSession('prepare', { reason: 'Recorded retry' }),
    ).rejects.toMatchObject({ code: 'DELIVERY_RECONCILIATION_REQUIRED' });
    const pod = f.pod();
    expect(pod).toMatchObject({ status: 'validated', containerId: 'container-123' });
    expect(pod.failureReason).toContain('Worktree identity is unavailable');
    expect(f.mainCaptured.cleanupContainerAfterAdvisorySettles).not.toHaveBeenCalled();
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    const next = f.reopen();
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
    expect(next.pods.getOrThrow('prepare')).toEqual(pod);
    expect(next.profiles.get('test-profile')).toEqual(profile);
  });
});
