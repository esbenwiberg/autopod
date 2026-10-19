import { describe, expect, it } from 'vitest';
import { createFixCycleFixture } from '../test-utils/fix-cycle-helpers.js';
describe('live fix provider binding', () => {
  it('reads a replaced live repository field after construction and reconciles only matching identity', () => {
    const f = createFixCycleFixture();
    const original = { ...f.pod(), providerIdSnapshot: null, providerAccountIdSnapshot: null };
    f.providerLive.providerAttemptRepo = undefined;
    expect(f.binding.providerBindingForFixPod(original)).toEqual({
      providerAccountIdSnapshot: null,
      providerIdSnapshot: null,
    });
    f.nativeAttempts.ensureProviderAttempt(f.pod(), f.passContext().profile);
    f.providerLive.providerAttemptRepo = f.repo;
    expect(f.binding.providerBindingForFixPod(original)).toEqual({
      providerAccountIdSnapshot: 'account',
      providerIdSnapshot: 'anthropic',
    });
    expect(f.binding.providerBindingForFixPod({ ...original, model: 'different' })).toEqual({
      providerAccountIdSnapshot: null,
      providerIdSnapshot: null,
    });
    expect(f.binding.providerBindingForFixPod({ ...original, runtime: 'codex' })).toEqual({
      providerAccountIdSnapshot: null,
      providerIdSnapshot: null,
    });
    expect(
      f.binding.providerBindingForFixPod({ ...original, providerAccountIdSnapshot: 'other' }),
    ).toEqual({ providerAccountIdSnapshot: 'other', providerIdSnapshot: null });
  });
  it('retains an already recorded provider instead of selecting the latest mutable attempt', () => {
    const f = createFixCycleFixture();
    const source = {
      ...f.pod(),
      providerIdSnapshot: 'openai' as const,
      providerAccountIdSnapshot: 'original',
    };
    expect(f.binding.providerBindingForFixPod(source)).toEqual({
      providerAccountIdSnapshot: 'original',
      providerIdSnapshot: 'openai',
    });
  });
});
