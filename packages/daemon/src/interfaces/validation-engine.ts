import type { TaskSummary, ValidationResult } from '@autopod/shared';

export interface ValidationEngineConfig {
  sessionId: string;
  containerId: string;
  previewUrl: string;
  /** URL reachable from inside the container (e.g. http://127.0.0.1:3000).
   *  Used by Playwright scripts that run in-container. Falls back to previewUrl. */
  containerBaseUrl?: string;
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
  /** Original plan reported by the agent via report_plan */
  plan?: { summary: string; steps: string[] };
  /** Task summary reported by the agent via report_task_summary */
  taskSummary?: TaskSummary;
}

export interface ValidationEngine {
  validate(
    config: ValidationEngineConfig,
    onProgress?: (message: string) => void,
  ): Promise<ValidationResult>;
}
