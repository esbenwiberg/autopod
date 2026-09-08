import { expect, it } from 'vitest';
import { fixture, resign } from '../test-utils/managed-fixture.js';
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
