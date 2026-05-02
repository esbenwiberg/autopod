import type { AcDefinition } from './ac.js';
import type { OutputMode } from './actions.js';
import type { EscalationRequest } from './escalation.js';
import type { PodOptions } from './pod-options.js';
import type { ExecutionTarget, PimGroupConfig, Profile } from './profile.js';
import type { RuntimeType } from './runtime.js';
import type { TaskSummary } from './task-summary.js';
import type { ValidationFinding, ValidationOverride, ValidationResult } from './validation.js';

export interface PreSubmitReviewSnapshot {
  status: 'pass' | 'fail' | 'uncertain' | 'skipped';
  /** Hash of the diff this verdict applies to. Cache keyed by this. */
  diffHash: string;
  reasoning: string;
  issues: string[];
  /** The reviewer model used (e.g. 'sonnet'). */
  model: string;
  /** ISO timestamp of when the pre-submit pass ran. */
  checkedAt: string;
}

export interface ReferenceRepo {
  url: string;
  mountPath: string; // derived from last URL segment at pod creation time
  /**
   * Name of the profile that contributed this URL, when the user picked it
   * from the profile list. Lets the daemon resolve auth (githubPat / adoPat)
   * from the source profile at clone time. Absent for ad-hoc URLs, which
   * clone unauthenticated.
   */
  sourceProfile?: string;
}

export type PodStatus =
  | 'queued'
  | 'provisioning'
  | 'running'
  | 'awaiting_input'
  | 'validating'
  | 'validated'
  | 'failed'
  | 'review_required'
  | 'approved'
  | 'merging'
  | 'merge_pending'
  | 'complete'
  | 'paused'
  | 'handoff'
  | 'killing'
  | 'killed';

