import type {
  AcDefinition,
  AgentMode,
  ExecutionTarget,
  OutputMode,
  OutputTarget,
  PimGroupConfig,
  Pod,
  PodOptions,
  PodStatus,
  PreSubmitReviewSnapshot,
  Profile,
  ReferenceRepo,
  TaskSummary,
  ValidationOverride,
  ValidationResult,
} from '@autopod/shared';
import {
  DEFAULT_MAX_PR_FIX_ATTEMPTS,
  PodNotFoundError,
  outputModeFromPodOptions,
  podOptionsFromOutputMode,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import { extractFindings } from '../validation/finding-fingerprint.js';

export interface NewPod {
  id: string;
  profileName: string;
  task: string;
  status: PodStatus;
  model: string;
  runtime: string;
  executionTarget: ExecutionTarget;
  branch: string;
  userId: string;
  /** Email of the human creator (JWT preferred_username). Used for git config inside the container. */
  creatorEmail?: string | null;
  /** Display name of the human creator (JWT name). Used for git config inside the container. */
  creatorName?: string | null;
  maxValidationAttempts: number;
  skipValidation: boolean;
  acceptanceCriteria?: AcDefinition[] | null;
  /** New-style pod options. If omitted, derived from `outputMode`. */
  options?: PodOptions;
  /** Legacy field — still persisted for wire back-compat. */
  outputMode: OutputMode;
  baseBranch?: string | null;
  acFrom?: string | null;
  linkedPodId?: string | null;
  pimGroups?: PimGroupConfig[] | null;
  /** Existing PR URL (set at creation for fix pods to skip PR creation) */
  prUrl?: string | null;
  /** Token budget override for this pod. null = inherit from profile. */
  tokenBudget?: number | null;
  /** Reference repos to clone read-only into the container. */
  referenceRepos?: ReferenceRepo[] | null;
  /** ID of the scheduled job that spawned this pod. */
  scheduledJobId?: string | null;
  /** IDs of the pods this pod depends on (fan-in supported). */
  dependsOnPodIds?: string[] | null;
  /** @deprecated Legacy single-parent mirror; use `dependsOnPodIds`. */
  dependsOnPodId?: string | null;
  /** Series this pod belongs to. */
  seriesId?: string | null;
  /** Human-readable series name. */
  seriesName?: string | null;
  /** Series purpose (from `purpose.md`) for series pods. */
  seriesDescription?: string | null;
  /** Series design (from `design.md`) for series pods. */
  seriesDesign?: string | null;
  /** Brief title from frontmatter (shown in the pipeline DAG). */
  briefTitle?: string | null;
  /** Per-brief advisory list of files this pod expects to modify. */
  touches?: string[] | null;
  /** Per-brief advisory list of files this pod should not modify. */
  doesNotTouch?: string[] | null;
  /** Series PR mode (single / stacked / none). null for non-series pods. */
  prMode?: 'single' | 'stacked' | 'none' | null;
  /** Stacked-series gate: wait for parent PR to merge before starting. */
  waitForMerge?: boolean;
  /** Names of sidecars to spawn for this pod (e.g. `['dagger']`). */
  requireSidecars?: string[] | null;
  /** Auto-approve on validate. */
  autoApprove?: boolean;
  /** Redirect ask_human to AI. */
  disableAskHuman?: boolean;
}

export interface PodFilters {
  profileName?: string;
  status?: PodStatus;
  userId?: string;
}

export interface PodUpdates {
  status?: PodStatus;
  /**
   * Update the pod's task description. Only used by the long-lived fix-pod
   * path (`profile.reuseFixPod = true`) — when the same fix pod is re-enqueued
   * for a new round of CI / review feedback, its task is replaced with a
   * fresh fix prompt covering the new failures.
   */
  task?: string;
  containerId?: string | null;
  worktreePath?: string | null;
  validationAttempts?: number;
  maxValidationAttempts?: number;
  lastValidationResult?: unknown | null;
  lastCorrectionMessage?: string | null;
  pendingEscalation?: unknown | null;
  escalationCount?: number;
  startedAt?: string | null;
  completedAt?: string | null;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  previewUrl?: string | null;
  prUrl?: string | null;
  mergeBlockReason?: string | null;
  plan?: { summary: string; steps: string[] } | null;
  progress?: {
    phase: string;
    description: string;
    currentPhase: number;
    totalPhases: number;
  } | null;
  claudeSessionId?: string | null;
  acceptanceCriteria?: AcDefinition[] | null;
  recoveryWorktreePath?: string | null;
  reworkReason?: string | null;
  reworkCount?: number;
  recoveryCount?: number;
  lastHeartbeatAt?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  commitCount?: number;
  lastCommitAt?: string | null;
  startCommitSha?: string | null;
  linkedPodId?: string | null;
  taskSummary?: TaskSummary | null;
  preSubmitReview?: PreSubmitReviewSnapshot | null;
  validationOverrides?: ValidationOverride[] | null;
  profileSnapshot?: Profile | null;
  prFixAttempts?: number;
  fixIteration?: number;
  maxPrFixAttempts?: number;
  fixPodId?: string | null;
  lastFixPodSpawnedAt?: string | null;
  tokenBudget?: number | null;
  budgetExtensionsUsed?: number;
  pauseReason?: 'budget' | 'manual' | null;
  referenceRepos?: ReferenceRepo[] | null;
  artifactsPath?: string | null;
  handoffInstructions?: string | null;
  handoffContext?: string | null;
  options?: PodOptions;
  dependencyStartedAt?: string | null;
  baseBranch?: string | null;
  sidecarContainerIds?: Record<string, string> | null;
  testRunBranches?: string[] | null;
  worktreeCompromised?: boolean;
  skipValidation?: boolean;
  forceCompletedAt?: string | null;
  forceCompletedReason?: string | null;
  lastAgentEventAt?: string | null;
  kickedAt?: string | null;
  kickedReason?: string | null;
  skipAgent?: boolean;
  deployBaselineHashes?: Record<string, string> | null;
}

export interface PodStats {
  total: number;
  byStatus: Record<PodStatus, number>;
}

export interface PodRepository {
  insert(pod: NewPod): void;
  getOrThrow(id: string): Pod;
  update(id: string, changes: PodUpdates): void;
  delete(id: string): void;
  list(filters?: PodFilters): Pod[];
  countByStatusAndProfile(status: PodStatus, profileName: string): number;
  getStats(filters?: { profileName?: string }): PodStats;
  getPodsDependingOn(podId: string): Pod[];
  getPodsBySeries(seriesId: string): Pod[];
  listNonTerminalPodIds(): string[];
}

/**
 * Normalize acceptance_criteria from DB — supports both old string[] (legacy)
 * and new AcDefinition[] (structured). Strings are wrapped as type:'none'.
 */
/**
 * Parse the depends_on_pod_ids JSON array column, falling back to the legacy
 * single-value depends_on_pod_id column for rows that predate migration 048.
 */
function parseDependsOnPodIds(rawArray: unknown, rawSingle: unknown): string[] {
  if (rawArray) {
    try {
      const parsed = JSON.parse(rawArray as string) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
      }
    } catch {
      // fall through to legacy
    }
  }
  if (typeof rawSingle === 'string' && rawSingle.length > 0) {
    return [rawSingle];
  }
  return [];
}

