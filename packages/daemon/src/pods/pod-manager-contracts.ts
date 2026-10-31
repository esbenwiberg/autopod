import type { PendingRequests } from '@autopod/escalation-mcp';
import type {
  AgentEvent,
  CreatePodRequest,
  DaemonConfig,
  EffectiveLaunchConfig,
  EscalationRequest,
  ExecutionTarget,
  HistoryQuery,
  InjectedMcpServer,
  OperatorActor,
  Pod,
  PodStatus,
  ProviderCredentials,
  ProviderFailoverTarget,
  PublicProviderCatalog,
  SpawnFixResponse,
  TaskRetryIdentity,
  UpdateFromBaseResponse,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { ActionAuditRepository } from '../actions/audit-repository.js';
import type { LaunchExecutionCredentials } from '../configuration/execution-credentials.js';
import type { SidecarManager } from '../containers/sidecar-manager.js';
import type { PodTokenIssuer } from '../crypto/pod-tokens.js';
import type { DaemonGitHubAuth } from '../github/daemon-github-auth.js';
import type {
  ContainerManager,
  PrManager,
  RuntimeRegistry,
  ValidationEngine,
  WorktreeManager,
} from '../interfaces/index.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { ProfileStore } from '../profiles/index.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import type {
  SandboxWorkspaceCheckpointArgs,
  WorkspaceCheckpointResult,
} from '../worktrees/sandbox-workspace-checkpoint.js';
import type { AgentRunOutcome } from './agent-execution-contracts.js';
import type { ApproveAllSkippedPod, ApproveSessionOptions } from './approval-contracts.js';
import type { ArtifactResumeObservation } from './artifact-resume-observation.js';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventBus } from './event-bus.js';
import type { EventRepository } from './event-repository.js';
import type { FixFeedbackRepository } from './fix-feedback-repository.js';
import type { NudgeRepository } from './nudge-repository.js';
import type { PodRepository, PodStats } from './pod-repository.js';
import type { ProgressEventRepository } from './progress-event-repository.js';
import type { ProviderAttemptRepository } from './provider-attempt-repository.js';
import type { QualityScoreRepository } from './quality-score-repository.js';
import type { NetworkManager } from './resource-contracts.js';
import type { ValidationRepository } from './validation-repository.js';
import type { WorkspaceCheckpointController } from './workspace-checkpoint-controller.js';
import type { PodCreator } from './workspace-contracts.js';
export interface ContainerManagerFactory {
  get(target: ExecutionTarget): ContainerManager;
}

