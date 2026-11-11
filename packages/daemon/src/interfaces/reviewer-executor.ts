import type { CodexReviewTokenUsage } from '../validation/review-codex-runner.js';
import type { ReviewerOutputContract } from '../validation/review-structured-output.js';

/** Daemon-owned inference. Input contains review context, never execution identity or credentials. */
export type ReviewerExecutor = ((input: {
  prompt: string;
  /** Native image content only; never arbitrary container/host file selectors. */
  images?: readonly import('../inputs/reviewer-images.js').ReviewerImage[];
  timeout: number;
  outputContract?: ReviewerOutputContract;
}) => Promise<{ stdout: string; tokenUsage?: CodexReviewTokenUsage; model?: string }>) & {
  /** Why another reviewer would be refused right now (e.g. unreconciled usage), else null. */
  retryBlocker?: () => string | null;
  /** Freeze and bound the final packet (including references) without paid inference. */
  prepare?: (input: Parameters<ReviewerExecutor>[0]) => Promise<{
    inputHash: string;
    execute: () => ReturnType<ReviewerExecutor>;
  }>;
};

/** Prefix of the skip-reason suffix written when the infrastructure retry was refused. */
export const REVIEW_RETRY_BLOCKED = 'Review not retried';