function parseAcceptanceCriteria(raw: unknown): AcDefinition[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw as string) as unknown[];
    return parsed.map((item) => {
      if (typeof item === 'string') {
        return {
          type: 'none' as const,
          test: item,
          pass: 'criterion satisfied',
          fail: 'criterion not satisfied',
        };
      }
      return item as AcDefinition;
    });
  } catch {
    return null;
  }
}

/**
 * Reconstruct the PodOptions from row columns. Falls back to deriving from the
 * legacy `output_mode` when the new columns are NULL (older rows) or missing.
 */
function readPodFromRow(row: Record<string, unknown>): PodOptions {
  const agentMode = row.agent_mode as AgentMode | undefined;
  const output = row.output_target as OutputTarget | undefined;
  if (agentMode && output) {
    return {
      agentMode,
      output,
      validate: row.validate !== undefined ? Boolean(row.validate) : output === 'pr',
      promotable: row.promotable !== undefined ? Boolean(row.promotable) : false,
    };
  }
  return podOptionsFromOutputMode((row.output_mode as OutputMode | undefined) ?? 'pr');
}

/** Map a SQLite row (snake_case) to a Pod (camelCase). */
function rowToSession(row: Record<string, unknown>): Pod {
  return {
    id: row.id as string,
    profileName: row.profile_name as string,
    task: row.task as string,
    status: row.status as PodStatus,
    model: row.model as string,
    runtime: row.runtime as Pod['runtime'],
    executionTarget: (row.execution_target as Pod['executionTarget']) ?? 'local',
    branch: row.branch as string,
    containerId: (row.container_id as string) ?? null,
    worktreePath: (row.worktree_path as string) ?? null,
    validationAttempts: row.validation_attempts as number,
    maxValidationAttempts: row.max_validation_attempts as number,
    lastValidationResult: row.last_validation_result
      ? JSON.parse(row.last_validation_result as string)
      : null,
    lastValidationFindings: (() => {
      if (!row.last_validation_result) return null;
      try {
        const r = JSON.parse(row.last_validation_result as string) as ValidationResult;
        const findings = extractFindings(r);
        return findings.length > 0 ? findings : null;
      } catch {
        return null;
      }
    })(),
    lastCorrectionMessage: (row.last_correction_message as string) ?? null,
    pendingEscalation: row.pending_escalation ? JSON.parse(row.pending_escalation as string) : null,
    escalationCount: row.escalation_count as number,
    skipValidation: Boolean(row.skip_validation),
    createdAt: row.created_at as string,
    startedAt: (row.started_at as string) ?? null,
    completedAt: (row.completed_at as string) ?? null,
    updatedAt: row.updated_at as string,
    userId: row.user_id as string,
    creatorEmail: (row.creator_email as string) ?? null,
    creatorName: (row.creator_name as string) ?? null,
    filesChanged: row.files_changed as number,
    linesAdded: row.lines_added as number,
    linesRemoved: row.lines_removed as number,
    previewUrl: (row.preview_url as string) ?? null,
    prUrl: (row.pr_url as string) ?? null,
    mergeBlockReason: (row.merge_block_reason as string) ?? null,
    plan: row.plan ? JSON.parse(row.plan as string) : null,
    progress: row.progress ? JSON.parse(row.progress as string) : null,
    acceptanceCriteria: parseAcceptanceCriteria(row.acceptance_criteria),
    claudeSessionId: (row.claude_session_id as string) ?? null,
    options: readPodFromRow(row),
    outputMode: (row.output_mode as OutputMode) ?? 'pr',
    baseBranch: (row.base_branch as string) ?? null,
    acFrom: (row.ac_from as string) ?? null,
    recoveryWorktreePath: (row.recovery_worktree_path as string) ?? null,
    reworkReason: (row.rework_reason as string) ?? null,
    reworkCount: (row.rework_count as number) ?? 0,
    recoveryCount: (row.recovery_count as number) ?? 0,
    lastHeartbeatAt: (row.last_heartbeat_at as string) ?? null,
    inputTokens: (row.input_tokens as number) ?? 0,
    outputTokens: (row.output_tokens as number) ?? 0,
    costUsd: (row.cost_usd as number) ?? 0,
    commitCount: (row.commit_count as number) ?? 0,
    lastCommitAt: (row.last_commit_at as string) ?? null,
    startCommitSha: (row.start_commit_sha as string) ?? null,
    linkedPodId: (row.linked_pod_id as string) ?? null,
    taskSummary: row.task_summary ? JSON.parse(row.task_summary as string) : null,
    preSubmitReview: row.pre_submit_review
      ? (JSON.parse(row.pre_submit_review as string) as PreSubmitReviewSnapshot)
      : null,
    validationOverrides: row.validation_overrides
      ? JSON.parse(row.validation_overrides as string)
      : null,
    pimGroups: row.pim_groups ? (JSON.parse(row.pim_groups as string) as PimGroupConfig[]) : null,
    profileSnapshot: row.profile_snapshot
      ? (JSON.parse(row.profile_snapshot as string) as Profile)
      : null,
    prFixAttempts: (row.pr_fix_attempts as number) ?? 0,
    maxPrFixAttempts: (row.max_pr_fix_attempts as number) ?? DEFAULT_MAX_PR_FIX_ATTEMPTS,
    fixIteration: (row.fix_iteration as number) ?? 0,
    fixPodId: (row.fix_pod_id as string) ?? null,
    lastFixPodSpawnedAt: (row.last_fix_pod_spawned_at as string) ?? null,
    tokenBudget: (row.token_budget as number | null) ?? null,
    budgetExtensionsUsed: (row.budget_extensions_used as number) ?? 0,
    pauseReason: (row.pause_reason as 'budget' | 'manual' | null) ?? null,
    referenceRepos: row.reference_repos
      ? (JSON.parse(row.reference_repos as string) as ReferenceRepo[])
      : null,
    artifactsPath: (row.artifacts_path as string) ?? null,
    handoffInstructions: (row.handoff_instructions as string) ?? null,
    handoffContext: (row.handoff_context as string) ?? null,
    scheduledJobId: (row.scheduled_job_id as string) ?? null,
    dependsOnPodIds: parseDependsOnPodIds(row.depends_on_pod_ids, row.depends_on_pod_id),
    dependsOnPodId: (row.depends_on_pod_id as string) ?? null,
    seriesId: (row.series_id as string) ?? null,
    seriesName: (row.series_name as string) ?? null,
    seriesDescription: (row.series_description as string) ?? null,
    seriesDesign: (row.series_design as string) ?? null,
    briefTitle: (row.brief_title as string) ?? null,
    touches: row.touches ? (JSON.parse(row.touches as string) as string[]) : null,
    doesNotTouch: row.does_not_touch
      ? (JSON.parse(row.does_not_touch as string) as string[])
      : null,
    prMode: (row.pr_mode as 'single' | 'stacked' | 'none' | null) ?? null,
    dependencyStartedAt: (row.dependency_started_at as string) ?? null,
    waitForMerge: Boolean(row.wait_for_merge),
    autoApprove: Boolean(row.auto_approve),
    disableAskHuman: Boolean(row.disable_ask_human),
    requireSidecars: row.require_sidecars
      ? (JSON.parse(row.require_sidecars as string) as string[])
      : [],
    sidecarContainerIds: row.sidecar_container_ids
      ? (JSON.parse(row.sidecar_container_ids as string) as Record<string, string>)
      : null,
    testRunBranches: row.test_run_branches
      ? (JSON.parse(row.test_run_branches as string) as string[])
      : null,
    worktreeCompromised: Boolean(row.worktree_compromised),
    forceCompletedAt: (row.force_completed_at as string) ?? null,
    forceCompletedReason: (row.force_completed_reason as string) ?? null,
    lastAgentEventAt: (row.last_agent_event_at as string) ?? null,
    kickedAt: (row.kicked_at as string) ?? null,
    kickedReason: (row.kicked_reason as string) ?? null,
    skipAgent: Boolean(row.skip_agent),
    deployBaselineHashes: row.deploy_baseline_hashes
      ? (JSON.parse(row.deploy_baseline_hashes as string) as Record<string, string>)
      : null,
  };
}

