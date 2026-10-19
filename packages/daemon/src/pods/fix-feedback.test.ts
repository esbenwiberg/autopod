import { describe, expect, it, vi } from 'vitest';
import { createFixCycleFixture } from '../test-utils/fix-cycle-helpers.js';
import { createFixFeedback } from './fix-feedback.js';
describe('host fix feedback replies', () => {
  it('filters empty ids/text and sends bounded outcome-aware replies through the original provider', async () => {
    const f = createFixCycleFixture();
    const fix = f.insertFix();
    fix.taskSummary = {
      actualSummary: 'Done',
      deviations: [],
      reviewFeedbackResponses: [
        { feedbackId: ' good ', outcome: 'fixed', response: ' repaired ' },
        { feedbackId: ' ', outcome: 'not_applicable', response: 'skip' },
        { feedbackId: 'empty', outcome: 'could_not_verify', response: ' ' },
      ],
    };
    await f.feedback.postFixPodReviewFeedbackReplies(fix);
    expect(f.provider.replyToReviewFeedback).toHaveBeenCalledWith({
      prUrl: fix.prUrl,
      worktreePath: fix.worktreePath,
      responses: [
        {
          feedbackId: 'good',
          outcome: 'fixed',
          body: 'Autopod fix pod response: Fixed\n\nrepaired',
        },
      ],
    });
  });
  it('skips missing responses/provider support and keeps posting failures best effort', async () => {
    const f = createFixCycleFixture();
    const fix = f.insertFix();
    await f.feedback.postFixPodReviewFeedbackReplies(fix);
    expect(f.provider.replyToReviewFeedback).not.toHaveBeenCalled();
    fix.taskSummary = {
      actualSummary: 'Done',
      deviations: [],
      reviewFeedbackResponses: [
        { feedbackId: 'one', outcome: 'needs_reviewer_decision', response: 'Please decide' },
      ],
    };
    await createFixFeedback({
      ...f.feedbackCaptured,
      prManagerFactory: () => ({ ...f.provider, replyToReviewFeedback: undefined }),
    }).postFixPodReviewFeedbackReplies(fix);
    expect(f.provider.replyToReviewFeedback).not.toHaveBeenCalled();
    f.provider.replyToReviewFeedback.mockRejectedValueOnce(new Error('synthetic post'));
    await expect(f.feedback.postFixPodReviewFeedbackReplies(fix)).resolves.toBeUndefined();
    expect(f.fix().status).toBe('validated');
  });
  it('reports posting/resolution errors without throwing or changing the fix lifecycle', async () => {
    const f = createFixCycleFixture();
    const fix = f.insertFix();
    fix.taskSummary = {
      actualSummary: 'Done',
      deviations: [],
      reviewFeedbackResponses: [
        { feedbackId: 'one', outcome: 'could_not_verify', response: 'No evidence' },
      ],
    };
    const emit = vi.fn();
    f.provider.replyToReviewFeedback.mockResolvedValueOnce({
      posted: 0,
      resolved: 0,
      skipped: 1,
      errors: ['synthetic post error'],
      resolutionErrors: ['synthetic resolution error'],
    });
    await createFixFeedback({
      ...f.feedbackCaptured,
      emitActivityStatus: emit,
    }).postFixPodReviewFeedbackReplies(fix);
    expect(emit).toHaveBeenCalledWith(
      'fix-child',
      expect.stringContaining('0 review feedback replies'),
    );
    expect(f.fix().status).toBe('validated');
  });
});
