import type {
  CreatePodRequest,
  EffectiveLaunchConfig,
  ExecutionTarget,
  OperatorActor,
  Pod,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager, WorktreeManager } from '../interfaces/index.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { ProfileStore } from '../profiles/index.js';
import type { createApprovalReadiness } from './approval-readiness.js';
import type { createArtifactFinalizer } from './artifact-finalizer.js';
import type { createCompletionEvents } from './completion-events.js';
import type { createCompletionGuards } from './completion-guards.js';
import type { createDeliveryScan } from './delivery-scan.js';
import type { EventBus } from './event-bus.js';
import type { EventRepository } from './event-repository.js';
import type { NudgeRepository } from './nudge-repository.js';
import type { PodRepository } from './pod-repository.js';
import type { createProviderAttemptContext } from './provider-attempt-context.js';
import type { ProviderAttemptRepository } from './provider-attempt-repository.js';
import type { createResourceAuxiliary } from './resource-auxiliary.js';
import type { createResourceCleanup } from './resource-cleanup.js';
import type { createResourcePreviewTimers } from './resource-preview-timers.js';
import type { createResourcePreview } from './resource-preview.js';
import type { ValidationRepository } from './validation-repository.js';
import type { createValidationWorkflowState } from './validation-workflow-state.js';
import type { createWorkspacePreservation } from './workspace-preservation.js';
import type { createWorkspaceRecoveryState } from './workspace-recovery-state.js';
import type { createWorkspaceTransfer } from './workspace-transfer.js';
export interface PodCreator {
  email?: string | null;
  name?: string | null;
}
export interface WorkspaceCompletionResult {
  pushError?: string;
  promotedTo?: 'pr' | 'branch' | 'artifact' | 'none';
}
export interface WorkspaceCompletionCalls {
  promoteToAuto(
    podId: string,
    targetOutput: 'pr' | 'branch' | 'artifact' | 'none',
    options?: { instructions?: string; skipAgent?: boolean },
  ): Promise<void>;
  revalidateSession(podId: string): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }>;
}
export interface WorkspaceManualFixCalls {
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
}
export interface WorkspaceWatchdogCalls {
  killSession(podId: string): Promise<void>;
  cleanupPodResourcesForRecovery(podId: string): Promise<void>;
}
export interface WorkspaceInfrastructureLiveDependencies {
  eventRepo?: EventRepository;
  providerAttemptRepo?: Pick<ProviderAttemptRepository, 'list'>;
  sandboxInfrastructureRetryBackoffMs?: readonly number[];
  requeueSessionAfterCurrent?: (podId: string) => void;
  enqueueSession: (podId: string) => void;
}
export interface WorkspacePromotionLiveDependencies {
  launchConfiguration?: {
    prepareWorker?: (
      input: import('../configuration/derive-launch.js').DerivedLaunchInput,
      apply: (config: EffectiveLaunchConfig) => void,
    ) => Promise<void>;
  };
}
export interface WorkspaceCompletionLiveDependencies {
  getSecret: (ref: string) => string | undefined;
}
export interface WorkspaceManualFixLiveDependencies {
  launchConfiguration?: {
    admitDerived?: (
      input: import('../configuration/derive-launch.js').DerivedLaunchInput,
      createPod: (config: EffectiveLaunchConfig) => string,
    ) => Promise<string>;
  };
}
export interface WorkspaceObservationLiveDependencies {
  eventRepo?: Pick<EventRepository, 'getForSession'>;
}
export interface WorkspaceWatchdogLiveDependencies {
  launchConfiguration?: { goals?: Pick<import('./pod-goal-service.js').PodGoalService, 'get'> };
}

export interface WorkspaceHostFetchCaptured {
  podRepo: PodRepository;
  enqueueSession: (podId: string) => void;
  emitActivityStatus: ReturnType<typeof createCompletionEvents>['emitActivityStatus'];
}

