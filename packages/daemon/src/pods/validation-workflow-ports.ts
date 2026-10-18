import type {
  AgentEvent,
  EffectiveLaunchConfig,
  ExecutionTarget,
  OperatorActor,
  Pod,
  PodStatus,
  ScanFinding,
  ValidationOverride,
  ValidationResult,
  ValidationWaiver,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type {
  ContainerManager,
  PrManager,
  ValidationEngine,
  WorktreeManager,
} from '../interfaces/index.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { ScanRepository, StoredScan } from '../security/index.js';
import type { GitCredentialError } from '../worktrees/local-worktree-manager.js';
import type { createAdvisoryValidation } from './advisory-validation.js';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventBus } from './event-bus.js';
import type { NudgeRepository } from './nudge-repository.js';
import type { PendingOverrideRepository } from './pending-override-repository.js';
import type { PodGoalService } from './pod-goal-service.js';
import type { PodRepository, PodUpdates } from './pod-repository.js';
import type { createRevalidationPassDelivery } from './revalidation-pass-delivery.js';
import type { createReviewerContext } from './reviewer-context.js';
import type { createValidationAttemptStart } from './validation-attempt-start.js';
import type { createValidationEnvironment } from './validation-environment.js';
import type { createValidationEvidence } from './validation-evidence.js';
import type { createValidationExecution } from './validation-execution.js';
import type { createValidationInfrastructure } from './validation-infrastructure.js';
import type { createValidationInputs } from './validation-inputs.js';
import type { createValidationPassDelivery } from './validation-pass-delivery.js';
import type { createValidationProgress } from './validation-progress.js';
import type { createValidationProvenance } from './validation-provenance.js';
import type { createValidationPublication } from './validation-publication.js';
import type { ValidationRepository } from './validation-repository.js';
import type { createValidationWorkspace } from './validation-workspace.js';
import type { createWorkerRuntimeCredentials } from './worker-runtime-credentials.js';
import type { createWorkspacePreservation } from './workspace-preservation.js';

export type AgentRunOutcome = 'completed' | 'failed' | 'paused' | 'stopped';

export interface ValidationWorkflowLiveDependencies {
  launchConfiguration?: {
    read(podId: string): EffectiveLaunchConfig | null;
    goals?: Pick<PodGoalService, 'get'>;
  };
  pendingOverrideRepo?: Pick<PendingOverrideRepository, 'flush'>;
}

