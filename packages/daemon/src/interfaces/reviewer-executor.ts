import type { CodexReviewTokenUsage } from '../validation/review-codex-runner.js';
import type { ReviewerOutputContract } from '../validation/review-structured-output.js';

/** Daemon-owned inference. Input contains review context, never execution identity or credentials. */
export type ReviewerExecutor = (input: {
  prompt: string;
  timeout: number;
  outputContract?: ReviewerOutputContract;
}) => Promise<{ stdout: string; tokenUsage?: CodexReviewTokenUsage }>;
