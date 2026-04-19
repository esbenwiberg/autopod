import type { AcDefinition } from './ac.js';
import type { OutputMode } from './actions.js';
import type { EscalationRequest } from './escalation.js';
import type { PodOptions } from './pod-options.js';
import type { ExecutionTarget, PimGroupConfig, Profile } from './profile.js';
import type { RuntimeType } from './runtime.js';
import type { TaskSummary } from './task-summary.js';
import type { ValidationOverride, ValidationResult } from './validation.js';

export interface ReferenceRepo {
  url: string;
  mountPath: string; // derived from last URL segment at pod creation time
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
  lastCorrectionMessage: string | null;
  pendingEscalation: EscalationRequest | null;
  escalationCount: number;
  skipValidation: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  userId: string;
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
  lastHeartbeatAt: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  commitCount: number;
  lastCommitAt: string | null;
  startCommitSha: string | null;
  linkedPodId: string | null;
  taskSummary: TaskSummary | null;
  validationOverrides: ValidationOverride[] | null;
  pimGroups: PimGroupConfig[] | null;
  /** Snapshot of the resolved profile config at pod creation time (after inheritance). */
  profileSnapshot: Profile | null;
  prFixAttempts: number;
  maxPrFixAttempts: number;
  fixPodId: string | null;
  /** Token budget for this pod (input + output). null = no budget. Inherited from profile at creation. */
  tokenBudget: number | null;
  /** Number of times the user has approved a budget extension for this pod. */
  budgetExtensionsUsed: number;
  /** Why the pod is paused. 'budget' = waiting for budget approval, 'manual' = user-paused mid-run. */
  pauseReason: 'budget' | 'manual' | null;
  /** Reference repos cloned read-only into the container for research pods. */
  referenceRepos: ReferenceRepo[] | null;
  /** Shared PAT for authenticating against all reference repos (plaintext). */
  referenceRepoPat: string | null;
  /** Host path where /workspace was extracted on pod completion (artifact mode). */
  artifactsPath: string | null;
  /** ID of the scheduled job that spawned this pod (null for on-demand pods). */
  scheduledJobId: string | null;
  /** ID of the pod this pod depends on (null for independent pods). */
  dependsOnPodId: string | null;
  /** Series this pod belongs to (null for standalone pods). */
  seriesId: string | null;
  /** Human-readable series name (null for standalone pods). */
  seriesName: string | null;
  /** When the dependency pod reached validated and this pod was enqueued. */
  dependencyStartedAt: string | null;
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
  /** Reference repos to clone read-only into the container. Mount paths are derived automatically. */
  referenceRepos?: { url: string }[];
  /** Shared PAT for authenticating against all reference repos (optional). */
  referenceRepoPat?: string;
  /** ID of the scheduled job that spawned this pod (null for on-demand pods). */
  scheduledJobId?: string | null;
  /** ID of the pod this pod depends on — starts this pod when dependency reaches validated. */
  dependsOnPodId?: string | null;
  /** Series this pod belongs to. */
  seriesId?: string | null;
  /** Human-readable series name. */
  seriesName?: string | null;
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
