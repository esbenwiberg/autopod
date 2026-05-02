import type {
  AcCheckResult,
  AcDefinition,
  PreSubmitReviewSnapshot,
  TaskSummary,
  ValidationOverride,
  ValidationPhase,
  ValidationResult,
} from '@autopod/shared';

export interface ValidationEngineConfig {
  podId: string;
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
  /** Anthropic API key for Tier 2 tool-use review. Defaults to ANTHROPIC_API_KEY env var. */
  reviewerApiKey?: string;
  testCommand?: string | null;
  /** Subdirectory relative to /workspace where build/test/start commands execute. */
  buildWorkDir?: string | null;
  /** Build phase timeout in ms. Default 300_000 (5 min). */
  buildTimeout?: number;
  /** Test phase timeout in ms. Default 600_000 (10 min). */
  testTimeout?: number;
  /** Optional lint command (e.g. 'biome lint .'). Phase is skipped when absent. */
  lintCommand?: string | null;
  /** Lint phase timeout in ms. Default 120_000 (2 min). */
  lintTimeout?: number;
  /** Optional SAST command (e.g. 'semgrep --config=p/security-audit .'). Phase is skipped when absent. */
  sastCommand?: string | null;
  /** SAST phase timeout in ms. Default 300_000 (5 min). */
  sastTimeout?: number;
  acceptanceCriteria?: AcDefinition[];
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
  /**
   * Brief-level advisory: files this pod was scoped to modify. Surfaced to the
   * reviewer as guidance, not enforcement — deviations become discussion items
   * in the review, not failures.
   */
  briefTouches?: string[];
  /**
   * Brief-level advisory: files this pod was asked to avoid. Surfaced to the
   * reviewer as guidance, not enforcement.
   */
  briefDoesNotTouch?: string[];
  /** Host worktree path for enriched review context. Enables Tier 0+1 context gathering and Tier 2/3 escalation. */
  worktreePath?: string;
  /** Base commit SHA for scoping diff annotations */
  startCommitSha?: string;
  /** Review depth: 'standard' (Tier 0+1 only), 'auto' (escalate on uncertain, default), 'deep' (always Tier 2+) */
  reviewDepth?: 'standard' | 'auto' | 'deep';
  /** Findings dismissed by human reviewer — exclude from review prompt */
  overrides?: ValidationOverride[];
  /** Whether the project has a web frontend. When false, the AC classifier will not
   *  produce web-ui checks and agents are not told to use validate_in_browser. Default true. */
  hasWebUi?: boolean;
  /**
   * Per-exec env vars injected into build/test/lint/SAST commands.
   *
   * Used to pass private-feed credentials (e.g. VSS_NUGET_EXTERNAL_FEED_ENDPOINTS for
   * the Azure Artifacts Credential Provider) without baking them into the container's
   * creation env, which would expose them via `docker inspect`. The runtime/agent path
   * already gets these via the agent shim; validation runs `dotnet build` directly via
   * execInContainer and would otherwise see no creds — causing NU1301 on cold caches.
   */
  extraExecEnv?: Record<string, string>;
  /**
   * Cached verdict from the agent's `pre_submit_review` tool call. When the
   * cached `diffHash` matches the current diff's hash AND the cached status
   * is `pass`, the Tier 1 single-shot reviewer pass is skipped — we already
   * spent the tokens on this exact diff during the agent's pre-submit pass.
   */
  preSubmitReview?: PreSubmitReviewSnapshot | null;
  /** Validation phases to skip unconditionally (profile-level harness decay control). */
  skipPhases?: ValidationPhase[];
}

export interface ValidationPhaseCallbacks {
  onPhaseStarted?: (phase: ValidationPhase) => void;
  onPhaseCompleted?: (
    phase: ValidationPhase,
    status: 'pass' | 'fail' | 'skip',
    result: unknown,
  ) => void;
  onAcProgress?: (completed: number, total: number, latest: AcCheckResult) => void;
}

export interface ValidationEngine {
  validate(
    config: ValidationEngineConfig,
    onProgress?: (message: string) => void,
    signal?: AbortSignal,
    callbacks?: ValidationPhaseCallbacks,
  ): Promise<ValidationResult>;
}
