import { createProvisioningMaterials } from './provisioning-materials.js';
import {
  AGENT_ENV_PATH,
  AGENT_SHIM_PATH,
  AGENT_SHIM_SCRIPT,
  buildCodeIntelligenceServers,
} from './provisioning-runtime-files.js';
import { createProvisioningSandboxState } from './provisioning-sandbox-state.js';
import { createProvisioningToolInstallation } from './provisioning-tool-installation.js';
import { createProvisioningWorkflow } from './provisioning-workflow.js';
export {
  AGENT_SHIM_PATH,
  AGENT_ENV_PATH,
  AGENT_SHIM_SCRIPT,
} from './provisioning-runtime-files.js';
import { execFile } from 'node:child_process';

import path from 'node:path';
import { promisify } from 'node:util';
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

import { createContinuationContext } from './continuation-context.js';
import { createContinuationControls } from './continuation-controls.js';
import { buildManualReworkReason } from './continuation-policy.js';
import { createProviderAttemptContext } from './provider-attempt-context.js';
import { resolvedReasoningEffort } from './provider-attempt-policy.js';
import { createProviderContinuation } from './provider-continuation.js';
import { createValidationRevalidationWorkflow } from './validation-revalidation-workflow.js';
import { createValidationTriggerWorkflow } from './validation-trigger-workflow.js';
import { createValidationWorkflowControls } from './validation-workflow-controls.js';
import {
  assertProtectedOperationalPathsInScope,
  getPodValidationSkipPhases,
  getPodValidationSuite,
  loadCodeReviewSkill,
  makeUnexpectedValidationFailureResult,
} from './validation-workflow-policy.js';
import { createValidationWorkflowState } from './validation-workflow-state.js';

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
import { createAdvisoryValidation } from './advisory-validation.js';

import { createArtifactFinalizer } from './artifact-finalizer.js';
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

import { createReviewerContext } from './reviewer-context.js';

import { createRuntimeResumeContext } from './runtime-resume-context.js';

import { createValidationAttemptStart } from './validation-attempt-start.js';
import { createValidationEnvironment } from './validation-environment.js';
import { createValidationEvidence } from './validation-evidence.js';
import { createValidationExecution } from './validation-execution.js';
import {
  createValidationInfrastructure,
  isReviewInfrastructureOnlyFailure,
  reviewInfrastructureFailureLabel,
  validationInfrastructureFailureLabel,
} from './validation-infrastructure.js';
import { createValidationInputs } from './validation-inputs.js';

import { createValidationProgress } from './validation-progress.js';
import { createValidationProvenance } from './validation-provenance.js';
import { createValidationPublication } from './validation-publication.js';
import type { ValidationRepository } from './validation-repository.js';
import { createValidationWorkspace } from './validation-workspace.js';
import { createWorkerRuntimeCredentials } from './worker-runtime-credentials.js';
import type { WorkspaceCheckpointController } from './workspace-checkpoint-controller.js';
import { createWorkspacePreservation } from './workspace-preservation.js';

import { createAgentActivity } from './agent-activity.js';
import { createAgentEventConsumption } from './agent-event-consumption.js';
import type { AgentRunOutcome } from './agent-execution-contracts.js';

import { createAgentProcessWorkflow } from './agent-process-workflow.js';
import { createAgentRunRegistry } from './agent-run-registry.js';
import type { ApproveAllSkippedPod, ApproveSessionOptions } from './approval-contracts.js';
import { createApprovalControls } from './approval-controls.js';
import { createApprovalDeliveryExecution } from './approval-delivery-execution.js';
import { createApprovalDeliveryPreparation } from './approval-delivery-preparation.js';
import { actorLabel, buildValidationWaiver, legacyRespondedBy } from './approval-policy.js';
import { createApprovalReadiness, createReadinessRefresh } from './approval-readiness.js';
import { createApprovalWorkflow } from './approval-workflow.js';
import {
  formatElapsedDuration,
  operatorErrorMessage,
  sanitizeFailureReason,
  summarizeAgentCompletionBlocker,
} from './completion-diagnostics.js';

import { createCompletionDiagnostics } from './completion-diagnostics.js';
import { createCompletionEvents } from './completion-events.js';
import { createCompletionGuards } from './completion-guards.js';
import { createCompletionOwners, createCompletionWorkflow } from './completion-workflow.js';
import { createDeliveryCredentials } from './delivery-credentials.js';
import {
  formatRebaseConflictReason,
  isSinglePrSeriesPod,
  resolvePrBaseBranch,
} from './delivery-policy.js';
import { createDeliveryPolling } from './delivery-polling.js';
import { createDeliveryPr } from './delivery-pr.js';
import { createDeliveryScan } from './delivery-scan.js';
import {
  createDeliveryMergeQueue,
  createDeliveryPollingState,
  createDeliveryProvider,
} from './delivery-state.js';
import {
  buildActionableFailureSummary,
  buildPrFixTask,
  createFixCyclePolicy,
} from './fix-policy.js';
import { createRevalidationPassDelivery } from './revalidation-pass-delivery.js';
import { createValidationPassDelivery } from './validation-pass-delivery.js';
import { createWorkspaceTransfer } from './workspace-transfer.js';
export { buildPrFixTask, buildActionableFailureSummary } from './fix-policy.js';
import { createFixAdmission } from './fix-admission.js';
import { createFixControls } from './fix-controls.js';
import { createFixDelivery } from './fix-delivery.js';
import { createFixFeedback } from './fix-feedback.js';
import { createFixParking } from './fix-parking.js';
import { createFixProviderBinding } from './fix-provider-binding.js';

