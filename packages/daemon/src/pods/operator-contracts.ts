import type { PendingRequests } from '@autopod/escalation-mcp';
import type {
  AgentEvent,
  EffectiveLaunchConfig,
  ExecutionTarget,
  Pod,
  ValidationOverride,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager, RuntimeRegistry, WorktreeManager } from '../interfaces/index.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { AgentRunOutcome } from './agent-execution-contracts.js';
import type { createAgentRunRegistry } from './agent-run-registry.js';
import type { ApproveSessionOptions } from './approval-contracts.js';
import type { createCompletionEvents } from './completion-events.js';
import type { createCompletionGuards } from './completion-guards.js';
import type { createDeliveryCredentials } from './delivery-credentials.js';
import type { createDeliveryPolling } from './delivery-polling.js';
import type { createDeliveryPr } from './delivery-pr.js';
import type { createDeliveryScan } from './delivery-scan.js';
import type { createDeliveryProvider } from './delivery-state.js';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventBus } from './event-bus.js';
import type { createFixDelivery } from './fix-delivery.js';
import type { NudgeRepository } from './nudge-repository.js';
import type { PodRepository } from './pod-repository.js';
import type { createProviderAttemptContext } from './provider-attempt-context.js';
import type { ProviderAttemptRepository } from './provider-attempt-repository.js';
import type { createProvisioningToolInstallation } from './provisioning-tool-installation.js';
import type { createRuntimeResumeContext } from './runtime-resume-context.js';
import type { createValidationWorkflowState } from './validation-workflow-state.js';
import type { createWorkerRuntimeCredentials } from './worker-runtime-credentials.js';

import type { PodGoalService } from './pod-goal-service.js';

export interface OperatorWorkflowCalls {
  handleCompletion(podId: string): Promise<void>;
  approveSession(podId: string, options?: ApproveSessionOptions): Promise<void>;
  triggerValidation(
    podId: string,
    options?: { force?: boolean; validationOnly?: boolean },
  ): Promise<void>;
  consumeAgentEvents(
    podId: string,
    events: AsyncIterable<AgentEvent>,
    attempt?: number,
  ): Promise<AgentRunOutcome>;
  refreshNetworkPolicy(profileName: string): Promise<void>;
  killSession(podId: string): Promise<void>;
}
export type OperatorMessageCalls = Pick<
  OperatorWorkflowCalls,
  'handleCompletion' | 'approveSession' | 'triggerValidation' | 'consumeAgentEvents'
>;
export type OperatorRejectionCalls = Pick<
  OperatorWorkflowCalls,
  'refreshNetworkPolicy' | 'consumeAgentEvents' | 'handleCompletion'
>;
export type OperatorBulkCalls = Pick<OperatorWorkflowCalls, 'killSession'>;
export interface OperatorMessageLiveDependencies {
  launchConfiguration?: {
    read(podId: string): EffectiveLaunchConfig | null;
    goals?: Pick<PodGoalService, 'get'>;
  };
  pendingRequestsByPod?: Map<string, PendingRequests>;
}
export interface OperatorPauseLiveDependencies {
  launchConfiguration?: {
    read(podId: string): EffectiveLaunchConfig | null;
    goals?: Pick<PodGoalService, 'control'>;
  };
}
export interface OperatorKillLiveDependencies extends OperatorPauseLiveDependencies {
  providerAttemptRepo?: Pick<ProviderAttemptRepository, 'getActive' | 'close'>;
}

