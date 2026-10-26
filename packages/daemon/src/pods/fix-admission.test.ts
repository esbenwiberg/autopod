import { describe, expect, it } from 'vitest';
import { createConfigurationStore } from '../configuration/configuration-store.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import { createFixCycleFixture, pendingStatus } from '../test-utils/fix-cycle-helpers.js';
import { createFixFeedbackRepository } from './fix-feedback-repository.js';
import { FIX_DELIVERY_FAILED_PREFIX } from './fix-policy.js';
describe('canonical fix admission and recycling', () => {
  it('uses the supplied PR-owner branch/base/URL while keeping the triggering root linkage', async () => {
    const f = createFixCycleFixture();
    f.admissionCaptured.resolveBranchSource.mockReturnValue({
      ...f.pod(),
      id: 'series-owner',
      branch: 'owner-branch',
      baseBranch: 'release',
      prUrl: 'https://github.com/org/repo/pull/99',
    });
    await f.admission().maybeSpawnFixSession('prepare', pendingStatus());
    const id = f.pod().fixPodId;
    if (!id) throw new Error('Missing redirected fix');
    expect(f.podRepo.getOrThrow(id)).toMatchObject({
      linkedPodId: 'prepare',
      branch: 'owner-branch',
      baseBranch: 'release',
      prUrl: 'https://github.com/org/repo/pull/99',
    });
  });
  it('admits a native fix using the frozen repository without a legacy profile alias', async () => {
    const f = createFixCycleFixture();
    await f.nativeParent(false);
    await f.admission().maybeSpawnFixSession('native-parent', pendingStatus());
    const parent = f.podRepo.getOrThrow('native-parent');
    expect(parent.prFixAttempts).toBe(1);
    expect(parent.fixPodId).toBeTruthy();
    if (!parent.fixPodId) throw new Error('Missing native fix');
    expect(f.podRepo.getOrThrow(parent.fixPodId)).toMatchObject({
      linkedPodId: 'native-parent',
      status: 'queued',
    });
    expect(f.admissionCaptured.enqueueSession).toHaveBeenCalledWith(parent.fixPodId);
  });
  it('keeps one canonical queued fix with parent/provider/branch ownership and feedback through SQLite reopen', async () => {
    const f = createFixCycleFixture(true);
    const profile = f.profiles.get('test-profile');
    f.deps.fixFeedbackRepo.enqueue('prepare', 'Synthetic queued feedback');
    await f.admission().maybeSpawnFixSession('prepare', pendingStatus());
    const parent = f.pod();
    if (!parent.fixPodId) throw new Error('Missing canonical fix');
    const child = f.podRepo.getOrThrow(parent.fixPodId);
    expect(parent.prFixAttempts).toBe(1);
    expect(child).toMatchObject({
      status: 'queued',
      linkedPodId: 'prepare',
      branch: parent.branch,
      prUrl: parent.prUrl,
      providerAccountIdSnapshot: parent.providerAccountIdSnapshot,
      providerIdSnapshot: parent.providerIdSnapshot,
    });
    expect(f.deps.fixFeedbackRepo.count('prepare')).toBe(1);
    await f.admission().maybeSpawnFixSession('prepare', pendingStatus());
    expect(f.pod().prFixAttempts).toBe(1);
    expect(f.admissionCaptured.enqueueSession).toHaveBeenCalledOnce();
    const next = f.reopen();
    expect(next.pods.getOrThrow('prepare')).toEqual(parent);
    expect(next.pods.getOrThrow(child.id)).toEqual(child);
    expect(createFixFeedbackRepository(f.db).peek('prepare')[0]?.message).toBe(
      'Synthetic queued feedback',
    );
    expect(next.profiles.get('test-profile')).toEqual(profile);
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('does not spawn sub-fixers or fixes for terminal parents', async () => {
    const f = createFixCycleFixture();
    f.insertFix('running');
    await f.admission().maybeSpawnFixSession('fix-child', pendingStatus());
    f.podRepo.update('prepare', { status: 'complete' });
    await f.admission().maybeSpawnFixSession('prepare', pendingStatus());
    expect(f.admissionCaptured.enqueueSession).not.toHaveBeenCalled();
    expect(f.pod().prFixAttempts).toBe(0);
  });
  it('leaves active and operator-parked canonical fixes alone', async () => {
    const f = createFixCycleFixture();
    f.insertFix('queued');
    await f.admission().maybeSpawnFixSession('prepare', pendingStatus());
    f.podRepo.update('fix-child', {
      status: 'awaiting_input',
      mergeBlockReason: `${FIX_DELIVERY_FAILED_PREFIX}: synthetic failure`,
    });
    await f.admission().maybeSpawnFixSession('prepare', pendingStatus());
    expect(f.admissionCaptured.enqueueSession).not.toHaveBeenCalled();
    expect(f.pod().prFixAttempts).toBe(0);
    expect(f.fix().status).toBe('awaiting_input');
  });
  it('fails an exhausted parent and stops its existing poller before another worker admission', async () => {
    const f = createFixCycleFixture();
    f.podRepo.update('prepare', { prFixAttempts: 1, maxPrFixAttempts: 1 });
    await f.admission().maybeSpawnFixSession('prepare', pendingStatus());
    expect(f.pod()).toMatchObject({
      status: 'failed',
      mergeBlockReason: 'Max PR fix attempts (1) exhausted',
    });
    expect(f.admissionCaptured.stopMergePolling).toHaveBeenCalledWith('prepare');
    expect(f.admissionCaptured.enqueueSession).not.toHaveBeenCalled();
  });
  it('stops and awaits merge_pending cleanup before recycling, with exact resets durable after reopen', async () => {
    const f = createFixCycleFixture(true);
    f.insertFix('merge_pending');
    f.podRepo.update('fix-child', {
      fixIteration: 2,
      validationAttempts: 2,
      claudeSessionId: 'old-session',
      taskSummary: { actualSummary: 'Old iteration', deviations: [] },
    });
    f.podRepo.update('prepare', { prFixAttempts: 1 });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.admissionCaptured.cleanupContainer.mockImplementationOnce(async () => {
      f.effects.push('cleanup');
      await gate;
    });
    const pending = f.admission().maybeSpawnFixSession('prepare', pendingStatus());
    expect(f.effects).toEqual(['stop:fix-child', 'cleanup']);
    expect(f.fix().status).toBe('merge_pending');
    expect(f.admissionCaptured.enqueueSession).not.toHaveBeenCalled();
    release();
    await pending;
    const child = f.fix();
    const parent = f.pod();
    expect(child).toMatchObject({
      status: 'queued',
      fixIteration: 3,
      containerId: null,
      worktreePath: null,
      validationAttempts: 0,
      lastValidationResult: null,
      claudeSessionId: null,
      taskSummary: null,
    });
    expect(parent).toMatchObject({ fixPodId: 'fix-child', prFixAttempts: 2 });
    expect(f.effects.at(-1)).toBe('enqueue:fix-child');
    const next = f.reopen();
    expect(next.pods.getOrThrow('fix-child')).toEqual(child);
    expect(next.pods.getOrThrow('prepare')).toEqual(parent);
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('recycles a terminal child using the supplied PR-owner branch reference without restarting cleanup', async () => {
    const f = createFixCycleFixture();
    f.insertFix('failed');
    f.admissionCaptured.resolveBranchSource.mockReturnValue({
      ...f.pod(),
      baseBranch: f.pod().baseBranch,
    });
    await f.admission().maybeSpawnFixSession('prepare', pendingStatus());
    expect(f.fix().status).toBe('queued');
    expect(f.admissionCaptured.resolveBranchSource).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'prepare' }),
    );
    expect(f.admissionCaptured.cleanupContainer).not.toHaveBeenCalled();
    expect(f.admissionCaptured.stopMergePolling).not.toHaveBeenCalled();
  });
  it('uses the same live native derived-admission service after construction and retains frozen authority across preset edits/reopen', async () => {
    const f = createFixCycleFixture(true);
    const native = await f.nativeParent();
    const owner = f.admission();
    const service = f.admissionLive.launchConfiguration;
    f.admissionLive.launchConfiguration = undefined;
    await expect(
      owner.maybeSpawnFixSession('native-parent', pendingStatus()),
    ).rejects.toMatchObject({ code: 'CONFIG_EXECUTION_UNAVAILABLE' });
    f.admissionLive.launchConfiguration = service;
    const env = native.store.get('environment', 'env');
    native.store.write({
      ...env,
      expectedRevision: env.revision,
      payload: { ...env.payload, template: 'node24' },
    });
    await owner.maybeSpawnFixSession('native-parent', pendingStatus());
    const parent = f.podRepo.getOrThrow('native-parent');
    if (!parent.fixPodId) throw new Error('Missing frozen fix');
    const child = f.podRepo.getOrThrow(parent.fixPodId);
    const snapshot = native.snapshots.get(child.id);
    expect(snapshot).toMatchObject({
      environment: { template: 'node22' },
      derivation: { podId: 'native-parent', digest: native.parent.config.digest, kind: 'fix' },
      work: { linkedPodId: 'native-parent', branch: 'native/parent', dependsOnPodIds: [] },
    });
    expect(child.launchConfigDigest).toBe(snapshot?.digest);
    const next = f.reopen();
    expect(next.pods.getOrThrow(child.id)).toEqual(child);
    expect(
      createLaunchSnapshotRepository(f.db, createConfigurationStore(f.db)).get(child.id),
    ).toEqual(snapshot);
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
});
