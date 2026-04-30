import { describe, expect, it, vi } from 'vitest';
import type { PodBridge, PreSubmitReviewToolResult } from '../pod-bridge.js';
import { preSubmitReview } from './pre-submit-review.js';

function makeBridge(result: PreSubmitReviewToolResult) {
  return {
    runPreSubmitReview: vi.fn().mockResolvedValue(result),
  } as unknown as PodBridge;
}

describe('preSubmitReview', () => {
  it('returns the bridge result as JSON, including issues on a fail', async () => {
    const bridge = makeBridge({
      status: 'fail',
      reasoning: 'Missing input validation.',
      issues: ['src/api/users.ts:42: validate the email field'],
      model: 'sonnet',
      durationMs: 8123,
    });

    const raw = await preSubmitReview('pod-1', {}, bridge);
    const parsed = JSON.parse(raw);

    expect(parsed.status).toBe('fail');
    expect(parsed.issues).toEqual(['src/api/users.ts:42: validate the email field']);
    expect(parsed.reasoning).toContain('Missing input validation');
    expect(parsed.model).toBe('sonnet');
    expect(parsed.durationMs).toBe(8123);
  });

  it('omits skipReason when the bridge result does not include one', async () => {
    const bridge = makeBridge({
      status: 'pass',
      reasoning: 'Looks good.',
      issues: [],
      model: 'sonnet',
      durationMs: 4200,
    });

    const raw = await preSubmitReview('pod-1', {}, bridge);
    const parsed = JSON.parse(raw);

    expect('skipReason' in parsed).toBe(false);
  });

  it('forwards skipReason when the critic was skipped', async () => {
    const bridge = makeBridge({
      status: 'skipped',
      reasoning: 'No diff to review.',
      issues: [],
      skipReason: 'no-diff',
      model: 'sonnet',
      durationMs: 0,
    });

    const raw = await preSubmitReview('pod-1', {}, bridge);
    const parsed = JSON.parse(raw);

    expect(parsed.status).toBe('skipped');
    expect(parsed.skipReason).toBe('no-diff');
  });

  it('passes plannedSummary and plannedDeviations through to the bridge', async () => {
    const bridge = makeBridge({
      status: 'pass',
      reasoning: '',
      issues: [],
      model: 'sonnet',
      durationMs: 0,
    });

    await preSubmitReview(
      'pod-1',
      {
        plannedSummary: 'Added dark mode',
        plannedDeviations: [{ step: 'Step 2', planned: 'A', actual: 'B', reason: 'because' }],
      },
      bridge,
    );

    expect(bridge.runPreSubmitReview).toHaveBeenCalledWith('pod-1', {
      plannedSummary: 'Added dark mode',
      plannedDeviations: [{ step: 'Step 2', planned: 'A', actual: 'B', reason: 'because' }],
    });
  });
});