export interface Pod {
  id: string;
  profileName: string;
  task: string;
  status: PodStatus;
  model: string;
  runtime: RuntimeType;
  executionTarget: ExecutionTarget;
  branch: string;
  containerId: string | null;
  worktreePath: string | null;
  validationAttempts: number;
  maxValidationAttempts: number;
  lastValidationResult: ValidationResult | null;
  lastValidationFindings: ValidationFinding[] | null;
  lastCorrectionMessage: string | null;
  pendingEscalation: EscalationRequest | null;
  escalationCount: number;
  skipValidation: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  userId: string;
  /**
   * Email of the human who created this pod (from the JWT `preferred_username`
   * claim). Used to pre-fill `git config --global user.email` inside the
   * container so interactive commits don't fail with "Author identity unknown".
   * Null for legacy pods predating this field.
   */
  creatorEmail: string | null;
  /**
   * Display name of the human who created this pod (from the JWT `name`
   * claim). Used to pre-fill `git config --global user.name` inside the
   * container. Null for legacy pods predating this field.
   */
  creatorName: string | null;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  previewUrl: string | null;
  prUrl: string | null;
  mergeBlockReason: string | null;
  plan: { summary: string; steps: string[] } | null;
  progress: {
    phase: string;
    description: string;
    currentPhase: number;
    totalPhases: number;
  } | null;
  acceptanceCriteria: AcDefinition[] | null;
  claudeSessionId: string | null;
  /**
   * Orthogonal axes describing how this pod is driven and where its output
   * goes. Replaces the legacy `outputMode` enum.
   */
  options: PodOptions;
  /**
   * @deprecated Mirrors `options` for wire/storage back-compat. New code should
   * read `options` directly. Kept in sync by the pod repository.
   */
  outputMode: OutputMode;
  baseBranch: string | null;
  acFrom: string | null;
  recoveryWorktreePath: string | null;
  reworkReason: string | null;
  reworkCount: number;
  recoveryCount: number;
  lastHeartbeatAt: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  commitCount: number;
  lastCommitAt: string | null;
  startCommitSha: string | null;
  linkedPodId: string | null;
  taskSummary: TaskSummary | null;
  /**
   * Cached verdict from the agent's `pre_submit_review` tool call. The daemon's
   * full reviewer skips its Tier 1 single-shot pass when this verdict is `pass`
   * AND `diffHash` matches the diff at validation time — i.e. the agent
   * hasn't changed code since the pre-submit pass.
   */
  preSubmitReview: PreSubmitReviewSnapshot | null;
  validationOverrides: ValidationOverride[] | null;
  pimGroups: PimGroupConfig[] | null;
  /** Snapshot of the resolved profile config at pod creation time (after inheritance). */
  profileSnapshot: Profile | null;
  prFixAttempts: number;
  maxPrFixAttempts: number;
  fixPodId: string | null;
  /**
   * Iteration counter for fix pods running under `profile.reuseFixPod = true`.
   * 0 for non-fix pods or the first iteration; increments each time the same
   * fix pod is re-enqueued for a new round of CI / review feedback.
   */
  fixIteration: number;
  /** Token budget for this pod (input + output). null = no budget. Inherited from profile at creation. */
  tokenBudget: number | null;
  /** Number of times the user has approved a budget extension for this pod. */
  budgetExtensionsUsed: number;
  /** Why the pod is paused. 'budget' = waiting for budget approval, 'manual' = user-paused mid-run. */
  pauseReason: 'budget' | 'manual' | null;
  /** Reference repos cloned read-only into the container for research pods. */
  referenceRepos: ReferenceRepo[] | null;
  /** Host path where /workspace was extracted on pod completion (artifact mode). */
  artifactsPath: string | null;
  /**
   * Raw human-typed instructions captured when a workspace pod was promoted
   * (interactive → auto). Persisted at promote time and read once when the
   * recovery restart composes `handoffContext`. Null for pods that were
   * never promoted, or promoted without instructions.
   */
  handoffInstructions: string | null;
  /**
   * Composed handoff blob (instructions + commit log + diff stat) written
   * after `syncWorkspaceBack()` runs on the recovery restart. Rendered as
   * the `## Handoff` section in the agent's CLAUDE.md so the spawned agent
   * picks up after the human's interactive session with full context.
   * Null when the pod was never promoted.
   */
  handoffContext: string | null;
  /** ID of the scheduled job that spawned this pod (null for on-demand pods). */
  scheduledJobId: string | null;
  /**
   * IDs of the pods this pod depends on. A pod is only enqueued once *all*
   * listed parents reach `validated`. Empty array = no dependencies.
   */
  dependsOnPodIds: string[];
  /**
   * @deprecated Legacy single-parent mirror (= dependsOnPodIds[0] or null).
   * New code should read `dependsOnPodIds`. Kept in sync by the repository
   * until the follow-up migration removes the underlying DB column.
   */
  dependsOnPodId: string | null;
  /** Series this pod belongs to (null for standalone pods). */
  seriesId: string | null;
  /** Human-readable series name (null for standalone pods). */
  seriesName: string | null;
  /**
   * Series purpose (from `purpose.md`) for series pods. Used as the PR "Why"
   * section and title instead of the individual brief task, and rendered as
   * `## Purpose` in the agent's CLAUDE.md.
   *
   * The wire/column name `seriesDescription` is preserved for backwards
   * compatibility with desktop clients that decode this field directly.
   */
  seriesDescription: string | null;
  /**
   * Series design (from `design.md`) for series pods. Rendered as `## Design`
   * in the agent's CLAUDE.md alongside the purpose section. Carries seams,
   * cross-pod contracts, UX flows, file map, and reference reading.
   */
  seriesDesign: string | null;
  /**
   * Human-readable title for this pod, sourced from the brief's frontmatter
   * `title` field. Null for standalone (non-series) pods or briefs without a
   * title in their frontmatter.
   */
  briefTitle: string | null;
  /**
   * Per-brief advisory list of files this pod expects to modify. The reviewer
   * flags deviations as discussion items, not failures. Directory shorthand
   * (a path ending in `/`) means "anything under this directory".
   */
  touches: string[] | null;
  /**
   * Per-brief advisory list of files this pod should not modify. The reviewer
   * flags deviations as discussion items, not failures.
   */
  doesNotTouch: string[] | null;
  /**
   * Series PR mode this pod participates in: 'single' (all series pods share
   * one branch + one PR), 'stacked' (each pod owns its own PR), or 'none'
   * (push branches, no PR). null for non-series pods.
   */
  prMode: 'single' | 'stacked' | 'none' | null;
  /** When the dependency pod reached validated and this pod was enqueued. */
  dependencyStartedAt: string | null;
  /**
   * When true (stacked series), this pod waits for its parent to reach `complete`
   * (fully merged) before starting. When false (single-branch series or standalone),
   * it starts as soon as the parent reaches `validated`.
   */
  waitForMerge: boolean;
  /**
   * Names of sidecars this pod requested at creation time (e.g. `['dagger']`).
   * Persisted so daemon-restart recovery can re-resolve + re-spawn them.
   * Empty array when the pod declared no sidecars.
   */
  requireSidecars: string[];
  /**
   * Map of sidecar name → container id for sidecars spawned for this pod.
   * E.g. `{ dagger: 'abc123...' }`. Empty/null when no sidecars were requested.
   * Used for orphan reconciliation and teardown cascade.
   */
  sidecarContainerIds: Record<string, string> | null;
  /**
   * Branch names the daemon pushed to the test repo on behalf of this pod
   * (via `ado.run_test_pipeline`). Cleared on pod end so the branch-cleanup
   * sweep can reap them.
   */
  testRunBranches: string[] | null;
  /**
   * Set by the daemon when the auto-commit deletion guard aborts a commit —
   * almost always because `syncWorkspaceBack()` failed and left the host worktree
   * missing files while the git index still references them. When true, the
   * desktop should disable "Create PR" / merge actions and show a recovery banner:
   * the agent's real work may still live in the container and retrying the push
   * will commit a phantom mass-delete.
   */
  worktreeCompromised: boolean;
  /** When true, the pod is automatically approved once it reaches `validated` — no human gate. */
  autoApprove: boolean;
  /** When true, agent `ask_human` calls are rerouted to the reviewer AI model instead of blocking. */
  disableAskHuman: boolean;
  /**
   * ISO timestamp when an operator force-completed this pod (admin escape hatch
   * that skips remaining push / PR / merge steps). Null when the pod completed
   * normally.
   */
  forceCompletedAt: string | null;
  /** Operator-supplied reason for the force-complete. Null when not force-completed. */
  forceCompletedReason: string | null;
  /**
   * ISO timestamp of the most recent AgentEvent consumed for this pod. The stuck-pod
   * watchdog reads this to detect `running` pods whose agent stream has gone silent
   * (container hang, network blip) and auto-fails them so the concurrency slot frees up.
   * Null until the first event arrives.
   */
  lastAgentEventAt: string | null;
  /**
   * ISO timestamp when an operator kicked this pod (manual unstick: re-enqueues a
   * stuck queued pod, or kills + fails a stuck running/provisioning pod).
   */
  kickedAt: string | null;
  /** Operator-supplied reason for the kick. */
  kickedReason: string | null;
  /**
   * One-shot flag set by `promoteToAuto` when the operator promoted an
   * interactive pod with `--skip-agent`. `processPod` clears it before
   * handing off to `handleCompletion`, so the agent is skipped exactly once.
   */
  skipAgent: boolean;
  /**
   * SHA-256 hex digests of every script in `profile.deployment.allowedScripts`
   * captured from the bare repo at the base ref when the pod was provisioned.
   * Keyed by repo-relative script path. The deploy handler refuses to execute
   * a script whose current container content does not match its baseline,
   * blocking the agent from editing-then-invoking. `null` for pods without
   * deployment enabled (or pods predating migration 079).
   */
  deployBaselineHashes: Record<string, string> | null;
  /**
   * Agent's self-reported verification status for each acceptance criterion,
   * submitted alongside `report_task_summary`. Null until the agent submits it.
   * Discrepancies with automated findings are surfaced in correction messages.
   */
  acSelfReport: Array<{ criterion: string; verified: boolean; notes?: string }> | null;
  /**
   * Token counts consumed by harness-side AI calls (e.g. AI review, plan evaluation).
   * Keyed by phase name. Populated as each phase completes; null until any harness
   * AI call runs.
   */
  phaseTokenUsage: Partial<
    Record<'review' | 'plan_eval', { inputTokens: number; outputTokens: number }>
  > | null;
}

