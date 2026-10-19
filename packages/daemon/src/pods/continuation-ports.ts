import type { EffectiveLaunchConfig, ExecutionTarget, Pod, PodStatus } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager, RuntimeRegistry, WorktreeManager } from '../interfaces/index.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { ProfileStore } from '../profiles/index.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import type { EventRepository } from './event-repository.js';
import type { NudgeRepository } from './nudge-repository.js';
import type { PodGoalService } from './pod-goal-service.js';
import type { PodRepository, PodUpdates } from './pod-repository.js';
import type { createProviderAttemptContext } from './provider-attempt-context.js';
import type { ProviderAttemptRepository } from './provider-attempt-repository.js';
import type { createRuntimeResumeContext } from './runtime-resume-context.js';
import type { createWorkerRuntimeCredentials } from './worker-runtime-credentials.js';
import type { createWorkspaceTransfer } from './workspace-transfer.js';

export interface ContinuationLiveDependencies {
  eventRepo?: Pick<EventRepository, 'getForSession'>;
  providerAttemptRepo?: Pick<ProviderAttemptRepository, 'list'>;
  requeueSessionAfterCurrent?: (podId: string) => void;
  workerInfrastructureRetryBackoffMs?: readonly number[];
  sandboxInfrastructureRetryBackoffMs?: readonly number[];
  launchConfiguration?: {
    read(podId: string): EffectiveLaunchConfig | null;
    assertCurrentCapabilities(config: EffectiveLaunchConfig): Promise<void>;
    beginGoalRework?(
      podId: string,
      task: string,
      apply: (config: EffectiveLaunchConfig) => void,
    ): Promise<void>;
    goals?: Pick<PodGoalService, 'get' | 'prepareResume'>;
  };
}

export interface ContinuationCaptured {
  podRepo: Pick<
    PodRepository,
    | 'getOrThrow'
    | 'update'
    | 'completionJournal'
    | 'hasUnansweredDecision'
    | 'executionProvenance'
    | 'taskExecutions'
    | 'incrementLifecycleGeneration'
    | 'atomically'
    | 'afterCommit'
    | 'workerRetries'
    | 'sandboxStartupRetries'
  >;
  nudgeRepo: Pick<NudgeRepository, 'hasPending'>;
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  resolveEffectiveBoundProfile: ReturnType<
    typeof createProviderAttemptContext
  >['resolveEffectiveBoundProfile'];
  emitActivityStatus: (podId: string, message: string) => void;
  getResumeEnv: ReturnType<typeof createWorkerRuntimeCredentials>['getResumeEnv'];
  runtimeRegistry: Pick<RuntimeRegistry, 'get'>;
  primeRuntimeForResume: ReturnType<typeof createRuntimeResumeContext>['primeRuntimeForResume'];
  executionForPod: (pod: Pod) => PodExecutionSettings;
  mcpBaseUrl: string;
  worktreeManager: Pick<WorktreeManager, 'ensureExcludes'>;
  profileForProviderTarget: ReturnType<
    typeof createProviderAttemptContext
  >['profileForProviderTarget'];
  providerAccountStore: Pick<ProviderAccountStore, 'get'> | undefined;
  openProviderTargetAttempt: ReturnType<
    typeof createProviderAttemptContext
  >['openProviderTargetAttempt'];
  transition: (pod: Pod, to: PodStatus, extraUpdates?: Partial<PodUpdates> | undefined) => Pod;
  closeProviderAttempt: ReturnType<typeof createProviderAttemptContext>['closeProviderAttempt'];
  enqueueSession: (podId: string) => void;
  logger: Pick<Logger, 'warn' | 'info'>;
  syncWorkspaceBack: ReturnType<typeof createWorkspaceTransfer>['syncWorkspaceBack'];
  stopSandboxPreviewProxy: (podId: string) => Promise<void>;
  stopHaproxyDenyReceiver: (podId: string) => Promise<void>;
  CONTAINER_CLEANUP_TIMEOUT_MS: number;
  forgetMaxCredentialLineage: ReturnType<
    typeof createProviderAttemptContext
  >['forgetMaxCredentialLineage'];
  selectProviderFailoverTarget: ReturnType<
    typeof createProviderAttemptContext
  >['selectProviderFailoverTarget'];
  providerFailoverUnavailableActivity: ReturnType<
    typeof createProviderAttemptContext
  >['providerFailoverUnavailableActivity'];
  assertExecutionTerminationVerified: (podId: string) => void;
  profileStore: Pick<ProfileStore, 'resolveProviderFailover'>;
  operatorErrorMessage: (err: unknown, phase: 'agent') => string;
  activeAgentRuns: Pick<Map<string, unknown>, 'has'>;
  assertGuidanceCollected: (podId: string) => void;
  artifactResumeRuns: Map<string, Promise<void>>;
  ownsLifecycle: (podId: string, generation: number, containerId: string | null) => boolean;
  isRetryableFixDeliveryFailure: (pod: Pod) => boolean;
  completeFixPodAfterPush: (fixPod: Pod) => Promise<void>;
  infrastructureResumeRuns: Map<string, Promise<void>>;
  hasDurableAgentExecutionEvidence: (pod: Pod) => boolean;
  pushAndCreatePr: (pod: Pod, callerLabel: string) => Promise<string>;
}

export interface ContinuationResumeCalls {
  handleCompletion(podId: string): Promise<void>;
  revalidateSession(podId: string, options?: { force?: boolean }): Promise<void>;
  approveSession(podId: string, options?: { automation?: boolean }): Promise<void>;
}