export interface WorkspaceInfrastructureCaptured {
  ownsLifecycle: ReturnType<typeof createCompletionGuards>['ownsLifecycle'];
  podRepo: PodRepository;
  emitActivityStatus: ReturnType<typeof createCompletionEvents>['emitActivityStatus'];
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  logger: Logger;
  closeProviderAttempt: ReturnType<typeof createProviderAttemptContext>['closeProviderAttempt'];
  killSidecarsForPod: ReturnType<typeof createResourceAuxiliary>['killSidecarsForPod'];
  destroyPodNetwork: (podId: string, strict?: boolean) => Promise<void>;
}

export interface WorkspaceBranchSourceCaptured {
  podRepo: PodRepository;
  logger: Logger;
}

export interface WorkspaceFencesCaptured {
  podRepo: PodRepository;
  logger: Logger;
  eventBus: EventBus;
  emitActivityStatus: ReturnType<typeof createCompletionEvents>['emitActivityStatus'];
  nudgeRepo: NudgeRepository;
  emitActivityError: ReturnType<typeof createCompletionEvents>['emitActivityError'];
  assertApprovalCurrent: ReturnType<typeof createApprovalReadiness>['assertApprovalCurrent'];
  assertGuidanceCollected: ReturnType<typeof createCompletionGuards>['assertGuidanceCollected'];
  transition: ReturnType<typeof createCompletionEvents>['transition'];
}

export interface WorkspacePreservationRecoveryCaptured {
  podRepo: PodRepository;
  preservePodWorkspace: ReturnType<typeof createWorkspacePreservation>['preservePodWorkspace'];
  cleanupContainer: ReturnType<typeof createResourceCleanup>['cleanupContainer'];
  emitActivityStatus: ReturnType<typeof createCompletionEvents>['emitActivityStatus'];
  logger: Logger;
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  recoverWorktreeFromContainer: ReturnType<
    typeof createWorkspaceTransfer
  >['recoverWorktreeFromContainer'];
}

export interface WorkspacePromotionCaptured {
  podRepo: PodRepository;
  executionForPod: (pod: Pod) => PodExecutionSettings;
  transition: ReturnType<typeof createCompletionEvents>['transition'];
  enqueueSession: (podId: string) => void;
  logger: Logger;
  profileStore: ProfileStore;
  eventBus: EventBus;
}

export interface WorkspaceCompletionCaptured {
  podRepo: PodRepository;
  coordinateInteractiveCompletion: ReturnType<
    typeof createWorkspaceRecoveryState
  >['coordinateInteractiveCompletion'];
  assertInteractiveCompletionCurrent: (pod: Pod, allowRemovedContainer?: boolean) => void;
  preserveArtifacts: ReturnType<typeof createArtifactFinalizer>['preserveArtifacts'];
  failInteractivePreservation: (pod: Pod, reason: string) => never;
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  syncWorkspaceBack: ReturnType<typeof createWorkspaceTransfer>['syncWorkspaceBack'];
  logger: Logger;
  executionForPod: (pod: Pod) => PodExecutionSettings;
  runPushCheckpointScan: ReturnType<typeof createDeliveryScan>['runPushCheckpointScan'];
  resolveGitCredential: (profile: PodExecutionSettings) => Promise<string | undefined>;
  worktreeManager: WorktreeManager;
  handleDeletionGuardError: (podId: string, err: unknown) => boolean;
  emitActivityStatus: ReturnType<typeof createCompletionEvents>['emitActivityStatus'];
  cleanupContainer: ReturnType<typeof createResourceCleanup>['cleanupContainer'];
  transition: ReturnType<typeof createCompletionEvents>['transition'];
  eventBus: EventBus;
}

export interface WorkspaceBranchSyncCaptured {
  podRepo: PodRepository;
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  syncWorkspaceBack: ReturnType<typeof createWorkspaceTransfer>['syncWorkspaceBack'];
  logger: Logger;
  executionForPod: (pod: Pod) => PodExecutionSettings;
  worktreeManager: WorktreeManager;
  resolveGitCredential: (profile: PodExecutionSettings) => Promise<string | undefined>;
}

