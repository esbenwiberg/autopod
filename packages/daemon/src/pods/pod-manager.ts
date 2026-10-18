import { isAcrQualifiedImage } from './provisioning-image-policy.js';
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
import { createHash } from 'node:crypto';

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
  MemoryEntry,
  NetworkPolicy,
  OperatorActor,
  Pod,
  PodOptions,
  PodStatus,
  PrivateRegistry,
  ProviderCredentials,
  ProviderFailoverTarget,
  PublicProviderCatalog,
  RequestCredentialPayload,
  SpawnFixResponse,
  TaskRetryIdentity,
  UpdateFromBaseResponse,
  ValidationOverride,
  ValidationOverridePayload,
  ValidationResult,
} from '@autopod/shared';
import {
  AutopodError,
  generatePodId,
  outputModeFromPodOptions,
  podOptionsFromOutputMode,
  resolvePodOptions,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { ActionAuditRepository } from '../actions/audit-repository.js';

import { assertLaunchAgentAccount } from '../configuration/agent-route-resolution.js';
import type { LaunchExecutionCredentials } from '../configuration/execution-credentials.js';
import { launchPodOptions } from '../configuration/launch-pod-options.js';
import { createContinuationContext } from './continuation-context.js';
import { createContinuationControls } from './continuation-controls.js';
import { REWORK_IN_PROGRESS_PREFIX, buildManualReworkReason } from './continuation-policy.js';
import { createProviderAttemptContext } from './provider-attempt-context.js';
import { nativeSessionId, resolvedReasoningEffort } from './provider-attempt-policy.js';
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

import {
  computeNetworkPolicyAllowlist,
  networkNameForPod,
} from '../containers/docker-network-manager.js';
import {
  type HaproxyDenyStreamHandle,
  streamHaproxyDenials,
} from '../containers/haproxy-deny-stream.js';

import type { SandboxInfrastructureError } from '../containers/sandbox-api-client.js';
import { sandboxEgressRefreshPayload } from '../containers/sandbox-container-manager.js';
import type { SidecarManager } from '../containers/sidecar-manager.js';
import { getAutoAttachedSidecars, resolveSidecarSpec } from '../containers/sidecar-resolver.js';
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
import { assertNoExpiredPat } from '../profiles/pat-expiry.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';

import type { ProfileLlmClientResult } from '../providers/index.js';

import { ResumeSessionNotFoundError } from '../runtimes/claude-runtime.js';
import { cleanupClaudeState } from '../runtimes/claude-state-store.js';
import { cleanupCodexState } from '../runtimes/codex-state-store.js';

import { authenticatedGitEnvironment } from '../worktrees/authenticated-git-environment.js';

import {
  DeletionGuardError,
  GitCredentialError,
  type GitTransientFetchError,
} from '../worktrees/local-worktree-manager.js';

import type {
  SandboxWorkspaceCheckpointArgs,
  WorkspaceCheckpointResult,
} from '../worktrees/sandbox-workspace-checkpoint.js';
import { createAdvisoryValidation } from './advisory-validation.js';

import { createArtifactFinalizer } from './artifact-finalizer.js';
import {
  type ArtifactResumeObservation,
  observeArtifactResume,
} from './artifact-resume-observation.js';

import { admitComposablePod } from './composable-pod-admission.js';
import { AgentContinuationSupersededError } from './continuation-preflight.js';

import { runDeletionCleanup } from './deletion-cleanup.js';
import { deletionOwnershipError } from './deletion-ownership.js';
import { dispatchRequestHash } from './dispatch-preflight-ledger.js';
import { persistCompletionReply } from './escalation-coordinator.js';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventBus } from './event-bus.js';
import type { EventRepository } from './event-repository.js';
import { formatFeedback } from './feedback-formatter.js';
import type { FixFeedbackRepository } from './fix-feedback-repository.js';
import { mergeMcpServers } from './injection-merger.js';
import { createInteractiveCompletionCoordinator } from './interactive-completion-coordinator.js';
import { reconcileLocalSessions } from './local-reconciler.js';
import type { MemoryRepository } from './memory-repository.js';
import { prefilterMemories, selectRelevantMemories } from './memory-selector.js';
import type { MemoryUsageRepository } from './memory-usage-repository.js';
import type { NudgeRepository } from './nudge-repository.js';
import type { PodRepository, PodStats } from './pod-repository.js';
import { createPollingCoordinator } from './polling-coordinator.js';
import { type PreflightConflict, findPreflightConflicts } from './preflight.js';
import { buildSupervisorCommand, parseStatus } from './preview-supervisor.js';
import type { ProgressEventRepository } from './progress-event-repository.js';
import { projectMemoryScope } from './project-memory-scope.js';
import type { ProviderAttemptRepository } from './provider-attempt-repository.js';
import { resolveProviderPreflight } from './provider-preflight.js';
import type { QualityScoreRepository } from './quality-score-repository.js';

import { deriveReferenceRepos } from './reference-repos.js';
import { createReviewerContext } from './reviewer-context.js';
import { addRuntimeNetworkDefaults } from './runtime-network-defaults.js';

import { createRuntimeResumeContext } from './runtime-resume-context.js';
import { type SandboxPreviewProxy, startSandboxPreviewProxy } from './sandbox-preview-proxy.js';
import { sandboxStartupRetryInput } from './sandbox-startup-admission.js';

import {
  canKill,
  canNudge,
  canPause,
  canPromote,
  canReceiveMessage,
  isTerminalState,
} from './state-machine.js';

import { TaskRetryBlockedError } from './task-retry-ledger.js';
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
import {
  deriveAgentAttempt,
  hasLatestPersistedAgentTerminalEventComplete,
} from './agent-execution-policy.js';
import { createAgentProcessWorkflow } from './agent-process-workflow.js';
import { createAgentRunRegistry } from './agent-run-registry.js';
import type { ApproveAllSkippedPod, ApproveSessionOptions } from './approval-contracts.js';
import { createApprovalControls } from './approval-controls.js';
import { createApprovalDeliveryExecution } from './approval-delivery-execution.js';
import { createApprovalDeliveryPreparation } from './approval-delivery-preparation.js';
import {
  actorLabel,
  buildValidationWaiver,
  legacyRespondedBy,
  parseValidationOverrideResponse,
} from './approval-policy.js';
import { createApprovalReadiness, createReadinessRefresh } from './approval-readiness.js';
import { createApprovalWorkflow } from './approval-workflow.js';
import {
  describeSyncFailure,
  formatElapsedDuration,
  operatorErrorMessage,
  sanitizeFailureReason,
  summarizeAgentCompletionBlocker,
} from './completion-diagnostics.js';
import type { OperatorFailurePhase } from './completion-diagnostics.js';
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

export type { ApproveSessionOptions, ApproveAllSkippedPod } from './approval-contracts.js';

function buildDetachedMcpFallbackMessage(
  escalationType: string | undefined,
  response: string,
): string {
  const label = escalationType ? `${escalationType} MCP call` : 'MCP call';
  return [
    `Fallback response for the previous ${label}:`,
    '',
    response,
    '',
    'The original MCP response stream closed before this answer could be delivered. If you already received the same answer directly from the tool call, ignore this duplicate.',
  ].join('\n');
}

/** Allocate a random host port in range 10000–48999 for container port mapping.
 * Capped at 48999 to avoid the Windows/Hyper-V ephemeral port reservation range (49152+). */
function allocateHostPort(): number {
  return 10_000 + Math.floor(Math.random() * 39_000);
}

/** Default container port for app servers (matches Dockerfile HEALTHCHECK). */
const CONTAINER_APP_PORT = 3000;

/**
 * Entra email allowlist for native sandbox preview URLs. When set (comma/space
 * separated), sandbox pods expose their app port through the platform's native
 * public URL (Entra-gated to these addresses) instead of the daemon-side exec
 * proxy; unset preserves the exec-proxy behavior. This is both the enable switch
 * and the "where do I put my email" answer for native preview.
 */
function nativePreviewEmails(): string[] {
  return (process.env.AUTOPOD_SANDBOX_NATIVE_PREVIEW_EMAILS ?? '')
    .split(/[,\s]+/)
    .map((email) => email.trim())
    .filter(Boolean);
}

/** Auto-stop preview containers after this duration (default 10 minutes). */
const PREVIEW_AUTO_STOP_MS = 10 * 60 * 1000;

const execFileAsync = promisify(execFile);

/**
 * Warn when a single-PR series pod is about to create a PR without the
 * series-level metadata it needs. With either `seriesName` or
 * `seriesDescription` missing, `buildPrTitle` falls back to using the brief's
 * task as the title and "Why" body — usually a sign that the client (CLI or
 * desktop) didn't forward `purpose.md` from the spec folder.
 */
function warnIfSinglePrSeriesMissingSeriesMeta(pod: Pod, logger: Logger): void {
  if (pod.prMode !== 'single' || !pod.seriesId) return;
  if (pod.seriesDescription && pod.seriesName) return;
  logger.warn(
    {
      podId: pod.id,
      seriesId: pod.seriesId,
      hasSeriesDescription: Boolean(pod.seriesDescription),
      hasSeriesName: Boolean(pod.seriesName),
    },
    'Single-PR series pod is missing seriesName or seriesDescription — PR title and "Why" will fall back to the brief task. Verify the client forwarded purpose.md when creating the series.',
  );
}

/** Merge new overrides into existing ones, deduplicating by findingId (latest wins). */
function mergeOverrides(
  existing: ValidationOverride[],
  incoming: ValidationOverride[],
): ValidationOverride[] {
  const map = new Map<string, ValidationOverride>();
  for (const o of existing) map.set(o.findingId, o);
  for (const o of incoming) map.set(o.findingId, o);
  return [...map.values()];
}

export interface ContainerManagerFactory {
  get(target: ExecutionTarget): ContainerManager;
}

export interface NetworkManager {
  buildNetworkConfig(
    policy: NetworkPolicy | null,
    mcpServers: InjectedMcpServer[],
    daemonGatewayIp: string,
    registries?: PrivateRegistry[],
    podId?: string,
    extraAllowedIps?: string[],
    extraAllowedHosts?: string[],
    daemonGatewayPort?: number,
  ): Promise<{ networkName: string; firewallScript: string } | null>;
  getGatewayIp(podId?: string): Promise<string>;
  /** Remove the per-pod bridge — called from pod cleanup. Idempotent. */
  destroyNetworkForPod?(podId: string): Promise<void>;
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

/** Identity of the human who created a pod, used to pre-fill git config inside the container. */
export interface PodCreator {
  email?: string | null;
  name?: string | null;
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

function podMemoryScopeIds(pod: Pod): string[] {
  return Array.from(new Set([pod.id, ...(pod.dependsOnPodIds ?? [])]));
}

function approvedMemoriesForPod(pod: Pod, memoryRepo: MemoryRepository): MemoryEntry[] {
  return [
    ...podMemoryScopeIds(pod).flatMap((podId) => memoryRepo.list('pod', podId, true)),
    ...(!pod.launchConfigDigest ? memoryRepo.list('profile', pod.profileName, true) : []),
    ...memoryRepo.list('global', null, true),
  ];
}

export async function selectMemoryBriefingForPod(opts: {
  pod: Pod;
  profile: PodExecutionSettings;
  memoryRepo: MemoryRepository;
  usageRepo?: MemoryUsageRepository;
  logger: Logger;
  createReviewerClient?: (
    profile: PodExecutionSettings,
    reviewerModelId: string,
    logger: Logger,
  ) => Promise<ProfileLlmClientResult>;
}): Promise<Awaited<ReturnType<typeof selectRelevantMemories>>> {
  const { pod, profile, memoryRepo, usageRepo, logger } = opts;
  if (pod.options.agentMode !== 'auto') {
    return { selected: [], unavailableReason: null };
  }

  const candidates = prefilterMemories({
    pod,
    memories: approvedMemoriesForPod(pod, memoryRepo),
  });
  if (candidates.length === 0) {
    return { selected: [], unavailableReason: null };
  }

  const reviewerModelId =
    profile.reviewerModel || profile.defaultModel || pod.model || 'claude-haiku-4-5';
  const createReviewerClient = opts.createReviewerClient ?? createProfileAnthropicClient;
  let reviewerClient: ProfileLlmClientResult | null = null;
  let reviewerUnavailableReason: string | undefined;
  try {
    reviewerClient = await createReviewerClient(profile, reviewerModelId, logger);
    if (!reviewerClient.ok) {
      reviewerUnavailableReason = reviewerClient.reason;
    }
  } catch (err) {
    reviewerUnavailableReason = 'reviewer_model_client_unavailable';
    logger.warn({ err, podId: pod.id }, 'Memory reviewer client unavailable — using fallback');
  }

  return selectRelevantMemories({
    pod,
    profile,
    deps: {
      memoryRepo,
      usageRepo,
      anthropicClient: reviewerClient?.ok ? reviewerClient.client : undefined,
      reviewerModel: reviewerClient?.ok ? reviewerClient.model : undefined,
      reviewerUnavailableReason,
      logger,
    },
  });
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

  const { materializeSpecFiles, captureDeployBaselineHashes } =
    createProvisioningMaterials(execFileAsync);
  const {
    assertSandboxAgentStreamingExecSupported,
    syncSandboxRuntimeSessionState,
    syncSandboxSeriesHandover,
  } = createProvisioningSandboxState(deps, { podRepo, containerManagerFactory, logger });
  const { installGhBinary, installAzViaPip } = createProvisioningToolInstallation({ logger });

  function executionForPod(pod: Pod): PodExecutionSettings {
    const resolved = deps.launchConfiguration?.read(pod.id);
    if (resolved && deps.launchConfiguration)
      return deps.launchConfiguration.executionSettings(resolved);
    if (pod.launchConfigDigest)
      throw new AutopodError(
        'Immutable launch configuration is unavailable',
        'SNAPSHOT_CORRUPT',
        500,
      );
    return profileStore.get(pod.profileName);
  }
  function executionCredentialsFor(
    config: EffectiveLaunchConfig,
  ): LaunchExecutionCredentials | undefined {
    const credentials = deps.launchConfiguration?.credentials;
    if (!credentials && Object.keys(config.credentialReferences).length)
      throw new AutopodError(
        'Scoped execution credentials are unavailable',
        'SECRET_EXECUTION_ADAPTER_REQUIRED',
        503,
      );
    return credentials;
  }

  const { validationEnvironmentForPod } = createValidationEnvironment(deps, {
    executionCredentialsFor,
    containerManagerFactory,
  });

  function injectionsForPod(pod: Pod): typeof daemonConfig {
    return pod.launchConfigDigest
      ? { mcpServers: [], claudeMdSections: [], skills: [] }
      : daemonConfig;
  }
  const { prManagerFactory } = createDeliveryProvider(rawPrManagerFactory, podRepo);

  const hostFetchRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleHostFetchRetry(pod: Pod, error: GitTransientFetchError): void {
    const previous = pod.infrastructureFailure;
    const attemptCount =
      previous?.source === 'git-fetch' &&
      previous.branch === error.branch &&
      previous.purpose === error.purpose
        ? previous.attemptCount + 1
        : 1;
    const delayMs = attemptCount === 1 ? 30_000 : attemptCount === 2 ? 120_000 : 300_000;
    const retryNotBefore = new Date(Date.now() + delayMs).toISOString();
    podRepo.update(pod.id, {
      infrastructureFailure: {
        source: 'git-fetch',
        code: 'GIT_FETCH_TRANSIENT',
        branch: error.branch,
        purpose: error.purpose,
        diagnostics: error.diagnostics,
        attemptCount,
        occurredAt: new Date().toISOString(),
        recoveryDisposition: 'automatic_retry_scheduled',
        retryNotBefore,
      },
      failureReason: null,
    });
    const existing = hostFetchRetryTimers.get(pod.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      hostFetchRetryTimers.delete(pod.id);
      let current: Pod;
      try {
        current = podRepo.getOrThrow(pod.id);
      } catch {
        return;
      }
      if (
        current?.status === 'queued' &&
        current.infrastructureFailure?.source === 'git-fetch' &&
        current.infrastructureFailure.retryNotBefore === retryNotBefore
      ) {
        enqueueSession(pod.id);
      }
    }, delayMs);
    timer.unref();
    hostFetchRetryTimers.set(pod.id, timer);
    emitActivityStatus(
      pod.id,
      `Remote ${error.purpose} branch fetch failed; retrying automatically.`,
    );
  }

  function hasDurableAgentExecutionEvidence(pod: Pod): boolean {
    if (
      pod.worktreeCompromised ||
      pod.claudeSessionId !== null ||
      pod.codexSessionId !== null ||
      pod.piSessionId !== null ||
      pod.inputTokens > 0 ||
      pod.outputTokens > 0 ||
      pod.costUsd > 0 ||
      pod.taskSummary !== null ||
      pod.lastValidationResult !== null ||
      pod.prUrl !== null ||
      hasLatestPersistedAgentTerminalEventComplete(deps.eventRepo, pod.id)
    ) {
      return true;
    }
    return (deps.providerAttemptRepo?.list(pod.id) ?? []).some(
      (attempt) =>
        attempt.nativeSessionId !== null ||
        attempt.inputTokens > 0 ||
        attempt.outputTokens > 0 ||
        attempt.costUsd > 0,
    );
  }

  function sandboxInfrastructureFailure(
    error: SandboxInfrastructureError,
    phase: 'setup' | 'agent',
    safeAgentRestart: boolean,
    recoveryDisposition:
      | 'automatic_retry_scheduled'
      | 'automatic_retry_exhausted'
      | 'agent_execution_ambiguous'
      | 'sandbox_cleanup_unconfirmed',
    retryNotBefore: string | null,
  ): Pod['infrastructureFailure'] {
    return {
      source: error.source,
      code: error.code,
      phase,
      statusCode: error.statusCode,
      diagnostics: error.diagnostics,
      safeAgentRestart,
      recoveryDisposition,
      occurredAt: new Date().toISOString(),
      retryNotBefore,
    };
  }

  async function tryRecoverTransientSandboxFailure(
    podId: string,
    capturedPod: Pod,
    runtimeEventObserved: boolean,
    error: SandboxInfrastructureError,
    phase: OperatorFailurePhase,
  ): Promise<boolean> {
    if (
      capturedPod.executionTarget !== 'sandbox' ||
      (phase !== 'setup' && phase !== 'agent') ||
      !ownsLifecycle(podId, capturedPod.lifecycleGeneration, null)
    ) {
      return false;
    }

    const validationOnlyRecovery = capturedPod.skipAgent;
    const durableEvidence = hasDurableAgentExecutionEvidence(capturedPod);
    // A fresh-container validation-only run deliberately carries the completed
    // agent's durable evidence forward. That evidence is not ambiguous for this
    // lifecycle: skipAgent fences processPod from starting or resuming an agent.
    // Treat a setup failure here like any other pre-agent transport failure and
    // preserve skipAgent across the fresh-sandbox retry.
    if (!validationOnlyRecovery && (runtimeEventObserved || durableEvidence)) {
      podRepo.update(podId, {
        infrastructureFailure: sandboxInfrastructureFailure(
          error,
          phase,
          false,
          'agent_execution_ambiguous',
          null,
        ),
      });
      return false;
    }
    const startupLedger = podRepo.sandboxStartupRetries;
    let exhausted = capturedPod.infrastructureRecoveryCount >= 1;
    if (startupLedger) {
      const input = sandboxStartupRetryInput(capturedPod);
      try {
        startupLedger.assertCanAdmit(
          podId,
          capturedPod.lifecycleGeneration,
          input.identity,
          input.bindingHash,
          [...(deps.sandboxInfrastructureRetryBackoffMs ?? [30_000])],
        );
        exhausted = false;
      } catch (admissionError) {
        if (!(admissionError instanceof TaskRetryBlockedError)) throw admissionError;
        exhausted = true;
        emitActivityStatus(podId, admissionError.message);
      }
    }
    if (exhausted) {
      podRepo.update(podId, {
        infrastructureFailure: sandboxInfrastructureFailure(
          error,
          phase,
          true,
          'automatic_retry_exhausted',
          null,
        ),
      });
      return false;
    }

    // Fence every stale lifecycle continuation before touching the sandbox identity.
    const recoveryGeneration = podRepo.incrementLifecycleGeneration(podId);
    const oldContainerId = capturedPod.containerId;
    let deleted = oldContainerId === null;
    if (oldContainerId) {
      try {
        await containerManagerFactory.get('sandbox').kill(oldContainerId);
        deleted = true;
      } catch (cleanupError) {
        logger.warn(
          { err: cleanupError, podId, containerId: oldContainerId },
          'Fresh sandbox recovery could not prove old sandbox deletion',
        );
      }
    }
    const current = podRepo.getOrThrow(podId);
    if (
      current.lifecycleGeneration !== recoveryGeneration ||
      current.containerId !== oldContainerId
    ) {
      return true;
    }
    if (!deleted) {
      podRepo.update(podId, {
        infrastructureFailure: sandboxInfrastructureFailure(
          error,
          phase,
          false,
          'sandbox_cleanup_unconfirmed',
          null,
        ),
      });
      return false;
    }

    const startupState = startupLedger?.state(podId);
    const delay = startupState?.backoffsMs?.[startupState.transientRetryCount] ?? 30_000;
    const retryNotBefore = new Date(Date.now() + delay).toISOString();
    closeProviderAttempt(podId, 'aborted');
    await killSidecarsForPod(podId);
    await destroyPodNetwork(podId);
    const afterCleanup = podRepo.getOrThrow(podId);
    if (
      afterCleanup.lifecycleGeneration !== recoveryGeneration ||
      afterCleanup.containerId !== oldContainerId
    ) {
      return true;
    }
    podRepo.update(podId, {
      containerId: null,
      recoveryWorktreePath: afterCleanup.worktreePath,
      infrastructureRecoveryCount: capturedPod.infrastructureRecoveryCount + 1,
      infrastructureFailure: sandboxInfrastructureFailure(
        error,
        phase,
        true,
        'automatic_retry_scheduled',
        retryNotBefore,
      ),
      failureReason: null,
      completedAt: null,
    });
    const queued = podRepo.getOrThrow(podId);
    if (queued.status !== 'queued') podRepo.update(podId, { status: 'queued' });
    emitActivityStatus(
      podId,
      'Azure sandbox was unavailable before agent execution; retrying within the task startup budget.',
    );
    if (deps.requeueSessionAfterCurrent) {
      deps.requeueSessionAfterCurrent(podId);
    } else {
      // Compatibility for injected test/legacy managers: defer until this active
      // processPod call has unwound, matching PodQueue.requeueAfterCurrent().
      setImmediate(() => deps.enqueueSession(podId));
    }
    return true;
  }