export interface PodManagerDependencies {
  podRepo: PodRepository;
  providerAttemptRepo?: ProviderAttemptRepository;
  escalationRepo: EscalationRepository;
  nudgeRepo: NudgeRepository;
  /** Queue of feedback messages drained into the next fix-pod iteration. */
  fixFeedbackRepo: FixFeedbackRepository;
  validationRepo?: ValidationRepository;
  progressEventRepo?: ProgressEventRepository;
  profileStore: ProfileStore;
  /** Immutable launch projection. Legacy pods return null during the cutover period. */
  launchConfiguration?: {
    read(podId: string): EffectiveLaunchConfig | null;
    executionSettings(config: EffectiveLaunchConfig): PodExecutionSettings;
    assertCurrentCapabilities(config: EffectiveLaunchConfig): Promise<void>;
    prepareEnvironment(config: EffectiveLaunchConfig): Promise<string>;
    beginGoalRework?(
      podId: string,
      task: string,
      apply: (config: EffectiveLaunchConfig) => void,
    ): Promise<void>;
    admitDerived?(
      input: import('../configuration/derive-launch.js').DerivedLaunchInput,
      createPod: (config: EffectiveLaunchConfig) => string,
    ): Promise<string>;
    prepareWorker?(
      input: import('../configuration/derive-launch.js').DerivedLaunchInput,
      apply: (config: EffectiveLaunchConfig) => void,
    ): Promise<void>;
    activateWorker?(
      podId: string,
      generation: number,
      apply: (config: EffectiveLaunchConfig) => void,
    ): Promise<boolean>;
    credentials?: LaunchExecutionCredentials;
    pim?: import('../pim/pod-lifecycle.js').PimPodLifecycle;
    reviewer?: import('../validation/isolated-reviewer.js').IsolatedReviewer;
    goals?: import('./pod-goal-service.js').PodGoalService;
  };
  /** Canonical credential source for every GitHub operation. Legacy profile PATs are ignored. */
  githubAuth?: DaemonGitHubAuth;
  /** Canonical credential source for every Azure DevOps operation. */
  azureDevOpsAuth?: import('../providers/azure-devops-auth.js').AzureDevOpsAuth;
  providerAccountStore?: ProviderAccountStore;
  /** Validated catalog override for deterministic manifest-only conformance tests. */
  providerCatalog?: PublicProviderCatalog;
  eventBus: EventBus;
  containerManagerFactory: ContainerManagerFactory;
  worktreeManager: WorktreeManager;
  runtimeRegistry: RuntimeRegistry;
  validationEngine: ValidationEngine;
  networkManager?: NetworkManager;
  /** Optional sidecar orchestrator. Pods that set `requireSidecars` need this;
   *  pods that don't aren't affected by its absence. */
  sidecarManager?: SidecarManager;
  /** Factory returning the appropriate PrManager for a given profile. Return null to skip PR creation. */
  prManagerFactory?: (profile: PodExecutionSettings) => PrManager | null;
  actionEngine?: {
    getAvailableActions: (
      policy: import('@autopod/shared').ActionPolicy,
    ) => import('@autopod/shared').ActionDefinition[];
  };
  actionAuditRepo?: ActionAuditRepository;
  eventRepo?: EventRepository;
  memoryRepo?: import('./memory-repository.js').MemoryRepository;
  memoryUsageRepo?: import('./memory-usage-repository.js').MemoryUsageRepository;
  beforeContainerCleanup?: (podId: string) => Promise<void>;
  pendingOverrideRepo?: import('./pending-override-repository.js').PendingOverrideRepository;
  enqueueSession: (podId: string) => void;
  /** Queue-safe self-requeue used from inside the current processPod run. */
  requeueSessionAfterCurrent?: (podId: string) => void;
  /**
   * Operator-only: clear a stale `activeIds` entry from the queue. Used by
   * `kickPod` to recover from the stuck-queued bug where a previous run's
   * finally never cleaned up, leaving `enqueue` to silently dedup forever.
   * Returns `true` if the entry was cleared.
   */
  clearStuckQueueEntry?: (podId: string) => boolean;
  mcpBaseUrl: string;
  daemonConfig: Pick<DaemonConfig, 'mcpServers' | 'claudeMdSections' | 'skills'>;
  /** Pending MCP ask_human requests keyed by podId — used to resolve escalations */
  pendingRequestsByPod?: Map<string, PendingRequests>;
  /** Used to generate a pod-scoped Bearer token injected into the container so it can
   * authenticate calls to the /mcp/:podId endpoint. Optional for backwards compat. */
  sessionTokenIssuer?: PodTokenIssuer;
  /** Resolve environment variable or secret by name (e.g. AZURE_GRAPH_TOKEN). */
  getSecret: (ref: string) => string | undefined;
  /** Optional ACR manifest preflight for sandbox warm images. */
  warmImageExists?: (tag: string) => Promise<boolean>;
  /** Optional repo content scanner — runs at provisioning to flag secrets/PII/injection. */
  repoScanner?: import('../security/index.js').RepoScanner;
  /** Optional scan repository — used to query the latest push scan when building PR bodies. */
  scanRepo?: import('../security/index.js').ScanRepository;
  /** On-disk screenshot store. Smoke screenshots are written here after validation. */
  screenshotStore?: import('./screenshot-store.js').ScreenshotStore;
  /** Resolve the host Playwright screenshot directory for a pod. */
  hostScreenshotDir?: (podId: string) => string;
  /** Test hook for shrinking review infrastructure retry delays. */
  reviewInfrastructureRetryBackoffMs?: readonly number[];
  /** Test seam for the sandbox checkpoint transport. Production uses the Git-native primitive. */
  sandboxWorkspaceCheckpoint?: (
    args: SandboxWorkspaceCheckpointArgs,
  ) => Promise<WorkspaceCheckpointResult>;
  workspaceCheckpointController?: WorkspaceCheckpointController;
  /** Trusted identity capture seam; production captures actual container inputs. */
  captureRetryIdentity?: (
    config: Parameters<ValidationEngine['validate']>[0],
  ) => Promise<TaskRetryIdentity>;
  /** Task-wide automatic retries for typed validation infrastructure failures. */
  validationInfrastructureRetryBackoffMs?: readonly number[];
  /** Test seam for the durable fresh-sandbox recovery cooldown. */
  sandboxInfrastructureRecoveryDelay?: (delayMs: number) => Promise<void>;
  /** Persisted task-wide sandbox startup policy; defaults to one 30-second retry. */
  sandboxInfrastructureRetryBackoffMs?: readonly number[];
  /** Persisted task-wide allowance for classified outer worker infrastructure retries. */
  workerInfrastructureRetryBackoffMs?: readonly number[];
  /** Test seam for the persisted worker cooldown. */
  workerInfrastructureRetryDelay?: (delayMs: number) => Promise<void>;
  /** Test seam for bounding best-effort sandbox runtime-session extraction. */
  sandboxRuntimeSessionSyncTimeoutMs?: number;
  /** Safety events repository for writing per-pattern detection rows. */
  safetyEventsRepo?: import('../safety/safety-events-repository.js').SafetyEventsRepository;
  /** Persisted behavioural quality scores used by Readiness Review when available. */
  qualityScoreRepo?: QualityScoreRepository;
  logger: Logger;
}

