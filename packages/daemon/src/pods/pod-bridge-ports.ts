import type {
  EffectiveLaunchConfig,
  EscalationRequest,
  ExecutionTarget,
  Pod,
  ProviderCredentials,
} from '@autopod/shared';
import type { ContainerManager } from '../interfaces/index.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
export interface SessionBridgeManagerPort {
  getLaunchConfiguration?(podId: string): EffectiveLaunchConfig | null;
  getReviewerConfig(pod: Pod): {
    profile: PodExecutionSettings;
    credentials: ProviderCredentials | null;
  };
  touchHeartbeat(podId: string): void;
  notifyEscalation(podId: string, escalation: EscalationRequest): void;
  getSession(podId: string): Pod;
  getReviewerExecEnv(pod: Pod): Promise<Record<string, string> | undefined>;
  getReviewerExecutor(
    pod: Pod,
  ): import('../interfaces/reviewer-executor.js').ReviewerExecutor | undefined;
  revalidateSession(
    podId: string,
    options?: { force?: boolean },
  ): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }>;
  getProjectMemoryScope(pod: Pod): import('./project-memory-scope.js').ProjectMemoryScope;
  getValidationEnvironment?(podId: string): Promise<Record<string, string> | undefined>;
}
export interface SessionBridgeContainerFactory {
  get(target: ExecutionTarget): ContainerManager;
}