export interface CreatePodRequest {
  profileName: string;
  task: string;
  model?: string;
  runtime?: RuntimeType;
  executionTarget?: ExecutionTarget;
  branch?: string;
  /** Override the profile's branch prefix for this pod (e.g. 'hotfix/'). Ignored when branch is set. */
  branchPrefix?: string;
  skipValidation?: boolean;
  acceptanceCriteria?: AcDefinition[];
  /**
   * Per-pod override of the profile's pod options. Each field is
   * independently overridable — `{agentMode:'interactive'}` keeps the
   * profile's `output` choice.
   */
  options?: Partial<PodOptions>;
  /**
   * @deprecated Prefer `options`. When set, resolves to the corresponding
   * `PodOptions` via `podOptionsFromOutputMode()`. Ignored if `options` is set.
   */
  outputMode?: OutputMode;
  baseBranch?: string;
  acFrom?: string;
  linkedPodId?: string;
  /** PIM groups to activate for the duration of this pod */
  pimGroups?: PimGroupConfig[];
  /** Existing PR URL to carry forward (used for fix pods — skips PR creation) */
  prUrl?: string | null;
  /** Override the profile's token budget for this pod. null = inherit from profile. */
  tokenBudget?: number | null;
  /**
   * Reference repos to clone read-only into the container. Mount paths are
   * derived automatically. When `sourceProfile` is set, the daemon resolves
   * auth from that profile's `githubPat` / `adoPat` at clone time. Ad-hoc
   * URLs (no `sourceProfile`) clone unauthenticated — must be public/SSH.
   */
  referenceRepos?: { url: string; sourceProfile?: string }[];
  /** ID of the scheduled job that spawned this pod (null for on-demand pods). */
  scheduledJobId?: string | null;
  /**
   * IDs of the pods this pod depends on. The pod stays `queued` until *all*
   * listed parents reach `validated`. Multi-parent enables fan-in (e.g. an
   * integration pod waiting on both a frontend and a backend pod).
   */
  dependsOnPodIds?: string[];
  /**
   * @deprecated Prefer `dependsOnPodIds`. When provided, it is upgraded to a
   * single-element array. Ignored if `dependsOnPodIds` is also set.
   */
  dependsOnPodId?: string | null;
  /** Series this pod belongs to. */
  seriesId?: string | null;
  /** Human-readable series name. */
  seriesName?: string | null;
  /** Series purpose (from `purpose.md`). Used as the PR "Why" section and rendered as `## Purpose` in CLAUDE.md. */
  seriesDescription?: string | null;
  /** Series design (from `design.md`). Rendered as `## Design` in CLAUDE.md. */
  seriesDesign?: string | null;
  /** Brief title from frontmatter (shown in the pipeline DAG). */
  briefTitle?: string | null;
  /** Per-brief advisory list of files this pod expects to modify. */
  touches?: string[];
  /** Per-brief advisory list of files this pod should not modify. */
  doesNotTouch?: string[];
  /** Series PR mode (single / stacked / none). Set by the series route on each created pod. */
  prMode?: 'single' | 'stacked' | 'none' | null;
  /**
   * Gate the next pod in a stacked series on this pod's PR being merged (complete).
   * Defaults to false — set to true for stacked-series non-root pods.
   */
  waitForMerge?: boolean;
  /**
   * Names of sidecars to spawn for this pod (e.g. `['dagger']`). Each name
   * must correspond to an enabled entry in `profile.sidecars`. Privileged
   * sidecars additionally require `profile.trustedSource: true`.
   */
  requireSidecars?: string[];
  /** Auto-approve the pod once it reaches `validated` — no human gate. Useful for overnight series. */
  autoApprove?: boolean;
  /** Redirect agent `ask_human` calls to the reviewer AI model instead of blocking. */
  disableAskHuman?: boolean;
}

