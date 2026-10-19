import { describe, expect, it } from 'vitest';
import { createAdmissionFixture } from '../test-utils/admission-queries-helpers.js';
describe('dependent admission and restart', () => {
  it('waits for fan-in and uses first-parent stacking while excluding missing parents', () => {
    const f = createAdmissionFixture();
    const a = f.insert('a', { status: 'validated', branch: 'feature-a' });
    f.insert('b', { status: 'running' });
    f.insert('child', { dependsOnPodIds: ['a', 'b'] });
    f.insert('missing', { dependsOnPodIds: ['a', 'gone'] });
    f.dependents.maybeTriggerDependents(a);
    expect(f.enqueueSession).not.toHaveBeenCalled();
    f.podRepo.update('b', { status: 'validated' });
    f.dependents.maybeTriggerDependents(f.podRepo.getOrThrow('b'));
    expect(f.enqueueSession).toHaveBeenCalledExactlyOnceWith('child');
    expect(f.podRepo.getOrThrow('child').baseBranch).toBe('feature-a');
  });
  it('requires complete for shared branches and single PR', () => {
    const f = createAdmissionFixture();
    const a = f.insert('a', { status: 'validated', branch: 'shared', baseBranch: 'release' });
    f.insert('shared-child', { branch: 'shared', dependsOnPodIds: ['a'] });
    f.insert('single', { seriesId: 's', prMode: 'single', dependsOnPodIds: ['a'] });
    f.dependents.maybeTriggerDependents(a);
    expect(f.enqueueSession).not.toHaveBeenCalled();
    f.podRepo.update('a', { status: 'complete' });
    f.dependents.maybeTriggerDependents(f.podRepo.getOrThrow('a'));
    expect(f.enqueueSession.mock.calls.map((c) => c[0]).sort()).toEqual(['shared-child', 'single']);
    expect(f.podRepo.getOrThrow('single').baseBranch).toBe('release');
  });
  it('retains the original waitForMerge distinction between completion trigger and restart', () => {
    const f = createAdmissionFixture();
    const a = f.insert('a', { status: 'validated', branch: 'feature', baseBranch: 'release' });
    f.insert('child', { dependsOnPodIds: ['a'], waitForMerge: true });
    f.dependents.maybeTriggerDependents(a);
    expect(f.enqueueSession).not.toHaveBeenCalled();
    f.dependents.rehydrateDependentSessions();
    expect(f.enqueueSession).toHaveBeenCalledExactlyOnceWith('child');
    expect(f.podRepo.getOrThrow('child').baseBranch).toBe('release');
  });
  it('heals only exact cascade marker and retains frozen base through actual SQLite reopen', () => {
    const f = createAdmissionFixture(true);
    const parent = f.insert('a', { status: 'complete', branch: 'feature' });
    f.insert('heal', { status: 'failed', dependsOnPodIds: ['a'] });
    f.podRepo.update('heal', { mergeBlockReason: 'dependency pod a failed' });
    f.insert('other-failure', { status: 'failed', dependsOnPodIds: ['a'] });
    f.podRepo.update('other-failure', { mergeBlockReason: 'own failure' });
    f.insert('frozen', { dependsOnPodIds: ['a'], baseBranch: 'frozen-source' });
    f.db
      .prepare('UPDATE pods SET launch_config_digest=? WHERE id=?')
      .run('synthetic-retained-digest', 'frozen');
    f.dependents.maybeTriggerDependents(parent);
    expect(f.podRepo.getOrThrow('heal')).toMatchObject({
      status: 'queued',
      mergeBlockReason: null,
    });
    expect(f.podRepo.getOrThrow('other-failure').status).toBe('failed');
    expect(f.events.some((e) => e.type === 'pod.status_changed' && e.podId === 'heal')).toBe(true);
    const saved = f.podRepo.getOrThrow('frozen');
    expect(saved.baseBranch).toBe('frozen-source');
    const next = f.reopen();
    expect(next.pods.getOrThrow('frozen')).toEqual(saved);
    expect(next.pods.getOrThrow('heal').status).toBe('queued');
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
});