export interface PodManager {
  acceptFindings(
    podId: string,
    request: import('./research-findings.js').AcceptFindingsRequest,
    actor: OperatorActor,
  ): Promise<NonNullable<Pod['researchFindings']>>;
  adoptSource?(
    podId: string,
    input: import('./source-adoption-controller.js').SourceAdoptionRequest,
    actor: OperatorActor,
  ): Promise<import('./source-adoption-types.js').SourceAdoptionState>;
  getSourceAdoptions?(podId: string): import('./source-adoption-types.js').SourceAdoptionState[];
  getLaunchConfiguration?(podId: string): EffectiveLaunchConfig | null;
  createResolvedSession?(
    config: EffectiveLaunchConfig,
    userId: string,
    creator?: PodCreator,
    actor?: OperatorActor,
  ): Pod;
  createSession(
    request: CreatePodRequest,
    userId: string,
    creator?: PodCreator,
    actor?: OperatorActor,
  ): Pod;
  processPod(podId: string): Promise<void>;
  resumeNativeGoal?(podId: string, revision: number): Promise<void>;
  consumeAgentEvents(
    podId: string,
    events: AsyncIterable<AgentEvent>,
    attempt?: number,
    lifecycle?: { generation: number; containerId: string | null; nativeGoal?: boolean },
  ): Promise<AgentRunOutcome>;
  handleCompletion(podId: string): Promise<void>;
  getArtifactResumeObservation?(podId: string): ArtifactResumeObservation;
  preserveWorkspace(podId: string, reason?: string): Promise<void>;
  quiesceSandboxAgent(podId: string): Promise<void>;
  suspendSandboxForRecovery(podId: string): Promise<void>;
  cleanupPodResourcesForRecovery(podId: string): Promise<void>;
  sendMessage(podId: string, message: string, actor?: OperatorActor): Promise<void>;
  notifyEscalation(podId: string, escalation: EscalationRequest): void;
  touchHeartbeat(podId: string): void;
  getReviewerConfig(pod: Pod): {
    profile: PodExecutionSettings;
    credentials: ProviderCredentials | null;
  };
  getReviewerExecEnv(pod: Pod): Promise<Record<string, string> | undefined>;
  getProjectMemoryScope(pod: Pod): import('./project-memory-scope.js').ProjectMemoryScope;
  getLaunchMemoryContext(pod: Pod): {
    profile: PodExecutionSettings;
    projectScope: import('./project-memory-scope.js').ProjectMemoryScope;
    reviewer: import('../providers/memory-reviewer.js').MemoryReviewer;
  };
  getReviewerExecutor(
    pod: Pod,
  ): import('../interfaces/reviewer-executor.js').ReviewerExecutor | undefined;
  approveSession(podId: string, options?: ApproveSessionOptions): Promise<void>;
  rejectSession(podId: string, reason?: string, actor?: OperatorActor): Promise<void>;
  approveAllValidated(): Promise<{ approved: string[]; skipped: ApproveAllSkippedPod[] }>;
  killAllFailed(): Promise<{ killed: string[] }>;
  extendAttempts(podId: string, additionalAttempts: number): Promise<void>;
  /** Apply queued overrides to the last validation result without re-running validation.
   *  If overrides make the result pass, transitions review_required → validated. */
  applyOverridesInstant(podId: string): Promise<{ advanced: boolean }>;
  /** Approve a pending required-fact waiver, then re-run validation-only flow. */
  approveFactWaiver(
    podId: string,
    factId: string,
    reason?: string,
    actor?: OperatorActor,
  ): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }>;
  /** Bypass validation and transition the pod directly to validated.
   *  Valid from failed or review_required. The pod then awaits normal approval. */
  forceApprove(podId: string, reason?: string, actor?: OperatorActor): Promise<void>;
  extendPrAttempts(podId: string, additionalAttempts: number): Promise<void>;
  pauseSession(podId: string): Promise<void>;
  nudgeSession(podId: string, message: string): void;
  killSession(podId: string): Promise<void>;
  completeSession(
    podId: string,
    options?: {
      promoteTo?: 'pr' | 'branch' | 'artifact' | 'none';
      instructions?: string;
      /** When true, promote without spawning the agent — go straight to validation/PR
       *  with the human's work as-is. Requires a promotion target (pr/artifact). */
      skipAgent?: boolean;
    },
  ): Promise<{ pushError?: string; promotedTo?: 'pr' | 'branch' | 'artifact' | 'none' }>;
  /**
   * Sync a running interactive workspace's branch to origin without changing
   * pod state — used when the desktop wants to spawn a series from briefs that
   * live in the workspace's worktree. Mirrors the sync+commit+push of
   * `completeSession` but skips worktree cleanup and the `complete` transition,
   * so the user can keep iterating after the handoff. Best-effort: errors are
   * surfaced in the return value rather than thrown so the caller can still
   * fall through to a folder-based brief preview.
   */
  syncWorkspaceBranch(podId: string): Promise<{
    committed: boolean;
    pushed: boolean;
    error?: string;
  }>;
  /** Promote an interactive pod to auto on the same pod ID.
   *  `options.instructions` is the raw human-typed handoff text from the desktop sheet
   *  (or `--instructions` on the CLI); persisted as `handoffInstructions` and consumed
   *  by the recovery restart to compose the agent-facing `## Handoff` section.
   *  `options.skipAgent` skips agent spawn entirely — pod goes straight to validation. */
  promoteToAuto(
    podId: string,
    targetOutput: 'pr' | 'branch' | 'artifact' | 'none',
    options?: { instructions?: string; skipAgent?: boolean },
  ): Promise<void>;
  /** Check worker retry permission before Rework can tear down or enqueue resources. */
  assertCanRework(podId: string): void;
  assertCanRetryValidation(podId: string): void;
  triggerValidation(
    podId: string,
    options?: { force?: boolean; validationOnly?: boolean },
  ): Promise<void>;
  /** Pull latest from remote branch and re-run validation without agent rework on failure.
   *  Used after human fixes via a linked workspace pod.
   *  Pass `{ force: true }` to skip the no-new-commits early-exit — used by Resume
   *  when the operator suspects validation crashed on infra rather than on real
   *  findings. */
  revalidateSession(
    podId: string,
    options?: { force?: boolean; checksOnly?: boolean },
  ): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }>;
  /** Create a linked workspace pod on the same branch as a failed worker pod for human fixes. */
  fixManually(
    podId: string,
    actor: OperatorActor | string,
    creator?: PodCreator,
    instructions?: string,
  ): Promise<Pod>;
  createHistoryWorkspace(
    profileName: string,
    userId: string,
    historyQuery: HistoryQuery,
    creator?: PodCreator,
  ): Pod;
  createMemoryWorkspace(profileName: string, userId: string, creator?: PodCreator): Pod;
  deleteSession(podId: string): Promise<void>;
  startPreview(podId: string): Promise<{ previewUrl: string }>;
  stopPreview(podId: string): Promise<void>;
  previewStatus(podId: string): Promise<{
    running: boolean;
    reachable: boolean;
    restartCount: number;
    lastError: string | null;
    previewUrl: string | null;
  }>;
  getSession(podId: string): Pod;
  getExternalDelivery(podId: string): import('@autopod/shared').ExternalDeliveryReceipt | null;
  /** Refresh terminal readiness after dependent quality telemetry is persisted. */
  refreshReadinessAfterQualityScore(podId: string): boolean;
  listSessions(filters?: {
    profileName?: string;
    status?: PodStatus | PodStatus[];
    userId?: string;
    limit?: number;
    since?: string;
    before?: { createdAt: string; id: string };
  }): Pod[];
  getSessionStats(filters?: { profileName?: string }): PodStats;
  getValidationHistory(podId: string): import('./validation-repository.js').StoredValidation[];
  /**
   * Resolve the *real* injected MCP server configs for a pod — daemon-wide
   * defaults merged with the pod profile's servers, with original URLs and
   * auth headers preserved. Consumed by the MCP proxy handler to forward
   * requests on the agent's behalf.
   */
  getInjectedMcpServers(podId: string): InjectedMcpServer[];
  getInjectedMcpServer?(podId: string, name: string): Promise<InjectedMcpServer | undefined>;
  getValidationEnvironment?(podId: string): Promise<Record<string, string> | undefined>;
  getDeploymentConfiguration?(podId: string): Promise<PodExecutionSettings['deployment']>;
  /**
   * Re-apply network policy to all running local containers using the given profile.
   * Called after a profile's networkPolicy is updated via the API.
   * Fire-and-forget safe — errors are logged but do not propagate.
   */
  refreshNetworkPolicy(profileName: string): Promise<void>;
  /** Abort a currently running validation for the given pod. No-op if not validating. */
  interruptValidation(podId: string): void;
  /** Toggle skip-validation at runtime. When true, the next validation result is bypassed → validated. */
  setSkipValidation(podId: string, skip: boolean, actor?: OperatorActor): void;
  /**
   * Inject provider credentials directly into a running container without exposing the token.
   * Reads the PAT from the profile, runs the auth command inside the container, and deletes
   * the temp credential file. Safe to call from user-initiated flows (workspace pods, CLI).
   */
  injectCredential(podId: string, service: 'github' | 'ado'): Promise<void>;
  /** Install gh or az CLI into a running pod container without touching credentials. */
  installCliTool(podId: string, tool: 'gh' | 'az'): Promise<void>;
  /**
   * Manually queue a fix-feedback message for a `merge_pending` pod and ask
   * `maybeSpawnFixSession` to spawn/recycle the canonical fix pod. The message
   * is enqueued onto the parent's fix-feedback queue and built into the fix
   * pod's task when it transitions to `running`. Bumps maxPrFixAttempts if the
   * current cap would otherwise block the spawn. Throws 409 for terminal or
   * fix-pod parents.
   */
  spawnFixSession(podId: string, userMessage?: string): Promise<void>;
  /**
   * Queue-driven fix-pod request used by the HTTP API. Enqueues `message` onto
   * the parent's fix-feedback queue and asks `maybeSpawnFixSession` to
   * spawn/recycle the canonical fix pod if needed. Returns the resulting queue
   * state. A terminal parent yields `{ ok: false, reason: 'parent_terminal' }`
   * rather than throwing; a missing parent throws `PodNotFoundError` (404) and
   * a fix pod passed as parent throws `AutopodError` (409).
   */
  requestFixSession(podId: string, message: string): Promise<SpawnFixResponse>;
  /**
   * Rebase an eligible pod branch onto the latest origin/<baseBranch> and restart
   * validation. Eligible statuses: `validating`, `failed`, `review_required`.
   * For `validating` pods, aborts current validation and queues the update intent;
   * the unwind runs the rebase before sending correction feedback.
   * Returns a typed outcome — does not wait for follow-up validation to complete.
   */
  updateFromBase(podId: string): Promise<UpdateFromBaseResponse>;
  /**
   * Retry PR creation for a complete pod whose PR was never successfully created.
   * Updates prUrl on success. Throws if the pod is not complete or already has a PR.
   */
  retryCreatePr(podId: string): Promise<void>;
  getValidationExecutionRecovery: ReturnType<
    typeof import('./validation-execution-recovery.js').createValidationExecutionRecovery
  >['getValidationExecutionRecovery'];
  readValidationEvidence: ReturnType<
    typeof import('./validation-execution-recovery.js').createValidationExecutionRecovery
  >['readValidationEvidence'];
  reconcileValidationExecution: ReturnType<
    typeof import('./validation-execution-recovery.js').createValidationExecutionRecovery
  >['reconcileValidationExecution'];
  authorizeValidationRecoveryBudget: ReturnType<
    typeof import('./validation-execution-recovery.js').createValidationExecutionRecovery
  >['authorizeValidationRecoveryBudget'];
  reconcileTermination(
    podId: string,
    runId: string,
    reason: string,
    actor: OperatorActor,
  ): Promise<import('@autopod/shared').TerminationReconciliationReceipt>;
  /**
   * Operator escape hatch for `failed` pods: advance the pod from where it died
   * without re-running the agent. Picks the cheapest action that fits the pod's
   * state — push + open PR if validation passed, re-validate if validation
   * failed on infra. Throws when the pod isn't in a recoverable state.
   */
  resumePod(podId: string): Promise<{
    action: 'retry-pr' | 'revalidate' | 'retry-fix-delivery' | 'retry-agent' | 'collect-artifacts';
  }>;
  /**
   * Continue a provider-limit pause, or explicitly recover a failed pod on the
   * profile's current primary provider, through normal provisioning.
   */
  continueProvider(
    podId: string,
    target?: ProviderFailoverTarget | 'profile-primary',
    actor?: OperatorActor,
  ): Promise<{ action: 'same-provider' | 'alternate-provider' | 'primary-provider' }>;
  /**
   * Operator admin override: force-transition a `failed` pod to `complete`,
   * skipping push, PR creation, and validation. Persists `forceCompletedAt`
   * + reason on the pod row for audit.
   */
  forceComplete(podId: string, reason?: string, actor?: OperatorActor): Promise<void>;
  /**
   * Operator escape hatch to unstick a pod. On `queued` pods (e.g. if the queue
   * silently lost track), re-enqueues without state change. On `running` /
   * `provisioning` pods, kills the container best-effort and transitions to
   * `failed` so the slot frees up — the pod is then recoverable via
   * `resume` / `force-complete`. Persists `kickedAt` + reason for audit.
   */
  kickPod(
    podId: string,
    reason?: string,
    actor?: OperatorActor,
  ): Promise<{ action: 'requeued' | 'failed' }>;
  /**
   * Start the global watchdog that detects `running` pods whose agent stream has
   * gone silent for longer than the configured threshold and transitions them to
   * `failed`. Called once from the daemon entrypoint. Idempotent.
   */
  startStuckPodWatchdog(options?: { intervalMs?: number; thresholdMs?: number }): void;
  /** Stop the stuck-pod watchdog (used in tests / shutdown). */
  stopStuckPodWatchdog(): void;
  /** Return all pods belonging to a series, ordered by creation time. */
  getSeriesPods(seriesId: string): Pod[];
  /**
   * Re-trigger any `queued` dependent pods whose all parents have already
   * reached a terminal-success state (validated/approved/complete/etc.).
   * Call on daemon startup to recover series that got stuck across restarts
   * or due to a missing `maybeTriggerDependents` call.
   */
  rehydrateDependentSessions(): void;
  /**
   * Attempt to recover a pod whose worktree was marked compromised by the deletion guard.
   * Pulls files from the container (which must still be running), repopulates the worktree,
   * and retries the auto-commit. Clears `worktreeCompromised` on success.
   */
  recoverWorktree(podId: string): Promise<{
    recovered: boolean;
    message: string;
    blockers?: Array<{ status: string; path: string }>;
    checkpoint?: WorkspaceCheckpointResult;
  }>;
}
