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
  /** Pod ID for reference */
  podId: string;
  /** Task description from the pod */
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
  /** Series-level description (from context.md). When set, used instead of task for the PR title and "Why" section. */
  seriesDescription?: string;
  /** Human-readable series name. Used with seriesDescription to build the PR title. */
  seriesName?: string;
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

export interface CiFailureDetail {
  /** Check run name (e.g. "test / unit-tests") */
  name: string;
  /** Conclusion: "failure" | "timed_out" | "action_required" etc. */
  conclusion: string;
  /** Link to the CI run for context */
  detailsUrl: string | null;
  /** Inline failure annotations (up to 10) */
  annotations: Array<{ path: string; message: string; annotationLevel: string }>;
}

export interface ReviewCommentDetail {
  /** Reviewer display name — stored for audit, NOT injected into agent task */
  author?: string;
  /** Comment body text */
  body: string;
  /** File path for inline comments, null for PR-level review comments */
  path: string | null;
}

export interface PrMergeStatus {
  /** Whether the PR has been merged */
  merged: boolean;
  /** Whether the PR is still open (false = closed/abandoned without merging) */
  open: boolean;
  /** Human-readable reason the merge is blocked, if known */
  blockReason: string | null;
  /** Failed CI checks with detail — populated only when there are actionable failures */
  ciFailures: CiFailureDetail[];
  /** Review comments from CHANGES_REQUESTED reviews — populated only when actionable */
  reviewComments: ReviewCommentDetail[];
}

export interface PrManager {
  createPr(config: CreatePrConfig): Promise<string>; // returns PR URL
  mergePr(config: MergePrConfig): Promise<MergePrResult>;
  getPrStatus(config: { prUrl: string; worktreePath?: string }): Promise<PrMergeStatus>;
}
