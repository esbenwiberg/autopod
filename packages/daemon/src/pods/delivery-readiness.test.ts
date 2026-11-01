import { describe, expect, it, vi } from 'vitest';
import { createDeliveryFixture } from '../test-utils/delivery-helpers.js';
import { createPassingValidationResult } from '../test-utils/mock-helpers.js';
import { deliveryReadinessBlock, withDeliveryReadiness } from './delivery-readiness.js';
import { createReadinessService, deriveReadinessReview } from './readiness-review.js';

function cache(f: ReturnType<typeof createDeliveryFixture>) {
  const validation = createPassingValidationResult('prepare');
  const review = deriveReadinessReview({ pod: f.pod(), latestValidation: validation });
  const original = {
    ...review,
    status: 'ready' as const,
    approval: {
      approvedAt: '2026-11-01T22:03:14Z',
      approvedBy: 'operator',
      statusAtApproval: 'ready' as const,
      scope: 'pod' as const,
    },
  };
  f.podRepo.update('prepare', {
    status: 'validated',
    lastValidationResult: validation,
    readinessReview: original,
    mergeBlockReason: null,
    failureReason: null,
  });
  return original;
}

describe('current delivery readiness', () => {
  it('projects an unresolved admitted merge on detail/list/reopen and fresh computation', async () => {
    const f = createDeliveryFixture(true);
    const { publication, entry } = await f.planMerge();
    const journal = f.podRepo.mergeJournal;
    if (!journal) throw new Error('Missing journal');
    journal.claim(f.pod(), f.pod(), publication.publicationId, entry.request.config);
    const original = cache(f);
    for (const pod of [f.pod(), f.podRepo.list()[0]]) {
      expect(pod?.readinessReview?.status).toBe('needs_review');
      expect(pod?.readinessReview?.summary).toContain('no confirmed outcome');
      expect(pod?.readinessReview?.approval).toEqual(original.approval);
      expect(pod?.mergeBlockReason).toBeNull();
    }
    expect(
      createReadinessService({ podRepo: f.podRepo }).computePodReadiness('prepare').status,
    ).toBe('needs_review');
    const stored = f.db.prepare('SELECT readiness_review FROM pods WHERE id=?').get('prepare') as {
      readiness_review: string;
    };
    expect(JSON.parse(stored.readiness_review)).toEqual(original);
    expect(f.podRepo.mergeJournal?.find(f.pod())?.state).toBe('admitted');
    const reopened = f.reopen().pods.getOrThrow('prepare');
    expect(reopened.readinessReview?.status).toBe('needs_review');
    expect(reopened.readinessReview?.summary).toContain('no confirmed outcome');
    expect(reopened.readinessReview?.approval).toEqual(original.approval);
  });

  it('does not infer a blocked delivery from an unadmitted plan alone', async () => {
    const f = createDeliveryFixture();
    await f.planMerge();
    cache(f);
    expect(f.pod().readinessReview?.status).toBe('ready');
  });

  it('shows a retained approval failure even when mergeBlockReason was never set', () => {
    const f = createDeliveryFixture();
    const original = cache(f);
    const failureReason =
      'Approval delivery failed. Original resources retained; reconcile delivery.';
    f.podRepo.update('prepare', { failureReason });
    const pod = f.pod();
    expect(pod.readinessReview?.status).toBe('needs_review');
    expect(deriveReadinessReview({ pod, latestValidation: pod.lastValidationResult }).status).toBe(
      'needs_review',
    );
    const projected = withDeliveryReadiness(original, failureReason);
    expect(withDeliveryReadiness(projected, failureReason)).toEqual(projected);
    expect(original.status).toBe('ready');
    expect(projected.approval).toEqual(original.approval);
    f.podRepo.update('prepare', { failureReason: null });
    expect(f.pod().readinessReview?.status).toBe('ready');
  });

  it('fails closed on unverifiable journal identity without breaking read-only pod access', async () => {
    const f = createDeliveryFixture();
    await f.planMerge();
    cache(f);
    if (!f.podRepo.mergeJournal) throw new Error('Missing journal');
    vi.spyOn(f.podRepo.mergeJournal, 'find').mockImplementation(() => {
      throw new Error('identity unavailable');
    });
    expect(deliveryReadinessBlock(f.pod(), f.podRepo.mergeJournal)).toContain('cannot be verified');
    expect(f.pod().readinessReview?.status).toBe('needs_review');
  });
});