import { createOperatorControls } from './operator-controls.js';
import { createOperatorKill } from './operator-kill.js';
import { createOperatorMessages } from './operator-messages.js';
import { createOperatorPause } from './operator-pause.js';
import { createOperatorRejection } from './operator-rejection.js';
import { createOperatorPauseState } from './operator-state.js';
import { createOperatorTools } from './operator-tools.js';
import type { NetworkManager } from './resource-contracts.js';
import {
  CONTAINER_APP_PORT,
  CONTAINER_CLEANUP_TIMEOUT_MS,
  allocateHostPort,
  hostnameFromUrl,
  portFromUrl,
} from './resource-policy.js';
export type { NetworkManager } from './resource-contracts.js';
import { createResourceAdvisoryCleanup, createResourceAdvisoryState } from './resource-advisory.js';
import { createResourceAuxiliary } from './resource-auxiliary.js';
import { createResourceCleanup } from './resource-cleanup.js';
import {
  createResourceCommitPolling,
  createResourceCommitPollingState,
} from './resource-commit-polling.js';
import { createResourceDenials } from './resource-denials.js';
import { createResourceNetwork } from './resource-network.js';
import { createResourcePreviewControls } from './resource-preview-controls.js';
import { createResourcePreviewTimers } from './resource-preview-timers.js';
import { createResourcePreview } from './resource-preview.js';
import type { PodCreator } from './workspace-contracts.js';
export type { PodCreator } from './workspace-contracts.js';
import { mergeOverrides, warnIfSinglePrSeriesMissingSeriesMeta } from './admission-policy.js';
import { createWorkspaceArtifactObservation } from './workspace-artifact-observation.js';
import { createWorkspaceBranchSource } from './workspace-branch-source.js';
import { createWorkspaceBranchSync } from './workspace-branch-sync.js';
import { createWorkspaceCompletion } from './workspace-completion.js';
import { createWorkspaceDeletion } from './workspace-deletion.js';
import { createWorkspaceEscapeControls } from './workspace-escape-controls.js';
import { createWorkspaceFences } from './workspace-fences.js';
import { createWorkspaceHostFetchRetry } from './workspace-host-fetch-retry.js';
import { createWorkspaceInfrastructureRecovery } from './workspace-infrastructure-recovery.js';
import { createWorkspaceManualFix } from './workspace-manual-fix.js';
import { createWorkspacePreservationRecovery } from './workspace-preservation-recovery.js';
import { createWorkspacePromotion } from './workspace-promotion.js';
import { createWorkspaceRecoveryCommands } from './workspace-recovery-commands.js';
import {
  createWorkspaceLeaseState,
  createWorkspaceRecoveryState,
} from './workspace-recovery-state.js';
import { createWorkspaceWatchdog } from './workspace-watchdog.js';
export { selectMemoryBriefingForPod } from './admission-memory-briefing.js';
import { createAdmissionAnalysisWorkspaces } from './admission-analysis-workspaces.js';
import { createAdmissionDependents } from './admission-dependents.js';
import { createAdmissionExecutionContext } from './admission-execution-context.js';
import { createAdmissionLegacy } from './admission-legacy.js';
import { createAdmissionMemoryContext } from './admission-memory-context.js';
import { createAdmissionQueries } from './admission-queries.js';
import { createAdmissionResolved } from './admission-resolved.js';
import { createAdmissionSeriesDeletion } from './admission-series-deletion.js';

export type { ApproveSessionOptions, ApproveAllSkippedPod } from './approval-contracts.js';

const execFileAsync = promisify(execFile);

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

export type { AgentRunOutcome } from './agent-execution-contracts.js';

