import type { execFile } from 'node:child_process';
import type {
  InjectedMcpServer,
  NetworkPolicy,
  PrivateRegistry,
  PublicProviderCatalog,
} from '@autopod/shared';
import type {
  DaemonConfig,
  EffectiveLaunchConfig,
  ExecutionTarget,
  McpServerConfig,
  Pod,
  PodStatus,
} from '@autopod/shared';
import type { ReasoningEffort } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ActionAuditRepository } from '../actions/audit-repository.js';
import type { LaunchExecutionCredentials } from '../configuration/execution-credentials.js';
import type { SidecarManager } from '../containers/sidecar-manager.js';
import type { PodTokenIssuer } from '../crypto/pod-tokens.js';
import type { DaemonGitHubAuth } from '../github/daemon-github-auth.js';
import type { ContainerManager, PrMergeStatus, WorktreeManager } from '../interfaces/index.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { ProfileStore } from '../profiles/index.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import type { ProviderEnvResult } from '../providers/types.js';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventRepository } from './event-repository.js';
import type { FixFeedbackRepository } from './fix-feedback-repository.js';
import type { PodRepository, PodUpdates } from './pod-repository.js';
import type { ProgressEventRepository } from './progress-event-repository.js';
import type { createProviderAttemptContext } from './provider-attempt-context.js';
import type { ProviderAttemptRepository } from './provider-attempt-repository.js';
import type { createProvisioningMaterials } from './provisioning-materials.js';
import type { createProvisioningSandboxState } from './provisioning-sandbox-state.js';
import type { ValidationRepository } from './validation-repository.js';
import type { createWorkerRuntimeCredentials } from './worker-runtime-credentials.js';
import type { createWorkspaceTransfer } from './workspace-transfer.js';

export interface ProvisioningNetworkManager {
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
}

export interface ProvisioningLiveDependencies {
  launchConfiguration?: {
    read(podId: string): EffectiveLaunchConfig | null;
    assertCurrentCapabilities(config: EffectiveLaunchConfig): Promise<void>;
    prepareEnvironment(config: EffectiveLaunchConfig): Promise<string>;
    activateWorker?(
      podId: string,
      generation: number,
      apply: (config: EffectiveLaunchConfig) => void,
    ): Promise<boolean>;
    pim?: import('../pim/pod-lifecycle.js').PimPodLifecycle;
  };
  sandboxInfrastructureRecoveryDelay?: (delayMs: number) => Promise<void>;
  providerAttemptRepo?: ProviderAttemptRepository;
  sandboxInfrastructureRetryBackoffMs?: readonly number[];
  githubAuth?: DaemonGitHubAuth;
  warmImageExists?: (tag: string) => Promise<boolean>;
  eventRepo?: EventRepository;
  actionAuditRepo?: ActionAuditRepository;
  memoryRepo?: import('./memory-repository.js').MemoryRepository;
  getSecret: (ref: string) => string | undefined;
  sessionTokenIssuer?: PodTokenIssuer;
  actionEngine?: {
    getAvailableActions: (
      policy: import('@autopod/shared').ActionPolicy,
    ) => import('@autopod/shared').ActionDefinition[];
  };
  memoryUsageRepo?: import('./memory-usage-repository.js').MemoryUsageRepository;
  sandboxRuntimeSessionSyncTimeoutMs?: number;
}