export interface PodSummary {
  id: string;
  profileName: string;
  task: string;
  status: PodStatus;
  model: string;
  runtime: RuntimeType;
  duration: number | null;
  filesChanged: number;
  createdAt: string;
}

/**
 * Per-pod behavioural telemetry derived from the agent event stream plus
 * escalation/pod state. Surfaces how the agent actually worked — reading
 * before editing, how often the human had to intervene, cost — so sketchy
 * sessions can be spotted at a glance.
 */
export type QualityGrade = 'green' | 'yellow' | 'red';

export interface QualitySignals {
  podId: string;
  /** Count of `Read` tool invocations on the agent stream. */
  readCount: number;
  /** Count of `create` + `modify` file-change events. */
  editCount: number;
  /** `readCount / max(editCount, 1)` — higher is better. */
  readEditRatio: number;
  /** Modifies to files that were never read earlier in the session. */
  editsWithoutPriorRead: number;
  /** `ask_human` escalations plus 1 if the pod ended in `killed`. */
  userInterrupts: number;
  /** Distinct files with 3+ modify events — indicates thrashing. */
  editChurnCount: number;
  /** Stop-phrase/hedging/give-up patterns detected in agent output text. */
  tellsCount: number;
  /** Number of PR fix cycles the pod went through. */
  prFixAttempts: number;
  /** Whether smoke validation passed (null = no validation ran). */
  validationPassed: boolean | null;
  /**
   * Aggregate of agent-driven `validate_in_browser` MCP calls, parsed from
   * tool_use events. `null` when the agent never invoked the tool.
   */
  browserChecks: {
    /** Number of `validate_in_browser` invocations. */
    calls: number;
    /** Sum of individual checks across all invocations. */
    totalChecks: number;
    /** Sum of passing checks across all invocations. */
    passedChecks: number;
  } | null;
  tokens: { input: number; output: number; costUsd: number };
  grade: QualityGrade;
  /**
   * Persisted numeric score (0..100) from `pod_quality_scores`, or `null`
   * if the pod hasn't reached a terminal state yet.
   */
  score: number | null;
  /** Exact model string at completion time, e.g. `'claude-opus-4-7'`. */
  model: string | null;
}

/**
 * Persisted record written to `pod_quality_scores` on pod completion. Used
 * for fleet-wide queries (leaderboards, drift detection, model A/B).
 */
export interface PodQualityScore {
  podId: string;
  score: number;
  readCount: number;
  editCount: number;
  readEditRatio: number;
  editsWithoutPriorRead: number;
  userInterrupts: number;
  editChurnCount: number;
  tellsCount: number;
  prFixAttempts: number;
  validationPassed: boolean | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  runtime: RuntimeType;
  profileName: string;
  model: string | null;
  finalStatus: 'complete' | 'killed';
  completedAt: string;
  computedAt: string;
}

/**
 * One data point from `GET /pods/quality/trends` — daily average score
 * per runtime/model over the trailing N days.
 */
export interface QualityTrend {
  day: string;
  avgScore: number;
  podCount: number;
  runtime: string;
  model: string | null;
}