export interface ValidationWorkflowDependencies {
  completeValidationPass: ReturnType<typeof createValidationPassDelivery>['completeValidationPass'];
  completeRevalidationPass: ReturnType<
    typeof createRevalidationPassDelivery
  >['completeRevalidationPass'];
  podRepo: PodRepository;
  transition: (pod: Pod, to: PodStatus, extraUpdates?: Partial<PodUpdates> | undefined) => Pod;
  executionForPod: (pod: Pod) => PodExecutionSettings;
  emitActivityStatus: (podId: string, message: string) => void;
  worktreeManager: WorktreeManager;
  resolveGitCredential: (profile: PodExecutionSettings) => Promise<string | undefined>;
  forceWithLeaseAllowances: Set<string>;
  buildValidationWaiver: (
    result: ValidationResult | null,
    reason: string | undefined,
    actor: OperatorActor,
  ) => ValidationWaiver;
  actorLabel: (actor: OperatorActor) => string;
  logger: Logger;
  pendingUpdateFromBaseIntents: Set<string>;
  assertExecutionTerminationVerified: (podId: string) => void;
  validationAbortControllers: Map<string, AbortController>;
  nudgeRepo: NudgeRepository;
  attemptExtensionRuns: Map<string, Promise<void>>;
  mergeOverrides: (
    existing: ValidationOverride[],
    incoming: ValidationOverride[],
  ) => ValidationOverride[];
  escalationRepo: EscalationRepository;
  legacyRespondedBy: (actor: OperatorActor) => 'human' | 'ai';
  maybeTriggerDependents: (completedPod: Pod) => void;
  beginGoalTaskRework: (pod: Pod, task: string) => Promise<boolean>;
  buildManualReworkReason: (pod: Pod, blockedPushScan?: StoredScan | undefined) => string;
  runUpdateFromBaseAfterAbort: (
    podId: string,
    startFollowUpValidation: () => void,
  ) => Promise<void>;
  resolveEffectiveBoundProfile: (pod: Pod) => PodExecutionSettings;
  preservePodWorkspace: ReturnType<typeof createWorkspacePreservation>['preservePodWorkspace'];
  killSidecarsForPod: (
    podId: string,
    strict?: boolean,
    assertCurrent?: (() => void) | undefined,
    retainMetadata?: boolean,
  ) => Promise<void>;
  cleanupTestRunBranches: (
    podId: string,
    options?:
      | { strict: boolean; assertCurrent: () => void; retainMetadata?: boolean | undefined }
      | undefined,
  ) => Promise<void>;
  cleanupContainer: (
    pod: Pod,
    label: string,
    mode?: 'kill' | 'stop',
    assertReleaseAllowed?: (() => void) | undefined,
  ) => Promise<void>;
  destroyPodNetwork: (podId: string, strict?: boolean) => Promise<void>;
  scanRepo: ScanRepository | undefined;
  enqueueSession: (podId: string) => void;
  startValidationAttempt: ReturnType<typeof createValidationAttemptStart>['startValidationAttempt'];
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  validationRepo: ValidationRepository | undefined;
  eventBus: EventBus;
  parkOnValidationInfrastructureFailure: ReturnType<
    typeof createValidationInfrastructure
  >['parkOnValidationInfrastructureFailure'];
  checkpointSandboxWorkspaceForPod: ReturnType<
    typeof createWorkspacePreservation
  >['checkpointSandboxWorkspaceForPod'];
  prepareWorkspaceForValidation: ReturnType<
    typeof createValidationWorkspace
  >['prepareWorkspaceForValidation'];
  tryRecoverAfterWorkspaceSyncFailure: (
    pod: Pod,
    err: unknown,
    phase: 'auto-commit' | 'validation',
  ) => Promise<boolean>;
  parkOnWorktreeSyncFailure: (podId: string, reason: string) => void;
  prepareValidationInputs: ReturnType<typeof createValidationInputs>['prepareValidationInputs'];
  validationEngine: ValidationEngine;
  claimValidation: (
    expectedPod: Pod,
    validationController: AbortController,
  ) => { assertCurrent(): Pod; isCurrent(): boolean };
  validateWithInfrastructureRetries: ReturnType<
    typeof createValidationExecution
  >['validateWithInfrastructureRetries'];
  buildPhaseEventCallbacks: ReturnType<typeof createValidationProgress>['buildPhaseEventCallbacks'];
  ownsLifecycle: (podId: string, generation: number, containerId: string | null) => boolean;
  collectValidationEvidence: ReturnType<
    typeof createValidationEvidence
  >['collectValidationEvidence'];
  publishValidationResult: ReturnType<
    typeof createValidationPublication
  >['publishValidationResult'];
  parkOnReviewInfrastructureFailure: ReturnType<
    typeof createValidationInfrastructure
  >['parkOnReviewInfrastructureFailure'];
  recordValidationProvenance: ReturnType<
    typeof createValidationProvenance
  >['recordValidationProvenance'];
  withReviewerLaunchPreflight: ReturnType<
    typeof createValidationProvenance
  >['withReviewerLaunchPreflight'];
  ownedValidationCallbacks: ReturnType<typeof createValidationProgress>['ownedValidationCallbacks'];
  applySkipValidationDecision: (pod: Pod, result: ValidationResult) => Pod | null;
  stopSandboxPreviewProxy: (podId: string) => Promise<void>;
  prManagerFactory: ((profile: PodExecutionSettings) => PrManager | null) | undefined;
  parkOnCredentialFailure: (podId: string, err: GitCredentialError) => true;
  handleDeletionGuardError: (podId: string, err: unknown) => boolean;
  warnIfSinglePrSeriesMissingSeriesMeta: (pod: Pod, logger: Logger) => void;
  resolvePrBaseBranch: (pod: Pod, profile: PodExecutionSettings) => string;
  ensurePrBaseBranchOnOrigin: (
    pod: Pod,
    profile: PodExecutionSettings,
    baseBranch: string,
    callerLabel: string,
  ) => Promise<void>;
  getLatestPushFindings: (podId: string) => ScanFinding[];
  refreshReadiness: (
    podId: string,
    options?: { advisoryQaInFlight?: boolean | undefined },
  ) => boolean;
  runAdvisoryAfterValidation: ReturnType<
    typeof createAdvisoryValidation
  >['runAdvisoryAfterValidation'];
  advisoryPublicationOwnership: ReturnType<
    typeof createAdvisoryValidation
  >['advisoryPublicationOwnership'];
  completeFixPodAfterPush: (fixPod: Pod) => Promise<void>;
  taskFeedbackEvents: (
    podId: string,
    message: string,
    fresh: boolean,
  ) => Promise<AsyncIterable<AgentEvent>>;
  persistRuntimeCredentialsForPod: ReturnType<
    typeof createWorkerRuntimeCredentials
  >['persistRuntimeCredentialsForPod'];
  parkOnRetryAdmission: ReturnType<typeof createValidationInfrastructure>['parkOnRetryAdmission'];
  isParkedHostPushRecovery: (pod: Pod) => boolean;
  parkFixPodDeliveryFailure: (fixPod: Pod, err: unknown) => void;
  sanitizeFailureReason: (raw: unknown, prefix: string) => string;
  emitActivityError: (podId: string, message: string, fatal?: boolean) => void;
  assertGuidanceCollected: (podId: string) => void;
  runPushCheckpointScan: (pod: Pod, profile: PodExecutionSettings) => Promise<void>;
  validationEnvironmentForPod: ReturnType<
    typeof createValidationEnvironment
  >['validationEnvironmentForPod'];
  getEffectiveReviewerConfig: ReturnType<
    typeof createReviewerContext
  >['getEffectiveReviewerConfig'];
  buildReviewerExecEnv: ReturnType<typeof createReviewerContext>['buildReviewerExecEnv'];
  CONTAINER_APP_PORT: 3000;
  getReviewerExecutor: ReturnType<typeof createReviewerContext>['getReviewerExecutor'];
}