  async function resolveGitCredential(profile: PodExecutionSettings): Promise<string | undefined> {
    if (profile.prProvider === 'ado') return deps.azureDevOpsAuth?.getToken();
    if (!profile.repoUrl) {
      throw new Error(`GitHub profile "${profile.name}" does not have a repository URL`);
    }
    let hostname: string;
    try {
      hostname = new URL(profile.repoUrl).hostname.toLowerCase();
    } catch {
      throw new Error(`GitHub profile "${profile.name}" has an invalid repository URL`);
    }
    if (hostname !== 'github.com') {
      throw new Error(
        `GitHub profile "${profile.name}" must use an exact github.com repository host`,
      );
    }
    return (await deps.githubAuth?.resolveCredential())?.token;
  }

  const { primeRuntimeForResume } = createRuntimeResumeContext(deps, {
    executionForPod,
    executionCredentialsFor,
    injectionsForPod,
    mcpBaseUrl,
    buildCodeIntelligenceServers,
    resolvedReasoningEffort,
  });
  const { mergeQueue } = createDeliveryMergeQueue();

  /** Per-pod HAProxy denial log receivers. Started after container spawn in
   *  restricted mode; stopped from `cleanupContainer`. Map is the source of
   *  truth — any cleanup path that goes through `cleanupContainer` reaps the
   *  handle. */
  const haproxyDenyHandles = new Map<string, HaproxyDenyStreamHandle>();
  const { readinessService, refreshReadiness } = createReadinessRefresh(deps, {
    podRepo,
    validationRepo,
    scanRepo,
    escalationRepo,
    qualityScoreRepo,
    logger,
  });

  /** Best-effort: start the HAProxy deny log receiver for a restricted-mode
   *  pod and wire each denied SNI to a `pod.firewall_denied` event. Failures
   *  here must not block the pod — denial visibility is informational. */
  async function startHaproxyDenyReceiver(pod: Pod, containerId: string): Promise<void> {
    const cm = containerManagerFactory.get(pod.executionTarget);
    try {
      const handle = await streamHaproxyDenials(
        cm,
        containerId,
        ({ sni, src }) => {
          eventBus.emit({
            type: 'pod.firewall_denied',
            timestamp: new Date().toISOString(),
            podId: pod.id,
            sni,
            src,
          });
        },
        logger,
      );
      haproxyDenyHandles.set(pod.id, handle);
    } catch (err) {
      logger.warn(
        { err, podId: pod.id, containerId },
        'Failed to start HAProxy deny receiver — pod runs without denial visibility',
      );
    }
  }

  /** Stop the deny receiver for a pod, if one is registered. Idempotent. */
  async function stopHaproxyDenyReceiver(podId: string): Promise<void> {
    const handle = haproxyDenyHandles.get(podId);
    if (!handle) return;
    haproxyDenyHandles.delete(podId);
    try {
      await handle.stop();
    } catch (err) {
      logger.warn({ err, podId }, 'Failed to stop HAProxy deny receiver');
    }
  }

  /** Destroy the per-pod Docker bridge. Must be called AFTER the pod + all
   *  sidecars are killed, otherwise Docker refuses with "has active endpoints".
   *  No-ops when the network manager doesn't support teardown (tests / older
   *  implementations) or isn't wired. Best-effort unless `strict` is requested. */
  async function destroyPodNetwork(podId: string, strict = false): Promise<void> {
    if (!networkManager?.destroyNetworkForPod) return;
    try {
      await networkManager.destroyNetworkForPod(podId);
    } catch (err) {
      logger.warn({ err, podId }, 'Failed to destroy pod network');
      if (strict) throw err;
    }
  }

  /** Hard ceiling on container cleanup at terminal transitions. A wedged Docker
   *  daemon must never keep an operator endpoint hanging — once the pod is
   *  conceptually done, we proceed even if Docker is still chewing on the API
   *  call. 15s is generous for a cooperative `stop -t 10` + remove. */
  const CONTAINER_CLEANUP_TIMEOUT_MS = 15_000;

