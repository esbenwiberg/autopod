import { expect, it } from 'vitest';
import { fixture, requestTimeFixture, resign } from '../test-utils/managed-fixture.js';
import { digest } from './canonical.js';
import { admitManagedRequest } from './grants.js';

it('admits only the exact reviewed request when a single-job boundary is present', () => {
  const f = fixture();
  try {
    f.admission.expectedRequest = structuredClone(f.request);
    expect(() => admitManagedRequest(f.request, f.admission, 100)).not.toThrow();

    const changed = structuredClone(f.request);
    changed.dispatcherAttemptId = 'attempt-other';
    changed.effectiveGrant.dispatcherAttemptId = changed.dispatcherAttemptId;
    resign(changed);
    expect(() => admitManagedRequest(changed, f.admission, 100)).toThrow(
      'managed-request-not-reviewed',
    );
  } finally {
    f.close();
  }
});

it('admits a stricter observed-token stop derived from a legacy reviewed profile', () => {
  const f = requestTimeFixture(8, 25);
  try {
    const profileBudget = f.request.profileSnapshot.budget;
    if (!('maxProviderRequests' in profileBudget)) throw new Error('request-time fixture required');
    f.request.profileSnapshot.budget = {
      mode: 'request-time',
      expiresAt: profileBudget.expiresAt,
      maxProviderRequests: profileBudget.maxProviderRequests,
      maxDurationSeconds: profileBudget.maxDurationSeconds,
    };
    f.request.profileSnapshot.snapshotDigest = digest(
      Object.fromEntries(
        Object.entries(f.request.profileSnapshot).filter(([key]) => key !== 'snapshotDigest'),
      ),
    );
    f.request.effectiveGrant.profileSnapshotDigest = f.request.profileSnapshot.snapshotDigest;
    resign(f.request);
    f.admission.profiles = new Map([
      [f.request.profileSnapshot.snapshotDigest, f.request.profileSnapshot],
    ]);

    expect(() => admitManagedRequest(f.request, f.admission, 100)).not.toThrow();
    expect('maxObservedTokens' in f.request.profileSnapshot.budget).toBe(false);
    expect(f.request.effectiveGrant.budget.maxObservedTokens).toBe(25);
  } finally {
    f.close();
  }
});