export interface ValidationWorkflowCalls {
  triggerValidation(
    podId: string,
    options?: { force?: boolean; validationOnly?: boolean },
  ): Promise<void>;
  assertCanRework(podId: string): void;
  approveSession(
    podId: string,
    options?: { squash?: boolean; reason?: string; automation?: boolean; actor?: OperatorActor },
  ): Promise<void>;
  consumeAgentEvents(
    podId: string,
    events: AsyncIterable<AgentEvent>,
    attempt?: number,
  ): Promise<AgentRunOutcome>;
  handleCompletion(podId: string): Promise<void>;
}

export interface ValidationPassContext {
  podId: string;
  pod: Pod;
  profile: PodExecutionSettings;
  s2: Pod;
  result: ValidationResult;
  validationSyncOk: boolean;
  attempt: number;
  validationConfig: Parameters<ValidationEngine['validate']>[0];
  validationRecord: ReturnType<ValidationWorkflowDependencies['publishValidationResult']>;
}
export type RevalidationPassContext = Omit<
  ValidationPassContext,
  'validationSyncOk' | 'attempt'
> & { revalDefaultBranch: string; newCommits: boolean };

export type ValidationPassCaptured = Pick<
  ValidationWorkflowDependencies,
  | 'warnIfSinglePrSeriesMissingSeriesMeta'
  | 'resolvePrBaseBranch'
  | 'podRepo'
  | 'containerManagerFactory'
  | 'worktreeManager'
  | 'validationEngine'
  | 'logger'
  | 'prManagerFactory'
  | 'resolveGitCredential'
  | 'refreshReadiness'
  | 'getLatestPushFindings'
  | 'stopSandboxPreviewProxy'
  | 'pendingUpdateFromBaseIntents'
  | 'completeFixPodAfterPush'
  | 'emitActivityStatus'
  | 'advisoryPublicationOwnership'
  | 'runAdvisoryAfterValidation'
  | 'parkOnCredentialFailure'
  | 'handleDeletionGuardError'
  | 'ensurePrBaseBranchOnOrigin'
  | 'transition'
  | 'maybeTriggerDependents'