export interface PodManager {
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
    options?: { force?: boolean },
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

export function createPodManager(deps: PodManagerDependencies): PodManager {
  const {
    podRepo,
    escalationRepo,
    nudgeRepo,
    fixFeedbackRepo,
    profileStore,
    providerAccountStore,
    providerCatalog,
    eventBus,
    containerManagerFactory,
    worktreeManager,
    runtimeRegistry,
    validationEngine,
    networkManager,
    sidecarManager,
    prManagerFactory: rawPrManagerFactory,
    enqueueSession,
    clearStuckQueueEntry,
    mcpBaseUrl,
    daemonConfig,
    logger,
    validationRepo,
    progressEventRepo,
    repoScanner,
    scanRepo,
    screenshotStore,
    hostScreenshotDir,
    safetyEventsRepo,
    qualityScoreRepo,
  } = deps;
  const { assertExecutionTerminationVerified, assertGuidanceCollected, ownsLifecycle } =
    createCompletionGuards({ podRepo, nudgeRepo });
  const admissionDependents = createAdmissionDependents({
    podRepo,
    logger,
    eventBus,
    enqueueSession,
  });
  const { maybeTriggerDependents } = admissionDependents;

  const { materializeSpecFiles, captureDeployBaselineHashes } =
    createProvisioningMaterials(execFileAsync);
  const {
    assertSandboxAgentStreamingExecSupported,
    syncSandboxRuntimeSessionState,
    syncSandboxSeriesHandover,
  } = createProvisioningSandboxState(deps, { podRepo, containerManagerFactory, logger });
  const { installGhBinary, installAzViaPip } = createProvisioningToolInstallation({ logger });
  const { executionForPod, executionCredentialsFor, injectionsForPod, resolveGitCredential } =
    createAdmissionExecutionContext(deps, { profileStore, daemonConfig });

  const { validationEnvironmentForPod } = createValidationEnvironment(deps, {
    executionCredentialsFor,
    containerManagerFactory,
  });
  const { prManagerFactory } = createDeliveryProvider(rawPrManagerFactory, podRepo);
  const { scheduleHostFetchRetry } = createWorkspaceHostFetchRetry({
    podRepo,
    enqueueSession,
    emitActivityStatus: (podId, message) => emitActivityStatus(podId, message),
  });

  const { primeRuntimeForResume } = createRuntimeResumeContext(deps, {
    executionForPod,
    executionCredentialsFor,
    injectionsForPod,
    mcpBaseUrl,
    buildCodeIntelligenceServers,
    resolvedReasoningEffort,
  });
  const { mergeQueue } = createDeliveryMergeQueue();
  const { startHaproxyDenyReceiver, stopHaproxyDenyReceiver } = createResourceDenials({
    containerManagerFactory,
    eventBus,
    logger,
  });

  const { readinessService, refreshReadiness } = createReadinessRefresh(deps, {
    podRepo,
    validationRepo,
    scanRepo,
    escalationRepo,
    qualityScoreRepo,
    logger,
  });
  const resourceNetwork = createResourceNetwork(deps, {
    networkManager,
    logger,
    profileStore,
    podRepo,
    daemonConfig,
    sidecarManager,
    providerAccountStore,
    providerCatalog,
    mcpBaseUrl,
    containerManagerFactory,
  });
  const { destroyPodNetwork } = resourceNetwork;

  const { ensureSandboxPreviewProxy, stopSandboxPreviewProxy } = createResourcePreview({
    containerManagerFactory,
    logger,
    podRepo,
  });

  const { killSidecarsForPod, cleanupTestRunBranches } = createResourceAuxiliary(deps, {
    sidecarManager,
    podRepo,
    logger,
    executionForPod,
  });

  const { clearPreviewTimer, schedulePreviewAutoStop } = createResourcePreviewTimers({
    stopSandboxPreviewProxy,
    containerManagerFactory,
    logger,
  });

  const { commitPolling } = createResourceCommitPollingState({ logger });

  const { mergePolling, DEFAULT_MERGE_POLL_INTERVAL_MS } = createDeliveryPollingState(logger);

  /** Active AbortControllers for in-progress validation runs, keyed by podId. */
  const { validationAbortControllers, attemptExtensionRuns, pendingUpdateFromBaseIntents } =
    createValidationWorkflowState();
  const {
    infrastructureResumeRuns,
    artifactResumeRuns,
    artifactCompletionRuns,
    coordinateInteractiveCompletion,
  } = createWorkspaceRecoveryState();

  const { pauseIntents } = createOperatorPauseState();

  const { activeAgentRuns, activeAgentRunResolvers } = createAgentRunRegistry();
  const {
    providerForAttempt,
    ensureProviderAttempt,
    rotateProviderAttemptForFreshSegment,
    closeProviderAttempt,
    isCompatibleTarget,
    selectProviderFailoverTarget,
    escapeProviderTargetDiagnosticValue,
    describeProviderFailoverTarget,
    providerFailoverUnavailableActivity,
    profileForProviderTarget,
    resolveEffectiveBoundProfile,
    openProviderTargetAttempt,
    rememberMaxCredentialLineage,
    forgetMaxCredentialLineage,
    maxCredentialLineageByPod,
  } = createProviderAttemptContext(deps, {
    podRepo,
    providerAccountStore,
    providerCatalog,
    profileStore,
    executionForPod,
    activeAgentRuns,
  });
  const { cleanupContainer } = createResourceCleanup(deps, {
    podRepo,
    logger,
    ownsLifecycle,
    stopSandboxPreviewProxy,
    stopHaproxyDenyReceiver,
    containerManagerFactory,
    forgetMaxCredentialLineage,
  });
  const { acquireAdvisoryQaSlot, releaseAdvisoryQaSlot, advisoryRuns } =
    createResourceAdvisoryState();
  const { forceWithLeaseAllowances } = createWorkspaceLeaseState();

  const { lastEventWriteAt, bumpActivityTimestamp, touchHeartbeat, recordNotReportedMemoryUsage } =
    createAgentActivity(deps, { podRepo, logger });
  const { emitActivityStatus, emitActivityError, transition, emitPodCompletedEvent } =
    createCompletionEvents({
      eventBus,
      bumpActivityTimestamp,
      recordNotReportedMemoryUsage,
      podRepo,
      refreshReadiness,
    });
  const { hasDurableAgentExecutionEvidence, tryRecoverTransientSandboxFailure } =
    createWorkspaceInfrastructureRecovery(deps, {
      ownsLifecycle,
      podRepo,
      emitActivityStatus,
      containerManagerFactory,
      logger,
      closeProviderAttempt,
      killSidecarsForPod,
      destroyPodNetwork,
    });

  const { cleanupContainerAfterAdvisorySettles } = createResourceAdvisoryCleanup({
    assertGuidanceCollected,
    advisoryRuns,
    cleanupContainer,
    emitActivityStatus,
    logger,
  });

  const { resolveApprovalReadiness, persistReadinessApproval, assertApprovalCurrent } =
    createApprovalReadiness({
      assertGuidanceCollected,
      advisoryRuns,
      readinessService,
      emitActivityStatus,
      isSinglePrSeriesPod,
      podRepo,
      eventBus,
      assertExecutionTerminationVerified,
    });
  const {
    handleDeletionGuardError,
    ownsArtifactCompletion,
    failInteractivePreservation,
    failBranchPreservation,
    assertInteractiveCompletionCurrent,
    parkOnWorktreeSyncFailure,
  } = createWorkspaceFences({
    podRepo,
    logger,
    eventBus,
    emitActivityStatus,
    nudgeRepo,
    emitActivityError,
    assertApprovalCurrent,
    assertGuidanceCollected,
    transition,
  });

  const { emitBlockingSecurityScanFindings } = createCompletionDiagnostics({ emitActivityError });
  const { runPushCheckpointScan, getLatestPushFindings } = createDeliveryScan({
    repoScanner,
    emitActivityStatus,
    logger,
    emitBlockingSecurityScanFindings,
    scanRepo,
  });

  const { parkOnCredentialFailure } = createDeliveryCredentials({
    podRepo,
    escalationRepo,
    transition,
    emitActivityStatus,
    logger,
  });

  const { ensurePrBaseBranchOnOrigin, pushAndCreatePr, retryCreatePr } = createDeliveryPr({
    worktreeManager,
    logger,
    resolveGitCredential,
    emitActivityStatus,
    assertGuidanceCollected,
    executionForPod,
    prManagerFactory,
    handleDeletionGuardError,
    getLatestPushFindings,
    podRepo,
  });
  const workspaceWatchdog = createWorkspaceWatchdog(deps, {
    logger,
    podRepo,
    stopSandboxPreviewProxy,
    containerManagerFactory,
    transition,
    emitActivityStatus,
    eventBus,
    enqueueSession,
    validationRepo,
  });

  const { resolveBranchSource } = createWorkspaceBranchSource({ podRepo, logger });

  const { isFixCycleTerminal, isFixPodRecyclable } = createFixCyclePolicy();

  const { providerBindingForFixPod } = createFixProviderBinding(deps);

  const { parkFixPodDeliveryFailure, isParkedHostPushRecovery, isRetryableFixDeliveryFailure } =
    createFixParking({ parkOnCredentialFailure, logger, emitActivityStatus, transition });

  const { maybeSpawnFixSession } = createFixAdmission(deps, {
    podRepo,
    logger,
    isFixCycleTerminal,
    emitActivityStatus,
    isFixPodRecyclable,
    transition,
    stopMergePolling: (podId) => stopMergePolling(podId),
    executionForPod,
    resolveBranchSource,
    cleanupContainer,
    providerBindingForFixPod,
    enqueueSession,
    eventBus,
  });

  const { postFixPodReviewFeedbackReplies } = createFixFeedback({
    executionForPod,
    prManagerFactory,
    logger,
    emitActivityStatus,
  });

  const { completeFixPodAfterPush } = createFixDelivery({
    assertGuidanceCollected,
    executionForPod,
    podRepo,
    logger,
    emitActivityStatus,
    mergeQueue,
    worktreeManager,
    resolveGitCredential,
    parkFixPodDeliveryFailure,
    postFixPodReviewFeedbackReplies,
    cleanupContainer,
    transition,
    eventBus,
  });

  const validationWorkflowControls = createValidationWorkflowControls(deps, {
    actorLabel,
    legacyRespondedBy,
    buildValidationWaiver,
    mergeOverrides,
    podRepo,
    escalationRepo,
    nudgeRepo,
    worktreeManager,
    logger,
    executionForPod,
    assertExecutionTerminationVerified,
    resolveGitCredential,
    validationAbortControllers,
    attemptExtensionRuns,
    pendingUpdateFromBaseIntents,
    forceWithLeaseAllowances,
    emitActivityStatus,
    transition,
    maybeTriggerDependents,
  });
  const { runUpdateFromBaseAfterAbort, applySkipValidationDecision, claimValidation } =
    validationWorkflowControls;
  const { startMergePolling, stopMergePolling, resumeMergePolling } = createDeliveryPolling({
    podRepo,
    assertApprovalCurrent,
    executionForPod,
    prManagerFactory,
    transition,
    emitActivityStatus,
    worktreeManager,
    mergeQueue,
    cleanupContainer,
    eventBus,
    logger,
    maybeTriggerDependents,
    buildActionableFailureSummary,
    fixFeedbackRepo,
    maybeSpawnFixSession,
    DEFAULT_MERGE_POLL_INTERVAL_MS,
    mergePolling,
  });

  // Resume merge polling on startup
  resumeMergePolling();
  const { startCommitPolling, stopCommitPolling } = createResourceCommitPolling(deps, {
    podRepo,
    commitPolling,
    containerManagerFactory,
    logger,
    emitActivityStatus,
  });

  const { getResumeEnv, persistRuntimeCredentialsForPod } = createWorkerRuntimeCredentials(deps, {
    podRepo,
    providerAccountStore,
    providerCatalog,
    profileStore,
    containerManagerFactory,
    logger,
    maxCredentialLineageByPod,
    resolveEffectiveBoundProfile,
    validationEnvironmentForPod,
    rememberMaxCredentialLineage,
  });

  const { buildReviewerExecEnv, getEffectiveReviewerConfig, getReviewerExecutor } =
    createReviewerContext(deps, {
      providerAccountStore,
      providerCatalog,
      profileStore,
      containerManagerFactory,
      logger,
      maxCredentialLineageByPod,
      executionForPod,
      resolveEffectiveBoundProfile,
    });
  const admissionMemory = createAdmissionMemoryContext(deps, {
    getReviewerExecutor,
    getEffectiveReviewerConfig,
  });

  const { syncWorkspaceBack, recoverWorktreeFromContainer } = createWorkspaceTransfer({ logger });

  const continuationContext = createContinuationContext(deps, {
    podRepo,
    nudgeRepo,
    containerManagerFactory,
    runtimeRegistry,
    mcpBaseUrl,
    executionForPod,
    primeRuntimeForResume,
    resolveEffectiveBoundProfile,
    getResumeEnv,
    emitActivityStatus,
  });
  const {
    appendDecisionContext,
    buildRecoveryTask,
    buildContinuationPrompt,
    buildReworkTask,
    recordContinuationProvenance,
    beginGoalTaskRework,
    taskFeedbackEvents,
  } = continuationContext;

  const providerContinuation = createProviderContinuation(deps, {
    podRepo,
    profileStore,
    providerAccountStore,
    containerManagerFactory,
    worktreeManager,
    runtimeRegistry,
    enqueueSession,
    logger,
    executionForPod,
    assertExecutionTerminationVerified,
    stopHaproxyDenyReceiver,
    CONTAINER_CLEANUP_TIMEOUT_MS,
    stopSandboxPreviewProxy,
    closeProviderAttempt,
    selectProviderFailoverTarget,
    providerFailoverUnavailableActivity,
    profileForProviderTarget,
    openProviderTargetAttempt,
    forgetMaxCredentialLineage,
    syncWorkspaceBack,
    emitActivityStatus,
    operatorErrorMessage,
    transition,
  });
  const {
    visibleProviderHandoffActivity,
    prepareProviderContinuationHandoff,
    queueProviderContinuation,
    handleProviderLimit,
  } = providerContinuation;

  const continuationControls = createContinuationControls(deps, {
    podRepo,
    containerManagerFactory,
    enqueueSession,
    logger,
    assertExecutionTerminationVerified,
    assertGuidanceCollected,
    hasDurableAgentExecutionEvidence,
    infrastructureResumeRuns,
    artifactResumeRuns,
    activeAgentRuns,
    resolveEffectiveBoundProfile,
    ownsLifecycle,
    isRetryableFixDeliveryFailure,
    completeFixPodAfterPush,
    emitActivityStatus,
    pushAndCreatePr,
    transition,
  });

  const { prepareWorkspaceForValidation } = createValidationWorkspace({
    logger,
    syncWorkspaceBack,
  });

  const { preservePodWorkspace, checkpointSandboxWorkspaceForPod } = createWorkspacePreservation({
    getContainerManager: (target) => containerManagerFactory.get(target),
    syncWorkspaceBack,
    workspaceCheckpointController: deps.workspaceCheckpointController,
    sandboxWorkspaceCheckpoint: deps.sandboxWorkspaceCheckpoint,
    logger,
    emitActivityStatus,
  });
  const { preserveSandboxAfterAgentFailure, tryRecoverAfterWorkspaceSyncFailure } =
    createWorkspacePreservationRecovery({
      podRepo,
      preservePodWorkspace,
      cleanupContainer,
      emitActivityStatus,
      logger,
      containerManagerFactory,
      recoverWorktreeFromContainer,
    });

  const { holdCompletionForHumanWork, prepareSourceForCompletion, applyCompletionDecision } =
    createCompletionOwners({
      podRepo,
      nudgeRepo,
      preservePodWorkspace,
      ownsArtifactCompletion,
      transition,
      logger,
      emitActivityStatus,
      containerManagerFactory,
      worktreeManager,
      checkpointSandboxWorkspaceForPod,
      syncSandboxSeriesHandover,
      syncWorkspaceBack,
      tryRecoverAfterWorkspaceSyncFailure,
      recoverWorktreeFromContainer,
      parkOnWorktreeSyncFailure,
      handleDeletionGuardError,
      executionForPod,
      cleanupContainer,
      emitPodCompletedEvent,
      maybeTriggerDependents,
    });

  const { startValidationAttempt } = createValidationAttemptStart({
    assertGuidanceCollected,
    runPushCheckpointScan,
    podRepo,
    transition,
    eventBus,
    getPodValidationSuite,
    emitActivityStatus,
  });

  const { prepareValidationInputs } = createValidationInputs({
    logger,
    worktreeManager,
    podRepo,
    validationRepo,
    overrideSource: deps,
    validationEnvironmentForPod,
    assertProtectedOperationalPathsInScope,
    loadCodeReviewSkill,
    getEffectiveReviewerConfig,
    buildReviewerExecEnv,
    mergeOverrides,
    getReviewerExecutor,
    getPodValidationSkipPhases,
    emitActivityStatus,
  });

  const { buildPhaseEventCallbacks, ownedValidationCallbacks } = createValidationProgress({
    eventBus,
  });

  const { recordValidationProvenance, withReviewerLaunchPreflight } = createValidationProvenance({
    podRepo,
    containerManagerFactory,
    resolveEffectiveBoundProfile,
  });

  const { validateWithInfrastructureRetries } = createValidationExecution({
    logger,
    containerManagerFactory,
    podRepo,
    validationEngine,
    retrySource: deps,
    recordValidationProvenance,
    resolveEffectiveBoundProfile,
    withReviewerLaunchPreflight,
    ownedValidationCallbacks,
    emitActivityStatus,
    makeUnexpectedValidationFailureResult,
    validationInfrastructureFailureLabel,
    isReviewInfrastructureOnlyFailure,
    reviewInfrastructureFailureLabel,
  });

  const { collectValidationEvidence } = createValidationEvidence({
    logger,
    containerManagerFactory,
    checkpointSandboxWorkspaceForPod,
    syncWorkspaceBack,
    screenshotStore,
    hostScreenshotDir,
    emitActivityStatus,
    formatElapsedDuration,
  });

  const { publishValidationResult } = createValidationPublication({
    podRepo,
    validationRepo,
    eventBus,
  });

  const {
    parkOnRetryAdmission,
    parkOnValidationInfrastructureFailure,
    parkOnReviewInfrastructureFailure,
  } = createValidationInfrastructure({
    logger,
    podRepo,
    containerManagerFactory,
    transition,
    stopSandboxPreviewProxy,
    emitActivityStatus,
  });

  const { advisoryPublicationOwnership, runAdvisoryAfterValidation } = createAdvisoryValidation({
    podRepo,
    nudgeRepo,
    validationRepo,
    validationEngine,
    logger,
    advisoryRuns,
    acquireAdvisoryQaSlot,
    releaseAdvisoryQaSlot,
    buildPhaseEventCallbacks,
    ownedValidationCallbacks,
    refreshReadiness,
    emitActivityStatus,
  });

  const { preserveArtifacts, finalizeArtifactPod } = createArtifactFinalizer({
    podRepo,
    getContainerManager: (target) => containerManagerFactory.get(target),
    ownsArtifactCompletion,
    executionForPod,
    syncSandboxSeriesHandover,
    resolveGitCredential,
    worktreeManager,
    cleanupContainer,
    transition,
    logger,
    emitActivityStatus,
    emitActivityError,
  });
  const { completeValidationPass } = createValidationPassDelivery({
    warnIfSinglePrSeriesMissingSeriesMeta,
    resolvePrBaseBranch,
    podRepo,
    containerManagerFactory,
    worktreeManager,
    validationEngine,
    logger,
    prManagerFactory,
    resolveGitCredential,
    refreshReadiness,
    getLatestPushFindings,
    stopSandboxPreviewProxy,
    pendingUpdateFromBaseIntents,
    completeFixPodAfterPush,
    emitActivityStatus,
    advisoryPublicationOwnership,
    runAdvisoryAfterValidation,
    parkOnCredentialFailure,
    handleDeletionGuardError,
    ensurePrBaseBranchOnOrigin,
    transition,
    maybeTriggerDependents,
  });
  const validationTriggerWorkflow = createValidationTriggerWorkflow(deps, {
    buildManualReworkReason,
    mergeOverrides,
    podRepo,
    escalationRepo,
    eventBus,
    containerManagerFactory,
    validationEngine,
    enqueueSession,
    logger,
    validationRepo,
    scanRepo,
    assertExecutionTerminationVerified,
    resolveEffectiveBoundProfile,
    beginGoalTaskRework,
    taskFeedbackEvents,
    destroyPodNetwork,
    cleanupContainer,
    stopSandboxPreviewProxy,
    killSidecarsForPod,
    cleanupTestRunBranches,
    validationAbortControllers,
    ownsLifecycle,
    pendingUpdateFromBaseIntents,
    parkFixPodDeliveryFailure,
    isParkedHostPushRecovery,
    runUpdateFromBaseAfterAbort,
    persistRuntimeCredentialsForPod,
    prepareWorkspaceForValidation,
    preservePodWorkspace,
    checkpointSandboxWorkspaceForPod,
    startValidationAttempt,
    prepareValidationInputs,
    buildPhaseEventCallbacks,
    ownedValidationCallbacks,
    recordValidationProvenance,
    withReviewerLaunchPreflight,
    validateWithInfrastructureRetries,
    collectValidationEvidence,
    publishValidationResult,
    parkOnRetryAdmission,
    parkOnValidationInfrastructureFailure,
    parkOnReviewInfrastructureFailure,
    emitActivityStatus,
    emitActivityError,
    sanitizeFailureReason,
    tryRecoverAfterWorkspaceSyncFailure,
    parkOnWorktreeSyncFailure,
    transition,
    applySkipValidationDecision,
    claimValidation,
    maybeTriggerDependents,
    completeValidationPass,
  });

  const { completeRevalidationPass } = createRevalidationPassDelivery({
    warnIfSinglePrSeriesMissingSeriesMeta,
    resolvePrBaseBranch,
    podRepo,
    containerManagerFactory,
    worktreeManager,
    validationEngine,
    logger,
    prManagerFactory,
    resolveGitCredential,
    refreshReadiness,
    getLatestPushFindings,
    emitActivityStatus,
    advisoryPublicationOwnership,
    runAdvisoryAfterValidation,
    handleDeletionGuardError,
    ensurePrBaseBranchOnOrigin,
    transition,
    maybeTriggerDependents,
  });
  const validationRevalidationWorkflow = createValidationRevalidationWorkflow(deps, {
    CONTAINER_APP_PORT,
    podRepo,
    eventBus,
    containerManagerFactory,
    worktreeManager,
    validationEngine,
    enqueueSession,
    logger,
    validationRepo,
    executionForPod,
    validationEnvironmentForPod,
    assertExecutionTerminationVerified,
    assertGuidanceCollected,
    resolveGitCredential,
    runPushCheckpointScan,
    validationAbortControllers,
    buildReviewerExecEnv,
    getEffectiveReviewerConfig,
    getReviewerExecutor,
    prepareWorkspaceForValidation,
    buildPhaseEventCallbacks,
    validateWithInfrastructureRetries,
    publishValidationResult,
    parkOnRetryAdmission,
    parkOnValidationInfrastructureFailure,
    parkOnReviewInfrastructureFailure,
    emitActivityStatus,
    emitActivityError,
    sanitizeFailureReason,
    tryRecoverAfterWorkspaceSyncFailure,
    parkOnWorktreeSyncFailure,
    transition,
    applySkipValidationDecision,
    claimValidation,
    maybeTriggerDependents,
    completeRevalidationPass,
  });

  const provisioningWorkflow = createProvisioningWorkflow(deps, {
    materializeSpecFiles,
    captureDeployBaselineHashes,
    podRepo,
    profileStore,
    providerAccountStore,
    providerCatalog,
    containerManagerFactory,
    worktreeManager,
    logger,
    repoScanner,
    executionCredentialsFor,
    resolveGitCredential,
    assertSandboxAgentStreamingExecSupported,
    destroyPodNetwork,
    stopSandboxPreviewProxy,
    killSidecarsForPod,
    closeProviderAttempt,
    resolveEffectiveBoundProfile,
    openProviderTargetAttempt,
    persistRuntimeCredentialsForPod,
    syncWorkspaceBack,
    transition,
    allocateHostPort,
    CONTAINER_APP_PORT,
    execFileAsync,
    networkManager,
    sidecarManager,
    mcpBaseUrl,
    injectionsForPod,
    startHaproxyDenyReceiver,
    hostnameFromUrl,
    portFromUrl,
    buildPrFixTask,
    fixFeedbackRepo,
    escalationRepo,
    validationRepo,
    progressEventRepo,
    safetyEventsRepo,
    rememberMaxCredentialLineage,
    emitActivityStatus,
  });
  const processWorkflow = createAgentProcessWorkflow(deps, {
    podRepo,
    logger,
    emitActivityStatus,
    resolveEffectiveBoundProfile,
    provisioningWorkflow,
    runtimeRegistry,
    ensureProviderAttempt,
    activeAgentRuns,
    touchHeartbeat,
    rotateProviderAttemptForFreshSegment,
    buildReworkTask,
    buildContinuationPrompt,
    buildRecoveryTask,
    recordContinuationProvenance,
    primeRuntimeForResume,
    appendDecisionContext,
    ownsLifecycle,
    persistRuntimeCredentialsForPod,
    preserveSandboxAfterAgentFailure,
    hasDurableAgentExecutionEvidence,
    tryRecoverTransientSandboxFailure,
    closeProviderAttempt,
    scheduleHostFetchRetry,
    emitActivityError,
    transition,
    escalationRepo,
    operatorErrorMessage,
    containerManagerFactory,
    CONTAINER_CLEANUP_TIMEOUT_MS,
  });

  const agentEventConsumption = createAgentEventConsumption(deps, {
    podRepo,
    activeAgentRunResolvers,
    activeAgentRuns,
    resolveEffectiveBoundProfile,
    ensureProviderAttempt,
    startCommitPolling,
    pauseIntents,
    logger,
    eventBus,
    bumpActivityTimestamp,
    emitActivityStatus,
    transition,
    progressEventRepo,
    rotateProviderAttemptForFreshSegment,
    summarizeAgentCompletionBlocker,
    executionForPod,
    sanitizeFailureReason,
    touchHeartbeat,
    hasDurableAgentExecutionEvidence,
    syncSandboxRuntimeSessionState,
    closeProviderAttempt,
    handleProviderLimit,
    stopCommitPolling,
    lastEventWriteAt,
  });
  const completionWorkflow = createCompletionWorkflow(deps, {
    podRepo,
    holdCompletionForHumanWork,
    artifactCompletionRuns,
    finalizeArtifactPod,
    prepareSourceForCompletion,
    applyCompletionDecision,
  });
  const { prepareApprovalDelivery } = createApprovalDeliveryPreparation({
    podRepo,
    assertApprovalCurrent,
    executionForPod,
    worktreeManager,
    emitActivityError,
    containerManagerFactory,
    logger,
    prManagerFactory,
    emitActivityStatus,
    failBranchPreservation,
    forceWithLeaseAllowances,
    transition,
    persistReadinessApproval,
    cleanupContainerAfterAdvisorySettles,
    eventBus,
    maybeTriggerDependents,
  });
  const { executeApprovalDelivery } = createApprovalDeliveryExecution({
    podRepo,
    assertApprovalCurrent,
    executionForPod,
    worktreeManager,
    emitActivityError,
    logger,
    prManagerFactory,
    emitActivityStatus,
    forceWithLeaseAllowances,
    transition,
    resolveGitCredential,
    mergeQueue,
    formatRebaseConflictReason,
    startMergePolling,
    resolvePrBaseBranch,
    ensurePrBaseBranchOnOrigin,
    getLatestPushFindings,
    handleDeletionGuardError,
  });
  const approvalWorkflow = createApprovalWorkflow({
    podRepo,
    resolveApprovalReadiness,
    assertApprovalCurrent,
    logger,
    emitActivityStatus,
    transition,
    persistReadinessApproval,
    cleanupContainerAfterAdvisorySettles,
    eventBus,
    maybeTriggerDependents,
    prepareApprovalDelivery,
    executeApprovalDelivery,
  });

  const approvalControls = createApprovalControls({
    podRepo,
    resolveApprovalReadiness,
    logger,
    nudgeRepo,
    validationRepo,
    emitActivityStatus,
    escalationRepo,
    transition,
    maybeTriggerDependents,
    refreshReadiness,
  });
  const fixControls = createFixControls({
    podRepo,
    executionForPod,
    transition,
    emitActivityStatus,
    startMergePolling,
    logger,
    fixFeedbackRepo,
    maybeSpawnFixSession,
    isFixCycleTerminal,
  });
  const operatorMessages = createOperatorMessages(deps, {
    pauseIntents,
    podRepo,
    activeAgentRuns,
    executionForPod,
    emitActivityStatus,
    transition,
    logger,
    resolveGitCredential,
    escalationRepo,
    enqueueSession,
    worktreeManager,
    prManagerFactory,
    ensurePrBaseBranchOnOrigin,
    getLatestPushFindings,
    completeFixPodAfterPush,
    maybeTriggerDependents,
    stopSandboxPreviewProxy,
    containerManagerFactory,
    parkOnCredentialFailure,
    nudgeRepo,
    beginGoalTaskRework,
    mergeOverrides,
    taskFeedbackEvents,
    persistRuntimeCredentialsForPod,
    getResumeEnv,
    runtimeRegistry,
    recordContinuationProvenance,
    primeRuntimeForResume,
    buildRecoveryTask,
    resolveEffectiveBoundProfile,
  });
  const operatorRejection = createOperatorRejection({
    podRepo,
    beginGoalTaskRework,
    emitActivityStatus,
    transition,
    containerManagerFactory,
    logger,
    taskFeedbackEvents,
    persistRuntimeCredentialsForPod,
  });
  const operatorPause = createOperatorPause(deps, {
    pauseIntents,
    podRepo,
    emitActivityStatus,
    activeAgentRuns,
    logger,
    runtimeRegistry,
    transition,
  });
  const operatorKill = createOperatorKill(deps, {
    podRepo,
    clearPreviewTimer,
    stopSandboxPreviewProxy,
    stopMergePolling,
    emitActivityStatus,
    transition,
    validationAbortControllers,
    killSidecarsForPod,
    cleanupTestRunBranches,
    containerManagerFactory,
    persistRuntimeCredentialsForPod,
    ownsLifecycle,
    logger,
    destroyPodNetwork,
    runtimeRegistry,
    worktreeManager,
    forgetMaxCredentialLineage,
    eventBus,
  });
  const operatorControls = createOperatorControls({
    podRepo,
    nudgeRepo,
    emitActivityStatus,
    logger,
    transition,
  });
  const operatorTools = createOperatorTools({
    podRepo,
    containerManagerFactory,
    emitActivityStatus,
    installGhBinary,
    installAzViaPip,
  });
  const resourcePreviewControls = createResourcePreviewControls({
    podRepo,
    containerManagerFactory,
    executionForPod,
    ensureSandboxPreviewProxy,
    schedulePreviewAutoStop,
    logger,
    clearPreviewTimer,
    stopSandboxPreviewProxy,
  });
  const workspaceArtifactObservation = createWorkspaceArtifactObservation(deps, {
    assertExecutionTerminationVerified,
    assertGuidanceCollected,
    podRepo,
    artifactResumeRuns,
    artifactCompletionRuns,
  });

  const workspaceEscapeControls = createWorkspaceEscapeControls({
    podRepo,
    cleanupContainer,
    transition,
    emitActivityStatus,
    logger,
    maybeTriggerDependents,
    clearStuckQueueEntry,
    enqueueSession,
    validationAbortControllers,
  });

  const workspaceDeletion = createWorkspaceDeletion({
    podRepo,
    executionForPod,
    clearPreviewTimer,
    stopSandboxPreviewProxy,
    killSidecarsForPod,
    containerManagerFactory,
    destroyPodNetwork,
    cleanupTestRunBranches,
    worktreeManager,
    pendingUpdateFromBaseIntents,
    forceWithLeaseAllowances,
    logger,
  });

  const workspaceManualFix = createWorkspaceManualFix(deps, {
    podRepo,
    assertExecutionTerminationVerified,
    logger,
    emitActivityStatus,
  });

  const workspaceRecoveryCommands = createWorkspaceRecoveryCommands({
    preservePodWorkspace,
    podRepo,
    containerManagerFactory,
    emitActivityStatus,
    killSidecarsForPod,
    destroyPodNetwork,
    checkpointSandboxWorkspaceForPod,
    recoverWorktreeFromContainer,
    executionForPod,
    worktreeManager,
    logger,
  });

  const workspaceBranchSync = createWorkspaceBranchSync({
    podRepo,
    containerManagerFactory,
    syncWorkspaceBack,
    logger,
    executionForPod,
    worktreeManager,
    resolveGitCredential,
  });

  const workspaceCompletion = createWorkspaceCompletion(deps, {
    podRepo,
    coordinateInteractiveCompletion,
    assertInteractiveCompletionCurrent,
    preserveArtifacts,
    failInteractivePreservation,
    containerManagerFactory,
    syncWorkspaceBack,
    logger,
    executionForPod,
    runPushCheckpointScan,
    resolveGitCredential,
    worktreeManager,
    handleDeletionGuardError,
    emitActivityStatus,
    cleanupContainer,
    transition,
    eventBus,
  });

  const workspacePromotion = createWorkspacePromotion(deps, {
    podRepo,
    executionForPod,
    transition,
    enqueueSession,
    logger,
    profileStore,
    eventBus,
  });
  const admissionSeries = createAdmissionSeriesDeletion({ podRepo, logger });

  const admissionQueries = createAdmissionQueries(deps, {
    podRepo,
    executionCredentialsFor,
    executionForPod,
    injectionsForPod,
    validationRepo,
  });

  const admissionAnalysis = createAdmissionAnalysisWorkspaces(deps);

  const admissionLegacy = createAdmissionLegacy(deps, {
    podRepo,
    profileStore,
    providerAccountStore,
    providerCatalog,
    containerManagerFactory,
    assertSandboxAgentStreamingExecSupported,
    executionForPod,
    logger,
    eventBus,
    enqueueSession,
  });

  const admissionResolved = createAdmissionResolved(deps, {
    providerAccountStore,
    providerCatalog,
    containerManagerFactory,
    assertSandboxAgentStreamingExecSupported,
    podRepo,
    eventBus,
    enqueueSession,
    maybeTriggerDependents,
  });

  return {
    getLaunchConfiguration(podId: string): EffectiveLaunchConfig | null {
      return admissionQueries.getLaunchConfiguration(podId);
    },
    createResolvedSession(config, userId, creator, actor): Pod {
      return admissionResolved.createResolvedSession(config, userId, creator, actor);
    },
    createSession(
      request: CreatePodRequest,
      userId: string,
      creator?: PodCreator,
      actor?: OperatorActor,
    ): Pod {
      return admissionLegacy.createSession(request, userId, creator, actor);
    },

    createHistoryWorkspace(
      profileName: string,
      userId: string,
      historyQuery: HistoryQuery,
      creator?: PodCreator,
    ): Pod {
      return admissionAnalysis.createHistoryWorkspace.call(
        this,
        profileName,
        userId,
        historyQuery,
        creator,
      );
    },

    createMemoryWorkspace(profileName: string, userId: string, creator?: PodCreator): Pod {
      return admissionAnalysis.createMemoryWorkspace.call(this, profileName, userId, creator);
    },
    resumeNativeGoal(podId: string, revision: number) {
      return continuationControls.resumeNativeGoal(podId, revision);
    },
    async processPod(podId: string): Promise<void> {
      return processWorkflow.processPod.call(this, podId);
    },

    async consumeAgentEvents(
      podId: string,
      events: AsyncIterable<AgentEvent>,
      attempt = 0,
      lifecycle?: { generation: number; containerId: string | null; nativeGoal?: boolean },
    ): Promise<AgentRunOutcome> {
      return agentEventConsumption.consumeAgentEvents(podId, events, attempt, lifecycle);
    },

    async handleCompletion(podId: string): Promise<void> {
      return completionWorkflow.handleCompletion.call(this, podId);
    },

    sendMessage(
      podId: string,
      message: string,
      actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
    ): Promise<void> {
      return operatorMessages.sendMessage.call(this, podId, message, actor);
    },

    approveSession(podId: string, options: ApproveSessionOptions = {}): Promise<void> {
      return approvalWorkflow.approveSession(podId, options);
    },

    rejectSession(
      podId: string,
      reason?: string,
      actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
    ): Promise<void> {
      return operatorRejection.rejectSession.call(this, podId, reason, actor);
    },

    pauseSession(podId: string): Promise<void> {
      return operatorPause.pauseSession(podId);
    },

    nudgeSession(podId: string, message: string): void {
      operatorControls.nudgeSession(podId, message);
    },

    killSession(podId: string): Promise<void> {
      return operatorKill.killSession(podId);
    },

    /**
     * Promote an interactive pod to an agent-driven (`auto`) pod on
     * the same pod ID. Keeps branch, event log, token budget, and
     * escalation history. Used when the human hands off work to the agent
     * via `ap complete <id> --pr` (or `--artifact`).
     *
     * Flow: sync `/workspace` back to host → stop interactive container →
     * transition to `handoff` → swap the pod's `pod` config → re-enqueue
     * for `processPod()` which will pick up in the new mode.
     */
    promoteToAuto(
      podId: string,
      targetOutput: 'pr' | 'branch' | 'artifact' | 'none',
      options?: { instructions?: string; skipAgent?: boolean },
    ): Promise<void> {
      return workspacePromotion.promoteToAuto(podId, targetOutput, options);
    },

    completeSession(
      podId: string,
      options?: {
        promoteTo?: 'pr' | 'branch' | 'artifact' | 'none';
        instructions?: string;
        skipAgent?: boolean;
      },
    ): Promise<{ pushError?: string; promotedTo?: 'pr' | 'branch' | 'artifact' | 'none' }> {
      return workspaceCompletion.completeSession.call(this, podId, options);
    },

    syncWorkspaceBranch(
      podId: string,
    ): Promise<{ committed: boolean; pushed: boolean; error?: string }> {
      return workspaceBranchSync.syncWorkspaceBranch(podId);
    },

    preserveWorkspace(podId: string, reason = 'operator recovery'): Promise<void> {
      return workspaceRecoveryCommands.preserveWorkspace(podId, reason);
    },

    quiesceSandboxAgent(podId: string): Promise<void> {
      return workspaceRecoveryCommands.quiesceSandboxAgent(podId);
    },

    suspendSandboxForRecovery(podId: string): Promise<void> {
      return workspaceRecoveryCommands.suspendSandboxForRecovery(podId);
    },

    cleanupPodResourcesForRecovery(podId: string): Promise<void> {
      return workspaceRecoveryCommands.cleanupPodResourcesForRecovery(podId);
    },
    assertCanRework(podId: string) {
      return continuationControls.assertCanRework(podId);
    },
    triggerValidation(podId: string, options?: { force?: boolean; validationOnly?: boolean }) {
      return validationTriggerWorkflow.triggerValidation.call(
        {
          triggerValidation: (...args) => this.triggerValidation(...args),
          assertCanRework: (...args) => this.assertCanRework(...args),
          approveSession: (...args) => this.approveSession(...args),
          consumeAgentEvents: (...args) => this.consumeAgentEvents(...args),
          handleCompletion: (...args) => this.handleCompletion(...args),
        },
        podId,
        options,
      );
    },
    revalidateSession(podId: string, options?: { force?: boolean }) {
      return validationRevalidationWorkflow.revalidateSession.call(
        { approveSession: (...args) => this.approveSession(...args) },
        podId,
        options,
      );
    },

    fixManually(
      podId: string,
      actorOrUserId: OperatorActor | string,
      creator?: PodCreator,
      instructions?: string,
    ): Promise<Pod> {
      return workspaceManualFix.fixManually.call(this, podId, actorOrUserId, creator, instructions);
    },

    notifyEscalation(podId: string, escalation: EscalationRequest): void {
      operatorControls.notifyEscalation(podId, escalation);
    },

    touchHeartbeat,
    getReviewerConfig(pod: Pod): {
      profile: PodExecutionSettings;
      credentials: ProviderCredentials | null;
    } {
      return getEffectiveReviewerConfig(pod);
    },
    getReviewerExecEnv(pod: Pod): Promise<Record<string, string> | undefined> {
      return buildReviewerExecEnv(pod);
    },
    getReviewerExecutor,
    getProjectMemoryScope(pod) {
      return admissionMemory.getProjectMemoryScope(pod);
    },
    getLaunchMemoryContext(pod) {
      return admissionMemory.getLaunchMemoryContext(pod);
    },

    deleteSession(podId: string): Promise<void> {
      return workspaceDeletion.deleteSession(podId);
    },

    startPreview(podId: string): Promise<{ previewUrl: string }> {
      return resourcePreviewControls.startPreview(podId);
    },

    stopPreview(podId: string): Promise<void> {
      return resourcePreviewControls.stopPreview(podId);
    },

    previewStatus(podId: string): Promise<{
      running: boolean;
      reachable: boolean;
      restartCount: number;
      lastError: string | null;
      previewUrl: string | null;
    }> {
      return resourcePreviewControls.previewStatus(podId);
    },

    getSession(podId: string): Pod {
      return admissionQueries.getSession(podId);
    },

    refreshReadinessAfterQualityScore(podId: string): boolean {
      return approvalControls.refreshReadinessAfterQualityScore(podId);
    },

    async getValidationEnvironment(podId) {
      const pod = podRepo.getOrThrow(podId);
      return validationEnvironmentForPod(pod, executionForPod(pod));
    },

    async getDeploymentConfiguration(podId) {
      return admissionQueries.getDeploymentConfiguration(podId);
    },

    async getInjectedMcpServer(podId, name) {
      return admissionQueries.getInjectedMcpServer.call(this, podId, name);
    },

    getInjectedMcpServers(podId: string): InjectedMcpServer[] {
      return admissionQueries.getInjectedMcpServers(podId);
    },

    listSessions(filters?) {
      return admissionQueries.listSessions(filters);
    },

    getSessionStats(filters?) {
      return admissionQueries.getSessionStats(filters);
    },

    getSeriesPods(seriesId: string): Pod[] {
      return admissionQueries.getSeriesPods(seriesId);
    },

    rehydrateDependentSessions(): void {
      admissionDependents.rehydrateDependentSessions();
    },

    async deleteSeriesWithCascade(seriesId: string): Promise<void> {
      return admissionSeries.deleteSeriesWithCascade.call(this, seriesId);
    },

    getValidationHistory(podId: string) {
      return admissionQueries.getValidationHistory(podId);
    },

    approveAllValidated(): Promise<{ approved: string[]; skipped: ApproveAllSkippedPod[] }> {
      return approvalControls.approveAllValidated.call(this);
    },

    killAllFailed(): Promise<{ killed: string[] }> {
      return operatorControls.killAllFailed.call(this);
    },
    extendAttempts(podId: string, additionalAttempts: number) {
      return validationWorkflowControls.extendAttempts.call(
        { triggerValidation: (...args) => this.triggerValidation(...args) },
        podId,
        additionalAttempts,
      );
    },
    applyOverridesInstant(podId: string) {
      return validationWorkflowControls.applyOverridesInstant(podId);
    },

    approveFactWaiver(
      podId: string,
      factId: string,
      reason?: string,
      actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
    ): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }> {
      return approvalControls.approveFactWaiver.call(this, podId, factId, reason, actor);
    },

    forceApprove(
      podId: string,
      reason?: string,
      actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
    ): Promise<void> {
      return approvalControls.forceApprove(podId, reason, actor);
    },

    extendPrAttempts(podId: string, additionalAttempts: number): Promise<void> {
      return fixControls.extendPrAttempts(podId, additionalAttempts);
    },
    interruptValidation(podId: string) {
      return validationWorkflowControls.interruptValidation(podId);
    },
    updateFromBase(podId: string) {
      return validationWorkflowControls.updateFromBase.call(
        { triggerValidation: (...args) => this.triggerValidation(...args) },
        podId,
      );
    },
    setSkipValidation(
      podId: string,
      skip: boolean,
      actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
    ) {
      return validationWorkflowControls.setSkipValidation(podId, skip, actor);
    },

    refreshNetworkPolicy(profileName: string): Promise<void> {
      return resourceNetwork.refreshNetworkPolicy(profileName);
    },

    injectCredential(_podId: string, _service: 'github' | 'ado'): Promise<void> {
      return operatorTools.injectCredential(_podId, _service);
    },

    installCliTool(podId: string, tool: 'gh' | 'az'): Promise<void> {
      return operatorTools.installCliTool(podId, tool);
    },

    /**
     * Thin wrapper over the queue-driven fix-pod model: validate the parent is
     * eligible, enqueue the feedback message, and let `maybeSpawnFixSession`
     * decide whether to spawn/recycle. The task itself is built from the
     * drained queue when the fix pod transitions to `running`.
     */
    spawnFixSession(podId: string, userMessage?: string): Promise<void> {
      return fixControls.spawnFixSession(podId, userMessage);
    },

    requestFixSession(podId: string, message: string): Promise<SpawnFixResponse> {
      return fixControls.requestFixSession(podId, message);
    },

    retryCreatePr(podId: string): Promise<void> {
      return retryCreatePr(podId);
    },

    getArtifactResumeObservation(podId: string): ArtifactResumeObservation {
      return workspaceArtifactObservation.getArtifactResumeObservation(podId);
    },
    resumePod(podId: string) {
      return continuationControls.resumePod.call(
        {
          handleCompletion: (...args) => this.handleCompletion(...args),
          revalidateSession: (...args) => this.revalidateSession(...args),
          approveSession: (...args) => this.approveSession(...args),
        },
        podId,
      );
    },
    continueProvider(
      podId: string,
      requestedTarget?: ProviderFailoverTarget | 'profile-primary',
      actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
    ) {
      return providerContinuation.continueProvider(podId, requestedTarget, actor);
    },

    forceComplete(
      podId: string,
      reason?: string,
      actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
    ): Promise<void> {
      return workspaceEscapeControls.forceComplete(podId, reason, actor);
    },

    kickPod(
      podId: string,
      reason?: string,
      actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
    ): Promise<{ action: 'requeued' | 'failed' }> {
      return workspaceEscapeControls.kickPod(podId, reason, actor);
    },

    startStuckPodWatchdog(options?: { intervalMs?: number; thresholdMs?: number }): void {
      workspaceWatchdog.startStuckPodWatchdog.call(this, options);
    },

    stopStuckPodWatchdog(): void {
      workspaceWatchdog.stopStuckPodWatchdog();
    },

    recoverWorktree(podId: string): Promise<{
      recovered: boolean;
      message: string;
      blockers?: Array<{ status: string; path: string }>;
    }> {
      return workspaceRecoveryCommands.recoverWorktree(podId);
    },
  };
}