export function createPodRepository(db: Database.Database): PodRepository {
  return {
    insert(pod: NewPod): void {
      // Keep legacy output_mode and new pod columns in sync.
      const podOpts: PodOptions = pod.options ?? podOptionsFromOutputMode(pod.outputMode);
      const legacyOutputMode: OutputMode = pod.options
        ? outputModeFromPodOptions(podOpts)
        : pod.outputMode;
      // Normalize legacy single-parent input into the array form; keep the old
      // column in sync as depends_on_pod_ids[0] for back-compat readers.
      const depIds: string[] =
        pod.dependsOnPodIds && pod.dependsOnPodIds.length > 0
          ? pod.dependsOnPodIds
          : pod.dependsOnPodId
            ? [pod.dependsOnPodId]
            : [];
      db.prepare(`
        INSERT INTO pods (
          id, profile_name, task, status, model, runtime, execution_target, branch,
          user_id, creator_email, creator_name, max_validation_attempts, skip_validation, acceptance_criteria,
          output_mode, agent_mode, output_target, validate, promotable,
          base_branch, ac_from, linked_pod_id, pim_groups, pr_url,
          token_budget, reference_repos, scheduled_job_id,
          depends_on_pod_id, depends_on_pod_ids, series_id, series_name, series_description,
          series_design, brief_title, touches, does_not_touch, pr_mode, wait_for_merge,
          require_sidecars, auto_approve, disable_ask_human
        ) VALUES (
          @id, @profileName, @task, @status, @model, @runtime, @executionTarget, @branch,
          @userId, @creatorEmail, @creatorName, @maxValidationAttempts, @skipValidation, @acceptanceCriteria,
          @outputMode, @agentMode, @outputTarget, @validate, @promotable,
          @baseBranch, @acFrom, @linkedPodId, @pimGroups, @prUrl,
          @tokenBudget, @referenceRepos, @scheduledJobId,
          @dependsOnPodId, @dependsOnPodIds, @seriesId, @seriesName, @seriesDescription,
          @seriesDesign, @briefTitle, @touches, @doesNotTouch, @prMode, @waitForMerge,
          @requireSidecars, @autoApprove, @disableAskHuman
        )
      `).run({
        id: pod.id,
        profileName: pod.profileName,
        task: pod.task,
        status: pod.status,
        model: pod.model,
        runtime: pod.runtime,
        executionTarget: pod.executionTarget,
        branch: pod.branch,
        userId: pod.userId,
        creatorEmail: pod.creatorEmail ?? null,
        creatorName: pod.creatorName ?? null,
        maxValidationAttempts: pod.maxValidationAttempts,
        skipValidation: pod.skipValidation ? 1 : 0,
        acceptanceCriteria: pod.acceptanceCriteria ? JSON.stringify(pod.acceptanceCriteria) : null,
        outputMode: legacyOutputMode,
        agentMode: podOpts.agentMode,
        outputTarget: podOpts.output,
        validate: podOpts.validate ? 1 : 0,
        promotable: podOpts.promotable ? 1 : 0,
        baseBranch: pod.baseBranch ?? null,
        acFrom: pod.acFrom ?? null,
        linkedPodId: pod.linkedPodId ?? null,
        pimGroups: pod.pimGroups ? JSON.stringify(pod.pimGroups) : null,
        prUrl: pod.prUrl ?? null,
        tokenBudget: pod.tokenBudget ?? null,
        referenceRepos: pod.referenceRepos ? JSON.stringify(pod.referenceRepos) : null,
        scheduledJobId: pod.scheduledJobId ?? null,
        dependsOnPodId: depIds[0] ?? null,
        dependsOnPodIds: depIds.length > 0 ? JSON.stringify(depIds) : null,
        seriesId: pod.seriesId ?? null,
        seriesName: pod.seriesName ?? null,
        seriesDescription: pod.seriesDescription ?? null,
        seriesDesign: pod.seriesDesign ?? null,
        briefTitle: pod.briefTitle ?? null,
        touches: pod.touches && pod.touches.length > 0 ? JSON.stringify(pod.touches) : null,
        doesNotTouch:
          pod.doesNotTouch && pod.doesNotTouch.length > 0 ? JSON.stringify(pod.doesNotTouch) : null,
        prMode: pod.prMode ?? null,
        waitForMerge: pod.waitForMerge ? 1 : 0,
        requireSidecars:
          pod.requireSidecars && pod.requireSidecars.length > 0
            ? JSON.stringify(pod.requireSidecars)
            : null,
        autoApprove: pod.autoApprove ? 1 : 0,
        disableAskHuman: pod.disableAskHuman ? 1 : 0,
      });
    },

    getOrThrow(id: string): Pod {
      const row = db.prepare('SELECT * FROM pods WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row) throw new PodNotFoundError(id);
      return rowToSession(row);
    },

    update(id: string, changes: PodUpdates): void {
      const setClauses: string[] = [];
      const params: Record<string, unknown> = { id };

      if (changes.status !== undefined) {
        setClauses.push('status = @status');
        params.status = changes.status;
      }
      if (changes.task !== undefined) {
        setClauses.push('task = @task');
        params.task = changes.task;
      }
      if (changes.containerId !== undefined) {
        setClauses.push('container_id = @containerId');
        params.containerId = changes.containerId;
      }
      if (changes.worktreePath !== undefined) {
        setClauses.push('worktree_path = @worktreePath');
        params.worktreePath = changes.worktreePath;
      }
      if (changes.validationAttempts !== undefined) {
        setClauses.push('validation_attempts = @validationAttempts');
        params.validationAttempts = changes.validationAttempts;
      }
      if (changes.maxValidationAttempts !== undefined) {
        setClauses.push('max_validation_attempts = @maxValidationAttempts');
        params.maxValidationAttempts = changes.maxValidationAttempts;
      }
      if (changes.lastValidationResult !== undefined) {
        setClauses.push('last_validation_result = @lastValidationResult');
        params.lastValidationResult =
          changes.lastValidationResult !== null
            ? JSON.stringify(changes.lastValidationResult)
            : null;
      }
      if (changes.lastCorrectionMessage !== undefined) {
        setClauses.push('last_correction_message = @lastCorrectionMessage');
        params.lastCorrectionMessage = changes.lastCorrectionMessage;
      }
      if (changes.pendingEscalation !== undefined) {
        setClauses.push('pending_escalation = @pendingEscalation');
        params.pendingEscalation =
          changes.pendingEscalation !== null ? JSON.stringify(changes.pendingEscalation) : null;
      }
      if (changes.escalationCount !== undefined) {
        setClauses.push('escalation_count = @escalationCount');
        params.escalationCount = changes.escalationCount;
      }
      if (changes.startedAt !== undefined) {
        setClauses.push('started_at = @startedAt');
        params.startedAt = changes.startedAt;
      }
      if (changes.completedAt !== undefined) {
        setClauses.push('completed_at = @completedAt');
        params.completedAt = changes.completedAt;
      }
      if (changes.filesChanged !== undefined) {
        setClauses.push('files_changed = @filesChanged');
        params.filesChanged = changes.filesChanged;
      }
      if (changes.linesAdded !== undefined) {
        setClauses.push('lines_added = @linesAdded');
        params.linesAdded = changes.linesAdded;
      }
      if (changes.linesRemoved !== undefined) {
        setClauses.push('lines_removed = @linesRemoved');
        params.linesRemoved = changes.linesRemoved;
      }
      if (changes.previewUrl !== undefined) {
        setClauses.push('preview_url = @previewUrl');
        params.previewUrl = changes.previewUrl;
      }
      if (changes.prUrl !== undefined) {
        setClauses.push('pr_url = @prUrl');
        params.prUrl = changes.prUrl;
      }
      if (changes.mergeBlockReason !== undefined) {
        setClauses.push('merge_block_reason = @mergeBlockReason');
        params.mergeBlockReason = changes.mergeBlockReason;
      }
      if (changes.plan !== undefined) {
        setClauses.push('plan = @plan');
        params.plan = changes.plan !== null ? JSON.stringify(changes.plan) : null;
      }
      if (changes.progress !== undefined) {
        setClauses.push('progress = @progress');
        params.progress = changes.progress !== null ? JSON.stringify(changes.progress) : null;
      }
      if (changes.claudeSessionId !== undefined) {
        setClauses.push('claude_session_id = @claudeSessionId');
        params.claudeSessionId = changes.claudeSessionId;
      }
      if (changes.acceptanceCriteria !== undefined) {
        setClauses.push('acceptance_criteria = @acceptanceCriteria');
        params.acceptanceCriteria =
          changes.acceptanceCriteria !== null ? JSON.stringify(changes.acceptanceCriteria) : null;
      }
      if (changes.lastHeartbeatAt !== undefined) {
        setClauses.push('last_heartbeat_at = @lastHeartbeatAt');
        params.lastHeartbeatAt = changes.lastHeartbeatAt;
      }
      if (changes.recoveryWorktreePath !== undefined) {
        setClauses.push('recovery_worktree_path = @recoveryWorktreePath');
        params.recoveryWorktreePath = changes.recoveryWorktreePath;
      }
      if (changes.reworkReason !== undefined) {
        setClauses.push('rework_reason = @reworkReason');
        params.reworkReason = changes.reworkReason;
      }
      if (changes.reworkCount !== undefined) {
        setClauses.push('rework_count = @reworkCount');
        params.reworkCount = changes.reworkCount;
      }
      if (changes.recoveryCount !== undefined) {
        setClauses.push('recovery_count = @recoveryCount');
        params.recoveryCount = changes.recoveryCount;
      }
      if (changes.inputTokens !== undefined) {
        setClauses.push('input_tokens = @inputTokens');
        params.inputTokens = changes.inputTokens;
      }
      if (changes.outputTokens !== undefined) {
        setClauses.push('output_tokens = @outputTokens');
        params.outputTokens = changes.outputTokens;
      }
      if (changes.costUsd !== undefined) {
        setClauses.push('cost_usd = @costUsd');
        params.costUsd = changes.costUsd;
      }
      if (changes.commitCount !== undefined) {
        setClauses.push('commit_count = @commitCount');
        params.commitCount = changes.commitCount;
      }
      if (changes.lastCommitAt !== undefined) {
        setClauses.push('last_commit_at = @lastCommitAt');
        params.lastCommitAt = changes.lastCommitAt;
      }
      if (changes.startCommitSha !== undefined) {
        setClauses.push('start_commit_sha = @startCommitSha');
        params.startCommitSha = changes.startCommitSha;
      }
      if (changes.linkedPodId !== undefined) {
        setClauses.push('linked_pod_id = @linkedPodId');
        params.linkedPodId = changes.linkedPodId;
      }
      if (changes.taskSummary !== undefined) {
        setClauses.push('task_summary = @taskSummary');
        params.taskSummary =
          changes.taskSummary !== null ? JSON.stringify(changes.taskSummary) : null;
      }
      if (changes.preSubmitReview !== undefined) {
        setClauses.push('pre_submit_review = @preSubmitReview');
        params.preSubmitReview =
          changes.preSubmitReview !== null ? JSON.stringify(changes.preSubmitReview) : null;
      }
      if (changes.validationOverrides !== undefined) {
        setClauses.push('validation_overrides = @validationOverrides');
        params.validationOverrides =
          changes.validationOverrides !== null ? JSON.stringify(changes.validationOverrides) : null;
      }
      if (changes.profileSnapshot !== undefined) {
        setClauses.push('profile_snapshot = @profileSnapshot');
        params.profileSnapshot =
          changes.profileSnapshot !== null ? JSON.stringify(changes.profileSnapshot) : null;
      }
      if (changes.prFixAttempts !== undefined) {
        setClauses.push('pr_fix_attempts = @prFixAttempts');
        params.prFixAttempts = changes.prFixAttempts;
      }
      if (changes.fixIteration !== undefined) {
        setClauses.push('fix_iteration = @fixIteration');
        params.fixIteration = changes.fixIteration;
      }
      if (changes.maxPrFixAttempts !== undefined) {
        setClauses.push('max_pr_fix_attempts = @maxPrFixAttempts');
        params.maxPrFixAttempts = changes.maxPrFixAttempts;
      }
      if (changes.fixPodId !== undefined) {
        setClauses.push('fix_pod_id = @fixPodId');
        params.fixPodId = changes.fixPodId;
      }
      if (changes.lastFixPodSpawnedAt !== undefined) {
        setClauses.push('last_fix_pod_spawned_at = @lastFixPodSpawnedAt');
        params.lastFixPodSpawnedAt = changes.lastFixPodSpawnedAt ?? null;
      }
      if (changes.tokenBudget !== undefined) {
        setClauses.push('token_budget = @tokenBudget');
        params.tokenBudget = changes.tokenBudget ?? null;
      }
      if (changes.budgetExtensionsUsed !== undefined) {
        setClauses.push('budget_extensions_used = @budgetExtensionsUsed');
        params.budgetExtensionsUsed = changes.budgetExtensionsUsed;
      }
      if (changes.pauseReason !== undefined) {
        setClauses.push('pause_reason = @pauseReason');
        params.pauseReason = changes.pauseReason ?? null;
      }
      if (changes.referenceRepos !== undefined) {
        setClauses.push('reference_repos = @referenceRepos');
        params.referenceRepos =
          changes.referenceRepos !== null ? JSON.stringify(changes.referenceRepos) : null;
      }
      if (changes.artifactsPath !== undefined) {
        setClauses.push('artifacts_path = @artifactsPath');
        params.artifactsPath = changes.artifactsPath ?? null;
      }
      if (changes.handoffInstructions !== undefined) {
        setClauses.push('handoff_instructions = @handoffInstructions');
        params.handoffInstructions = changes.handoffInstructions ?? null;
      }
      if (changes.handoffContext !== undefined) {
        setClauses.push('handoff_context = @handoffContext');
        params.handoffContext = changes.handoffContext ?? null;
      }
      if (changes.dependencyStartedAt !== undefined) {
        setClauses.push('dependency_started_at = @dependencyStartedAt');
        params.dependencyStartedAt = changes.dependencyStartedAt ?? null;
      }
      if (changes.baseBranch !== undefined) {
        setClauses.push('base_branch = @baseBranch');
        params.baseBranch = changes.baseBranch ?? null;
      }
      if (changes.waitForMerge !== undefined) {
        setClauses.push('wait_for_merge = @waitForMerge');
        params.waitForMerge = changes.waitForMerge ? 1 : 0;
      }
      if (changes.sidecarContainerIds !== undefined) {
        setClauses.push('sidecar_container_ids = @sidecarContainerIds');
        params.sidecarContainerIds = changes.sidecarContainerIds
          ? JSON.stringify(changes.sidecarContainerIds)
          : null;
      }
      if (changes.testRunBranches !== undefined) {
        setClauses.push('test_run_branches = @testRunBranches');
        params.testRunBranches =
          changes.testRunBranches && changes.testRunBranches.length > 0
            ? JSON.stringify(changes.testRunBranches)
            : null;
      }
      if (changes.worktreeCompromised !== undefined) {
        setClauses.push('worktree_compromised = @worktreeCompromised');
        params.worktreeCompromised = changes.worktreeCompromised ? 1 : 0;
      }
      if (changes.skipValidation !== undefined) {
        setClauses.push('skip_validation = @skipValidation');
        params.skipValidation = changes.skipValidation ? 1 : 0;
      }
      if (changes.forceCompletedAt !== undefined) {
        setClauses.push('force_completed_at = @forceCompletedAt');
        params.forceCompletedAt = changes.forceCompletedAt;
      }
      if (changes.forceCompletedReason !== undefined) {
        setClauses.push('force_completed_reason = @forceCompletedReason');
        params.forceCompletedReason = changes.forceCompletedReason;
      }
      if (changes.lastAgentEventAt !== undefined) {
        setClauses.push('last_agent_event_at = @lastAgentEventAt');
        params.lastAgentEventAt = changes.lastAgentEventAt;
      }
      if (changes.kickedAt !== undefined) {
        setClauses.push('kicked_at = @kickedAt');
        params.kickedAt = changes.kickedAt;
      }
      if (changes.kickedReason !== undefined) {
        setClauses.push('kicked_reason = @kickedReason');
        params.kickedReason = changes.kickedReason;
      }
      if (changes.skipAgent !== undefined) {
        setClauses.push('skip_agent = @skipAgent');
        params.skipAgent = changes.skipAgent ? 1 : 0;
      }
      if (changes.deployBaselineHashes !== undefined) {
        setClauses.push('deploy_baseline_hashes = @deployBaselineHashes');
        params.deployBaselineHashes =
          changes.deployBaselineHashes !== null
            ? JSON.stringify(changes.deployBaselineHashes)
            : null;
      }
      if (changes.options !== undefined) {
        // Keep legacy output_mode synced with the new orthogonal columns so
        // older readers (desktop client, etc.) continue to see a valid value.
        setClauses.push(
          'agent_mode = @agentMode',
          'output_target = @outputTarget',
          'validate = @validate',
          'promotable = @promotable',
          'output_mode = @outputMode',
        );
        params.agentMode = changes.options.agentMode;
        params.outputTarget = changes.options.output;
        params.validate = changes.options.validate ? 1 : 0;
        params.promotable = changes.options.promotable ? 1 : 0;
        params.outputMode = outputModeFromPodOptions(changes.options);
      }

      if (setClauses.length === 0) return;

      // Always update the timestamp
      setClauses.push('updated_at = @updatedAt');
      params.updatedAt = new Date().toISOString();

      const result = db
        .prepare(`UPDATE pods SET ${setClauses.join(', ')} WHERE id = @id`)
        .run(params);

      if (result.changes === 0) throw new PodNotFoundError(id);
    },

    list(filters?: PodFilters): Pod[] {
      const whereClauses: string[] = [];
      const params: Record<string, unknown> = {};

      if (filters?.profileName !== undefined) {
        whereClauses.push('profile_name = @profileName');
        params.profileName = filters.profileName;
      }
      if (filters?.status !== undefined) {
        whereClauses.push('status = @status');
        params.status = filters.status;
      }
      if (filters?.userId !== undefined) {
        whereClauses.push('user_id = @userId');
        params.userId = filters.userId;
      }

      const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM pods ${where} ORDER BY created_at DESC`)
        .all(params) as Record<string, unknown>[];

      return rows.map(rowToSession);
    },

    listNonTerminalPodIds(): string[] {
      const rows = db
        .prepare("SELECT id FROM pods WHERE status NOT IN ('complete', 'killed')")
        .all() as { id: string }[];
      return rows.map((r) => r.id);
    },

    delete(id: string): void {
      // Null out self-referential FKs from other pods before deleting.
      // These were added without ON DELETE SET NULL (SQLite can't ALTER COLUMN),
      // so we nullify them at the application level.
      db.prepare('UPDATE pods SET linked_pod_id = NULL WHERE linked_pod_id = ?').run(id);
      db.prepare('UPDATE pods SET fix_pod_id = NULL WHERE fix_pod_id = ?').run(id);
      db.prepare('UPDATE pods SET depends_on_pod_id = NULL WHERE depends_on_pod_id = ?').run(id);
      // Remove the deleted pod from any dependsOnPodIds arrays.
      db.prepare(
        `UPDATE pods
         SET depends_on_pod_ids = (
           SELECT json_group_array(value) FROM json_each(depends_on_pod_ids)
           WHERE value != ?
         )
         WHERE depends_on_pod_ids IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM json_each(depends_on_pod_ids) WHERE json_each.value = ?
           )`,
      ).run(id, id);
      const result = db.prepare('DELETE FROM pods WHERE id = ?').run(id);
      if (result.changes === 0) throw new PodNotFoundError(id);
    },

    countByStatusAndProfile(status: PodStatus, profileName: string): number {
      const row = db
        .prepare(
          'SELECT COUNT(*) as count FROM pods WHERE status = @status AND profile_name = @profileName',
        )
        .get({ status, profileName }) as { count: number };
      return row.count;
    },

    getStats(filters?: { profileName?: string }): PodStats {
      const where = filters?.profileName !== undefined ? 'WHERE profile_name = @profileName' : '';
      const params = filters?.profileName !== undefined ? { profileName: filters.profileName } : {};

      const rows = db
        .prepare(`SELECT status, COUNT(*) as count FROM pods ${where} GROUP BY status`)
        .all(params) as { status: PodStatus; count: number }[];

      const allStatuses: PodStatus[] = [
        'queued',
        'provisioning',
        'running',
        'awaiting_input',
        'validating',
        'validated',
        'failed',
        'review_required',
        'approved',
        'merging',
        'merge_pending',
        'complete',
        'paused',
        'handoff',
        'killing',
        'killed',
      ];
      const byStatus = Object.fromEntries(allStatuses.map((s) => [s, 0])) as Record<
        PodStatus,
        number
      >;

      let total = 0;
      for (const row of rows) {
        byStatus[row.status] = row.count;
        total += row.count;
      }

      return { total, byStatus };
    },

    getPodsDependingOn(podId: string): Pod[] {
      // Match either the legacy single column or membership in the new JSON
      // array. Using EXISTS on json_each handles fan-in (multi-parent) rows.
      const rows = db
        .prepare(
          `SELECT * FROM pods
           WHERE depends_on_pod_id = ?
              OR (depends_on_pod_ids IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM json_each(depends_on_pod_ids)
                    WHERE json_each.value = ?
                  ))
           ORDER BY created_at ASC`,
        )
        .all(podId, podId) as Record<string, unknown>[];
      return rows.map(rowToSession);
    },

    getPodsBySeries(seriesId: string): Pod[] {
      const rows = db
        .prepare('SELECT * FROM pods WHERE series_id = ? ORDER BY created_at ASC')
        .all(seriesId) as Record<string, unknown>[];
      return rows.map(rowToSession);
    },
  };
}
