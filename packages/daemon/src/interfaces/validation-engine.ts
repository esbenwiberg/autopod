import type { ValidationResult } from '@autopod/shared';

export interface ValidationEngineConfig {
  sessionId: string;
  containerId: string;
  previewUrl: string;
  buildCommand: string;
  startCommand: string;
  healthPath: string;
  healthTimeout: number;
  smokePages: import('@autopod/shared').SmokePage[];
  attempt: number;
  task: string;
  diff: string;
  reviewerModel?: string;
  testCommand?: string | null;
  /** Build phase timeout in ms. Default 300_000 (5 min). */
  buildTimeout?: number;
  /** Test phase timeout in ms. Default 600_000 (10 min). */
  testTimeout?: number;
  acceptanceCriteria?: string[];
  /** Repo-specific review rules loaded from e.g. skills/code-review.md in the worktree */
  codeReviewSkill?: string;
  /** Git commit log between base branch and HEAD (one-line format) */
  commitLog?: string;
  /** AI review phase timeout in ms. Default 300_000 (5 min). */
  reviewTimeout?: number;
}

export interface ValidationEngine {
  validate(config: ValidationEngineConfig): Promise<ValidationResult>;
}
