import type { ValidationResult } from '@autopod/shared';

export interface CreatePrConfig {
  /** Worktree path to run `gh` from (inherits git remote context) */
  worktreePath: string;
  /** Branch the PR is for (--head) */
  branch: string;
  /** Target branch to merge into (--base) */
  baseBranch: string;
  /** Session ID for reference */
  sessionId: string;
  /** Task description from the session */
  task: string;
  /** Profile name */
  profileName: string;
  /** Validation result to include in PR body */
  validationResult: ValidationResult | null;
  /** Diff stats */
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  /** Preview URL if available */
  previewUrl: string | null;
}

export interface MergePrConfig {
  /** Worktree path to run `gh` from */
  worktreePath: string;
  /** PR URL or number to merge */
  prUrl: string;
  /** Squash merge instead of regular merge */
  squash?: boolean;
}

export interface PrManager {
  createPr(config: CreatePrConfig): Promise<string>; // returns PR URL
  mergePr(config: MergePrConfig): Promise<void>;
}
