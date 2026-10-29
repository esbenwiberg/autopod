import type { ReadinessReview, ValidationResult } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { createOperatorFixture } from '../test-utils/operator-helpers.js';
import { withLifecycleReadiness } from './readiness-projection.js';

const pass: ValidationResult = {
  podId: 'prepare',
  attempt: 1,
  timestamp: '2026-01-01T00:00:00Z',
  overall: 'pass',
  duration: 1,
  smoke: {
    status: 'pass',
    build: { status: 'pass', output: '', duration: 1 },
    health: { status: 'pass', url: 'http://localhost', responseCode: 200, duration: 1 },
    pages: [],
  },
  taskReview: null,
};
function cached(): ReadinessReview {
  return {
    status: 'ready',
    summary: 'Ready to release.',
    computedAt: '2026-01-01T00:00:00Z',
    scope: 'pod',
    findings: [],
    areas: [
      {
        area: 'validation',
        title: 'Validation',
        status: 'ready',
        summary: 'Blocking validation passed.',
        sourceRefs: [],
      },
    ],
    approval: {
      approvedAt: '2026-01-01T00:00:00Z',
      approvedBy: 'operator',
      statusAtApproval: 'ready',
      scope: 'pod',
    },
  };
}
describe('current lifecycle readiness projection', () => {
  it('preserves historical approval and never mutates or double-adds to cached evidence', () => {
    const original = cached();
    const result = withLifecycleReadiness(original, 'failed', null);
    expect(result.status).toBe('risky');
    expect(result.approval).toEqual(original.approval);
    expect(original.status).toBe('ready');
    expect(original.findings).toEqual([]);
    expect(withLifecycleReadiness(result, 'failed', null)).toEqual(result);
  });
  it.each(['validated', 'complete'] as const)('keeps genuine %s evidence ready', (status) => {
    const original = cached();
    expect(withLifecycleReadiness(original, status, pass)).toBe(original);
  });
  it('does not trust a cleared current result even in validated state', () => {
    expect(withLifecycleReadiness(cached(), 'validated', null).status).toBe('risky');
  });
  it('guards already-persisted ready snapshots on detail, list and database reopen', () => {
    const f = createOperatorFixture(true, 'sandbox');
    f.mainCaptured.transition(f.pod(), 'failed');
    // Emulate an older release's stale snapshot without rewriting historical approval.
    f.podRepo.update('prepare', { readinessReview: cached(), lastValidationResult: null });
    expect(f.pod().readinessReview?.status).toBe('risky');
    expect(f.podRepo.list({ status: 'failed' })[0]?.readinessReview?.summary).toContain('failed');
    const stored = f.db.prepare('SELECT readiness_review FROM pods WHERE id=?').get('prepare') as {
      readiness_review: string;
    };
    expect(JSON.parse(stored.readiness_review).status).toBe('ready');
    expect(f.reopen().pods.getOrThrow('prepare').readinessReview?.status).toBe('risky');
  });
});
