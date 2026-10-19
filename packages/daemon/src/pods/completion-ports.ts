import type { EffectiveLaunchConfig, ExecutionTarget, Pod, PodStatus } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager, WorktreeManager } from '../interfaces/index.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { createAgentActivity } from './agent-activity.js';
import type { createArtifactFinalizer } from './artifact-finalizer.js';
import type { createCompletionDecision } from './completion-decision.js';
import type { createCompletionHumanGate } from './completion-human-gate.js';
import type { createCompletionSource } from './completion-source.js';
import type { EventBus } from './event-bus.js';
import type { NudgeRepository } from './nudge-repository.js';
import type { PodRepository, PodUpdates } from './pod-repository.js';
import type { createProvisioningSandboxState } from './provisioning-sandbox-state.js';
import type { createWorkspacePreservation } from './workspace-preservation.js';
import type { createWorkspaceTransfer } from './workspace-transfer.js';

export interface CompletionCalls {
  triggerValidation(podId: string): Promise<void>;
}
export interface CompletionLiveDependencies {
  launchConfiguration?: {
    read(podId: string): EffectiveLaunchConfig | null;
    goals?: Pick<import('./pod-goal-service.js').PodGoalService, 'get'>;
  };
}

export interface CompletionGuardsCaptured {
  podRepo: Pick<PodRepository, 'deletionOwnership' | 'taskExecutions' | 'getOrThrow'>;
  nudgeRepo: Pick<NudgeRepository, 'hasPending'>;
}

export interface CompletionEventsCaptured {
  eventBus: EventBus;
  bumpActivityTimestamp: ReturnType<typeof createAgentActivity>['bumpActivityTimestamp'];
  recordNotReportedMemoryUsage: ReturnType<
    typeof createAgentActivity
  >['recordNotReportedMemoryUsage'];
  podRepo: Pick<PodRepository, 'update' | 'completionJournal' | 'afterCommit' | 'getOrThrow'>;
  refreshReadiness: (
    podId: string,
    options?: { advisoryQaInFlight?: boolean | undefined },
  ) => boolean;
}

export interface CompletionDiagnosticsCaptured {
  emitActivityError: (podId: string, message: string, fatal?: boolean) => void;
}

export interface CompletionOwnersCaptured {
  podRepo: Pick<PodRepository, 'getOrThrow' | 'update' | 'completionJournal' | 'atomically'>;
  nudgeRepo: Pick<NudgeRepository, 'hasPending'>;
  preservePodWorkspace: ReturnType<typeof createWorkspacePreservation>['preservePodWorkspace'];
  ownsArtifactCompletion: (
    pod: Pod,
    allowRemovedContainer?: boolean,
    allowQueuedGuidance?: boolean,
  ) => boolean;
  transition: (pod: Pod, to: PodStatus, extraUpdates?: Partial<PodUpdates> | undefined) => Pod;
  logger: Logger;
  emitActivityStatus: (podId: string, message: string) => void;
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  worktreeManager: WorktreeManager;
  checkpointSandboxWorkspaceForPod: ReturnType<
    typeof createWorkspacePreservation
  >['checkpointSandboxWorkspaceForPod'];
  syncSandboxSeriesHandover: ReturnType<
    typeof createProvisioningSandboxState
  >['syncSandboxSeriesHandover'];
  syncWorkspaceBack: ReturnType<typeof createWorkspaceTransfer>['syncWorkspaceBack'];
  tryRecoverAfterWorkspaceSyncFailure: (
    pod: Pod,
    err: unknown,
    phase: 'auto-commit' | 'validation',
  ) => Promise<boolean>;
  recoverWorktreeFromContainer: ReturnType<
    typeof createWorkspaceTransfer
  >['recoverWorktreeFromContainer'];
  parkOnWorktreeSyncFailure: (podId: string, reason: string) => void;
  handleDeletionGuardError: (podId: string, err: unknown) => boolean;
  executionForPod: (pod: Pod) => PodExecutionSettings;
  cleanupContainer: (
    pod: Pod,
    label: string,
    mode?: 'kill' | 'stop',
    assertReleaseAllowed?: (() => void) | undefined,
  ) => Promise<void>;
  emitPodCompletedEvent: (pod: Pod, filesChanged?: number) => void;
  maybeTriggerDependents: (completedPod: Pod) => void;
}

export interface CompletionWorkflowCaptured {
  podRepo: Pick<PodRepository, 'getOrThrow'>;
  holdCompletionForHumanWork: ReturnType<
    typeof createCompletionHumanGate
  >['holdCompletionForHumanWork'];
  artifactCompletionRuns: Map<string, Promise<void>>;
  finalizeArtifactPod: ReturnType<typeof createArtifactFinalizer>['finalizeArtifactPod'];
  prepareSourceForCompletion: ReturnType<
    typeof createCompletionSource
  >['prepareSourceForCompletion'];
  applyCompletionDecision: ReturnType<typeof createCompletionDecision>['applyCompletionDecision'];
}
