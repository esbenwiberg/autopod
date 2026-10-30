import type { DaemonConfig, PublicProviderCatalog } from '@autopod/shared';
import type {
  ExecutionTarget,
  InjectedMcpServer,
  NetworkPolicy,
  Pod,
  PrivateRegistry,
  ValidationResult,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { SidecarManager } from '../containers/sidecar-manager.js';
import type { ContainerManager } from '../interfaces/index.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { ProfileStore } from '../profiles/index.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import type { createCompletionEvents } from './completion-events.js';
import type { createCompletionGuards } from './completion-guards.js';
import type { EventBus } from './event-bus.js';
import type { PodRepository } from './pod-repository.js';
import type { createPollingCoordinator } from './polling-coordinator.js';
import type { createProviderAttemptContext } from './provider-attempt-context.js';
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

export interface ResourceNetworkLiveDependencies {
  launchConfiguration?: unknown;
}
export interface ResourceCleanupLiveDependencies {
  launchConfiguration?: {
    pim?: Pick<import('../pim/pod-lifecycle.js').PimPodLifecycle, 'release'>;
  };
  beforeContainerCleanup?: (podId: string) => Promise<void>;
}
export interface ResourceAuxiliaryLiveDependencies {
  azureDevOpsAuth?: Pick<import('../providers/azure-devops-auth.js').AzureDevOpsAuth, 'getToken'>;
}
export interface ResourceCommitLiveDependencies {
  workspaceCheckpointController?: Pick<
    import('./workspace-checkpoint-controller.js').WorkspaceCheckpointController,
    'poll'
  >;
}

export interface ResourceDenialsCaptured {
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  eventBus: EventBus;
  logger: Logger;
}

export interface ResourcePreviewCaptured {
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  logger: Logger;
  podRepo: PodRepository;
}

export interface ResourceNetworkCaptured {
  networkManager: NetworkManager | undefined;
  logger: Logger;
  profileStore: ProfileStore;
  podRepo: PodRepository;
  daemonConfig: Pick<DaemonConfig, 'mcpServers' | 'claudeMdSections' | 'skills'>;
  sidecarManager: SidecarManager | undefined;
  providerAccountStore: ProviderAccountStore | undefined;
  providerCatalog: PublicProviderCatalog | undefined;
  mcpBaseUrl: string;
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
}

export interface ResourceAuxiliaryCaptured {
  sidecarManager: SidecarManager | undefined;
  podRepo: PodRepository;
  logger: Logger;
  executionForPod: (pod: Pod) => PodExecutionSettings;
}

export interface ResourceCleanupCaptured {
  podRepo: PodRepository;
  logger: Logger;
  ownsLifecycle: ReturnType<typeof createCompletionGuards>['ownsLifecycle'];
  stopSandboxPreviewProxy: (podId: string) => Promise<void>;
  stopHaproxyDenyReceiver: (podId: string) => Promise<void>;
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  forgetMaxCredentialLineage: ReturnType<
    typeof createProviderAttemptContext
  >['forgetMaxCredentialLineage'];
}

export interface ResourcePreviewTimersCaptured {
  podRepo: PodRepository;
  stopSandboxPreviewProxy: (podId: string) => Promise<void>;
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  logger: Logger;
}

export interface ResourceCommitStateCaptured {
  logger: Logger;
}

export interface ResourceCommitCaptured {
  podRepo: PodRepository;
  commitPolling: ReturnType<typeof createPollingCoordinator>;
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  logger: Logger;
  emitActivityStatus: ReturnType<typeof createCompletionEvents>['emitActivityStatus'];
}

export interface ResourceAdvisoryCleanupCaptured {
  assertGuidanceCollected: ReturnType<typeof createCompletionGuards>['assertGuidanceCollected'];
  advisoryRuns: Map<string, Promise<ValidationResult>>;
  cleanupContainer: (
    pod: Pod,
    label: string,
    mode?: 'kill' | 'stop',
    assertReleaseAllowed?: (() => void) | undefined,
  ) => Promise<void>;
  emitActivityStatus: ReturnType<typeof createCompletionEvents>['emitActivityStatus'];
  logger: Logger;
}

export interface ResourcePreviewControlsCaptured {
  podRepo: PodRepository;
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  executionForPod: (pod: Pod) => PodExecutionSettings;
  ensureSandboxPreviewProxy: (pod: Pod) => Promise<string>;
  schedulePreviewAutoStop: (podId: string, containerId: string, target: ExecutionTarget) => void;
  logger: Logger;
  clearPreviewTimer: (podId: string) => void;
  stopSandboxPreviewProxy: (podId: string) => Promise<void>;
}
