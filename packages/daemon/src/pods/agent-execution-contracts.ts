import type {
  AgentEvent,
  EffectiveLaunchConfig,
  ExecutionTarget,
  Pod,
  PodStatus,
  ProviderFailureClassification,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { SandboxInfrastructureError } from '../containers/sandbox-api-client.js';
import type { ContainerManager, RuntimeRegistry } from '../interfaces/index.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { GitTransientFetchError } from '../worktrees/local-worktree-manager.js';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventBus } from './event-bus.js';
import type { EventRepository } from './event-repository.js';
import type { PodRepository, PodUpdates } from './pod-repository.js';
import type { ProgressEventRepository } from './progress-event-repository.js';
import type { createProviderAttemptContext } from './provider-attempt-context.js';
import type { ProviderAttemptRepository } from './provider-attempt-repository.js';
import type { createProvisioningSandboxState } from './provisioning-sandbox-state.js';
import type { createProvisioningWorkflow } from './provisioning-workflow.js';
import type { createRuntimeResumeContext } from './runtime-resume-context.js';
import type { createWorkerRuntimeCredentials } from './worker-runtime-credentials.js';

export type OperatorFailurePhase = 'setup' | 'agent' | 'completion';

export type AgentRunOutcome = 'completed' | 'failed' | 'paused' | 'stopped';

export interface AgentProcessCalls {
  triggerValidation(
    podId: string,
    options?: { force?: boolean; validationOnly?: boolean },
  ): Promise<void>;
  handleCompletion(podId: string): Promise<void>;
  consumeAgentEvents(
    podId: string,
    events: AsyncIterable<AgentEvent>,
    attempt?: number,
    lifecycle?: { generation: number; containerId: string | null; nativeGoal?: boolean },
  ): Promise<AgentRunOutcome>;
}

export interface AgentExecutionLiveDependencies {
  launchConfiguration?: {
    read(podId: string): EffectiveLaunchConfig | null;
    goals?: Pick<import('./pod-goal-service.js').PodGoalService, 'get' | 'processHooks' | 'run'>;
  };
  eventRepo?: EventRepository;
  providerAttemptRepo?: ProviderAttemptRepository;
  workerInfrastructureRetryBackoffMs?: readonly number[];
  workerInfrastructureRetryDelay?: (delayMs: number) => Promise<void>;
}

export interface AgentProcessCaptured {
  podRepo: PodRepository;
  logger: Logger;
  emitActivityStatus: (podId: string, message: string) => void;
  resolveEffectiveBoundProfile: ReturnType<
    typeof createProviderAttemptContext
  >['resolveEffectiveBoundProfile'];
  provisioningWorkflow: ReturnType<typeof createProvisioningWorkflow>;
  runtimeRegistry: RuntimeRegistry;
  ensureProviderAttempt: ReturnType<typeof createProviderAttemptContext>['ensureProviderAttempt'];
  activeAgentRuns: Map<
    string,
    {
      token: symbol;
      settled: Promise<void>;
      providerOrdinal?: number | undefined;
      taskRunId?: string | undefined;
      isCurrent?: (() => boolean) | undefined;
    }
  >;
  touchHeartbeat: (podId: string) => void;
  rotateProviderAttemptForFreshSegment: ReturnType<
    typeof createProviderAttemptContext
  >['rotateProviderAttemptForFreshSegment'];
  buildReworkTask: (pod: Pod, worktreePath: string, reason: string) => Promise<string>;
  buildContinuationPrompt: (pod: Pod, worktreePath: string) => Promise<string>;
  buildRecoveryTask: (pod: Pod, worktreePath: string) => Promise<string>;
  recordContinuationProvenance: (pod: Pod, containerId: string) => Promise<void>;
  primeRuntimeForResume: ReturnType<typeof createRuntimeResumeContext>['primeRuntimeForResume'];
  appendDecisionContext: (pod: Pod, task: string) => string;
  ownsLifecycle: (podId: string, generation: number, containerId: string | null) => boolean;
  persistRuntimeCredentialsForPod: ReturnType<
    typeof createWorkerRuntimeCredentials
  >['persistRuntimeCredentialsForPod'];
  preserveSandboxAfterAgentFailure: (podId: string, reason: string) => Promise<void>;
  hasDurableAgentExecutionEvidence: (pod: Pod) => boolean;
  tryRecoverTransientSandboxFailure: (
    podId: string,
    capturedPod: Pod,
    runtimeEventObserved: boolean,
    error: SandboxInfrastructureError,
    phase: OperatorFailurePhase,
  ) => Promise<boolean>;
  closeProviderAttempt: ReturnType<typeof createProviderAttemptContext>['closeProviderAttempt'];
  scheduleHostFetchRetry: (pod: Pod, error: GitTransientFetchError) => void;
  emitActivityError: (podId: string, message: string, fatal?: boolean) => void;
  transition: (pod: Pod, to: PodStatus, extraUpdates?: Partial<PodUpdates> | undefined) => Pod;
  escalationRepo: EscalationRepository;
  operatorErrorMessage: (err: unknown, phase: OperatorFailurePhase) => string;
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  CONTAINER_CLEANUP_TIMEOUT_MS: 15000;
}

export interface AgentConsumerCaptured {
  podRepo: PodRepository;
  activeAgentRunResolvers: Map<string, { token: symbol; resolve: () => void }>;
  activeAgentRuns: Map<
    string,
    {
      token: symbol;
      settled: Promise<void>;
      providerOrdinal?: number | undefined;
      taskRunId?: string | undefined;
      isCurrent?: (() => boolean) | undefined;
    }
  >;
  resolveEffectiveBoundProfile: ReturnType<
    typeof createProviderAttemptContext
  >['resolveEffectiveBoundProfile'];
  ensureProviderAttempt: ReturnType<typeof createProviderAttemptContext>['ensureProviderAttempt'];
  startCommitPolling: (podId: string) => void;
  pauseIntents: Map<string, symbol>;
  logger: Logger;
  eventBus: EventBus;
  bumpActivityTimestamp: (podId: string) => void;
  emitActivityStatus: (podId: string, message: string) => void;
  transition: (pod: Pod, to: PodStatus, extraUpdates?: Partial<PodUpdates> | undefined) => Pod;
  progressEventRepo: ProgressEventRepository | undefined;
  rotateProviderAttemptForFreshSegment: ReturnType<
    typeof createProviderAttemptContext
  >['rotateProviderAttemptForFreshSegment'];
  summarizeAgentCompletionBlocker: (result: string) => string | null;
  executionForPod: (pod: Pod) => PodExecutionSettings;
  sanitizeFailureReason: (raw: unknown, prefix: string) => string;
  touchHeartbeat: (podId: string) => void;
  hasDurableAgentExecutionEvidence: (pod: Pod) => boolean;
  syncSandboxRuntimeSessionState: ReturnType<
    typeof createProvisioningSandboxState
  >['syncSandboxRuntimeSessionState'];
  closeProviderAttempt: ReturnType<typeof createProviderAttemptContext>['closeProviderAttempt'];
  handleProviderLimit: (
    podId: string,
    classification: ProviderFailureClassification,
  ) => Promise<void>;
  stopCommitPolling: (podId: string) => void;
  lastEventWriteAt: Map<string, number>;
}
