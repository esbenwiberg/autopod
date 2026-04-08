import type { TaskSummary, ValidationResult } from '@autopod/shared';

export interface CreatePrConfig {
  /** Worktree path to run `gh` from (inherits git remote context) */
  worktreePath: string;
  /** GitHub repository URL (e.g. https://github.com/owner/repo.git) — required for API-based PR creation */
  repoUrl?: string;
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
  /** Screenshot references for PR body */
  screenshots?: Array<{ pagePath: string; imageUrl: string }>;
  /** Agent-reported task summary (what was done + deviations from plan) */
  taskSummary?: TaskSummary;
}

export interface MergePrConfig {
  /** Worktree path to run `gh` from */
  worktreePath: string;
  /** PR URL or number to merge */
  prUrl: string;
  /** Squash merge instead of regular merge */
  squash?: boolean;
}

export interface MergePrResult {
  /** Whether the merge completed immediately */
  merged: boolean;
  /** If not merged, whether auto-merge was scheduled (GitHub) or auto-complete set (ADO) */
  autoMergeScheduled: boolean;
}

export interface PrMergeStatus {
  /** Whether the PR has been merged */
  merged: boolean;
  /** Whether the PR is still open (false = closed/abandoned without merging) */
  open: boolean;
  /** Human-readable reason the merge is blocked, if known */
  blockReason: string | null;
}

export interface PrManager {
  createPr(config: CreatePrConfig): Promise<string>; // returns PR URL
  mergePr(config: MergePrConfig): Promise<MergePrResult>;
  getPrStatus(config: { prUrl: string; worktreePath?: string }): Promise<PrMergeStatus>;
}