export interface OperatorMessagesCaptured {
  pauseIntents: Map<string, symbol>;
  podRepo: PodRepository;
  activeAgentRuns: ReturnType<typeof createAgentRunRegistry>['activeAgentRuns'];
  executionForPod: (pod: Pod) => PodExecutionSettings;
  emitActivityStatus: ReturnType<typeof createCompletionEvents>['emitActivityStatus'];
  transition: ReturnType<typeof createCompletionEvents>['transition'];
  logger: Logger;
  resolveGitCredential: (profile: PodExecutionSettings) => Promise<string | undefined>;
  escalationRepo: EscalationRepository;
  enqueueSession: (podId: string) => void;
  worktreeManager: WorktreeManager;
  prManagerFactory: ReturnType<typeof createDeliveryProvider>['prManagerFactory'];
  ensurePrBaseBranchOnOrigin: ReturnType<typeof createDeliveryPr>['ensurePrBaseBranchOnOrigin'];
  getLatestPushFindings: ReturnType<typeof createDeliveryScan>['getLatestPushFindings'];
  completeFixPodAfterPush: ReturnType<typeof createFixDelivery>['completeFixPodAfterPush'];
  maybeTriggerDependents: (completedPod: Pod) => void;
  stopSandboxPreviewProxy: (podId: string) => Promise<void>;
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  parkOnCredentialFailure: ReturnType<typeof createDeliveryCredentials>['parkOnCredentialFailure'];
  nudgeRepo: NudgeRepository;
  beginGoalTaskRework: (pod: Pod, task: string) => Promise<boolean>;
  mergeOverrides: (
    existing: ValidationOverride[],
    incoming: ValidationOverride[],
  ) => ValidationOverride[];
  taskFeedbackEvents: (
    podId: string,
    message: string,
    fresh: boolean,
  ) => Promise<AsyncIterable<AgentEvent>>;
  persistRuntimeCredentialsForPod: ReturnType<
    typeof createWorkerRuntimeCredentials
  >['persistRuntimeCredentialsForPod'];
  getResumeEnv: ReturnType<typeof createWorkerRuntimeCredentials>['getResumeEnv'];
  runtimeRegistry: RuntimeRegistry;
  recordContinuationProvenance: (pod: Pod, containerId: string) => Promise<void>;
  primeRuntimeForResume: ReturnType<typeof createRuntimeResumeContext>['primeRuntimeForResume'];
  buildRecoveryTask: (pod: Pod, worktreePath: string) => Promise<string>;
  resolveEffectiveBoundProfile: ReturnType<
    typeof createProviderAttemptContext
  >['resolveEffectiveBoundProfile'];
}

export interface OperatorRejectionCaptured {
  podRepo: PodRepository;
  beginGoalTaskRework: (pod: Pod, task: string) => Promise<boolean>;
  emitActivityStatus: ReturnType<typeof createCompletionEvents>['emitActivityStatus'];
  transition: ReturnType<typeof createCompletionEvents>['transition'];
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  logger: Logger;
  taskFeedbackEvents: (
    podId: string,
    message: string,
    fresh: boolean,
  ) => Promise<AsyncIterable<AgentEvent>>;
  persistRuntimeCredentialsForPod: ReturnType<
    typeof createWorkerRuntimeCredentials
  >['persistRuntimeCredentialsForPod'];
}

export interface OperatorPauseCaptured {
  pauseIntents: Map<string, symbol>;
  podRepo: PodRepository;
  emitActivityStatus: ReturnType<typeof createCompletionEvents>['emitActivityStatus'];
  activeAgentRuns: ReturnType<typeof createAgentRunRegistry>['activeAgentRuns'];
  logger: Logger;
  runtimeRegistry: RuntimeRegistry;
  transition: ReturnType<typeof createCompletionEvents>['transition'];
}

export interface OperatorKillCaptured {
  podRepo: PodRepository;
  clearPreviewTimer: (podId: string) => void;
  stopSandboxPreviewProxy: (podId: string) => Promise<void>;
  stopMergePolling: ReturnType<typeof createDeliveryPolling>['stopMergePolling'];
  emitActivityStatus: ReturnType<typeof createCompletionEvents>['emitActivityStatus'];
  transition: ReturnType<typeof createCompletionEvents>['transition'];
  validationAbortControllers: ReturnType<
    typeof createValidationWorkflowState
  >['validationAbortControllers'];
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
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  persistRuntimeCredentialsForPod: ReturnType<
    typeof createWorkerRuntimeCredentials
  >['persistRuntimeCredentialsForPod'];
  ownsLifecycle: ReturnType<typeof createCompletionGuards>['ownsLifecycle'];
  logger: Logger;
  destroyPodNetwork: (podId: string, strict?: boolean) => Promise<void>;
  runtimeRegistry: RuntimeRegistry;
  worktreeManager: WorktreeManager;
  forgetMaxCredentialLineage: ReturnType<
    typeof createProviderAttemptContext
  >['forgetMaxCredentialLineage'];
  eventBus: EventBus;
}

export interface OperatorControlsCaptured {
  podRepo: PodRepository;
  nudgeRepo: NudgeRepository;
  emitActivityStatus: ReturnType<typeof createCompletionEvents>['emitActivityStatus'];
  logger: Logger;
  transition: ReturnType<typeof createCompletionEvents>['transition'];
}

export interface OperatorToolsCaptured {
  podRepo: PodRepository;
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  emitActivityStatus: ReturnType<typeof createCompletionEvents>['emitActivityStatus'];
  installGhBinary: ReturnType<typeof createProvisioningToolInstallation>['installGhBinary'];
  installAzViaPip: ReturnType<typeof createProvisioningToolInstallation>['installAzViaPip'];
}