export interface ProvisioningCaptured {
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  logger: Logger;
  podRepo: PodRepository;
  resolveEffectiveBoundProfile: ReturnType<
    typeof createProviderAttemptContext
  >['resolveEffectiveBoundProfile'];
  transition: (pod: Pod, to: PodStatus, extraUpdates?: Partial<PodUpdates> | undefined) => Pod;
  syncWorkspaceBack: ReturnType<typeof createWorkspaceTransfer>['syncWorkspaceBack'];
  worktreeManager: WorktreeManager;
  persistRuntimeCredentialsForPod: ReturnType<
    typeof createWorkerRuntimeCredentials
  >['persistRuntimeCredentialsForPod'];
  stopSandboxPreviewProxy: (podId: string) => Promise<void>;
  killSidecarsForPod: (
    podId: string,
    strict?: boolean,
    assertCurrent?: (() => void) | undefined,
    retainMetadata?: boolean,
  ) => Promise<void>;
  destroyPodNetwork: (podId: string, strict?: boolean) => Promise<void>;
  closeProviderAttempt: ReturnType<typeof createProviderAttemptContext>['closeProviderAttempt'];
  openProviderTargetAttempt: ReturnType<
    typeof createProviderAttemptContext
  >['openProviderTargetAttempt'];
  profileStore: ProfileStore;
  providerAccountStore: ProviderAccountStore | undefined;
  providerCatalog: PublicProviderCatalog | undefined;
  assertSandboxAgentStreamingExecSupported: ReturnType<
    typeof createProvisioningSandboxState
  >['assertSandboxAgentStreamingExecSupported'];
  resolveGitCredential: (profile: PodExecutionSettings) => Promise<string | undefined>;
  materializeSpecFiles: ReturnType<typeof createProvisioningMaterials>['materializeSpecFiles'];
  captureDeployBaselineHashes: ReturnType<
    typeof createProvisioningMaterials
  >['captureDeployBaselineHashes'];
  executionCredentialsFor: (
    config: EffectiveLaunchConfig,
  ) => LaunchExecutionCredentials | undefined;
  repoScanner: import('../security/index.js').RepoScanner | undefined;
  injectionsForPod: (pod: Pod) => Pick<DaemonConfig, 'mcpServers' | 'claudeMdSections' | 'skills'>;
  hostnameFromUrl: (url: string) => string;
  mcpBaseUrl: string;
  networkManager: ProvisioningNetworkManager | undefined;
  portFromUrl: (url: string) => number;
  allocateHostPort: () => number;
  sidecarManager: SidecarManager | undefined;
  execFileAsync: typeof execFile.__promisify__;
  CONTAINER_APP_PORT: 3000;
  startHaproxyDenyReceiver: (pod: Pod, containerId: string) => Promise<void>;
  fixFeedbackRepo: FixFeedbackRepository;
  buildPrFixTask: (
    pod: Pod,
    status: PrMergeStatus,
    podRepo: PodRepository,
    profile: PodExecutionSettings,
    userMessage?: string | undefined,
  ) => string;
  safetyEventsRepo:
    | import('../safety/safety-events-repository.js').SafetyEventsRepository
    | undefined;
  validationRepo: ValidationRepository | undefined;
  escalationRepo: EscalationRepository;
  progressEventRepo: ProgressEventRepository | undefined;
  rememberMaxCredentialLineage: ReturnType<
    typeof createProviderAttemptContext
  >['rememberMaxCredentialLineage'];
  emitActivityStatus: (podId: string, message: string) => void;
}

export interface ProvisioningRunControls {
  startupAdmission: { id: string; started: number | null } | undefined;
  finishStartup(outcome: import('@autopod/shared').TaskRetryOutcome): void;
  emitStatus(message: string): void;
  assertStartupCurrent(): void;
  stagedReferenceArchivePaths: Set<string>;
}

export interface ProvisioningInput {
  podId: string;
  pod: Pod;
  launchConfig: EffectiveLaunchConfig | null;
  lifecycleGeneration: number;
  run: ProvisioningRunControls;
}

export interface PreparedExecution {
  pod: Pod;
  launchConfig: EffectiveLaunchConfig | null;
  containerManager: ContainerManager;
  containerId: string;
  profile: PodExecutionSettings;
  isFreshContainerValidationOnly: boolean;
  isRecovery: boolean;
  isInfrastructureRecovery: boolean;
  isRework: boolean;
  systemInstructions: string;
  secretEnv: Record<string, string>;
  worktreePath: string | null;
  mcpServers: McpServerConfig[];
  reasoningEffort: ReasoningEffort;
  providerResult: ProviderEnvResult;
}

export type ProvisioningResult =
  | { kind: 'halted' }
  | { kind: 'ready'; prepared: PreparedExecution };