  /**
   * Best-effort container cleanup with a hard timeout. Use at terminal
   * transitions (complete, force-complete) and operator escape hatches (kick)
   * so a wedged Docker engine can't tie up the request. Never throws — the
   * caller has already decided the pod is done.
   *
   * mode='kill' stops + removes (terminal — pod will never restart).
   * mode='stop' only stops, leaving the container so it can be restarted later
   * (preview, rejection retry, resume).
   */
  async function cleanupContainer(
    pod: Pod,
    label: string,
    mode: 'kill' | 'stop' = 'kill',
    assertReleaseAllowed?: () => void,
  ): Promise<void> {
    assertReleaseAllowed?.();
    const targetContainerId = pod.containerId;
    if (!targetContainerId) {
      if (
        mode === 'kill' &&
        podRepo.getOrThrow(pod.id).lifecycleGeneration === pod.lifecycleGeneration
      )
        deps.launchConfiguration?.pim?.release(pod.id);
      return;
    }
    logger.info(
      { podId: pod.id, containerId: targetContainerId, generation: pod.lifecycleGeneration },
      'Cleaning lifecycle container by captured identity',
    );
    const ownsSharedResources = ownsLifecycle(pod.id, pod.lifecycleGeneration, targetContainerId);
    if (ownsSharedResources) await stopSandboxPreviewProxy(pod.id);
    assertReleaseAllowed?.();
    if (ownsSharedResources && mode === 'kill' && deps.beforeContainerCleanup) {
      let extractionTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        deps
          .beforeContainerCleanup(pod.id)
          .catch((err) =>
            logger.warn({ err, podId: pod.id, label }, 'Pre-cleanup memory extraction failed'),
          )
          .finally(() => {
            if (extractionTimer) clearTimeout(extractionTimer);
          }),
        new Promise<void>((resolve) => {
          extractionTimer = setTimeout(() => {
            logger.warn(
              { podId: pod.id, label, timeoutMs: 20_000 },
              'Pre-cleanup memory extraction timed out — continuing container cleanup',
            );
            resolve();
          }, 20_000);
        }),
      ]);
    }
    assertReleaseAllowed?.();
    // Stop denial receiver before killing/stopping the container so the
    // long-running socat exec gets a clean shutdown signal.
    if (ownsSharedResources) await stopHaproxyDenyReceiver(pod.id);
    assertReleaseAllowed?.();
    const cm = containerManagerFactory.get(pod.executionTarget);
    const op = mode === 'kill' ? cm.kill(targetContainerId) : cm.stop(targetContainerId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deleted = await Promise.race([
      op
        .then(() => true)
        .catch((err) => {
          logger.warn({ err, podId: pod.id, label, mode }, `${label}: container ${mode} failed`);
          return false;
        })
        .finally(() => {
          if (timer) clearTimeout(timer);
        }),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          logger.warn(
            { podId: pod.id, label, mode, timeoutMs: CONTAINER_CLEANUP_TIMEOUT_MS },
            `${label}: container ${mode} timed out — proceeding without waiting`,
          );
          resolve(false);
        }, CONTAINER_CLEANUP_TIMEOUT_MS);
      }),
    ]);
    assertReleaseAllowed?.();
    if (mode === 'kill' && deleted && pod.executionTarget === 'sandbox') {
      const current = podRepo.getOrThrow(pod.id);
      if (
        current.lifecycleGeneration === pod.lifecycleGeneration &&
        current.containerId === targetContainerId
      ) {
        podRepo.update(pod.id, { containerId: null });
      }
    }
    if (mode === 'kill' && ownsSharedResources) {
      deps.launchConfiguration?.pim?.release(pod.id);
      forgetMaxCredentialLineage(pod.id);
    }
  }

  const sandboxPreviewProxies = new Map<
    string,
    { containerId: string; proxy: SandboxPreviewProxy }
  >();
  // Pods whose preview is served by a native platform port (not the exec proxy).
  const nativePreviewPorts = new Map<string, { containerId: string; port: number; url: string }>();

  /**
   * Try to expose the app port on the platform's native public URL (Entra-gated
   * to the configured allowlist). Returns the URL on success, or null to fall
   * back to the daemon-side exec proxy. Never throws — a native failure must not
   * break preview, which has a working fallback.
   */
  async function tryNativeSandboxPreview(pod: Pod, containerId: string): Promise<string | null> {
    const emails = nativePreviewEmails();
    if (emails.length === 0) return null;
    const cm = containerManagerFactory.get('sandbox');
    if (!cm.exposePort) return null;

    const cached = nativePreviewPorts.get(pod.id);
    if (cached?.containerId === containerId) return cached.url;
    if (cached) nativePreviewPorts.delete(pod.id);

    try {
      const exposed = await cm.exposePort(containerId, CONTAINER_APP_PORT, { entraEmails: emails });
      if (!exposed.url) {
        logger.warn(
          { podId: pod.id },
          'Native sandbox port exposed but no URL assigned; falling back to preview proxy',
        );
        return null;
      }
      nativePreviewPorts.set(pod.id, { containerId, port: CONTAINER_APP_PORT, url: exposed.url });
      if (pod.previewUrl !== exposed.url) {
        podRepo.update(pod.id, { previewUrl: exposed.url });
      }
      logger.info({ podId: pod.id, url: exposed.url }, 'Native sandbox preview URL exposed');
      return exposed.url;
    } catch (err) {
      logger.warn(
        { err, podId: pod.id },
        'Native sandbox port exposure failed; falling back to preview proxy',
      );
      return null;
    }
  }

  async function ensureSandboxPreviewProxy(pod: Pod): Promise<string> {
    if (pod.executionTarget !== 'sandbox') {
      if (!pod.previewUrl) {
        throw new AutopodError(`Pod ${pod.id} has no preview URL`, 'INVALID_STATE', 409);
      }
      return pod.previewUrl;
    }

    if (!pod.containerId) {
      throw new AutopodError(
        `Pod ${pod.id} has no container — cannot start preview`,
        'INVALID_STATE',
        409,
      );
    }

    // Prefer the platform's native public port when configured; fall back to the
    // daemon-side exec proxy otherwise (or on failure).
    const nativeUrl = await tryNativeSandboxPreview(pod, pod.containerId);
    if (nativeUrl) {
      // A native URL supersedes any previously-started exec proxy for this pod.
      if (sandboxPreviewProxies.has(pod.id)) await stopSandboxPreviewProxy(pod.id);
      return nativeUrl;
    }

    let previewUrl = pod.previewUrl;
    // A stale native URL (native since disabled/failed) must not be reused as a
    // proxy host-port — reset it so a fresh 127.0.0.1 URL is allocated below.
    if (previewUrl && !previewUrl.startsWith('http://127.0.0.1')) {
      previewUrl = null;
    }
    if (!previewUrl) {
      previewUrl = `http://127.0.0.1:${allocateHostPort()}`;
      podRepo.update(pod.id, { previewUrl });
    }

    const existing = sandboxPreviewProxies.get(pod.id);
    if (existing?.containerId === pod.containerId) return existing.proxy.url;
    if (existing) await stopSandboxPreviewProxy(pod.id);

    const hostPort = parsePreviewPort(previewUrl);
    if (!hostPort) {
      throw new AutopodError(`Pod ${pod.id} has invalid preview URL`, 'INVALID_STATE', 409);
    }

    const proxy = await startSandboxPreviewProxy({
      podId: pod.id,
      containerId: pod.containerId,
      hostPort,
      containerPort: CONTAINER_APP_PORT,
      containerManager: containerManagerFactory.get('sandbox'),
      logger,
    });
    sandboxPreviewProxies.set(pod.id, { containerId: pod.containerId, proxy });
    if (proxy.url !== previewUrl) {
      podRepo.update(pod.id, { previewUrl: proxy.url });
    }
    return proxy.url;
  }

  async function stopSandboxPreviewProxy(podId: string): Promise<void> {
    const native = nativePreviewPorts.get(podId);
    if (native) {
      nativePreviewPorts.delete(podId);
      const cm = containerManagerFactory.get('sandbox');
      await cm.unexposePort?.(native.containerId, native.port).catch((err) => {
        logger.warn({ err, podId }, 'Failed to remove native sandbox preview port');
      });
    }
    const existing = sandboxPreviewProxies.get(podId);
    if (!existing) return;
    sandboxPreviewProxies.delete(podId);
    await existing.proxy.close().catch((err) => {
      logger.warn({ err, podId }, 'Failed to close sandbox preview proxy');
    });
  }

  function parsePreviewPort(previewUrl: string): number | null {
    try {
      const parsed = new URL(previewUrl);
      const port = Number.parseInt(parsed.port, 10);
      return Number.isSafeInteger(port) && port >= 0 ? port : null;
    } catch {
      return null;
    }
  }

  /** Tear down all sidecars attached to a pod. Re-reads the pod so it sees
   *  the most recent `sidecarContainerIds` even if the caller's snapshot is
   *  stale. No-ops if the pod never spawned any, or if no SidecarManager is
   *  configured (older deployments). Best-effort unless `strict` is requested. */
  async function killSidecarsForPod(
    podId: string,
    strict = false,
    assertCurrent?: () => void,
    retainMetadata = false,
  ): Promise<void> {
    assertCurrent?.();
    if (!sidecarManager) {
      if (strict && Object.keys(podRepo.getOrThrow(podId).sidecarContainerIds ?? {}).length > 0)
        throw new Error('Sidecar cleanup capability unavailable');
      return;
    }
    let current: Pod;
    try {
      current = podRepo.getOrThrow(podId);
    } catch {
      return;
    }
    const ids = current.sidecarContainerIds;
    if (!ids) return;
    const entries = Object.entries(ids);
    const results = await Promise.allSettled(
      entries.map(([, containerId]) => sidecarManager.kill(containerId)),
    );
    const failures: unknown[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') continue;
      const [name, containerId] = entries[index] ?? ['unknown', 'unknown'];
      failures.push(result.reason);
      logger.warn(
        { err: result.reason, podId, sidecarName: name, containerId },
        'Failed to kill sidecar',
      );
    }
    if (failures.length > 0 && strict) {
      throw new AggregateError(failures, `Failed to clean up sidecars for pod ${podId}`);
    }
    assertCurrent?.();
    if (!retainMetadata) podRepo.update(podId, { sidecarContainerIds: null });
  }

  /** Delete any branches this pod pushed to the test repo via
   *  `ado.run_test_pipeline`. Best-effort — network failures or already-deleted
   *  branches are logged, not thrown. Cleared from the DB afterwards so a
   *  cron-level sweep can see "this pod has no pending test branches".
   */
  async function cleanupTestRunBranches(
    podId: string,
    options?: { strict: boolean; assertCurrent: () => void; retainMetadata?: boolean },
  ): Promise<void> {
    options?.assertCurrent();
    let current: Pod;
    try {
      current = podRepo.getOrThrow(podId);
    } catch {
      return;
    }
    const branches = current.testRunBranches;
    if (!branches || branches.length === 0) return;
    const profile = executionForPod(current);
    const cfg = profile.testPipeline;
    if (!cfg || !cfg.enabled || !deps.azureDevOpsAuth) {
      if (options?.strict) throw new Error('Test branch cleanup capability unavailable');
      podRepo.update(podId, { testRunBranches: null });
      return;
    }
    const token = await deps.azureDevOpsAuth.getToken();
    options?.assertCurrent();
    if (!current.worktreePath) {
      // No worktree to run git from. Can't delete; leave a daily sweep to reap.
      if (options?.strict) throw new Error('Test branch worktree unavailable');
      logger.warn({ podId, branches }, 'Cannot cleanup test-run branches — pod has no worktree');
      podRepo.update(podId, { testRunBranches: null });
      return;
    }
    const results = await Promise.allSettled(
      branches.map(async (branch) => {
        try {
          options?.assertCurrent();
          await execFileAsync(
            'git',
            ['-C', current.worktreePath as string, 'push', cfg.testRepo, '--delete', branch],
            {
              timeout: 30_000,
              env: authenticatedGitEnvironment(cfg.testRepo, `Bearer ${token}`),
            },
          );
        } catch (err) {
          // Git errors can include authentication headers; never retain the raw provider error.
          logger.warn({ podId, branch }, 'Failed to delete test-run branch');
          if (options?.strict) throw new Error('Test branch deletion was not confirmed');
        }
      }),
    );
    options?.assertCurrent();
    if (options?.strict && results.some((result) => result.status === 'rejected'))
      throw new Error('Test branch cleanup incomplete');
    if (!options?.retainMetadata) podRepo.update(podId, { testRunBranches: null });
  }

  /** Active auto-stop timers for preview containers, keyed by podId. */
  const previewTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Active commit polling intervals, keyed by podId. */
  const commitPolling = createPollingCoordinator((err, podId) =>
    logger.debug({ err, podId }, 'Commit polling failed, skipping cycle'),
  );

  const COMMIT_POLL_INTERVAL_MS = 60_000;
  const { mergePolling, DEFAULT_MERGE_POLL_INTERVAL_MS } = createDeliveryPollingState(logger);

  /** Active AbortControllers for in-progress validation runs, keyed by podId. */
  const { validationAbortControllers, attemptExtensionRuns, pendingUpdateFromBaseIntents } =
    createValidationWorkflowState();
  /** Slow operator recovery is detached from HTTP and coalesced per pod. */

  const infrastructureResumeRuns = new Map<string, Promise<void>>();
  const artifactResumeRuns = new Map<string, Promise<void>>();
  const artifactCompletionRuns = new Map<string, Promise<void>>();
  const coordinateInteractiveCompletion =
    createInteractiveCompletionCoordinator<Awaited<ReturnType<PodManager['completeSession']>>>();
  const pauseIntents = new Map<string, symbol>();
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

  const PAUSE_QUIESCENCE_TIMEOUT_MS = 10_000;

  /** Active post-validation advisory QA runs, keyed by podId.
   *  These are nonblocking for validation outcome, but approval must not cut
   *  off the preview/container before screenshot-backed advisory QA finishes. */
  const advisoryRuns = new Map<string, Promise<ValidationResult>>();

  // Serialise advisory browser QA across pods so that concurrent validations
  // don't all hammer the reviewer model's rate limit window at once. Inner
  // retry handles transient 429s; the semaphore prevents the collision.
  const ADVISORY_QA_MAX_CONCURRENCY = 1;
  let advisoryQaActive = 0;
  const advisoryQaWaiters: Array<() => void> = [];

  function acquireAdvisoryQaSlot(): Promise<void> {
    if (advisoryQaActive < ADVISORY_QA_MAX_CONCURRENCY) {
      advisoryQaActive++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => advisoryQaWaiters.push(resolve));
  }

  function releaseAdvisoryQaSlot(): void {
    const next = advisoryQaWaiters.shift();
    if (next) {
      next();
    } else {
      advisoryQaActive--;
    }
  }

  function cleanupContainerAfterAdvisorySettles(
    pod: Pod,
    label: string,
    mode: 'kill' | 'stop' = 'kill',
    assertReleaseAllowed?: () => void,
  ): Promise<void> {
    assertGuidanceCollected(pod.id);
    const advisoryRun = advisoryRuns.get(pod.id);
    if (!advisoryRun) {
      return cleanupContainer(pod, label, mode, assertReleaseAllowed);
    }

    emitActivityStatus(pod.id, 'Keeping container running until advisory browser QA finishes…');
    void advisoryRun
      .finally(() => cleanupContainer(pod, label, mode, assertReleaseAllowed))
      .catch((err) =>
        logger.warn(
          { err, podId: pod.id, label, mode },
          'Deferred container cleanup after advisory QA failed',
        ),
      );
    return Promise.resolve();
  }

  /** Pods whose operator triggered update-from-base while they were validating.
   *  Consumed by the validation unwind to run the rebase instead of retrying the agent. */

  /** Pods whose branch was cleanly rebased by update-from-base.
   *  The next pushBranch call for these pods may use --force-with-lease; cleared after one use. */
  const forceWithLeaseAllowances = new Set<string>();
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

  /** Stuck-running watchdog interval handle (single global timer). */
  let stuckPodWatchdog: ReturnType<typeof setInterval> | null = null;
  /** Unsubscribe fn for the host.resumed wake-recovery listener. */
  let unsubscribeWakeRecovery: (() => void) | null = null;

  /**
   * Returns the pod whose branch/baseBranch/prUrl a fix pod should inherit.
   *
   * In single-PR series, the triggering pod (`parent`) may not be the PR
   * owner — the PR was opened by one specific pod in the series, and the
   * fix pod must operate on that pod's branch or its commits land
   * on a branch that isn't attached to the PR. Throws if the series has
   * no PR-owning pod yet (fix-spawn is meaningless in that case).
   *
   * For non-`single` modes, returns `parent` unchanged: stacked pods own
   * their own PR per pod, and standalone pods are their own PR owner.
   */
  const resolveBranchSource = (parent: Pod): Pod => {
    if (parent.prMode !== 'single') return parent;
    if (!parent.seriesId) {
      throw new AutopodError(
        `Pod ${parent.id} has prMode='single' but no seriesId — cannot resolve PR owner`,
        'INVALID_STATE',
        500,
      );
    }
    const seriesPods = podRepo.getPodsBySeries(parent.seriesId);
    const prOwners = seriesPods.filter((p) => p.prUrl);
    if (prOwners.length === 0) {
      throw new AutopodError(
        `Cannot spawn fix pod for pod ${parent.id}: no pod in series ${parent.seriesId} owns a PR yet`,
        'INVALID_STATE',
        409,
      );
    }
    let prOwner = prOwners[0] as Pod;
    if (prOwners.length > 1) {
      const matching = parent.prUrl ? prOwners.find((p) => p.prUrl === parent.prUrl) : undefined;
      prOwner = matching ?? prOwner;
      logger.warn(
        {
          podId: parent.id,
          seriesId: parent.seriesId,
          prOwnerCount: prOwners.length,
          chosenPodId: prOwner.id,
        },
        'Single-mode series has multiple PR-owning pods — picked one deterministically',
      );
    }
    if (prOwner.id !== parent.id) {
      logger.info(
        {
          podId: parent.id,
          prOwnerId: prOwner.id,
          prOwnerBranch: prOwner.branch,
          triggeringBranch: parent.branch,
        },
        'Fix pod redirected to PR-owning pod in single-mode series',
      );
    }
    return prOwner;
  };
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

  /** Start polling git commit count inside one owned lifecycle and container. */
  function startCommitPolling(podId: string): void {
    const expected = podRepo.getOrThrow(podId);
    let captureAttempted = false;
    commitPolling.start(podId, COMMIT_POLL_INTERVAL_MS, async (ownership) => {
      const current = (): Pod | null => {
        try {
          const pod = podRepo.getOrThrow(podId);
          if (
            ownership.isCurrent() &&
            pod.status === 'running' &&
            pod.containerId &&
            pod.lifecycleGeneration === expected.lifecycleGeneration &&
            pod.containerId === expected.containerId &&
            pod.executionTarget === expected.executionTarget &&
            pod.worktreePath === expected.worktreePath &&
            pod.branch === expected.branch &&
            pod.baseBranch === expected.baseBranch
          )
            return pod;
        } catch {
          /* Deleted or replaced pods have no polling authority. */
        }
        ownership.stop();
        return null;
      };
      let pod = current();
      if (!pod?.containerId) return;
      const cm = containerManagerFactory.get(pod.executionTarget);
      if (!captureAttempted) {
        captureAttempted = true;
        if (!pod.startCommitSha) {
          try {
            const shaResult = await cm.execInContainer(
              pod.containerId,
              ['git', 'rev-parse', 'HEAD'],
              {
                cwd: '/workspace',
                timeout: 5_000,
              },
            );
            pod = current();
            if (!pod) return;
            if (!pod.startCommitSha && shaResult.exitCode === 0 && shaResult.stdout.trim())
              podRepo.update(podId, { startCommitSha: shaResult.stdout.trim() });
          } catch {
            if (!current()) return;
            logger.debug({ podId }, 'Failed to capture start commit SHA');
          }
        }
      }
      pod = current();
      if (!pod?.containerId) return;
      // Use the captured starting SHA; retain the existing legacy base fallback.
      const exclusionRef = pod.startCommitSha ?? pod.baseBranch ?? 'main';
      const [countResult, timeResult] = await Promise.all([
        cm.execInContainer(
          pod.containerId,
          ['git', 'rev-list', '--count', 'HEAD', `^${exclusionRef}`],
          {
            cwd: '/workspace',
            timeout: 5_000,
          },
        ),
        cm.execInContainer(pod.containerId, ['git', 'log', '-1', '--format=%cI'], {
          cwd: '/workspace',
          timeout: 5_000,
        }),
      ]);
      const observed = current();
      if (!observed || observed.startCommitSha !== pod.startCommitSha) return;
      const commitCount = Number.parseInt(countResult.stdout.trim(), 10) || 0;
      const lastCommitAt = timeResult.exitCode === 0 ? timeResult.stdout.trim() : null;
      podRepo.update(podId, { commitCount, lastCommitAt });
      if (pod.executionTarget === 'sandbox') {
        const decision = await deps.workspaceCheckpointController?.poll(podId);
        if (!current()) return;
        if (decision?.degraded)
          emitActivityStatus(
            podId,
            'Durability degraded — retaining sandbox until checkpoint succeeds.',
          );
      }
    });
  }

  /** Stop only the currently registered poller; pending callbacks lose authority. */
  function stopCommitPolling(podId: string): void {
    commitPolling.stop(podId);
  }

  /** Cancel and remove an auto-stop timer for a pod if one exists. */
  function clearPreviewTimer(podId: string): void {
    const timer = previewTimers.get(podId);
    if (timer) {
      clearTimeout(timer);
      previewTimers.delete(podId);
    }
  }

  /** Schedule an auto-stop timer that will stop the container after PREVIEW_AUTO_STOP_MS. */
  function schedulePreviewAutoStop(
    podId: string,
    containerId: string,
    target: import('@autopod/shared').ExecutionTarget,
  ): void {
    clearPreviewTimer(podId);
    const timer = setTimeout(async () => {
      previewTimers.delete(podId);
      try {
        await stopSandboxPreviewProxy(podId);
        const cm = containerManagerFactory.get(target);
        await cm.stop(containerId);
        logger.info({ podId, containerId }, 'Preview auto-stopped after timeout');
      } catch (err) {
        logger.warn({ err, podId }, 'Failed to auto-stop preview container');
      }
    }, PREVIEW_AUTO_STOP_MS);
    // Unref so the timer doesn't prevent process exit
    timer.unref();
    previewTimers.set(podId, timer);
  }

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

  async function preserveSandboxAfterAgentFailure(podId: string, reason: string): Promise<void> {
    const pod = podRepo.getOrThrow(podId);
    if (pod.executionTarget !== 'sandbox' || !pod.containerId || !pod.worktreePath) return;
    try {
      await preservePodWorkspace(pod, reason);
      await cleanupContainer(pod, 'agent-failure-preserved');
    } catch (preserveErr) {
      emitActivityStatus(
        podId,
        'Workspace preservation failed after the agent exit — retaining the sandbox and blocking destructive Rework.',
      );
      logger.error(
        { err: preserveErr, podId, containerId: pod.containerId },
        'Failed to preserve workspace after agent failure',
      );
    }
  }

  async function tryRecoverAfterWorkspaceSyncFailure(
    pod: Pod,
    err: unknown,
    phase: 'auto-commit' | 'validation',
  ): Promise<boolean> {
    if (!pod.containerId || !pod.worktreePath) return false;

    const detail = describeSyncFailure(err);
    logger.warn(
      { err, podId: pod.id, phase },
      'Workspace sync failed - attempting live container recovery',
    );
    emitActivityStatus(
      pod.id,
      `Workspace sync failed before ${phase} (${detail}). Attempting live container recovery...`,
    );

    const cm = containerManagerFactory.get(pod.executionTarget);
    const recovered = await recoverWorktreeFromContainer(
      pod.containerId,
      pod.worktreePath,
      cm,
      pod.id,
    );
    if (!recovered) return false;

    podRepo.update(pod.id, { worktreeCompromised: false, preSubmitReview: null });
    emitActivityStatus(
      pod.id,
      `Workspace recovered from live container after sync failure; continuing ${phase}.`,
    );
    logger.info({ podId: pod.id, phase }, 'Recovered worktree after workspace sync failure');
    return true;
  }

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

  function handleDeletionGuardError(podId: string, err: unknown): boolean {
    if (!(err instanceof DeletionGuardError)) return false;
    try {
      podRepo.update(podId, { worktreeCompromised: true });
    } catch (updateErr) {
      logger.warn({ err: updateErr, podId }, 'Failed to persist worktreeCompromised flag');
    }
    eventBus.emit({
      type: 'pod.worktree_compromised',
      timestamp: new Date().toISOString(),
      podId,
      deletionCount: err.deletionCount,
      threshold: err.threshold,
    });
    emitActivityStatus(
      podId,
      `Worktree out of sync with container — ${err.deletionCount} phantom deletions blocked. Do not retry PR; work may still live in the container.`,
    );
    return true;
  }

  function ownsArtifactCompletion(
    pod: Pod,
    allowRemovedContainer = false,
    allowQueuedGuidance = false,
  ): boolean {
    const current = podRepo.getOrThrow(pod.id);
    return (
      current.lifecycleGeneration === pod.lifecycleGeneration &&
      (current.containerId === pod.containerId ||
        (allowRemovedContainer && current.containerId === null)) &&
      current.status === 'running' &&
      current.pendingEscalation === null &&
      (allowQueuedGuidance || !nudgeRepo.hasPending(pod.id))
    );
  }

  function failInteractivePreservation(pod: Pod, reason: string): never {
    const failureReason = `Workspace preservation failed. ${reason} Original resources retained; repair synchronization and retry completion.`;
    if (ownsArtifactCompletion(pod)) {
      podRepo.update(pod.id, { failureReason });
      emitActivityError(pod.id, failureReason, false);
    }
    throw new AutopodError(failureReason, 'WORKSPACE_PRESERVATION_FAILED', 502);
  }

  function failBranchPreservation(pod: Pod): never {
    assertApprovalCurrent(pod);
    const reason =
      'Branch preservation failed. Original resources retained; repair the branch or remote access and retry approval.';
    podRepo.update(pod.id, { failureReason: reason });
    emitActivityError(pod.id, reason, false);
    throw new AutopodError(reason, 'BRANCH_PRESERVATION_FAILED', 502);
  }

  function assertInteractiveCompletionCurrent(pod: Pod, allowRemovedContainer = false): void {
    assertGuidanceCollected(pod.id);
    const current = podRepo.getOrThrow(pod.id);
    if (
      current.lifecycleGeneration !== pod.lifecycleGeneration ||
      current.status !== 'running' ||
      current.options.agentMode !== 'interactive' ||
      current.options.output !== pod.options.output ||
      current.branch !== pod.branch ||
      current.baseBranch !== pod.baseBranch ||
      current.executionTarget !== pod.executionTarget ||
      current.worktreePath !== pod.worktreePath ||
      (current.containerId !== pod.containerId &&
        !(allowRemovedContainer && current.containerId === null))
    )
      throw new AutopodError(
        'Workspace completion was superseded; the current lifecycle and resources are retained.',
        'STALE_WORKSPACE_COMPLETION',
        409,
      );
    if (
      podRepo.hasUnansweredDecision?.(pod.id) ??
      Boolean(current.pendingEscalation || current.finalization?.pendingDecisionId)
    )
      throw new AutopodError(
        'An unanswered human decision must be resolved before completing this workspace.',
        'HUMAN_DECISION_PENDING',
        409,
      );
  }

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

  function parkOnWorktreeSyncFailure(podId: string, reason: string): void {
    try {
      podRepo.update(podId, { worktreeCompromised: true });
    } catch (updateErr) {
      logger.warn({ err: updateErr, podId }, 'Failed to persist worktreeCompromised flag');
    }
    emitActivityStatus(
      podId,
      `${reason} Recover the worktree before retrying validation or PR creation.`,
    );
    const current = podRepo.getOrThrow(podId);
    if (current.status === 'running' || current.status === 'validating') {
      transition(current, 'failed');
    }
  }

  /**
   * After a pod reaches `validated`, enqueue any dependents whose *all*
   * parents have now reached a completed-success state. Single-parent pods
   * fire immediately; multi-parent (fan-in) pods wait for the last holdout.
   *
   * The dependent pod stacks on its first parent's branch — this matches the
   * linear-chain mental model. Commits from other parents reach the child via
   * handover files or the eventual PR merge, not the worktree.
   */
  function maybeTriggerDependents(completedPod: Pod): void {
    const dependents = podRepo.getPodsDependingOn(completedPod.id);
    for (const dep of dependents) {
      // Also heal pods that were cascade-failed when this parent was previously killed.
      // The mergeBlockReason marker identifies exactly those pods so we don't disturb
      // genuinely-failed dependents that have their own failure reason.
      const cascadeFailed =
        dep.status === 'failed' &&
        dep.mergeBlockReason === `dependency pod ${completedPod.id} failed`;
      if (dep.status !== 'queued' && !cascadeFailed) continue;

      const parentIds =
        dep.dependsOnPodIds.length > 0
          ? dep.dependsOnPodIds
          : dep.dependsOnPodId
            ? [dep.dependsOnPodId]
            : [];
      if (parentIds.length === 0) continue;

      const parentsReady = parentIds.every((pid) => {
        let parent: Pod;
        try {
          parent = pid === completedPod.id ? completedPod : podRepo.getOrThrow(pid);
        } catch {
          // Missing parent — treat as not ready rather than crashing.
          return false;
        }
        if (isSinglePrSeriesPod(dep)) {
          return parent.status === 'complete';
        }
        // Shared branch (single-mode siblings): the parent holds the Git worktree
        // lock on the branch until it reaches 'complete' — worktree is cleaned up
        // on completion, not on validation. Starting the child early races into
        // an empty worktree and the repoint step fails. Wait for 'complete'.
        if (parent.branch === dep.branch) {
          return parent.status === 'complete';
        }
        if (dep.waitForMerge) {
          // Stacked series: wait until the parent PR is fully merged.
          return parent.status === 'complete';
        }
        // Accept any terminal-success status — a manually approved parent reaches
        // 'complete' without passing through 'validated' in the dependent's view.
        return (
          parent.status === 'validated' ||
          parent.status === 'approved' ||
          parent.status === 'merging' ||
          parent.status === 'merge_pending' ||
          parent.status === 'complete'
        );
      });
      if (!parentsReady) {
        logger.debug(
          {
            podId: dep.id,
            parentIds,
            waitingOn: parentIds.filter((pid) => pid !== completedPod.id),
          },
          'Series: dependent pod still waiting on other parents',
        );
        continue;
      }

      // Determine base branch for the dependent pod:
      // - Single-PR series, even if an older row has the wrong child branch:
      //   keep pointing at the real base so the final PR targets main/default.
      // - Single-branch (shared branch): same real-base rule.
      // - Stacked with waitForMerge: parent branch is deleted post-merge; use parent's
      //   baseBranch (main) so the dependent starts from the freshly-merged main.
      // - Stacked without waitForMerge: stack directly on parent's branch (classic stacking).
      const firstParentId = parentIds[0];
      const firstParent = firstParentId
        ? firstParentId === completedPod.id
          ? completedPod
          : podRepo.getOrThrow(firstParentId)
        : completedPod;
      const isSharedBranch = dep.branch === firstParent.branch;
      let baseBranch: string;
      if (dep.launchConfigDigest && dep.baseBranch) {
        // Composed launches already froze their source binding at admission.
        baseBranch = dep.baseBranch;
      } else if (isSinglePrSeriesPod(dep) || isSharedBranch || dep.waitForMerge) {
        baseBranch = firstParent.baseBranch ?? 'main';
      } else {
        baseBranch = firstParent.branch;
      }

      if (cascadeFailed) {
        podRepo.update(dep.id, { status: 'queued', completedAt: null, mergeBlockReason: null });
        eventBus.emit({
          type: 'pod.status_changed',
          timestamp: new Date().toISOString(),
          podId: dep.id,
          previousStatus: 'failed',
          newStatus: 'queued',
        });
        logger.info(
          { podId: dep.id, parentId: completedPod.id },
          'Series: healed cascade-failed dependent — parent completed',
        );
      }
      podRepo.update(dep.id, {
        baseBranch,
        dependencyStartedAt: new Date().toISOString(),
      });
      enqueueSession(dep.id);
      logger.info({ podId: dep.id, parentIds, baseBranch }, 'Series: dependent pod enqueued');
    }
  }
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

  return {
    getLaunchConfiguration(podId: string): EffectiveLaunchConfig | null {
      return deps.launchConfiguration?.read(podId) ?? null;
    },
    createResolvedSession(config, userId, creator, actor): Pod {
      if (!deps.launchConfiguration)
        throw new AutopodError(
          'Composable launch execution is unavailable',
          'CONFIG_EXECUTION_UNAVAILABLE',
          503,
        );
      if (!providerAccountStore)
        throw new AutopodError(
          'Provider account store is unavailable',
          'PROVIDER_CREDENTIALS_MISSING',
          503,
        );
      assertLaunchAgentAccount(
        config.ai.main,
        config.agentAccounts[config.ai.main.providerAccountId],
        providerAccountStore,
        providerCatalog,
      );
      const options = launchPodOptions(config);
      const backend = containerManagerFactory.get(config.execution.target);
      if (
        options.agentMode === 'interactive' &&
        config.execution.target !== 'local' &&
        !backend.attachTerminal
      )
        throw new AutopodError(
          'Selected backend cannot attach an interactive terminal',
          'INVALID_CONFIGURATION',
          400,
        );
      assertSandboxAgentStreamingExecSupported(
        { name: config.profileId },
        config.execution.target,
        options,
      );
      if (
        options.agentMode !== 'interactive' &&
        config.execution.networkPolicy?.enabled &&
        config.execution.networkPolicy.mode === 'deny-all'
      )
        throw new AutopodError(
          'An agent requires outbound provider access',
          'INVALID_CONFIGURATION',
          400,
        );
      const sidecars = Object.keys(config.resolvedExecution.sidecars);
      if (config.execution.target === 'sandbox' && sidecars.length)
        throw new AutopodError(
          'Sandbox sidecars are unavailable',
          'UNSUPPORTED_SANDBOX_SIDECAR',
          400,
        );
      if (sidecars.some((id) => !config.environment.sidecars.some((sidecar) => sidecar.id === id)))
        throw new AutopodError(
          'Sidecar was not admitted in the launch configuration',
          'INVALID_SIDECAR',
          400,
        );
      if (
        config.intent === 'goal' &&
        (!deps.launchConfiguration.goals || config.ai.main.runtime !== 'codex')
      )
        throw new AutopodError('Native Goal execution is unavailable', 'GOAL_UNAVAILABLE', 503);
      const pod = admitComposablePod({
        config,
        userId,
        creator,
        actor,
        pods: podRepo,
        read: deps.launchConfiguration.read,
        events: eventBus,
        enqueue: enqueueSession,
        reconcileDependencies: (parentId) => maybeTriggerDependents(podRepo.getOrThrow(parentId)),
      });
      if (config.intent === 'goal') {
        if (!deps.launchConfiguration?.goals)
          throw new AutopodError('Native Goal execution is unavailable', 'GOAL_UNAVAILABLE', 503);
        deps.launchConfiguration.goals.initialize(pod, config);
      }
      return pod;
    },
    createSession(
      request: CreatePodRequest,
      userId: string,
      creator?: PodCreator,
      actor?: OperatorActor,
    ): Pod {
      if (deps.launchConfiguration)
        throw new AutopodError(
          'This daemon requires a resolved repository launch; upgrade the caller to the configuration API',
          'CONFIG_API_VERSION_UNSUPPORTED',
          410,
        );
      if (request.intentionalRerun && (actor?.type !== 'human' || actor.userId !== userId))
        throw new AutopodError(
          'Intentional rerun requires an authenticated human decision',
          'UNAUTHORIZED_RERUN',
          403,
        );
      if (request.intentionalRerun) {
        if (!podRepo.dispatchPreflight)
          throw new AutopodError('Durable rerun admission unavailable', 'RERUN_UNAVAILABLE', 503);
        const existing = podRepo.dispatchPreflight.findRerun(request, userId);
        if (existing) return podRepo.getOrThrow(existing);
      }
      const profile = profileStore.get(request.profileName);
      assertNoExpiredPat(profile);
      const providerPreflight = resolveProviderPreflight(profile, request.runtime, request.model, {
        profileStore,
        providerAccountStore,
        manifest: providerCatalog,
      });
      const { runtime, model } = providerPreflight;
      const executionTarget = request.executionTarget ?? profile.executionTarget ?? 'local';
      const skipValidation = request.skipValidation ?? false;
      const normalizedDependsOnPodIds =
        request.dependsOnPodIds && request.dependsOnPodIds.length > 0
          ? request.dependsOnPodIds
          : request.dependsOnPodId
            ? [request.dependsOnPodId]
            : null;
      const singlePrSeriesParent =
        request.prMode === 'single' && request.seriesId && normalizedDependsOnPodIds?.[0]
          ? podRepo.getOrThrow(normalizedDependsOnPodIds[0])
          : null;
      if (
        singlePrSeriesParent &&
        request.branch !== undefined &&
        request.branch !== singlePrSeriesParent.branch
      ) {
        throw new AutopodError(
          `Single-PR series dependent must use parent branch '${singlePrSeriesParent.branch}' (got '${request.branch}')`,
          'INVALID_CONFIGURATION',
          400,
        );
      }
      const effectiveBaseBranch =
        request.baseBranch ?? singlePrSeriesParent?.baseBranch ?? profile.defaultBranch ?? 'main';
      const effectiveStartBranch =
        request.startBranch ?? singlePrSeriesParent?.startBranch ?? effectiveBaseBranch;

      // Resolve the effective PodOptions once, so both branch derivation and
      // DB insertion use the exact same values.
      const resolvedPod = resolvePodOptions(
        profile.pod ?? (profile.outputMode ? podOptionsFromOutputMode(profile.outputMode) : null),
        request.options ??
          (request.outputMode ? podOptionsFromOutputMode(request.outputMode) : undefined),
      );
      if (
        skipValidation &&
        request.options?.validationSuite &&
        request.options.validationSuite !== 'off'
      ) {
        throw new AutopodError(
          `skipValidation cannot be combined with validationSuite='${request.options.validationSuite}'`,
          'INVALID_CONFIGURATION',
          400,
        );
      }
      if (skipValidation) {
        resolvedPod.validate = false;
        resolvedPod.validationSuite = 'off';
      }
      if (resolvedPod.agentMode === 'interactive' && executionTarget !== 'local') {
        const interactiveCm = containerManagerFactory.get(executionTarget);
        if (!interactiveCm.attachTerminal) {
          throw new AutopodError(
            `Interactive pods on execution target '${executionTarget}' require a container backend with interactive terminal support (attachTerminal)`,
            'INVALID_CONFIGURATION',
            400,
          );
        }
      }
      if (executionTarget === 'sandbox') {
        if (!profile.warmImageTag) {
          throw new AutopodError(
            `Sandbox execution for profile "${profile.name}" requires a warm image. Run \`ap profile warm ${profile.name} --rebuild\` with ACR_REGISTRY_URL configured first.`,
            'SANDBOX_WARM_IMAGE_REQUIRED',
            400,
          );
        }
        if (!isAcrQualifiedImage(profile.warmImageTag)) {
          throw new AutopodError(
            `Sandbox warm image for profile "${profile.name}" must be an ACR-qualified image tag, got "${profile.warmImageTag}". Rebuild the warm image with ACR_REGISTRY_URL so profile.warmImageTag is stored as <registry>.azurecr.io/...`,
            'SANDBOX_WARM_IMAGE_REQUIRED',
            400,
          );
        }
      }
      assertSandboxAgentStreamingExecSupported(profile, executionTarget, resolvedPod);

      // deny-all network policy blocks all outbound — incompatible with cloud-backed runtimes.
      // Interactive pods run without an AI agent, so they're unaffected.
      if (
        resolvedPod.agentMode !== 'interactive' &&
        profile.networkPolicy?.enabled &&
        profile.networkPolicy?.mode === 'deny-all'
      ) {
        throw new AutopodError(
          `Network policy 'deny-all' blocks all outbound traffic, but runtime '${runtime}' requires API access. Use 'restricted' mode instead — the default allowlist includes the model API.`,
          'INVALID_CONFIGURATION',
          400,
        );
      }

      // Validate requireSidecars against the pod's profile at create time so
      // typos and missing configs fail fast instead of silently no-oping at
      // spawn. Privileged sidecars additionally require `trustedSource:true`.
      //
      // Auto-attach sidecars that the profile has enabled + trusted (currently
      // just Dagger). Profiles can opt out per child via inheritance — sub-
      // profiles set `sidecars.dagger.enabled:false` or `trustedSource:false`.
      // Auto-attach is unioned with the explicit request so CLI/brief-level
      // opt-in still works for sidecars not auto-attached.
      const autoAttached = getAutoAttachedSidecars(profile);
      const requestedSidecars = request.requireSidecars ?? [];
      const requireSidecars = Array.from(new Set([...autoAttached, ...requestedSidecars]));
      if (executionTarget === 'sandbox' && requireSidecars.length > 0) {
        throw new AutopodError(
          `Sidecars are not supported for sandbox execution yet (requested: ${requireSidecars.join(', ')}). Azure Sandboxes do not provide the Docker bridge network sidecars require.`,
          'UNSUPPORTED_SANDBOX_SIDECAR',
          400,
        );
      }
      for (const name of requireSidecars) {
        const spec = resolveSidecarSpec(profile, name);
        if (!spec) {
          throw new AutopodError(
            `Pod requested sidecar '${name}' but profile '${profile.name}' has no matching enabled config`,
            'INVALID_SIDECAR',
            400,
          );
        }
        if (spec.privileged === true && profile.trustedSource !== true) {
          throw new AutopodError(
            `Sidecar '${name}' runs privileged; profile '${profile.name}' must have trustedSource:true to enable it`,
            'UNTRUSTED_PROFILE',
            403,
          );
        }
      }

      const derivedReferenceRepos = deriveReferenceRepos(request.referenceRepos);

      // Preflight overlap check: does this pod's `touches` scope overlap with
      // any in-flight pod on the same repo + base? Computed BEFORE insert so
      // the `block` policy refuses cleanly without leaving a half-created row.
      // The `warn` path keeps the result and emits an event after the row
      // exists (so it carries the new pod's ID).
      let preflightConflicts: PreflightConflict[] = [];
      const candidateTouches = request.touches ?? [];
      if (candidateTouches.length > 0) {
        try {
          const candidateRepoUrl = profile.repoUrl ?? null;
          const candidates = podRepo.listNonTerminal().map((p) => ({
            pod: p,
            repoUrl: executionForPod(p).repoUrl ?? null,
          }));
          preflightConflicts = findPreflightConflicts(
            {
              touches: candidateTouches,
              repoUrl: candidateRepoUrl,
              baseBranch: effectiveBaseBranch,
            },
            candidates,
          );
        } catch (err) {
          // Best-effort: a failure inside the check itself must not block pod
          // creation, so swallow and treat as "no conflicts found".
          logger.debug({ err }, 'Preflight overlap check failed — treating as no conflicts');
          preflightConflicts = [];
        }

        if (preflightConflicts.length > 0 && profile.preflightConflictPolicy === 'block') {
          const ids = preflightConflicts.map((c) => c.conflictingPodId).join(', ');
          throw new AutopodError(
            `Pod creation blocked by profile.preflightConflictPolicy='block': touches scope overlaps in-flight pods [${ids}]`,
            'PREFLIGHT_CONFLICT',
            409,
          );
        }
      }

      let id: string;
      for (let attempt = 0; attempt < 10; attempt++) {
        id = generatePodId();
        const effectiveOutputMode = outputModeFromPodOptions(resolvedPod);
        let branch: string;
        if (request.branch) {
          branch = request.branch;
        } else if (singlePrSeriesParent) {
          branch = singlePrSeriesParent.branch;
        } else if (resolvedPod.output === 'artifact') {
          branch = `research/${id}`;
        } else {
          const prefix = request.branchPrefix ?? profile.branchPrefix ?? 'autopod/';
          branch = `${prefix}${id}`;
        }
        // Workspace pods must not land on the default branch — `ap complete` would push
        // directly to origin/main. Auto-generate a safe branch unless this pod was spawned
        // by fixManually() (linkedPodId set), which intentionally inherits the worker's branch.
        if (resolvedPod.agentMode === 'interactive' && !request.linkedPodId) {
          if (branch === effectiveBaseBranch) {
            const prefix = request.branchPrefix ?? profile.branchPrefix ?? 'autopod/';
            branch = `${prefix}${id}`;
          }
        }
        try {
          podRepo.insert({
            id,
            profileName: request.profileName,
            task: request.task,
            status: 'queued',
            model,
            runtime,
            providerAccountIdSnapshot: providerPreflight.account?.id ?? null,
            providerIdSnapshot:
              providerPreflight.manifestProvider?.id ??
              providerPreflight.account?.provider ??
              profile.modelProvider ??
              null,
            executionTarget,
            branch,
            userId,
            creatorEmail: creator?.email ?? null,
            creatorName: creator?.name ?? null,
            maxValidationAttempts: profile.maxValidationAttempts ?? 3,
            skipValidation,
            contract: request.contract ?? null,
            intentionalRerun: request.intentionalRerun,
            dispatchRepository: profile.repoUrl,
            rerunRequestHash: request.intentionalRerun ? dispatchRequestHash(request) : undefined,
            options: resolvedPod,
            outputMode: effectiveOutputMode,
            startBranch: effectiveStartBranch !== effectiveBaseBranch ? effectiveStartBranch : null,
            baseBranch: effectiveBaseBranch,
            // Persist durable handoff instructions immediately so they survive
            // independently of the originating Pi session and are visible on the
            // pod the moment it is created. Trimmed (schema already rejects empty).
            handoffInstructions: request.handoffInstructions?.trim() || null,
            specFiles: request.specFiles && request.specFiles.length > 0 ? request.specFiles : null,
            specContextFiles:
              request.specContextFiles && request.specContextFiles.length > 0
                ? request.specContextFiles
                : null,
            linkedPodId: request.linkedPodId ?? null,
            pimGroups: (() => {
              if (request.pimGroups != null) return request.pimGroups;
              // Fall back to profile-level pimActivations (group type only — stored as PimGroupConfig)
              const groupActivations = (profile.pimActivations ?? [])
                .filter((a): a is Extract<typeof a, { type: 'group' }> => a.type === 'group')
                .map(({ groupId, displayName, duration, justification }) => ({
                  groupId,
                  displayName,
                  duration,
                  justification,
                }));
              return groupActivations.length > 0 ? groupActivations : null;
            })(),
            prUrl: request.prUrl ?? null,
            tokenBudget:
              request.tokenBudget !== undefined
                ? request.tokenBudget
                : (profile.tokenBudget ?? null),
            referenceRepos: derivedReferenceRepos.length > 0 ? derivedReferenceRepos : null,
            scheduledJobId: request.scheduledJobId ?? null,
            dependsOnPodIds: normalizedDependsOnPodIds,
            dependsOnPodId: request.dependsOnPodId ?? null,
            seriesId: request.seriesId ?? null,
            seriesName: request.seriesName ?? null,
            seriesDescription: request.seriesDescription ?? null,
            seriesDesign: request.seriesDesign ?? null,
            briefTitle: request.briefTitle ?? null,
            touches: request.touches && request.touches.length > 0 ? request.touches : null,
            doesNotTouch:
              request.doesNotTouch && request.doesNotTouch.length > 0 ? request.doesNotTouch : null,
            prMode: request.prMode ?? null,
            waitForMerge: request.waitForMerge ?? false,
            requireSidecars: requireSidecars.length > 0 ? requireSidecars : null,
            autoApprove: request.autoApprove ?? false,
            disableAskHuman: request.disableAskHuman ?? false,
          });
          break;
        } catch (err: unknown) {
          if (
            err instanceof Error &&
            err.message.includes('UNIQUE constraint failed') &&
            attempt < 9
          ) {
            continue;
          }
          throw err;
        }
      }
      // biome-ignore lint/style/noNonNullAssertion: id is guaranteed non-null after the retry loop above
      id = id!;

      const pod = podRepo.getOrThrow(id);

      const publishCommittedPod = () => {
        eventBus.emit({
          type: 'pod.created',
          timestamp: new Date().toISOString(),
          pod: {
            id: pod.id,
            profileName: pod.profileName,
            task: pod.task,
            status: pod.status,
            model: pod.model,
            runtime: pod.runtime,
            branch: pod.branch,
            baseBranch: pod.baseBranch,
            duration: null,
            filesChanged: pod.filesChanged,
            createdAt: pod.createdAt,
          },
        });

        // Emit the preflight overlap warning (computed before insert above) now
        // that the new pod has an ID. The `block` policy already short-circuited
        // earlier; reaching this point means the policy is `warn` or unset.
        if (preflightConflicts.length > 0) {
          eventBus.emit({
            type: 'pod.preflight_overlap',
            timestamp: new Date().toISOString(),
            podId: id,
            conflicts: preflightConflicts.map((c) => ({
              conflictingPodId: c.conflictingPodId,
              conflictingPodTask: c.conflictingPodTask,
              conflictingPodStatus: c.conflictingPodStatus,
              overlappingGlobs: c.overlappingGlobs,
            })),
          });
          logger.warn(
            {
              podId: id,
              conflictingPodIds: preflightConflicts.map((c) => c.conflictingPodId),
            },
            'Pod created with preflight overlap on in-flight pods — possible merge conflict',
          );
        }

        // Dependent pods must not start until their predecessors reach `validated`;
        // maybeTriggerDependents() will enqueue them at that point. A pod counts
        // as dependent if either the new multi-parent array or the legacy single
        // field is populated.
        const hasDeps = (request.dependsOnPodIds?.length ?? 0) > 0 || !!request.dependsOnPodId;
        if (!hasDeps) {
          enqueueSession(id);
        }
        logger.info(
          {
            podId: id,
            profile: request.profileName,
            branch: pod.branch,
            baseBranch: pod.baseBranch,
            startBranch: pod.startBranch,
          },
          'Pod created',
        );
      };
      if (podRepo.afterInsertCommitted) podRepo.afterInsertCommitted(pod.id, publishCommittedPod);
      else publishCommittedPod();
      return pod;
    },

    createHistoryWorkspace(
      profileName: string,
      userId: string,
      historyQuery: HistoryQuery,
      creator?: PodCreator,
    ): Pod {
      // Encode query params into the task field with a [history] prefix
      const queryJson = JSON.stringify(historyQuery);
      const task = `[history] History analysis workspace | ${queryJson}`;
      return this.createSession(
        {
          profileName,
          task,
          outputMode: 'workspace',
          skipValidation: true,
        },
        userId,
        creator,
      );
    },

    createMemoryWorkspace(profileName: string, userId: string, creator?: PodCreator): Pod {
      const globalMems = deps.memoryRepo?.listByScope('global', true) ?? [];
      const profileMems = deps.memoryRepo?.list('profile', profileName, true) ?? [];
      const all = [...globalMems, ...profileMems];

      const formatted = all
        .map((m) => `### ${m.path}\n${m.rationale ? `Why: ${m.rationale}\n\n` : ''}${m.content}`)
        .join('\n\n---\n\n');

      const task = [
        `[memory-analysis] Review ${all.length} memories and draft a fix plan`,
        '',
        'You have been given a snapshot of memories from this project.',
        'Your job:',
        '1. Identify gotchas, bugs, and missing config that can be fixed in the repo',
        '2. For each fixable item, draft the specific change or PR needed',
        '3. Prioritize and optionally implement the most critical fixes',
        '',
        '## Memories',
        '',
        formatted,
      ].join('\n');

      return this.createSession(
        {
          profileName,
          task,
          outputMode: 'workspace',
          skipValidation: true,
        },
        userId,
        creator,
      );
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

    async sendMessage(
      podId: string,
      message: string,
      actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
    ): Promise<void> {
      if (pauseIntents.has(podId)) {
        throw new AutopodError(
          `Pod ${podId} pause is still settling; resume is not yet allowed`,
          'PAUSE_SETTLING',
          409,
        );
      }
      const pod = podRepo.getOrThrow(podId);
      if (deps.launchConfiguration?.read(podId)?.intent === 'goal') {
        const goal = deps.launchConfiguration.goals?.get(podId);
        const escalation = pod.pendingEscalation;
        const source =
          escalation?.type === 'request_credential'
            ? (escalation.payload as RequestCredentialPayload).source
            : undefined;
        const attachedNativeReply = Boolean(
          escalation &&
            !['request_credential', 'validation_override'].includes(escalation.type) &&
            activeAgentRuns.has(podId) &&
            !pod.pauseReason,
        );
        const hostRepair =
          (source === 'host_fetch' && !goal?.fence) ||
          (source === 'host_push' && goal?.state === 'achieved' && goal.executionStopped);
        const validationReply =
          escalation?.type === 'validation_override' &&
          goal?.state === 'achieved' &&
          goal.executionStopped;
        if (!attachedNativeReply && !hostRepair && !validationReply)
          throw new AutopodError(
            'Use native Goal controls to resume; ordinary replies cannot start another agent conversation',
            'GOAL_NATIVE_RESUME_REQUIRED',
            409,
          );
      }
      if (!canReceiveMessage(pod.status)) {
        throw new AutopodError(
          `Pod ${podId} is not awaiting input (status: ${pod.status})`,
          'INVALID_STATE',
          409,
        );
      }

      // ── Budget pause approval ──────────────────────────────────────────
      if (pod.pauseReason === 'budget') {
        const profile = executionForPod(pod);
        const maxExtensions = profile.maxBudgetExtensions;
        const newExtensionsUsed = pod.budgetExtensionsUsed + 1;

        if (maxExtensions !== null && newExtensionsUsed > maxExtensions) {
          throw new AutopodError(
            `Pod ${podId} has reached the maximum budget extensions (${maxExtensions})`,
            'BUDGET_EXHAUSTED',
            409,
          );
        }

        emitActivityStatus(
          podId,
          `Budget extension approved (${newExtensionsUsed}). Proceeding to validation…`,
        );
        podRepo.update(podId, {
          budgetExtensionsUsed: newExtensionsUsed,
          pauseReason: null,
        });

        const refreshed = podRepo.getOrThrow(podId);
        transition(refreshed, 'running');

        try {
          await this.handleCompletion(podId);
        } catch (err) {
          logger.error({ err, podId }, 'Failed to handle completion after budget approval');
          const s = podRepo.getOrThrow(podId);
          if (!isTerminalState(s.status)) {
            transition(s, 'failed');
          }
          throw err;
        }
        return;
      }

      // ── Credential injection ──────────────────────────────────────────
      if (pod.pendingEscalation?.type === 'request_credential') {
        const payload = pod.pendingEscalation.payload as RequestCredentialPayload;

        // Pre-provision host fetch failure: re-resolve the daemon-side credential
        // and queue the same pod. The next queue pass begins with a fresh remote
        // fetch; no container credential injection or agent resume is involved.
        if (payload.source === 'host_fetch') {
          const profile = executionForPod(pod);
          const credential = await resolveGitCredential(profile);
          if (!credential) {
            throw new AutopodError(
              payload.service === 'github'
                ? 'Daemon GitHub authentication is still unavailable. Run gh auth login as the daemon service account and try again.'
                : 'Daemon Azure DevOps authentication is still unavailable. Repair the daemon Azure CLI/managed identity and try again.',
              'MISSING_CREDENTIAL',
              400,
            );
          }
          escalationRepo.update(pod.pendingEscalation.id, {
            respondedAt: new Date().toISOString(),
            respondedBy: legacyRespondedBy(actor),
            actor,
            response: 'credential_repaired',
          });
          transition(pod, 'queued', { pendingEscalation: null });
          emitActivityStatus(
            podId,
            'Host credentials updated — fetching required remote refs again…',
          );
          enqueueSession(podId);
          return;
        }

        // Daemon-side push failure: skip container injection (no agent waiting)
        // and retry the post-validation push from the host with the repaired
        // daemon identity.
        if (payload.source === 'host_push') {
          const profile = executionForPod(pod);
          const pat = await resolveGitCredential(profile);
          if (!pat) {
            throw new AutopodError(
              payload.service === 'github'
                ? 'Daemon GitHub authentication is still unavailable. Run gh auth login as the daemon service account and try again.'
                : 'Daemon Azure DevOps authentication is still unavailable. Repair the daemon Azure CLI/managed identity and try again.',
              'MISSING_CREDENTIAL',
              400,
            );
          }

          if (!pod.worktreePath) {
            throw new AutopodError(
              `Pod ${podId} has no worktree — cannot retry push`,
              'INVALID_STATE',
              409,
            );
          }

          escalationRepo.update(pod.pendingEscalation.id, {
            respondedAt: new Date().toISOString(),
            respondedBy: legacyRespondedBy(actor),
            actor,
            response: 'daemon_auth_repaired',
          });
          // awaiting_input → validating: park-then-retry without re-running the
          // agent. The validation result we already passed is still authoritative.
          const validatingPod = transition(pod, 'validating', { pendingEscalation: null });
          const carryForwardPrUrl = validatingPod.prUrl;
          emitActivityStatus(
            podId,
            carryForwardPrUrl
              ? `${payload.service} PAT updated — retrying push to existing PR…`
              : `${payload.service} PAT updated — retrying branch push and PR creation…`,
          );

          try {
            // Always push first — same shape as the original post-validation
            // path. maxDeletions=0 mirrors `pushAndCreatePr`: the container is
            // already stopped/gone so a phantom mass-delete must not slip in.
            await worktreeManager.mergeBranch({
              worktreePath: validatingPod.worktreePath ?? '',
              targetBranch: validatingPod.branch,
              pat,
              maxDeletions: 0,
              podTask: validatingPod.task,
              profile,
              podModel: validatingPod.model,
            });

            // Only open a new PR if this isn't a fix pod carrying one forward.
            let newPrUrl = carryForwardPrUrl;
            if (!newPrUrl) {
              const prManager = prManagerFactory ? prManagerFactory(profile) : null;
              if (prManager) {
                emitActivityStatus(podId, 'Creating PR…');
                const refreshed = podRepo.getOrThrow(podId);
                const baseBranch = resolvePrBaseBranch(refreshed, profile);
                await ensurePrBaseBranchOnOrigin(refreshed, profile, baseBranch, 'host_push_retry');
                const createResult = await prManager.createPr({
                  // biome-ignore lint/style/noNonNullAssertion: validated above
                  worktreePath: refreshed.worktreePath!,
                  repoUrl: profile.repoUrl ?? undefined,
                  branch: refreshed.branch,
                  baseBranch,
                  podId,
                  task: refreshed.task,
                  profileName: refreshed.profileName,
                  profile,
                  podModel: refreshed.model,
                  handoffInstructions: refreshed.handoffInstructions ?? undefined,
                  validationResult: refreshed.lastValidationResult ?? null,
                  validationWaiver: refreshed.validationWaiver,
                  filesChanged: refreshed.filesChanged,
                  linesAdded: refreshed.linesAdded,
                  linesRemoved: refreshed.linesRemoved,
                  previewUrl: refreshed.previewUrl,
                  screenshots: [],
                  taskSummary: refreshed.taskSummary ?? undefined,
                  seriesDescription: refreshed.seriesDescription ?? undefined,
                  seriesName: refreshed.seriesName ?? undefined,
                  securityFindings: getLatestPushFindings(podId),
                });
                newPrUrl = createResult.url ?? null;
                if (newPrUrl) {
                  emitActivityStatus(podId, `PR created: ${newPrUrl}`);
                }
              }
            } else {
              emitActivityStatus(podId, `Carrying forward existing PR: ${carryForwardPrUrl}`);
            }

            const validatedPod = transition(podRepo.getOrThrow(podId), 'validated', {
              prUrl: newPrUrl,
              lastCorrectionMessage: null,
            });

            if (validatedPod.linkedPodId) {
              await completeFixPodAfterPush(validatedPod);
              return;
            }

            maybeTriggerDependents(validatedPod);

            // Stop the container post-validation (mirrors the original push path).
            if (validatedPod.containerId) {
              try {
                emitActivityStatus(podId, 'Stopping post-validation container…');
                await stopSandboxPreviewProxy(podId);
                const cm = containerManagerFactory.get(validatedPod.executionTarget);
                await cm.stop(validatedPod.containerId);
              } catch (stopErr) {
                logger.warn(
                  { err: stopErr, podId },
                  'Failed to stop container after host_push retry',
                );
              }
            }

            if (validatedPod.autoApprove) {
              emitActivityStatus(podId, 'Auto-approving…');
              logger.info({ podId }, 'Auto-approving pod after host_push retry');
              setImmediate(() => {
                this.approveSession(podId, { automation: true }).catch((err) =>
                  logger.warn({ err, podId }, 'Auto-approve after host_push retry failed'),
                );
              });
            }
          } catch (err) {
            // Fresh PAT is still bad — re-park rather than fail terminally.
            if (err instanceof GitCredentialError) {
              parkOnCredentialFailure(podId, err);
              return;
            }
            logger.error({ err, podId }, 'host_push retry failed after credential fix');
            const s = podRepo.getOrThrow(podId);
            if (!isTerminalState(s.status)) {
              transition(s, 'failed');
            }
            throw err;
          }
          return;
        }

        const authMessage =
          'Source credentials stay with the AutoPod daemon. Use scoped GitHub tools for reads and allowed actions; the daemon handles push and PR delivery.';

        const escalationId = pod.pendingEscalation.id;
        const pending = deps.pendingRequestsByPod?.get(podId);
        const savedResult = pending?.isDetached(escalationId)
          ? buildDetachedMcpFallbackMessage(pod.pendingEscalation.type, authMessage)
          : authMessage;
        persistCompletionReply(podRepo, pod, message, actor, () => {
          transition(pod, 'running', { pendingEscalation: null });
          nudgeRepo.queue(podId, savedResult);
        });
        emitActivityStatus(
          podId,
          `Direct ${payload.service} credential request declined; daemon delivery guidance saved.`,
        );
        pending?.resolveWithState(escalationId, authMessage);
        return;
      }

      // ── Validation override responses ─────────────────────────────────
      if (pod.pendingEscalation?.type === 'validation_override') {
        const payload = pod.pendingEscalation.payload as ValidationOverridePayload;
        const overrides = parseValidationOverrideResponse(message, payload.findings);
        const goalRework = overrides.some((item) => item.action === 'guidance')
          ? await beginGoalTaskRework(pod, `Apply reviewed validation guidance: ${message}`)
          : false;

        // Resolve the escalation in the DB
        escalationRepo.update(pod.pendingEscalation.id, {
          respondedAt: new Date().toISOString(),
          respondedBy: legacyRespondedBy(actor),
          actor,
          response: message,
        });

        // Merge new overrides into existing pod overrides
        const existingOverrides = pod.validationOverrides ?? [];
        const mergedOverrides = mergeOverrides(existingOverrides, overrides);
        podRepo.update(podId, {
          validationOverrides: mergedOverrides,
          pendingEscalation: null,
        });

        const hasGuidance = overrides.some((o) => o.action === 'guidance');

        if (!hasGuidance) {
          // All dismissed — re-run validation with overrides (doesn't burn an attempt)
          emitActivityStatus(podId, 'Overrides stored — re-running validation…');
          transition(pod, 'running');
          await this.triggerValidation(podId);
        } else {
          // Guidance provided — resume agent with human's instructions
          const guidanceText = overrides
            .filter((o) => o.action === 'guidance' && o.guidance)
            .map((o) => `- ${o.description}: ${o.guidance}`)
            .join('\n');

          const correctionMessage = [
            '## Human Reviewer Guidance',
            '',
            'The human reviewer provided the following instructions for recurring findings:',
            '',
            guidanceText,
            '',
            'Please address these items and try again.',
          ].join('\n');

          emitActivityStatus(podId, 'Resuming agent with human guidance…');
          transition(pod, 'running');

          try {
            const events = await taskFeedbackEvents(podId, correctionMessage, goalRework);
            const outcome = await this.consumeAgentEvents(podId, events, pod.validationAttempts);
            if (outcome === 'stopped') return;
            await persistRuntimeCredentialsForPod(
              podId,
              'Failed to persist rotated credentials after override-guidance resume',
            );
            if (outcome === 'completed') {
              await this.handleCompletion(podId);
            }
          } catch (err) {
            if (err instanceof AgentContinuationSupersededError) throw err;
            logger.error({ err, podId }, 'Failed to resume agent after override guidance');
            const s = podRepo.getOrThrow(podId);
            if (!isTerminalState(s.status)) {
              transition(s, 'failed');
            }
            throw err;
          }
        }

        logger.info(
          { podId, overrideCount: overrides.length, hasGuidance },
          'Validation override response processed',
        );
        return;
      }

      // ── Normal escalation responses ───────────────────────────────────
      const pendingForSession = deps.pendingRequestsByPod?.get(podId);
      const decisionId = pod.pendingEscalation?.id;
      const attachedWaiter = Boolean(
        decisionId &&
          pendingForSession?.hasPending(decisionId) &&
          !pendingForSession.isDetached(decisionId),
      );
      const retainedRun = podRepo.taskExecutions?.hasActiveRun(podId) ?? activeAgentRuns.has(podId);
      // An attached waiter is not proof that the MCP response reached the worker.
      const queueForRetainedRun = retainedRun || attachedWaiter;
      const queuedReply =
        pod.pendingEscalation && pendingForSession?.isDetached(pod.pendingEscalation.id)
          ? buildDetachedMcpFallbackMessage(pod.pendingEscalation.type, message)
          : message;
      persistCompletionReply(podRepo, pod, message, actor, () => {
        transition(pod, 'running', { pendingEscalation: null });
        if (queueForRetainedRun) nudgeRepo.queue(podId, queuedReply);
      });
      emitActivityStatus(podId, 'Human reply recorded.');

      // If the pod was blocked on an ask_human MCP call, resolve the pending request.
      // A still-attached MCP stream can deliver the response directly. If the
      // stream detached, resume the agent with the same fallback text queued for
      // check_messages so a dead or errored Codex turn is not stranded forever.
      let resumeMessage = message;
      if (pendingForSession && pod.pendingEscalation?.id) {
        const resolveResult = pendingForSession.resolveWithState(pod.pendingEscalation.id, message);
        if (resolveResult.resolved) {
          if (resolveResult.detached) {
            resumeMessage = buildDetachedMcpFallbackMessage(pod.pendingEscalation.type, message);
            if (!queueForRetainedRun) nudgeRepo.queue(podId, resumeMessage);
            emitActivityStatus(
              podId,
              'MCP response stream was closed — queued human reply for check_messages',
            );
          } else {
            // The MCP ask_human call has been unblocked — processPod's consumeAgentEvents
            // loop will continue picking up events from the still-running container.
            return;
          }
        }
      }

      if (queueForRetainedRun) {
        emitActivityStatus(
          podId,
          'Human reply saved for check_messages while the prior run is unresolved.',
        );
        return;
      }

      emitActivityStatus(podId, 'Resuming agent with message…');
      try {
        const resumeEnv = await getResumeEnv(pod);
        const runtime = runtimeRegistry.get(pod.runtime);
        if (!pod.containerId) throw new Error(`Pod ${podId} has no container`);
        const resumingPreservedSandbox =
          pod.lastRecoveryTrigger === 'restart' && pod.executionTarget === 'sandbox';
        if (resumingPreservedSandbox) {
          await containerManagerFactory.get('sandbox').start(pod.containerId);
          podRepo.update(podId, { lastRecoveryTrigger: null });
          emitActivityStatus(podId, 'Resuming preserved sandbox after daemon restart…');
        }
        await recordContinuationProvenance(pod, pod.containerId);
        const mcpServers = await primeRuntimeForResume(pod, runtime, pod.containerId, resumeEnv);
        let outcome: AgentRunOutcome;
        try {
          const events = runtime.resume(podId, resumeMessage, pod.containerId, resumeEnv);
          outcome = await this.consumeAgentEvents(podId, events, pod.validationAttempts);
        } catch (err) {
          if (!(resumingPreservedSandbox && err instanceof ResumeSessionNotFoundError)) throw err;
          if (!pod.worktreePath) throw err;
          podRepo.update(podId, { claudeSessionId: null });
          emitActivityStatus(
            podId,
            'Saved Claude session was unavailable — starting a fresh recovery worker in the preserved sandbox…',
          );
          const recoveryTask = await buildRecoveryTask(podRepo.getOrThrow(podId), pod.worktreePath);
          await recordContinuationProvenance(pod, pod.containerId);
          const recoveryEvents = runtime.spawn({
            podId,
            task: recoveryTask,
            model: pod.model,
            reasoningEffort: resolvedReasoningEffort(
              resolveEffectiveBoundProfile(pod),
              pod.profileSnapshot as unknown as Record<string, unknown> | null,
            ),
            workDir: '/workspace',
            containerId: pod.containerId,
            env: resumeEnv,
            mcpServers,
            executionTarget: pod.executionTarget,
          });
          outcome = await this.consumeAgentEvents(podId, recoveryEvents, pod.validationAttempts);
        }
        if (outcome === 'stopped') return;
        await persistRuntimeCredentialsForPod(
          podId,
          'Failed to persist rotated credentials after human-message resume',
        );
        if (outcome === 'completed') {
          await this.handleCompletion(podId);
        }
      } catch (err) {
        if (err instanceof AgentContinuationSupersededError) throw err;
        logger.error({ err, podId }, 'Failed to resume agent after message');
        const s = podRepo.getOrThrow(podId);
        if (!isTerminalState(s.status)) {
          transition(s, 'failed');
          emitActivityStatus(
            podId,
            `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        throw err;
      }
    },

    approveSession(podId: string, options: ApproveSessionOptions = {}): Promise<void> {
      return approvalWorkflow.approveSession(podId, options);
    },

    async rejectSession(
      podId: string,
      reason?: string,
      actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
    ): Promise<void> {
      const pod = podRepo.getOrThrow(podId);

      const rejectableStates = ['validated', 'failed', 'review_required'] as const;
      if (!(rejectableStates as readonly string[]).includes(pod.status)) {
        throw new AutopodError(
          `Cannot reject pod ${podId} in status ${pod.status}`,
          'INVALID_STATE',
          409,
        );
      }

      const goalRework = await beginGoalTaskRework(
        pod,
        `Address human feedback after Goal achievement: ${reason ?? 'Changes rejected. Please try again.'}`,
      );
      const previousStatus = pod.status as 'validated' | 'failed' | 'review_required';

      emitActivityStatus(
        podId,
        reason
          ? `Rejected by ${actorLabel(actor)}: ${reason}`
          : `Rejected by ${actorLabel(actor)} — resuming agent…`,
      );

      // Reset validation attempts — human is giving a fresh chance
      podRepo.update(podId, {
        validationAttempts: 0,
        lastValidationResult: null,
        lastCorrectionMessage: [
          REWORK_IN_PROGRESS_PREFIX,
          reason ? `${actorLabel(actor)} rejection: ${reason}` : `${actorLabel(actor)} rejection`,
        ].join(' '),
      });

      // Build rejection feedback message for the agent
      const rejectionMessage = formatFeedback({
        type: 'human_rejection',
        feedback: reason ?? 'Changes rejected. Please try again.',
        task: pod.task,
        previousStatus,
        attempt: 0,
        maxAttempts: pod.maxValidationAttempts,
      });

      // Transition to running
      transition(pod, 'running');

      try {
        if (!pod.containerId) throw new Error(`Pod ${podId} has no container`);

        // Container is stopped post-validation — restart it before resuming the agent
        const cm = containerManagerFactory.get(pod.executionTarget);
        await cm.start(pod.containerId);
        logger.info(
          { podId, containerId: pod.containerId },
          'Container restarted for rejection retry',
        );
        if (pod.executionTarget === 'local') {
          await this.refreshNetworkPolicy(pod.profileName);
        }

        // Resume agent with rejection feedback
        const events = await taskFeedbackEvents(podId, rejectionMessage, goalRework);
        const outcome = await this.consumeAgentEvents(
          podId,
          events,
          deriveAgentAttempt(pod.phaseTokenUsage),
        );
        if (outcome === 'stopped') return;
        await persistRuntimeCredentialsForPod(
          podId,
          'Failed to persist rotated credentials after rejection resume',
        );
        if (outcome === 'completed') {
          await this.handleCompletion(podId);
        }
      } catch (err) {
        // Roll back to failed — don't leave the pod stuck in 'running' with no agent
        if (err instanceof AgentContinuationSupersededError) throw err;
        logger.error({ err, podId }, 'Failed to resume agent after rejection');
        const s = podRepo.getOrThrow(podId);
        if (!isTerminalState(s.status)) {
          transition(s, 'failed');
          emitActivityStatus(
            podId,
            `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        throw err;
      }

      logger.info({ podId, reason, previousStatus }, 'Pod rejected, resuming agent with feedback');
    },

    async pauseSession(podId: string): Promise<void> {
      if (pauseIntents.has(podId)) {
        throw new AutopodError(`Pod ${podId} pause is already settling`, 'PAUSE_SETTLING', 409);
      }
      const pod = podRepo.getOrThrow(podId);
      if (!canPause(pod.status)) {
        throw new AutopodError(
          `Cannot pause pod ${podId} in status ${pod.status}`,
          'INVALID_STATE',
          409,
        );
      }

      emitActivityStatus(podId, 'Pausing pod…');
      const pauseToken = Symbol(podId);
      pauseIntents.set(podId, pauseToken);
      let activeRun = activeAgentRuns.get(podId);
      const releaseIntentAfterSettling = (message: string): void => {
        if (!activeRun) {
          if (pauseIntents.get(podId) === pauseToken) pauseIntents.delete(podId);
          return;
        }
        void activeRun.settled.then(() => {
          if (pauseIntents.get(podId) !== pauseToken) return;
          pauseIntents.delete(podId);
          emitActivityStatus(podId, message);
          logger.info({ podId }, message);
        });
      };
      // Suspend the runtime (kills stream but preserves pod ID)
      const runtime = runtimeRegistry.get(pod.runtime);
      try {
        if (deps.launchConfiguration?.read(podId)?.intent === 'goal') {
          if (!deps.launchConfiguration.goals)
            throw new AutopodError('Native Goal controls are unavailable', 'GOAL_UNAVAILABLE', 503);
          await deps.launchConfiguration.goals.control(podId, 'pause');
        } else await runtime.suspend(podId);
      } catch (err) {
        activeRun = activeAgentRuns.get(podId) ?? activeRun;
        releaseIntentAfterSettling(
          'Failed pause attempt has settled — pause may be retried safely',
        );
        throw err;
      }
      activeRun = activeAgentRuns.get(podId) ?? activeRun;
      const quiescenceDeadline = Date.now() + PAUSE_QUIESCENCE_TIMEOUT_MS;
      while (activeRun) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const remainingMs = Math.max(0, quiescenceDeadline - Date.now());
        const settled = await Promise.race([
          activeRun.settled.then(() => true),
          new Promise<false>((resolve) => {
            timeout = setTimeout(() => resolve(false), remainingMs);
          }),
        ]);
        if (timeout) clearTimeout(timeout);
        if (!settled) {
          const message = `Pause quiescence failed: active Codex run did not settle within ${PAUSE_QUIESCENCE_TIMEOUT_MS}ms`;
          emitActivityStatus(podId, message);
          logger.error({ podId }, message);
          releaseIntentAfterSettling(
            'Timed-out pause has now quiesced — pause may be retried safely',
          );
          throw new AutopodError(message, 'PAUSE_QUIESCENCE_TIMEOUT', 409);
        }
        const nextRun = activeAgentRuns.get(podId);
        activeRun = nextRun?.token === activeRun.token ? undefined : nextRun;
      }

      transition(pod, 'paused', { pauseReason: 'manual' });
      if (pauseIntents.get(podId) === pauseToken) pauseIntents.delete(podId);
      emitActivityStatus(podId, 'Pod paused — use [t] tell or [u] nudge to resume');
      logger.info({ podId }, 'Pod paused');
    },

    nudgeSession(podId: string, message: string): void {
      const pod = podRepo.getOrThrow(podId);
      if (!canNudge(pod.status)) {
        throw new AutopodError(
          `Cannot nudge pod ${podId} in status ${pod.status}`,
          'INVALID_STATE',
          409,
        );
      }

      nudgeRepo.queue(podId, message);
      emitActivityStatus(podId, `Nudge queued: ${message}`);
      logger.info({ podId }, 'Nudge message queued');
    },

    async killSession(podId: string): Promise<void> {
      podRepo.deletionOwnership?.assertTaskAvailable(podId);
      clearPreviewTimer(podId);
      await stopSandboxPreviewProxy(podId);
      stopMergePolling(podId);
      const pod = podRepo.getOrThrow(podId);
      if (!canKill(pod.status)) {
        throw new AutopodError(
          `Cannot kill pod ${podId} in status ${pod.status}`,
          'INVALID_STATE',
          409,
        );
      }

      emitActivityStatus(podId, 'Killing pod…');
      transition(pod, 'killing');
      validationAbortControllers.get(podId)?.abort();

      // Run cleanup with a timeout so a hung Docker stop or git cleanup
      // can never leave the pod stuck in 'killing' forever.
      const KILL_TIMEOUT_MS = 30_000;
      const ownsKillLifecycle = () =>
        podRepo.getOrThrow(podId).lifecycleGeneration === pod.lifecycleGeneration;
      const cleanup = async () => {
        if (deps.launchConfiguration?.read(podId)?.intent === 'goal') {
          if (!deps.launchConfiguration.goals)
            throw new AutopodError('Native Goal controls are unavailable', 'GOAL_UNAVAILABLE', 503);
          await deps.launchConfiguration.goals.control(podId, 'cancel');
          if (!ownsKillLifecycle()) return;
        }
        // Kill sidecars before the main container so they can't outlive their pod.
        await killSidecarsForPod(podId);
        if (!ownsKillLifecycle()) return;
        await cleanupTestRunBranches(podId);
        if (!ownsKillLifecycle()) return;
        // Kill container
        if (pod.containerId) {
          const cm = containerManagerFactory.get(pod.executionTarget);
          // Best-effort: recover runtime credentials before the container dies.
          await persistRuntimeCredentialsForPod(
            podId,
            'Failed to persist rotated credentials during kill — proceeding',
          );
          if (!ownsKillLifecycle()) return;
          try {
            await cm.kill(pod.containerId);
            if (ownsLifecycle(podId, pod.lifecycleGeneration, pod.containerId)) {
              podRepo.update(podId, { containerId: null });
            }
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to kill container');
          }
        }
        if (!ownsKillLifecycle()) return;
        // Remove the per-pod bridge network. Safe now that both the pod and
        // its sidecars are dead; Docker would otherwise refuse the remove.
        await destroyPodNetwork(podId);
        if (!ownsKillLifecycle()) return;

        // Abort runtime
        try {
          const runtime = runtimeRegistry.get(pod.runtime);
          await runtime.abort(podId);
        } catch (err) {
          logger.warn({ err, podId }, 'Failed to abort runtime');
        }

        if (!ownsKillLifecycle()) return;
        // Cleanup worktree — always clear the DB path even if cleanup throws,
        // so a subsequent rework doesn't attempt recovery on a stale directory.
        if (pod.worktreePath) {
          try {
            await worktreeManager.cleanup(pod.worktreePath);
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to cleanup worktree');
          }
          if (!ownsKillLifecycle()) return;
          podRepo.update(podId, { worktreePath: null });
        }

        // Cleanup per-pod conversation-history dirs on the host. Best
        // effort — if they linger they just waste a few KB of disk per pod.
        const runtimeStateDirs: Partial<Record<string, (id: string) => Promise<void>>> = {
          claude: cleanupClaudeState,
          codex: cleanupCodexState,
        };
        await runtimeStateDirs[pod.runtime]?.(podId)?.catch((err) => {
          logger.warn({ err, podId }, `Failed to cleanup ${pod.runtime} state dir`);
        });
      };

      let killTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          cleanup(),
          new Promise<void>((resolve) => {
            killTimer = setTimeout(() => {
              logger.warn({ podId }, 'Kill cleanup timed out — forcing killed');
              resolve();
            }, KILL_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (killTimer) clearTimeout(killTimer);
      }

      if (!ownsKillLifecycle()) return;

      const activeAttempt = deps.providerAttemptRepo?.getActive(podId);
      if (activeAttempt) {
        const latestPod = podRepo.getOrThrow(podId);
        deps.providerAttemptRepo?.close(podId, {
          nativeSessionId: nativeSessionId(latestPod),
          outcome: 'aborted',
          inputTokens: activeAttempt.inputTokens,
          outputTokens: activeAttempt.outputTokens,
          costUsd: activeAttempt.costUsd,
        });
      }
      const killingSession = podRepo.getOrThrow(podId);
      transition(killingSession, 'killed', { completedAt: new Date().toISOString() });
      forgetMaxCredentialLineage(podId);

      eventBus.emit({
        type: 'pod.completed',
        timestamp: new Date().toISOString(),
        podId,
        finalStatus: 'killed',
        summary: {
          id: podId,
          profileName: pod.profileName,
          task: pod.task,
          status: 'killed',
          model: pod.model,
          runtime: pod.runtime,
          duration: pod.startedAt ? Date.now() - new Date(pod.startedAt).getTime() : null,
          filesChanged: pod.filesChanged,
          createdAt: pod.createdAt,
        },
      });

      logger.info({ podId }, 'Pod killed');
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
    async promoteToAuto(
      podId: string,
      targetOutput: 'pr' | 'branch' | 'artifact' | 'none',
      options?: { instructions?: string; skipAgent?: boolean },
    ): Promise<void> {
      const pod = podRepo.getOrThrow(podId);

      if (!canPromote(pod.status, pod.options)) {
        throw new AutopodError(
          `Cannot promote pod ${podId} in status '${pod.status}' — must be an interactive, promotable, running pod`,
          'INVALID_STATE',
          409,
        );
      }

      const profile = executionForPod(pod);
      if (targetOutput === 'pr' && !profile.repoUrl) {
        throw new AutopodError(
          `Cannot promote to 'pr' — profile '${profile.name}' has no repoUrl`,
          'INVALID_CONFIGURATION',
          400,
        );
      }

      const skipAgent = !!options?.skipAgent;
      if (skipAgent && targetOutput === 'none') {
        // No PR, no push, no artifact, no agent — pod would just die. Refuse
        // explicitly so the caller picks a real promotion target.
        throw new AutopodError(
          "--skip-agent requires a promotion target ('--pr' or '--artifact')",
          'INVALID_OUTPUT_MODE',
          400,
        );
      }

      if (pod.launchConfigDigest) {
        const configuration = deps.launchConfiguration;
        if (!configuration?.prepareWorker)
          throw new AutopodError(
            'Frozen workspace handoff is unavailable',
            'CONFIG_EXECUTION_UNAVAILABLE',
            503,
          );
        const instructions = options?.instructions?.trim() || pod.handoffInstructions || undefined;
        await configuration.prepareWorker(
          {
            source: { podId, digest: pod.launchConfigDigest, kind: 'worker' },
            task: pod.task,
            output: targetOutput,
            work: { ...(instructions ? { handoffInstructions: instructions } : {}) },
          },
          (config) => {
            const current = podRepo.getOrThrow(podId);
            transition(current, 'handoff', {
              options: {
                agentMode: 'auto',
                output: targetOutput,
                validate: config.workflow.validationPhases.length > 0,
                validationSuite: config.workflow.validationPhases.length > 0 ? 'custom' : 'off',
                advisoryBrowserQaEnabled: config.workflow.advisoryBrowserQaEnabled,
                promotable: false,
              },
              recoveryWorktreePath: current.worktreePath,
              ...(instructions ? { handoffInstructions: instructions } : {}),
              skipAgent,
              autoApprove: false,
            });
          },
        );
        enqueueSession(podId);
        logger.info(
          { podId, targetOutput },
          'Workspace handoff prepared from frozen configuration',
        );
        return;
      }

      // Capture the human's handoff instructions BEFORE the transition so they
      // survive the recovery restart. The recovery path inside processPod reads
      // them after `syncWorkspaceBack()` completes and composes `handoffContext`.
      // (When skipAgent is set the agent never sees these — the field stays on
      // the pod for audit/UI purposes only.)
      //
      // DETERMINISTIC PROMOTION RULE — REPLACEMENT (not append/merge):
      // A non-empty promotion-time correction *replaces* whatever
      // `handoffInstructions` the pod already carried (e.g. the initial Pi
      // handoff persisted at creation). When no correction is supplied, the
      // existing value is reused verbatim. We never concatenate the two, so a
      // large initial handoff can't be silently duplicated. The composed
      // `## Handoff` section always shows the single authoritative instruction
      // (initial OR correction) distinct from the machine-generated summary.
      const trimmedInstructions = options?.instructions?.trim();
      if (trimmedInstructions && trimmedInstructions.length > 0) {
        podRepo.update(podId, { handoffInstructions: trimmedInstructions });
      }

      if (skipAgent) {
        podRepo.update(podId, { skipAgent: true, autoApprove: false });
      }

      // Swap to the worker profile if one is configured — this lets the
      // interactive profile keep a minimal setup and delegate the heavy
      // agent config (model, validation, PR provider) to a sibling profile.
      const targetProfileName = profileStore.get(pod.profileName).workerProfile ?? pod.profileName;
      const targetProfile = profileStore.get(targetProfileName);

      const newPod: PodOptions = {
        agentMode: 'auto',
        output: targetOutput,
        validate: targetOutput === 'pr',
        promotable: false,
      };

      transition(pod, 'handoff', {
        options: newPod,
        // Reuse the existing worktree in recovery mode so the agent resumes
        // on the human's in-flight work.
        recoveryWorktreePath: pod.worktreePath,
        // containerId is intentionally kept — processPod reads it to sync the
        // workspace and stop the container before spawning the agent container.
      });

      // If we're switching profiles for the worker phase, snapshot the new
      // one so the agent runs under the right model/validation config.
      if (targetProfile.name !== pod.profileName) {
        podRepo.update(podId, {
          profileSnapshot: targetProfile,
        });
      }

      eventBus.emit({
        type: 'pod.status_changed',
        timestamp: new Date().toISOString(),
        podId,
        previousStatus: 'handoff',
        newStatus: 'handoff',
      });

      enqueueSession(podId);
      logger.info(
        { podId, targetOutput, targetProfile: targetProfile.name },
        'Pod promoted interactive → auto',
      );
    },

    async completeSession(
      podId: string,
      options?: {
        promoteTo?: 'pr' | 'branch' | 'artifact' | 'none';
        instructions?: string;
        skipAgent?: boolean;
      },
    ): Promise<{ pushError?: string; promotedTo?: 'pr' | 'branch' | 'artifact' | 'none' }> {
      const pod = podRepo.getOrThrow(podId);
      return coordinateInteractiveCompletion(pod, options, async () => {
        if (pod.options.agentMode !== 'interactive') {
          throw new AutopodError(
            'Only interactive pods can be completed via this endpoint',
            'INVALID_OUTPUT_MODE',
            400,
          );
        }

        if (pod.status !== 'running') {
          throw new AutopodError(
            `Cannot complete pod in status '${pod.status}' — must be 'running'`,
            'INVALID_STATE',
            409,
          );
        }

        assertInteractiveCompletionCurrent(pod);

        // If caller asked us to promote (e.g. `ap complete <id> --pr`), hand off
        // into the agent-driven flow instead of just pushing + completing.
        if (options?.promoteTo && options.promoteTo !== 'branch') {
          await this.promoteToAuto(podId, options.promoteTo, {
            instructions: options.instructions,
            skipAgent: options.skipAgent,
          });
          return { promotedTo: options.promoteTo };
        }

        let pushError: string | undefined;

        if (pod.options.output === 'artifact') {
          // An interactive completion remains retryable if copying fails. No source
          // cleanup or terminal success can run before the snapshot is published.
          await preserveArtifacts(pod);
        } else {
          // Sync workspace changes back to host worktree before pushing
          if (pod.containerId && !pod.worktreePath && pod.options.output !== 'none')
            failInteractivePreservation(pod, 'The host worktree is unavailable.');
          if (pod.containerId && pod.worktreePath) {
            try {
              const cm = containerManagerFactory.get(pod.executionTarget);
              await syncWorkspaceBack(
                pod.containerId,
                pod.worktreePath,
                cm,
                podId,
                pod.executionTarget,
              );
            } catch (err) {
              logger.warn({ err, podId }, 'Failed to sync workspace before push');
              failInteractivePreservation(
                pod,
                'Neither workspace synchronization nor archive fallback succeeded.',
              );
            }
          }

          assertInteractiveCompletionCurrent(pod);

          // Push the branch to origin before completing, then clean up the worktree.
          // Only remove the worktree if push succeeds — don't lose uncommitted work.
          if (pod.worktreePath && pod.options.output !== 'none') {
            try {
              // Pre-push security scan for workspace-pod auto-push. The engine
              // rewrites block→escalate for workspace pods at the push checkpoint
              // so the human at the keyboard sees the warning rather than a hard
              // fail; runPushCheckpointScan only throws when block stays a block,
              // which happens for non-workspace pods (handled at validating entry).
              const pushScanProfile = executionForPod(pod);
              await runPushCheckpointScan(pod, pushScanProfile);
              assertInteractiveCompletionCurrent(pod);
              // Refuse to push a workspace pod directly to the default branch — this almost
              // always means the user passed `--branch main` by mistake. fixManually() pods
              // have linkedPodId set and are explicitly exempt.
              const completionBaseBranch =
                pod.baseBranch ?? pushScanProfile?.defaultBranch ?? 'main';
              if (!pod.linkedPodId && pod.branch === completionBaseBranch) {
                throw new AutopodError(
                  `Refusing to push workspace pod directly to default branch '${pod.branch}'. Use ap complete <id> --pr or check out a feature branch first.`,
                  'INVALID_STATE',
                  409,
                );
              }
              // mergeBranch auto-commits any remaining uncommitted changes before pushing.
              // Sync-back must succeed before this point; retain the normal deletion guard.
              const rawTask = pod.task?.trim() ?? '';
              const commitMessage =
                rawTask.length > 0
                  ? rawTask.length > 72
                    ? `${rawTask.slice(0, 69)}...`
                    : rawTask
                  : 'chore: workspace session complete';
              const pushCredential = await resolveGitCredential(pushScanProfile);
              assertInteractiveCompletionCurrent(pod);
              await worktreeManager.mergeBranch({
                worktreePath: pod.worktreePath,
                targetBranch: pod.branch ?? 'HEAD',
                // Pass the PAT explicitly — workspace pods auto-push on container exit,
                // possibly hours/days after the worktree was created. The in-memory PAT
                // cache may be cold after a daemon restart in between.
                pat: pushCredential,
                maxDeletions: 100,
                commitMessage,
              });
              assertInteractiveCompletionCurrent(pod);
              logger.info({ podId, branch: pod.branch }, 'Workspace branch pushed to origin');
              // Safe to clean up — work is in origin
              try {
                await worktreeManager.cleanup(pod.worktreePath);
                logger.info({ podId }, 'Workspace worktree cleaned up');
              } catch (err) {
                logger.warn({ err, podId }, 'Failed to cleanup workspace worktree');
              }
            } catch (err) {
              assertInteractiveCompletionCurrent(pod);
              pushError = err instanceof Error ? err.message : String(err);
              logger.warn(
                { err, podId },
                'Failed to push workspace branch — completing anyway, worktree preserved',
              );
              handleDeletionGuardError(podId, err);
            }
          }
        }

        assertInteractiveCompletionCurrent(pod);
        emitActivityStatus(podId, 'Pod complete');
        await cleanupContainer(pod, 'workspace-complete', 'kill', () =>
          assertInteractiveCompletionCurrent(pod),
        );
        assertInteractiveCompletionCurrent(pod, true);
        const completingPod = podRepo.getOrThrow(podId);
        transition(completingPod, 'complete', {
          completedAt: new Date().toISOString(),
          ...(completingPod.failureReason?.startsWith('Workspace preservation failed.')
            ? { failureReason: null }
            : {}),
        });

        // Deactivate PIM groups on pod completion
        if (pod.pimGroups?.length && pod.userId) {
          try {
            const { createPimClient } = await import('../actions/handlers/azure-pim-handler.js');
            const pimClient = createPimClient(deps.getSecret, logger);
            for (const group of pod.pimGroups) {
              try {
                await pimClient.deactivate(group.groupId, pod.userId);
                logger.info({ podId, groupId: group.groupId }, 'PIM group deactivated');
              } catch (err) {
                logger.warn(
                  { err, podId, groupId: group.groupId },
                  'PIM deactivation failed — continuing',
                );
              }
            }
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to load PIM client for deactivation');
          }
        }

        if (podRepo.getOrThrow(podId).lifecycleGeneration !== pod.lifecycleGeneration)
          return { pushError };
        eventBus.emit({
          type: 'pod.completed',
          timestamp: new Date().toISOString(),
          podId,
          finalStatus: 'complete',
          summary: {
            id: podId,
            profileName: pod.profileName,
            task: pod.task,
            status: 'complete',
            model: pod.model,
            runtime: pod.runtime,
            duration: pod.startedAt ? Date.now() - new Date(pod.startedAt).getTime() : null,
            filesChanged: pod.filesChanged,
            createdAt: pod.createdAt,
          },
        });

        // Auto-revalidate linked worker pod if this workspace was a fix
        if (pod.linkedPodId && !pushError) {
          try {
            const linked = podRepo.getOrThrow(pod.linkedPodId);
            if (linked.status === 'failed' || linked.status === 'review_required') {
              logger.info(
                { workspaceId: podId, workerId: pod.linkedPodId },
                'Workspace completed — auto-revalidating linked worker',
              );
              emitActivityStatus(
                pod.linkedPodId,
                `Linked workspace ${podId} completed — pulling changes and revalidating…`,
              );
              // Fire and forget — don't block workspace completion on revalidation
              this.revalidateSession(pod.linkedPodId).catch((err) => {
                logger.warn(
                  { err, workspaceId: podId, workerId: pod.linkedPodId },
                  'Auto-revalidation of linked worker failed',
                );
              });
            }
          } catch (err) {
            logger.warn(
              { err, podId, linkedPodId: pod.linkedPodId },
              'Failed to check linked pod for auto-revalidation',
            );
          }
        }

        logger.info({ podId, pushError }, 'Workspace pod completed');
        return { pushError };
      });
    },

    async syncWorkspaceBranch(
      podId: string,
    ): Promise<{ committed: boolean; pushed: boolean; error?: string }> {
      const pod = podRepo.getOrThrow(podId);

      if (pod.options.agentMode !== 'interactive') {
        throw new AutopodError(
          'sync-branch is only valid for interactive workspace pods',
          'INVALID_OUTPUT_MODE',
          400,
        );
      }
      if (pod.status !== 'running') {
        throw new AutopodError(
          `Cannot sync workspace branch in status '${pod.status}' — pod must be running`,
          'INVALID_STATE',
          409,
        );
      }
      if (!pod.worktreePath || !pod.branch) {
        throw new AutopodError(
          'Pod has no worktree or branch — nothing to sync',
          'INVALID_STATE',
          409,
        );
      }

      // Pull container changes back to the host worktree so any uncommitted
      // briefs the user just wrote land on disk. Mirrors the first step of
      // completeSession but stops short of pushing + cleaning up.
      if (pod.containerId) {
        try {
          const cm = containerManagerFactory.get(pod.executionTarget);
          await syncWorkspaceBack(
            pod.containerId,
            pod.worktreePath,
            cm,
            podId,
            pod.executionTarget,
          );
        } catch (err) {
          logger.warn({ err, podId }, 'syncWorkspaceBranch: sync-back failed');
          return {
            committed: false,
            pushed: false,
            error:
              'Workspace synchronization failed; source resources are retained. Retry after repairing synchronization.',
          };
        }
      }

      // Publish authored handoff documents and contracts. Other staged code is
      // outside this operation; commitFiles commits only these explicit paths.
      const profile = executionForPod(pod);
      const headBefore = await worktreeManager
        .getCommitLog(pod.worktreePath, pod.branch, 1)
        .catch(() => '');
      try {
        // List each handoff document that differs from HEAD or is untracked. Using
        // `git ls-files` with the `--others`/`--modified` flags catches both
        // existing-but-edited briefs and brand-new ones in one pass.
        const { stdout: mdListed } = await execFileAsync(
          'git',
          [
            'ls-files',
            '-z',
            '--modified',
            '--others',
            '--exclude-standard',
            '--',
            '*.md',
            'contract.yaml',
            'contract.yml',
            '**/contract.yaml',
            '**/contract.yml',
          ],
          { cwd: pod.worktreePath, maxBuffer: 10 * 1024 * 1024 },
        );
        const mdPaths = [...new Set(mdListed.split('\0').filter((p) => p.length > 0))];

        if (mdPaths.length === 0) {
          logger.info(
            { podId, branch: pod.branch },
            'syncWorkspaceBranch: no handoff document changes to commit',
          );
          await worktreeManager.pushBranch(pod.worktreePath, pod.branch, {
            pat: await resolveGitCredential(profile),
          });
          return { committed: false, pushed: true };
        }

        await worktreeManager.commitFiles(
          pod.worktreePath,
          mdPaths,
          'chore: sync workspace for series handoff',
        );

        await worktreeManager.pushBranch(pod.worktreePath, pod.branch, {
          pat: await resolveGitCredential(profile),
        });

        const headAfter = await worktreeManager
          .getCommitLog(pod.worktreePath, pod.branch, 1)
          .catch(() => '');
        const committed = headBefore !== headAfter;
        logger.info(
          { podId, branch: pod.branch, committed, mdFiles: mdPaths.length },
          'syncWorkspaceBranch: briefs synced + pushed to origin',
        );
        return { committed, pushed: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err, podId }, 'syncWorkspaceBranch: commit/push failed');
        return { committed: false, pushed: false, error: message };
      }
    },

    async preserveWorkspace(podId: string, reason = 'operator recovery'): Promise<void> {
      await preservePodWorkspace(podRepo.getOrThrow(podId), reason);
    },

    async quiesceSandboxAgent(podId: string): Promise<void> {
      const pod = podRepo.getOrThrow(podId);
      if (pod.executionTarget !== 'sandbox' || !pod.containerId) return;
      const cm = containerManagerFactory.get('sandbox');
      if ((await cm.getStatus(pod.containerId)) !== 'running') return;
      const result = await cm.execInContainer(
        pod.containerId,
        [
          'sh',
          '-c',
          [
            'pid_file=/run/autopod/agent.pid',
            '[ -r "$pid_file" ] || { echo "missing agent PID" >&2; exit 70; }',
            'pid=$(cat "$pid_file")',
            'case "$pid" in ""|*[!0-9]*) rm -f "$pid_file"; exit 0;; esac',
            'kill -TERM "$pid" 2>/dev/null || true',
            'i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 20 ]; do sleep 0.1; i=$((i + 1)); done',
            'kill -KILL "$pid" 2>/dev/null || true',
            'rm -f "$pid_file"',
          ].join('; '),
        ],
        { timeout: 5_000 },
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `Sandbox worker quiesce failed (exit ${result.exitCode}): ${result.stderr}`,
        );
      }
      emitActivityStatus(podId, 'Orphaned sandbox worker stopped for daemon recovery.');
    },

    async suspendSandboxForRecovery(podId: string): Promise<void> {
      const pod = podRepo.getOrThrow(podId);
      if (pod.executionTarget !== 'sandbox' || !pod.containerId) return;
      const cm = containerManagerFactory.get('sandbox');
      if ((await cm.getStatus(pod.containerId)) === 'running') await cm.stop(pod.containerId);
    },

    async cleanupPodResourcesForRecovery(podId: string): Promise<void> {
      await killSidecarsForPod(podId, true);
      await destroyPodNetwork(podId, true);
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

    async fixManually(
      podId: string,
      actorOrUserId: OperatorActor | string,
      creator?: PodCreator,
      instructions?: string,
    ): Promise<Pod> {
      const worker = podRepo.getOrThrow(podId);
      const actor: OperatorActor =
        typeof actorOrUserId === 'string'
          ? { type: 'human', userId: actorOrUserId }
          : actorOrUserId;
      if (
        worker.status !== 'failed' &&
        worker.status !== 'review_required' &&
        worker.status !== 'validated'
      ) {
        throw new AutopodError(
          `Cannot fix pod ${podId} in status ${worker.status} — only failed, review_required, or validated pods`,
          'INVALID_STATE',
          409,
        );
      }

      if (worker.launchConfigDigest) {
        assertExecutionTerminationVerified(worker.id);
        const create = this.createResolvedSession?.bind(this);
        if (!create)
          throw new AutopodError(
            'Composable execution is unavailable',
            'CONFIG_EXECUTION_UNAVAILABLE',
            503,
          );
        if (!deps.launchConfiguration?.admitDerived)
          throw new AutopodError(
            'Frozen manual-fix admission is unavailable',
            'CONFIG_EXECUTION_UNAVAILABLE',
            503,
          );
        const userId = actor.type === 'human' ? actor.userId : `${actor.type}:${actorLabel(actor)}`;
        const id = await deps.launchConfiguration.admitDerived(
          {
            source: { kind: 'manual-fix', podId: worker.id, digest: worker.launchConfigDigest },
            task: [
              `${actorLabel(actor)} fix for pod ${worker.id}: ${worker.task}`,
              ...(instructions?.trim() ? [`Instructions: ${instructions.trim()}`] : []),
            ].join('\n\n'),
            work: {
              branch: worker.branch,
              baseBranch: worker.baseBranch ?? undefined,
              linkedPodId: worker.id,
              dependsOnPodIds: [],
              startBranch: undefined,
              seriesId: undefined,
              seriesName: undefined,
              briefTitle: undefined,
              prMode: undefined,
              waitForMerge: false,
              specFiles: undefined,
            },
          },
          (config) => create(config, userId, creator, actor).id,
        );
        return podRepo.getOrThrow(id);
      }

      // Create a workspace pod on the same branch, linked to the failed worker
      const workspace = this.createSession(
        {
          profileName: worker.profileName,
          task: [
            `${actorLabel(actor)} fix for pod ${worker.id}: ${worker.task}`,
            ...(instructions?.trim() ? [`Instructions: ${instructions.trim()}`] : []),
          ].join('\n\n'),
          branch: worker.branch,
          outputMode: 'workspace',
          baseBranch: worker.baseBranch ?? undefined,
          linkedPodId: worker.id,
        },
        actor.type === 'human' ? actor.userId : `${actor.type}:${actorLabel(actor)}`,
        creator,
      );

      logger.info(
        { workerId: podId, workspaceId: workspace.id },
        'Created linked workspace for operator fix',
      );
      emitActivityStatus(podId, `${actorLabel(actor)} fix workspace created: ${workspace.id}`);

      return workspace;
    },

    notifyEscalation(podId: string, escalation: EscalationRequest): void {
      const pod = podRepo.getOrThrow(podId);
      if (pod.status === 'running') {
        transition(pod, 'awaiting_input', {
          pendingEscalation: escalation,
          escalationCount: pod.escalationCount + 1,
        });
      }
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
      return projectMemoryScope(pod, deps.launchConfiguration?.read(pod.id));
    },
    getLaunchMemoryContext(pod) {
      const executor = getReviewerExecutor(pod, 'memory');
      if (!executor)
        throw new AutopodError(
          'Launch memory requires composable configuration',
          'CONFIG_SNAPSHOT_UNAVAILABLE',
          503,
        );
      const profile = getEffectiveReviewerConfig(pod).profile;
      return {
        profile,
        projectScope: projectMemoryScope(pod, deps.launchConfiguration?.read(pod.id)),
        reviewer: {
          model: profile.reviewerModel ?? profile.defaultModel ?? pod.model,
          async generateText({ systemPrompt, userMessage }) {
            return (
              await executor({ prompt: `${systemPrompt}\n\n${userMessage}`, timeout: 20_000 })
            ).stdout;
          },
        },
      };
    },

    async deleteSession(podId: string): Promise<void> {
      podRepo.taskExecutions?.assertCanDelete(podId);
      const pod = podRepo.getOrThrow(podId);
      const deletable =
        isTerminalState(pod.status) ||
        pod.status === 'failed' ||
        pod.status === 'review_required' ||
        pod.status === 'killing';
      if (!deletable) {
        throw new AutopodError(
          `Cannot delete pod ${podId} in status ${pod.status} — kill it first`,
          'INVALID_STATE',
          409,
        );
      }
      const configuration = JSON.stringify(executionForPod(pod).testPipeline ?? null);
      const assertOwnership = () => {
        const current = podRepo.getOrThrow(podId);
        if (
          current.lifecycleGeneration !== pod.lifecycleGeneration ||
          current.status !== pod.status ||
          current.containerId !== pod.containerId ||
          current.executionTarget !== pod.executionTarget ||
          current.worktreePath !== pod.worktreePath ||
          current.runtime !== pod.runtime ||
          JSON.stringify(executionForPod(pod).testPipeline ?? null) !== configuration
        ) {
          throw new AutopodError(
            'Pod deletion cleanup ownership changed. Reconcile resource and pod state before retrying Delete.',
            'POD_DELETE_CLEANUP_UNVERIFIED',
            409,
          );
        }
        podRepo.taskExecutions?.assertCanDelete(podId);
      };
      const claim = podRepo.deletionOwnership?.acquire(
        podId,
        createHash('sha256').update(configuration).digest('hex'),
      );
      if (!claim) throw deletionOwnershipError();
      const runtimeStateDirs: Partial<Record<string, (id: string) => Promise<void>>> = {
        claude: cleanupClaudeState,
        codex: cleanupCodexState,
      };
      await runDeletionCleanup(
        [
          {
            name: 'preview',
            run: async () => {
              clearPreviewTimer(podId);
              await stopSandboxPreviewProxy(podId);
            },
          },
          {
            name: 'sidecars',
            run: (assertCurrent) => killSidecarsForPod(podId, true, assertCurrent, true),
          },
          {
            name: 'container',
            run: async () => {
              if (pod.containerId)
                await containerManagerFactory.get(pod.executionTarget).kill(pod.containerId);
            },
          },
          { name: 'network', run: () => destroyPodNetwork(podId, true) },
          {
            name: 'test branches',
            run: (assertCurrent) =>
              cleanupTestRunBranches(podId, { strict: true, assertCurrent, retainMetadata: true }),
          },
          {
            name: 'worktree',
            run: async () => {
              if (pod.worktreePath) await worktreeManager.cleanup(pod.worktreePath);
            },
          },
          {
            name: 'runtime state',
            run: async () => {
              await runtimeStateDirs[pod.runtime]?.(podId);
            },
          },
        ],
        assertOwnership,
        25_000,
        claim,
      );
      assertOwnership();
      pendingUpdateFromBaseIntents.delete(podId);
      forceWithLeaseAllowances.delete(podId);
      claim.finish(() => podRepo.delete(podId));
      logger.info({ podId }, 'Pod deleted');
    },

    async startPreview(podId: string): Promise<{ previewUrl: string }> {
      podRepo.deletionOwnership?.assertTaskAvailable(podId);
      const pod = podRepo.getOrThrow(podId);

      if (!pod.containerId) {
        throw new AutopodError(
          `Pod ${podId} has no container — cannot start preview`,
          'INVALID_STATE',
          409,
        );
      }

      if (!pod.previewUrl && pod.executionTarget !== 'sandbox') {
        throw new AutopodError(`Pod ${podId} has no preview URL`, 'INVALID_STATE', 409);
      }

      const cm = containerManagerFactory.get(pod.executionTarget);
      const status = await cm.getStatus(pod.containerId);

      if (status === 'unknown') {
        throw new AutopodError(
          `Container for pod ${podId} has been removed — cannot start preview`,
          'INVALID_STATE',
          409,
        );
      }

      const profile = executionForPod(pod);

      if (status === 'running') {
        // Container is running. Check if the supervisor is already alive — if so
        // return immediately without re-spawning (idempotent against a second
        // startPreview call while validation is running the supervisor).
        if (profile.startCommand) {
          const supervisorAlive = await (async () => {
            try {
              const pidResult = await cm.execInContainer(
                pod.containerId,
                ['sh', '-c', 'cat /tmp/autopod-supervisor.pid 2>/dev/null'],
                {},
              );
              const pid = pidResult.stdout.trim();
              if (!pid) return false;
              const liveness = await cm.execInContainer(
                pod.containerId,
                ['sh', '-c', `kill -0 ${pid} 2>/dev/null && echo 1 || echo 0`],
                {},
              );
              return liveness.stdout.trim() === '1';
            } catch {
              return false;
            }
          })();

          if (supervisorAlive) {
            const previewUrl =
              pod.executionTarget === 'sandbox'
                ? await ensureSandboxPreviewProxy(pod)
                : // biome-ignore lint/style/noNonNullAssertion: checked above for local pods
                  pod.previewUrl!;
            schedulePreviewAutoStop(podId, pod.containerId, pod.executionTarget);
            logger.info({ podId }, 'Supervisor already running — reusing existing preview');
            return { previewUrl };
          }

          // Supervisor is dead — (re)spawn it
          cm.execInContainer(
            pod.containerId,
            ['sh', '-c', buildSupervisorCommand(profile.startCommand)],
            { cwd: '/workspace' },
          ).catch((err) => {
            logger.warn({ err, podId }, 'Preview supervisor start errored');
          });
        }

        const previewUrl =
          pod.executionTarget === 'sandbox'
            ? await ensureSandboxPreviewProxy(pod)
            : // biome-ignore lint/style/noNonNullAssertion: checked above for local pods
              pod.previewUrl!;
        schedulePreviewAutoStop(podId, pod.containerId, pod.executionTarget);
        logger.info({ podId, previewUrl }, 'Preview started');
        return { previewUrl };
      }

      // Container is stopped — start it
      await cm.start(pod.containerId);
      const previewUrl =
        pod.executionTarget === 'sandbox'
          ? await ensureSandboxPreviewProxy(pod)
          : // biome-ignore lint/style/noNonNullAssertion: checked above for local pods
            pod.previewUrl!;

      // Re-run the start command under the supervisor and wait for health check
      if (profile.startCommand) {
        cm.execInContainer(
          pod.containerId,
          ['sh', '-c', buildSupervisorCommand(profile.startCommand)],
          { cwd: '/workspace' },
        ).catch((err) => {
          logger.warn(
            { err, podId },
            'Preview supervisor start command errored (may be expected for long-running processes)',
          );
        });

        // Poll for health
        const healthUrl = previewUrl + profile.healthPath;
        const timeoutMs = (profile.healthTimeout ?? 30) * 1_000;
        const pollIntervalMs = 2_000;
        const start = Date.now();

        while (Date.now() - start < timeoutMs) {
          try {
            const response = await fetch(healthUrl, {
              signal: AbortSignal.timeout(5_000),
            });
            if (response.status === 200) {
              logger.info({ podId, healthUrl }, 'Preview health check passed');
              break;
            }
          } catch {
            // Health check not ready yet
          }
          const remaining = timeoutMs - (Date.now() - start);
          if (remaining > 0) {
            await new Promise<void>((r) => setTimeout(r, Math.min(pollIntervalMs, remaining)));
          }
        }
      }

      schedulePreviewAutoStop(podId, pod.containerId, pod.executionTarget);
      logger.info({ podId, previewUrl }, 'Preview started');
      return { previewUrl };
    },

    async stopPreview(podId: string): Promise<void> {
      podRepo.deletionOwnership?.assertTaskAvailable(podId);
      clearPreviewTimer(podId);
      await stopSandboxPreviewProxy(podId);
      const pod = podRepo.getOrThrow(podId);

      if (!pod.containerId) {
        throw new AutopodError(
          `Pod ${podId} has no container — cannot stop preview`,
          'INVALID_STATE',
          409,
        );
      }

      const cm = containerManagerFactory.get(pod.executionTarget);
      await cm.stop(pod.containerId);
      logger.info({ podId }, 'Preview stopped');
    },

    async previewStatus(podId: string): Promise<{
      running: boolean;
      reachable: boolean;
      restartCount: number;
      lastError: string | null;
      previewUrl: string | null;
    }> {
      const pod = podRepo.getOrThrow(podId);
      const safeDefaults = {
        running: false,
        reachable: false,
        restartCount: 0,
        lastError: null,
        previewUrl: pod.previewUrl,
      };

      if (!pod.containerId || (!pod.previewUrl && pod.executionTarget !== 'sandbox')) {
        return safeDefaults;
      }

      const cm = containerManagerFactory.get(pod.executionTarget);

      // If the container is not running, the supervisor is definitely not alive.
      try {
        const containerStatus = await cm.getStatus(pod.containerId);
        if (containerStatus !== 'running') return safeDefaults;
      } catch {
        return safeDefaults;
      }

      const previewUrl =
        pod.executionTarget === 'sandbox'
          ? await ensureSandboxPreviewProxy(pod)
          : // biome-ignore lint/style/noNonNullAssertion: checked before status probe
            pod.previewUrl!;

      // A native sandbox preview URL is Entra-gated, so a host-side fetch just
      // gets 401 — probe the app from inside the container instead (the real
      // liveness signal). The daemon-local proxy URL (127.0.0.1) is fetched
      // directly as before.
      const isNativePreview =
        pod.executionTarget === 'sandbox' && !previewUrl.startsWith('http://127.0.0.1');

      // Exec parallel reads inside the container + an HTTP probe.
      const [pidResult, restartCountResult, logTailResult, httpProbeResult] = await Promise.all([
        cm
          .execInContainer(
            pod.containerId,
            ['sh', '-c', 'cat /tmp/autopod-supervisor.pid 2>/dev/null'],
            {},
          )
          .catch(() => null),
        cm
          .execInContainer(
            pod.containerId,
            ['sh', '-c', 'cat /tmp/autopod-restart-count 2>/dev/null'],
            {},
          )
          .catch(() => null),
        cm
          .execInContainer(
            pod.containerId,
            ['sh', '-c', 'tail -c 200 /tmp/autopod-start.log 2>/dev/null'],
            {},
          )
          .catch(() => null),
        isNativePreview
          ? cm
              .execInContainer(
                pod.containerId,
                [
                  'sh',
                  '-c',
                  // Prefer curl for the exact status code; fall back to wget (treat
                  // a 2xx/3xx success as 200) so leaner warm images still probe.
                  `code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:${CONTAINER_APP_PORT} 2>/dev/null); if [ -n "$code" ] && [ "$code" != "000" ]; then echo "$code"; elif wget -q -T 3 -O /dev/null http://localhost:${CONTAINER_APP_PORT} 2>/dev/null; then echo 200; fi`,
                ],
                {},
              )
              .then((r) => {
                const code = Number.parseInt(r.stdout.trim(), 10);
                return Number.isFinite(code) && code > 0 ? code : null;
              })
              .catch(() => null)
          : fetch(previewUrl, { signal: AbortSignal.timeout(3_000) })
              .then((r) => r.status)
              .catch(() => null),
      ]);

      // Check PID liveness: if we got a PID string, verify the process is still alive.
      const rawPid = pidResult?.stdout?.trim() ?? null;
      let alivePid: string | null = null;
      if (rawPid) {
        try {
          const check = await cm.execInContainer(
            pod.containerId,
            ['sh', '-c', `kill -0 ${rawPid} 2>/dev/null && echo 1 || echo 0`],
            {},
          );
          alivePid = check.stdout.trim() === '1' ? rawPid : null;
        } catch {
          alivePid = null;
        }
      }

      const status = parseStatus({
        pid: alivePid,
        restartCount: restartCountResult?.stdout ?? null,
        startLogTail: logTailResult?.stdout ?? null,
        reachableHttp: typeof httpProbeResult === 'number' ? httpProbeResult : null,
      });

      return { ...status, previewUrl };
    },

    getSession(podId: string): Pod {
      return podRepo.getOrThrow(podId);
    },

    refreshReadinessAfterQualityScore(podId: string): boolean {
      return approvalControls.refreshReadinessAfterQualityScore(podId);
    },

    async getValidationEnvironment(podId) {
      const pod = podRepo.getOrThrow(podId);
      return validationEnvironmentForPod(pod, executionForPod(pod));
    },

    async getDeploymentConfiguration(podId) {
      const pod = podRepo.getOrThrow(podId);
      const launch = deps.launchConfiguration?.read(podId);
      if (launch) {
        await deps.launchConfiguration?.assertCurrentCapabilities(launch);
        const deployment =
          (await executionCredentialsFor(launch)?.deployment(launch)) ??
          executionForPod(pod).deployment;
        await deps.launchConfiguration?.assertCurrentCapabilities(launch);
        return deployment;
      }
      return executionForPod(pod).deployment;
    },

    async getInjectedMcpServer(podId, name) {
      const pod = podRepo.getOrThrow(podId);
      const launch = deps.launchConfiguration?.read(podId);
      if (launch) {
        if (pod.status !== 'running')
          throw new AutopodError('Pod is not running', 'POD_NOT_RUNNING', 409);
        await deps.launchConfiguration?.assertCurrentCapabilities(launch);
        const credentials = executionCredentialsFor(launch);
        if (credentials) {
          const server = await credentials.httpServer(launch, name);
          await deps.launchConfiguration?.assertCurrentCapabilities(launch);
          return server;
        }
      }
      return this.getInjectedMcpServers(podId).find((server) => server.name === name);
    },

    getInjectedMcpServers(podId: string): InjectedMcpServer[] {
      const pod = podRepo.getOrThrow(podId);
      const profile = executionForPod(pod);
      return mergeMcpServers(injectionsForPod(pod).mcpServers, profile.mcpServers);
    },

    listSessions(filters?) {
      return podRepo.list(filters);
    },

    getSessionStats(filters?) {
      return podRepo.getStats(filters);
    },

    getSeriesPods(seriesId: string): Pod[] {
      return podRepo.getPodsBySeries(seriesId);
    },

    rehydrateDependentSessions(): void {
      const PARENT_DONE = new Set([
        'validated',
        'approved',
        'merging',
        'merge_pending',
        'complete',
      ]);
      const stuckDeps = podRepo
        .list({ status: 'queued' })
        .filter((p) => p.dependsOnPodIds.length > 0 || !!p.dependsOnPodId);

      for (const dep of stuckDeps) {
        const parentIds =
          dep.dependsOnPodIds.length > 0
            ? dep.dependsOnPodIds
            : dep.dependsOnPodId
              ? [dep.dependsOnPodId]
              : [];
        if (parentIds.length === 0) continue;

        const allParentsDone = parentIds.every((pid) => {
          try {
            const parent = podRepo.getOrThrow(pid);
            if (isSinglePrSeriesPod(dep)) {
              return parent.status === 'complete';
            }
            // Shared branch: parent must reach 'complete' before its worktree
            // releases the branch lock. See maybeTriggerDependents for rationale.
            if (parent.branch === dep.branch) {
              return parent.status === 'complete';
            }
            return PARENT_DONE.has(parent.status);
          } catch {
            return false;
          }
        });
        if (!allParentsDone) continue;

        // Enqueue each stuck pod directly (once per pod) rather than calling
        // maybeTriggerDependents which iterates *all* dependents of the parent
        // and would fire multiple times if called once per stuck dep in the loop.
        const firstParentId = parentIds[0];
        if (!firstParentId) continue;
        try {
          const firstParent = podRepo.getOrThrow(firstParentId);
          const baseBranch =
            dep.launchConfigDigest && dep.baseBranch
              ? dep.baseBranch
              : isSinglePrSeriesPod(dep) || dep.waitForMerge || dep.branch === firstParent.branch
                ? (firstParent.baseBranch ?? 'main')
                : firstParent.branch;
          podRepo.update(dep.id, {
            baseBranch,
            dependencyStartedAt: new Date().toISOString(),
          });
          enqueueSession(dep.id);
          logger.info(
            { podId: dep.id, firstParentId, baseBranch },
            'Series: rehydrated stuck dependent pod',
          );
        } catch {
          logger.warn({ podId: dep.id }, 'rehydrate: failed to enqueue dependent');
        }
      }
    },

    async deleteSeriesWithCascade(seriesId: string): Promise<void> {
      const seriesPods = podRepo.getPodsBySeries(seriesId);
      if (seriesPods.length === 0) {
        throw new AutopodError(`Series ${seriesId} not found`, 'NOT_FOUND', 404);
      }
      for (const pod of seriesPods) {
        if (canKill(pod.status)) {
          await this.killSession(pod.id).catch((err) =>
            logger.warn({ err, podId: pod.id, seriesId }, 'Series delete: kill failed, continuing'),
          );
        }
        await this.deleteSession(pod.id).catch((err) =>
          logger.warn({ err, podId: pod.id, seriesId }, 'Series delete: delete failed, continuing'),
        );
      }
      logger.info({ seriesId, count: seriesPods.length }, 'Series deleted');
    },

    getValidationHistory(podId: string) {
      // Verify pod exists
      podRepo.getOrThrow(podId);
      return validationRepo?.getForSession(podId) ?? [];
    },

    approveAllValidated(): Promise<{ approved: string[]; skipped: ApproveAllSkippedPod[] }> {
      return approvalControls.approveAllValidated.call(this);
    },

    async killAllFailed(): Promise<{ killed: string[] }> {
      const failed = podRepo.list({ status: 'failed' });
      const killed: string[] = [];
      for (const pod of failed) {
        try {
          await this.killSession(pod.id);
          killed.push(pod.id);
        } catch (err) {
          logger.warn({ err, podId: pod.id }, 'Failed to kill pod in bulk');
        }
      }
      return { killed };
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

    async refreshNetworkPolicy(profileName: string): Promise<void> {
      if (deps.launchConfiguration)
        throw new AutopodError(
          'Running pods retain their launch network policy. Change the reusable profile for a new launch.',
          'CONFIG_API_VERSION_UNSUPPORTED',
          410,
        );
      const profile = profileStore.get(profileName);
      if (!profile.networkPolicy?.enabled) return;

      const runningSessions = podRepo
        .list({ status: 'running' })
        .filter(
          (s) =>
            s.profileName === profileName &&
            (s.executionTarget === 'local' || s.executionTarget === 'sandbox') &&
            s.containerId != null,
        );

      if (runningSessions.length === 0) return;

      const mergedServers = mergeMcpServers(daemonConfig.mcpServers, profile.mcpServers);

      // Resolve the current bridge IP of each sidecar for a given pod. With
      // per-pod networks each pod has its own `autopod-<podId>` bridge, and
      // sidecar IPs can be different across pods.
      const collectSidecarIps = async (pod: import('@autopod/shared').Pod): Promise<string[]> => {
        if (!sidecarManager || !pod.sidecarContainerIds) return [];
        const networkName = networkNameForPod(pod.id);
        const ips: string[] = [];
        for (const [name, containerId] of Object.entries(pod.sidecarContainerIds)) {
          const ip = await sidecarManager.getBridgeIp({ containerId, name }, networkName);
          if (ip) ips.push(ip);
        }
        return ips;
      };

      // With per-pod networks, each pod has its own bridge and may have
      // different sidecar IPs to allowlist. Build the firewall script per
      // pod rather than once for the whole profile.
      await Promise.all(
        runningSessions.map(async (pod) => {
          try {
            const providerPreflight = resolveProviderPreflight(profile, pod.runtime, pod.model, {
              profileStore,
              providerAccountStore,
              manifest: providerCatalog,
              ...(pod.providerIdSnapshot
                ? {
                    expectedBinding: {
                      accountId: pod.providerAccountIdSnapshot,
                      providerId: pod.providerIdSnapshot,
                    },
                  }
                : {}),
            });
            const runtimeNetworkPolicy = addRuntimeNetworkDefaults(
              profile.networkPolicy,
              profile,
              pod.runtime,
              providerPreflight.manifestProvider,
              providerPreflight.account,
            );
            // biome-ignore lint/style/noNonNullAssertion: runningSessions always have a containerId
            const containerId = pod.containerId!;
            if (pod.executionTarget === 'sandbox') {
              if (!runtimeNetworkPolicy?.enabled) return;
              const allowedHosts = computeNetworkPolicyAllowlist(
                runtimeNetworkPolicy,
                mergedServers,
                hostnameFromUrl(mcpBaseUrl),
                profile.privateRegistries,
              );
              const cm = containerManagerFactory.get('sandbox');
              await cm.refreshFirewall(
                containerId,
                sandboxEgressRefreshPayload(
                  runtimeNetworkPolicy.mode ?? 'restricted',
                  allowedHosts,
                ),
              );
            } else {
              if (!networkManager) return;
              const gatewayIp = await networkManager.getGatewayIp(pod.id);
              const sidecarIps = await collectSidecarIps(pod);
              const netConfig = await networkManager.buildNetworkConfig(
                runtimeNetworkPolicy,
                mergedServers,
                gatewayIp,
                profile.privateRegistries,
                pod.id,
                sidecarIps,
                [hostnameFromUrl(mcpBaseUrl)],
                portFromUrl(mcpBaseUrl),
              );
              if (!netConfig) return;
              const cm = containerManagerFactory.get('local');
              await cm.refreshFirewall(containerId, netConfig.firewallScript);
            }
            logger.info(
              { podId: pod.id, profileName },
              'Network policy refreshed on running container',
            );
          } catch (err) {
            logger.warn(
              { err, podId: pod.id, profileName },
              'Failed to refresh network policy on running container',
            );
          }
        }),
      );
    },

    async injectCredential(_podId: string, _service: 'github' | 'ado'): Promise<void> {
      throw new AutopodError(
        'Source credentials stay with the AutoPod daemon. Use scoped access tools; push and PR delivery are daemon-owned.',
        'SOURCE_CREDENTIAL_INJECTION_DISABLED',
        410,
      );
    },

    async installCliTool(podId: string, tool: 'gh' | 'az'): Promise<void> {
      const pod = podRepo.getOrThrow(podId);
      if (pod.status !== 'running') {
        throw new AutopodError(
          `Pod ${podId} is ${pod.status} — can only install tools into running pods.`,
          'INVALID_STATE',
          409,
        );
      }
      if (!pod.containerId) {
        throw new AutopodError(`Pod ${podId} has no running container`, 'INVALID_STATE', 409);
      }
      const cm = containerManagerFactory.get(pod.executionTarget);
      const containerId = pod.containerId;

      const check = await cm.execInContainer(containerId, ['sh', '-c', `command -v ${tool}`]);
      if (check.exitCode === 0) {
        emitActivityStatus(podId, `${tool} is already installed.`);
        return;
      }

      emitActivityStatus(podId, `Installing ${tool} CLI…`);
      if (tool === 'gh') {
        await installGhBinary(cm, containerId, podId);
      } else {
        await installAzViaPip(cm, containerId, podId);
      }
      emitActivityStatus(podId, `${tool} CLI installed.`);
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
      const unavailable: ArtifactResumeObservation = {
        protocol: 'artifact-resume-observation-v1',
        state: 'unavailable',
        operations: [],
      };
      if (!deps.eventRepo) return unavailable;
      try {
        assertExecutionTerminationVerified(podId);
        assertGuidanceCollected(podId);
        if (podRepo.taskExecutions?.hasActiveRun(podId)) return unavailable;
        const pod = podRepo.getOrThrow(podId);
        const key = `${pod.id}:${pod.lifecycleGeneration}:${pod.finalization?.cycle ?? 0}`;
        return observeArtifactResume(
          pod,
          deps.eventRepo.getForSession(podId),
          artifactResumeRuns.has(podId) || artifactCompletionRuns.has(key),
        );
      } catch {
        // Reading status must never resume a process or claim an unavailable exit.
        return unavailable;
      }
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

    async forceComplete(
      podId: string,
      reason?: string,
      actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
    ): Promise<void> {
      podRepo.deletionOwnership?.assertTaskAvailable(podId);
      const pod = podRepo.getOrThrow(podId);
      if (pod.status === 'complete') {
        throw new AutopodError(`Pod ${podId} is already complete`, 'INVALID_STATE', 409);
      }
      if (pod.status !== 'failed') {
        throw new AutopodError(
          `Cannot force-complete pod ${podId} in status ${pod.status} — only failed pods are eligible`,
          'INVALID_STATE',
          409,
        );
      }

      // Force-complete is terminal — kill+remove the container so it doesn't
      // linger as a stopped record in Docker. Bounded so a wedged engine can't
      // hang the operator endpoint.
      await cleanupContainer(pod, 'force-complete');

      const trimmedReason = reason?.trim() || null;
      const now = new Date().toISOString();
      podRepo.update(podId, {
        forceCompletedAt: now,
        forceCompletedReason: trimmedReason,
      });
      transition(pod, 'complete');
      emitActivityStatus(
        podId,
        trimmedReason
          ? `Force-completed by ${actorLabel(actor)}: ${trimmedReason}`
          : `Force-completed by ${actorLabel(actor)}`,
      );
      logger.warn(
        { podId, reason: trimmedReason },
        'Pod force-completed by operator (admin override — push/PR/merge skipped)',
      );

      // Series children that were waiting on this pod must be triggered just
      // like a normal completion — otherwise the entire downstream series
      // stalls in `queued` forever and the operator has to manually `kick`
      // each dependent. The whole point of force-complete is to unstick a
      // series, so silently failing to advance it is a footgun.
      const completedPod = podRepo.getOrThrow(podId);
      maybeTriggerDependents(completedPod);
    },

    async kickPod(
      podId: string,
      reason?: string,
      actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
    ): Promise<{ action: 'requeued' | 'failed' }> {
      const pod = podRepo.getOrThrow(podId);
      const trimmedReason = reason?.trim() || null;
      const nowIso = new Date().toISOString();

      if (pod.status === 'queued') {
        // A pod that has been in `queued` long enough for an operator to kick is
        // past any live processPod (status would have moved to provisioning). If the
        // queue still tracks it as active, that's a stale entry from a previous run
        // whose finally never ran — clear it so the upcoming enqueue isn't silently
        // dedup'd. Without this, the kick endpoint reports success but the pod sits
        // forever because `enqueue`'s `activeIds.has(podId)` check returns true.
        const cleared = clearStuckQueueEntry?.(podId) ?? false;
        podRepo.update(podId, { kickedAt: nowIso, kickedReason: trimmedReason });
        enqueueSession(podId);
        emitActivityStatus(
          podId,
          trimmedReason
            ? `Re-enqueued by ${actorLabel(actor)}: ${trimmedReason}`
            : `Re-enqueued by ${actorLabel(actor)}`,
        );
        logger.warn(
          { podId, reason: trimmedReason, clearedStuckEntry: cleared },
          'Pod kicked by operator — re-enqueued from queued',
        );
        return { action: 'requeued' };
      }

      if (
        pod.status === 'running' ||
        pod.status === 'provisioning' ||
        pod.status === 'validating'
      ) {
        // Bounded — the whole point of kick is to free a slot when something
        // upstream (often Docker itself) is wedged. The transition to `failed`
        // must not depend on Docker cooperating. Mode='stop' so a subsequent
        // `resume` can still restart the same container if Docker recovers.
        validationAbortControllers.get(podId)?.abort();
        await cleanupContainer(pod, 'kick', 'stop');
        podRepo.update(podId, { kickedAt: nowIso, kickedReason: trimmedReason });
        transition(pod, 'failed', { completedAt: nowIso });
        emitActivityStatus(
          podId,
          trimmedReason
            ? `Kicked by ${actorLabel(actor)} (force-failed): ${trimmedReason}`
            : `Kicked by ${actorLabel(actor)} (force-failed)`,
        );
        logger.warn(
          { podId, previousStatus: pod.status, reason: trimmedReason },
          'Pod kicked by operator — transitioned to failed',
        );
        return { action: 'failed' };
      }

      throw new AutopodError(
        `Cannot kick pod ${podId} in status ${pod.status} — only queued/running/provisioning/validating are eligible`,
        'INVALID_STATE',
        409,
      );
    },

    startStuckPodWatchdog(options?: { intervalMs?: number; thresholdMs?: number }): void {
      if (stuckPodWatchdog) return; // idempotent
      const intervalMs = options?.intervalMs ?? 60_000;
      const thresholdMs =
        options?.thresholdMs ??
        (process.env.AUTOPOD_STUCK_RUNNING_THRESHOLD_MS
          ? Number(process.env.AUTOPOD_STUCK_RUNNING_THRESHOLD_MS)
          : 30 * 60 * 1_000);

      const WAKE_GRACE_MS = 60_000;
      let lastWakeAt: number | null = null;

      const tick = async (): Promise<void> => {
        try {
          const sinceWakeMs = lastWakeAt !== null ? Date.now() - lastWakeAt : null;
          if (sinceWakeMs !== null && sinceWakeMs < WAKE_GRACE_MS) {
            logger.debug({ sinceWakeMs }, 'Watchdog: skipping tick during wake grace window');
            return;
          }
          const running = podRepo.list({ status: 'running' as PodStatus });
          const now = Date.now();
          for (const pod of running) {
            // Workspace (interactive) pods have no agent by design — the human
            // drives the container directly. They will never emit agent events,
            // so silence-based timeout cannot apply.
            if (pod.options?.agentMode === 'interactive') continue;
            // Reference is the most recent of (lastAgentEventAt, lastHeartbeatAt,
            // startedAt) — all are real liveness signals scoped to the current run.
            // MCP tools can legitimately stay open while validation runs without
            // producing an agent-stream event, so their heartbeat must defer the
            // watchdog just like an agent event does.
            // `startedAt` is reset on every transition into provisioning, so it
            // acts as a freshness floor that prevents a stale `lastAgentEventAt`
            // or `lastHeartbeatAt` (from a prior life of the same pod, e.g. across
            // recovery) from dragging the reference back across the threshold.
            // Fall back to updatedAt/createdAt only when all primary signals
            // are missing (pods predating the migration that added these fields).
            const primary = [pod.lastAgentEventAt, pod.lastHeartbeatAt, pod.startedAt]
              .filter((t): t is string => typeof t === 'string')
              .map((t) => new Date(t).getTime())
              .filter((ms) => !Number.isNaN(ms));
            let refMs: number;
            if (primary.length > 0) {
              refMs = Math.max(...primary);
            } else {
              const fallback = pod.updatedAt ?? pod.createdAt;
              refMs = new Date(fallback).getTime();
              if (Number.isNaN(refMs)) continue;
            }
            const ageMs = now - refMs;
            if (ageMs < thresholdMs) continue;

            logger.warn(
              { podId: pod.id, ageMs, thresholdMs },
              'Watchdog: running pod has gone silent — transitioning to failed',
            );
            if (pod.containerId) {
              try {
                await stopSandboxPreviewProxy(pod.id);
                const cm = containerManagerFactory.get(pod.executionTarget);
                await cm.stop(pod.containerId);
              } catch (err) {
                logger.warn({ err, podId: pod.id }, 'Watchdog: failed to stop container');
              }
            }
            try {
              const fresh = podRepo.getOrThrow(pod.id);
              if (fresh.status !== 'running') continue; // raced with another transition
              transition(fresh, 'failed', { completedAt: new Date(now).toISOString() });
              emitActivityStatus(pod.id, 'Watchdog: no agent activity — pod auto-failed');
            } catch (err) {
              logger.warn({ err, podId: pod.id }, 'Watchdog: transition to failed failed');
            }
          }
        } catch (err) {
          logger.warn({ err }, 'Stuck-pod watchdog tick failed');
        }
      };

      stuckPodWatchdog = setInterval(() => {
        void tick();
      }, intervalMs);
      logger.info({ intervalMs, thresholdMs }, 'Stuck-pod watchdog started');

      // Wake-recovery: subscribe to host.resumed, reconcile local pods, then re-publish
      // a richer event (with reconciledPodIds) for the desktop banner.
      // De-dupe by source timestamp so the re-published event doesn't trigger a second
      // reconcile (even when 0 pods are recovered and reconciledPodIds:[] is ambiguous).
      // Bounded at 256 entries — one per wake event — resets on overflow.
      const processedWakeTimestamps = new Set<string>();
      unsubscribeWakeRecovery = eventBus.subscribe((event) => {
        if (event.type !== 'host.resumed') return;
        // Update before the dedupe check so every host.resumed (including the
        // re-published completed event) refreshes the grace window.
        lastWakeAt = Date.now();
        if (processedWakeTimestamps.has(event.timestamp)) return;
        if (processedWakeTimestamps.size >= 256) processedWakeTimestamps.clear();
        processedWakeTimestamps.add(event.timestamp);

        const { sleptMs, detector, timestamp } = event;
        logger.info({ sleptMs, detector }, 'Host wake detected — reconciling local sessions');

        void (async () => {
          try {
            const result = await reconcileLocalSessions({
              podRepo,
              readNativeGoal: deps.launchConfiguration?.goals?.get,
              finishCancelledGoal: (id) => this.killSession(id),
              eventBus,
              containerManager: containerManagerFactory.get('local'),
              enqueueSession,
              validationRepo,
              cleanupPodResources: (id) => this.cleanupPodResourcesForRecovery(id),
              logger,
              trigger: 'wake',
            });
            logger.info(
              { recovered: result.recovered, killed: result.killed, sleptMs },
              'Wake reconcile complete',
            );
            // Re-publish with reconciledPodIds populated so the desktop banner shows counts.
            // Use the original timestamp so the processedWakeTimestamps guard suppresses the
            // subscriber from firing again (handles the 0-recovered edge case).
            eventBus.emit({
              type: 'host.resumed',
              timestamp,
              sleptMs,
              detector,
              reconciledPodIds: result.recovered,
            });
          } catch (err) {
            logger.error({ err, sleptMs }, 'Wake reconcile failed');
          }
        })();
      });
    },

    stopStuckPodWatchdog(): void {
      if (stuckPodWatchdog) {
        clearInterval(stuckPodWatchdog);
        stuckPodWatchdog = null;
      }
      if (unsubscribeWakeRecovery) {
        unsubscribeWakeRecovery();
        unsubscribeWakeRecovery = null;
      }
    },

    async recoverWorktree(podId: string): Promise<{
      recovered: boolean;
      message: string;
      blockers?: Array<{ status: string; path: string }>;
    }> {
      const pod = podRepo.getOrThrow(podId);
      if (!pod.worktreeCompromised) {
        throw new AutopodError(
          `Pod ${podId} worktree is not compromised — nothing to recover`,
          'INVALID_STATE',
          409,
        );
      }
      if (!pod.worktreePath) {
        return {
          recovered: false,
          message: 'Pod has no worktree — manual extraction needed',
        };
      }

      if (pod.executionTarget === 'sandbox') {
        if (pod.containerId) {
          const cm = containerManagerFactory.get('sandbox');
          if ((await cm.getStatus(pod.containerId)) === 'stopped') {
            await cm.start(pod.containerId);
            emitActivityStatus(podId, 'Resumed retained sandbox for checkpoint recovery.');
          }
        }
        const checkpoint = await checkpointSandboxWorkspaceForPod(pod);
        const recovered =
          checkpoint.lineageVerified && checkpoint.promoted && checkpoint.materialized;
        if (!recovered) {
          return {
            recovered: false,
            message: `Verified checkpoint recovery incomplete: ${checkpoint.error?.message ?? 'proof missing'}`,
            checkpoint,
          };
        }
        podRepo.update(podId, { worktreeCompromised: false, preSubmitReview: null });
        emitActivityStatus(podId, 'Verified checkpoint recovered and materialized the worktree.');
        return {
          recovered: true,
          message: 'Verified checkpoint recovered and materialized',
          checkpoint,
        };
      }

      // Path A — container is alive: pull /workspace from the live container,
      // overwrite the partial host worktree, then auto-commit. Most powerful
      // recovery because it captures any uncommitted state still inside the
      // container's overlayfs.
      if (pod.containerId) {
        const cm = containerManagerFactory.get(pod.executionTarget);
        const recovered = await recoverWorktreeFromContainer(
          pod.containerId,
          pod.worktreePath,
          cm,
          pod.id,
        );
        if (recovered) {
          try {
            const profileForRecovery = executionForPod(pod);
            await worktreeManager.commitPendingChangesWithGeneratedMessage(
              pod.worktreePath,
              pod.task,
              profileForRecovery,
              pod.model,
              { maxDeletions: 100 },
            );
            podRepo.update(podId, { worktreeCompromised: false });
            emitActivityStatus(
              podId,
              'Worktree recovered from container and committed successfully',
            );
            return { recovered: true, message: 'Worktree recovered and committed' };
          } catch (err) {
            return {
              recovered: false,
              message: `Recovery failed at commit stage: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }
        // Live recovery failed — fall through to the bare-repo path. The
        // agent's commits may still be on the bare from a successful
        // in-container push during the original sync-back attempt.
        logger.info(
          { podId },
          'Live container recovery failed — trying bare-repo restore fallback',
        );
      }

      // Path B — no container (or live recovery failed): the agent's commits
      // are typically already on the bare via the in-container `git push` step
      // of syncWorkspaceBack, even when the file-copy half timed out. The host
      // worktree's HEAD/index point at those commits — only working-tree files
      // are stale on disk. `restoreFromHead` is gated on recoverable tracked-file
      // damage so it can fix stale index/deletion/corruption states without
      // sweeping unrelated untracked work.
      const restored = await worktreeManager.restoreFromHead(pod.worktreePath, {
        allowTrackedModifications: true,
      });
      if (!restored.restored) {
        return {
          recovered: false,
          message: pod.containerId
            ? `Container not reachable and bare-repo restore refused: ${restored.reason}`
            : `No container to recover from; bare-repo restore refused: ${restored.reason}`,
          blockers: restored.blockers,
        };
      }
      podRepo.update(podId, { worktreeCompromised: false });
      emitActivityStatus(podId, `Worktree recovered from HEAD — ${restored.reason}`);
      return { recovered: true, message: restored.reason };
    },
  };
}

function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'host.docker.internal';
  }
}

function portFromUrl(url: string): number {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number.parseInt(parsed.port, 10);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return 3100;
  }
}