export interface WorkspaceRecoveryCommandsCaptured {
  preservePodWorkspace: ReturnType<typeof createWorkspacePreservation>['preservePodWorkspace'];
  podRepo: PodRepository;
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  emitActivityStatus: ReturnType<typeof createCompletionEvents>['emitActivityStatus'];
  killSidecarsForPod: ReturnType<typeof createResourceAuxiliary>['killSidecarsForPod'];
  destroyPodNetwork: (podId: string, strict?: boolean) => Promise<void>;
  checkpointSandboxWorkspaceForPod: ReturnType<
    typeof createWorkspacePreservation
  >['checkpointSandboxWorkspaceForPod'];
  recoverWorktreeFromContainer: ReturnType<
    typeof createWorkspaceTransfer
  >['recoverWorktreeFromContainer'];
  executionForPod: (pod: Pod) => PodExecutionSettings;
  worktreeManager: WorktreeManager;
  logger: Logger;
}

export interface WorkspaceManualFixCaptured {
  podRepo: PodRepository;
  assertExecutionTerminationVerified: ReturnType<
    typeof createCompletionGuards
  >['assertExecutionTerminationVerified'];
  logger: Logger;
  emitActivityStatus: ReturnType<typeof createCompletionEvents>['emitActivityStatus'];
}

export interface WorkspaceDeletionCaptured {
  podRepo: PodRepository;
  executionForPod: (pod: Pod) => PodExecutionSettings;
  clearPreviewTimer: ReturnType<typeof createResourcePreviewTimers>['clearPreviewTimer'];
  stopSandboxPreviewProxy: ReturnType<typeof createResourcePreview>['stopSandboxPreviewProxy'];
  killSidecarsForPod: ReturnType<typeof createResourceAuxiliary>['killSidecarsForPod'];
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  destroyPodNetwork: (podId: string, strict?: boolean) => Promise<void>;
  cleanupTestRunBranches: ReturnType<typeof createResourceAuxiliary>['cleanupTestRunBranches'];
  worktreeManager: WorktreeManager;
  pendingUpdateFromBaseIntents: ReturnType<
    typeof createValidationWorkflowState
  >['pendingUpdateFromBaseIntents'];
  forceWithLeaseAllowances: Set<string>;
  logger: Logger;
}

export interface WorkspaceEscapeCaptured {
  podRepo: PodRepository;
  cleanupContainer: ReturnType<typeof createResourceCleanup>['cleanupContainer'];
  transition: ReturnType<typeof createCompletionEvents>['transition'];
  emitActivityStatus: ReturnType<typeof createCompletionEvents>['emitActivityStatus'];
  logger: Logger;
  maybeTriggerDependents: (completedPod: Pod) => void;
  clearStuckQueueEntry: ((podId: string) => boolean) | undefined;
  enqueueSession: (podId: string) => void;
  validationAbortControllers: ReturnType<
    typeof createValidationWorkflowState
  >['validationAbortControllers'];
}

export interface WorkspaceObservationCaptured {
  assertExecutionTerminationVerified: ReturnType<
    typeof createCompletionGuards
  >['assertExecutionTerminationVerified'];
  assertGuidanceCollected: ReturnType<typeof createCompletionGuards>['assertGuidanceCollected'];
  podRepo: PodRepository;
  artifactResumeRuns: Map<string, Promise<void>>;
  artifactCompletionRuns: Map<string, Promise<void>>;
}

export interface WorkspaceWatchdogCaptured {
  logger: Logger;
  podRepo: PodRepository;
  stopSandboxPreviewProxy: ReturnType<typeof createResourcePreview>['stopSandboxPreviewProxy'];
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  transition: ReturnType<typeof createCompletionEvents>['transition'];
  emitActivityStatus: ReturnType<typeof createCompletionEvents>['emitActivityStatus'];
  eventBus: EventBus;
  enqueueSession: (podId: string) => void;
  validationRepo: ValidationRepository | undefined;
}
