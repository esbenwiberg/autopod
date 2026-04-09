import type { TaskSummary, ValidationOverride, ValidationResult } from '@autopod/shared';

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
  /** Playwright navigation timeout in ms per page. Default 60_000 (1 min). */
  navigationTimeout?: number;
  /** AI review phase timeout in ms. Default 300_000 (5 min). */
  reviewTimeout?: number;
  /** Original plan reported by the agent via report_plan */
  plan?: { summary: string; steps: string[] };
  /** Task summary reported by the agent via report_task_summary */
  taskSummary?: TaskSummary;
  /** Host worktree path for enriched review context. Enables Tier 0+1 context gathering and Tier 2/3 escalation. */
  worktreePath?: string;
  /** Base commit SHA for scoping diff annotations */
  startCommitSha?: string;
  /** Review depth: 'standard' (Tier 0+1 only), 'auto' (escalate on uncertain, default), 'deep' (always Tier 2+) */
  reviewDepth?: 'standard' | 'auto' | 'deep';
  /** Findings dismissed by human reviewer — exclude from review prompt */
  overrides?: ValidationOverride[];
}

export interface ValidationEngine {
  validate(
    config: ValidationEngineConfig,
    onProgress?: (message: string) => void,
  ): Promise<ValidationResult>;
}
