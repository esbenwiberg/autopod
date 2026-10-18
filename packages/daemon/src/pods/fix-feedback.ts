import type { Pod } from '@autopod/shared';
import type { FixFeedbackCaptured } from './fix-contracts.js';
import { formatReviewFeedbackReply } from './fix-policy.js';
export function createFixFeedback(captured: FixFeedbackCaptured) {
  const { executionForPod, prManagerFactory, logger, emitActivityStatus } = captured;
  async function postFixPodReviewFeedbackReplies(fixPod: Pod): Promise<void> {
    const responses = fixPod.taskSummary?.reviewFeedbackResponses ?? [];
    const prUrl = fixPod.prUrl;
    if (!prUrl || responses.length === 0) return;

    const profile = executionForPod(fixPod);
    const prManager = prManagerFactory ? prManagerFactory(profile) : null;
    if (!prManager?.replyToReviewFeedback) {
      logger.info(
        { podId: fixPod.id, responseCount: responses.length },
        'Fix pod reported review feedback responses but PR manager cannot post replies',
      );
      return;
    }

    const replyResponses = responses
      .filter((response) => response.response.trim().length > 0)
      .map((response) => ({
        feedbackId: response.feedbackId.trim(),
        outcome: response.outcome,
        body: formatReviewFeedbackReply(response),
      }))
      .filter((response) => response.feedbackId.length > 0 && response.body.trim().length > 0);

    if (replyResponses.length === 0) return;

    try {
      const result = await prManager.replyToReviewFeedback({
        prUrl,
        worktreePath: fixPod.worktreePath ?? undefined,
        responses: replyResponses,
      });
      emitActivityStatus(
        fixPod.id,
        `Posted ${result.posted} review feedback repl${result.posted === 1 ? 'y' : 'ies'}; resolved ${result.resolved} conversation${result.resolved === 1 ? '' : 's'} (${result.skipped} fallback/skipped)`,
      );
      if (result.errors.length > 0) {
        logger.warn(
          { podId: fixPod.id, prUrl, errors: result.errors },
          'Some fix-pod review feedback replies failed',
        );
      }
      if (result.resolutionErrors.length > 0) {
        logger.warn(
          { podId: fixPod.id, prUrl, errors: result.resolutionErrors },
          'Some fix-pod review feedback resolutions failed',
        );
      }
    } catch (err) {
      logger.warn({ err, podId: fixPod.id, prUrl }, 'Failed to post fix-pod review replies');
      emitActivityStatus(fixPod.id, 'Review feedback replies failed to post');
    }
  }
  return { postFixPodReviewFeedbackReplies };
}
