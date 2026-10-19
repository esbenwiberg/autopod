import { describe, expect, it } from 'vitest';
import { createFixCycleFixture } from '../test-utils/fix-cycle-helpers.js';
import { GitCredentialError } from '../worktrees/local-worktree-manager.js';
import { FIX_DELIVERY_FAILED_PREFIX } from './fix-policy.js';
describe('fix delivery parking', () => {
  it('forwards credential error identity into host-push escalation and retains resources', () => {
    const f = createFixCycleFixture();
    const fix = f.insertFix('validating');
    const error = new GitCredentialError('synthetic', 'github', 'push', 'synthetic');
    f.parking.parkFixPodDeliveryFailure(fix, error);
    expect(f.parkingCaptured.parkOnCredentialFailure).toHaveBeenCalledWith('fix-child', error);
    expect(f.fix()).toMatchObject({
      status: 'awaiting_input',
      containerId: 'fix-container',
      worktreePath: f.directory,
    });
    expect(f.parking.isParkedHostPushRecovery(f.fix())).toBe(true);
    expect(f.parking.isRetryableFixDeliveryFailure(f.fix())).toBe(false);
  });
  it('persists ordinary delivery parking and original retry predicates through SQLite reopen', () => {
    const f = createFixCycleFixture(true);
    const fix = f.insertFix();
    const profile = f.profiles.get('test-profile');
    f.parking.parkFixPodDeliveryFailure(fix, new Error('synthetic push'));
    const saved = f.fix();
    expect(saved).toMatchObject({
      status: 'awaiting_input',
      mergeBlockReason: `${FIX_DELIVERY_FAILED_PREFIX}: synthetic push`,
      containerId: 'fix-container',
    });
    expect(f.parking.isParkedHostPushRecovery(saved)).toBe(true);
    expect(f.parking.isRetryableFixDeliveryFailure(saved)).toBe(true);
    expect(f.parking.isRetryableFixDeliveryFailure({ ...saved, lastValidationResult: null })).toBe(
      false,
    );
    const next = f.reopen();
    expect(next.pods.getOrThrow('fix-child')).toEqual(saved);
    expect(next.profiles.get('test-profile')).toEqual(profile);
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
});