>;
export type ValidationTriggerCaptured = Pick<
  ValidationWorkflowDependencies,
  | 'buildManualReworkReason'
  | 'mergeOverrides'
  | 'podRepo'
  | 'escalationRepo'
  | 'eventBus'
  | 'containerManagerFactory'
  | 'validationEngine'
  | 'enqueueSession'
  | 'logger'
  | 'validationRepo'
  | 'scanRepo'
  | 'assertExecutionTerminationVerified'
  | 'resolveEffectiveBoundProfile'
  | 'beginGoalTaskRework'
  | 'taskFeedbackEvents'
  | 'destroyPodNetwork'
  | 'cleanupContainer'
  | 'stopSandboxPreviewProxy'
  | 'killSidecarsForPod'
  | 'cleanupTestRunBranches'
  | 'validationAbortControllers'
  | 'ownsLifecycle'
  | 'pendingUpdateFromBaseIntents'
  | 'parkFixPodDeliveryFailure'
  | 'isParkedHostPushRecovery'
  | 'runUpdateFromBaseAfterAbort'
  | 'persistRuntimeCredentialsForPod'
  | 'prepareWorkspaceForValidation'
  | 'preservePodWorkspace'
  | 'checkpointSandboxWorkspaceForPod'
  | 'startValidationAttempt'
  | 'prepareValidationInputs'
  | 'buildPhaseEventCallbacks'
  | 'ownedValidationCallbacks'
  | 'recordValidationProvenance'
  | 'withReviewerLaunchPreflight'
  | 'validateWithInfrastructureRetries'
  | 'collectValidationEvidence'
  | 'publishValidationResult'
  | 'parkOnRetryAdmission'
  | 'parkOnValidationInfrastructureFailure'
  | 'parkOnReviewInfrastructureFailure'
  | 'emitActivityStatus'
  | 'emitActivityError'
  | 'sanitizeFailureReason'
  | 'tryRecoverAfterWorkspaceSyncFailure'
  | 'parkOnWorktreeSyncFailure'
  | 'transition'
  | 'applySkipValidationDecision'
  | 'claimValidation'
  | 'maybeTriggerDependents'
  | 'completeValidationPass'
>;

export type RevalidationPassCaptured = Pick<
  ValidationWorkflowDependencies,
  | 'warnIfSinglePrSeriesMissingSeriesMeta'
  | 'resolvePrBaseBranch'
  | 'podRepo'
  | 'containerManagerFactory'
  | 'worktreeManager'
  | 'validationEngine'
  | 'logger'
  | 'prManagerFactory'
  | 'resolveGitCredential'
  | 'refreshReadiness'
  | 'getLatestPushFindings'
  | 'emitActivityStatus'
  | 'advisoryPublicationOwnership'
  | 'runAdvisoryAfterValidation'
  | 'handleDeletionGuardError'
  | 'ensurePrBaseBranchOnOrigin'
  | 'transition'
  | 'maybeTriggerDependents'
>;
export type ValidationRevalidationCaptured = Pick<
  ValidationWorkflowDependencies,
  | 'CONTAINER_APP_PORT'
  | 'podRepo'
  | 'eventBus'
  | 'containerManagerFactory'
  | 'worktreeManager'
  | 'validationEngine'
  | 'enqueueSession'
  | 'logger'
  | 'validationRepo'
  | 'executionForPod'
  | 'validationEnvironmentForPod'
  | 'assertExecutionTerminationVerified'
  | 'assertGuidanceCollected'
  | 'resolveGitCredential'
  | 'runPushCheckpointScan'
  | 'validationAbortControllers'
  | 'buildReviewerExecEnv'
  | 'getEffectiveReviewerConfig'
  | 'getReviewerExecutor'
  | 'prepareWorkspaceForValidation'
  | 'buildPhaseEventCallbacks'
  | 'validateWithInfrastructureRetries'
  | 'publishValidationResult'
  | 'parkOnRetryAdmission'
  | 'parkOnValidationInfrastructureFailure'
  | 'parkOnReviewInfrastructureFailure'
  | 'emitActivityStatus'
  | 'emitActivityError'
  | 'sanitizeFailureReason'
  | 'tryRecoverAfterWorkspaceSyncFailure'
  | 'parkOnWorktreeSyncFailure'
  | 'transition'
  | 'applySkipValidationDecision'
  | 'claimValidation'
  | 'maybeTriggerDependents'
  | 'completeRevalidationPass'
>;
