import type { DaemonConfig, PublicProviderCatalog } from '@autopod/shared';
import type {
  CreatePodRequest,
  EffectiveLaunchConfig,
  ExecutionTarget,
  InjectedMcpServer,
  OperatorActor,
  Pod,
  PodStatus,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { LaunchExecutionCredentials } from '../configuration/execution-credentials.js';
import type { DaemonGitHubAuth } from '../github/daemon-github-auth.js';
import type { ContainerManager } from '../interfaces/index.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { ProfileStore } from '../profiles/index.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import type { EventBus } from './event-bus.js';
import type { MemoryRepository } from './memory-repository.js';
import type { PodRepository } from './pod-repository.js';
import type { createProvisioningSandboxState } from './provisioning-sandbox-state.js';
import type { createReviewerContext } from './reviewer-context.js';
import type { ValidationRepository } from './validation-repository.js';
import type { PodCreator } from './workspace-contracts.js';

export interface AdmissionSessionFilters {
  profileName?: string;
  status?: PodStatus | PodStatus[];
  userId?: string;
  limit?: number;
  since?: string;
  before?: { createdAt: string; id: string };
}
export interface AdmissionCreateCalls {
  createSession(
    request: CreatePodRequest,
    userId: string,
    creator?: PodCreator,
    actor?: OperatorActor,
  ): Pod;
}
export interface AdmissionMcpCalls {
  getInjectedMcpServers(podId: string): InjectedMcpServer[];
}
export interface AdmissionSeriesCalls {
  killSession(podId: string): Promise<void>;
  deleteSession(podId: string): Promise<void>;
}
export interface AdmissionExecutionLiveDependencies {
  launchConfiguration?: {
    read(podId: string): EffectiveLaunchConfig | null;
    executionSettings(config: EffectiveLaunchConfig): PodExecutionSettings;
    credentials?: LaunchExecutionCredentials;
  };
  githubAuth?: Pick<DaemonGitHubAuth, 'resolveCredential'>;
  azureDevOpsAuth?: Pick<import('../providers/azure-devops-auth.js').AzureDevOpsAuth, 'getToken'>;
}
export interface AdmissionResolvedLiveDependencies {
  launchConfiguration?: {
    read(podId: string): EffectiveLaunchConfig | null;
    goals?: Pick<import('./pod-goal-service.js').PodGoalService, 'initialize'>;
  };
}
export interface AdmissionLegacyLiveDependencies {
  launchConfiguration?: unknown;
}
export interface AdmissionAnalysisLiveDependencies {
  memoryRepo?: Pick<MemoryRepository, 'listByScope' | 'list'>;
}
export interface AdmissionMemoryLiveDependencies {
  launchConfiguration?: { read(podId: string): EffectiveLaunchConfig | null };
}
export interface AdmissionQueriesLiveDependencies {
  launchConfiguration?: {
    read(podId: string): EffectiveLaunchConfig | null;
    assertCurrentCapabilities(config: EffectiveLaunchConfig): Promise<void>;
  };
}
export interface AdmissionLaunchMemoryContext {
  profile: PodExecutionSettings;
  projectScope: import('./project-memory-scope.js').ProjectMemoryScope;
  reviewer: import('../providers/memory-reviewer.js').MemoryReviewer;
}

export interface AdmissionExecutionCaptured {
  profileStore: ProfileStore;
  daemonConfig: Pick<DaemonConfig, 'mcpServers' | 'claudeMdSections' | 'skills'>;
}

export interface AdmissionDependentsCaptured {
  podRepo: PodRepository;
  logger: Logger;
  eventBus: EventBus;
  enqueueSession: (podId: string) => void;
}

export interface AdmissionResolvedCaptured {
  providerAccountStore: ProviderAccountStore | undefined;
  providerCatalog: PublicProviderCatalog | undefined;
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  assertSandboxAgentStreamingExecSupported: ReturnType<
    typeof createProvisioningSandboxState
  >['assertSandboxAgentStreamingExecSupported'];
  podRepo: PodRepository;
  eventBus: EventBus;
  enqueueSession: (podId: string) => void;
  maybeTriggerDependents: (completedPod: Pod) => void;
}

export interface AdmissionLegacyCaptured {
  podRepo: PodRepository;
  profileStore: ProfileStore;
  providerAccountStore: ProviderAccountStore | undefined;
  providerCatalog: PublicProviderCatalog | undefined;
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  assertSandboxAgentStreamingExecSupported: ReturnType<
    typeof createProvisioningSandboxState
  >['assertSandboxAgentStreamingExecSupported'];
  executionForPod: (pod: Pod) => PodExecutionSettings;
  logger: Logger;
  eventBus: EventBus;
  enqueueSession: (podId: string) => void;
}

export interface AdmissionMemoryCaptured {
  getReviewerExecutor: ReturnType<typeof createReviewerContext>['getReviewerExecutor'];
  getEffectiveReviewerConfig: ReturnType<
    typeof createReviewerContext
  >['getEffectiveReviewerConfig'];
}

export interface AdmissionQueriesCaptured {
  podRepo: PodRepository;
  executionCredentialsFor: (
    config: EffectiveLaunchConfig,
  ) => LaunchExecutionCredentials | undefined;
  executionForPod: (pod: Pod) => PodExecutionSettings;
  injectionsForPod: (pod: Pod) => Pick<DaemonConfig, 'mcpServers' | 'claudeMdSections' | 'skills'>;
  validationRepo: ValidationRepository | undefined;
}

export interface AdmissionSeriesCaptured {
  podRepo: PodRepository;
  logger: Logger;
}
