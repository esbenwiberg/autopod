import type { EffectiveLaunchConfig, Pod, PodStatus } from '@autopod/shared';
import type { Logger } from 'pino';
import type { PrManager, PrMergeStatus, WorktreeManager } from '../interfaces/index.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { GitCredentialError } from '../worktrees/local-worktree-manager.js';
import type { MergeQueue } from '../worktrees/merge-queue.js';
import type { EventBus } from './event-bus.js';
import type { FixFeedbackRepository } from './fix-feedback-repository.js';
import type { PodRepository, PodUpdates } from './pod-repository.js';
import type { ProviderAttemptRepository } from './provider-attempt-repository.js';

import type { DerivedLaunchInput } from '../configuration/derive-launch.js';

export interface FixProviderLiveDependencies {
  providerAttemptRepo?: Pick<ProviderAttemptRepository, 'list'>;
}
export interface FixAdmissionLiveDependencies {
  launchConfiguration?: {
    admitDerived?(
      input: DerivedLaunchInput,
      createPod: (config: EffectiveLaunchConfig) => string,
    ): Promise<string>;
  };
}

export interface FixParkingCaptured {
  parkOnCredentialFailure: (podId: string, err: GitCredentialError) => true;
  logger: Logger;
  emitActivityStatus: (podId: string, message: string) => void;
  transition: (pod: Pod, to: PodStatus, extraUpdates?: Partial<PodUpdates> | undefined) => Pod;
}

export interface FixFeedbackCaptured {
  executionForPod: (pod: Pod) => PodExecutionSettings;
  prManagerFactory: ((profile: PodExecutionSettings) => PrManager | null) | undefined;
  logger: Logger;
  emitActivityStatus: (podId: string, message: string) => void;
}

export interface FixAdmissionCaptured {
  podRepo: PodRepository;
  logger: Logger;
  isFixCycleTerminal: (status: PodStatus) => boolean;
  emitActivityStatus: (podId: string, message: string) => void;
  isFixPodRecyclable: (status: PodStatus) => boolean;
  transition: (pod: Pod, to: PodStatus, extraUpdates?: Partial<PodUpdates> | undefined) => Pod;
  stopMergePolling: (podId: string) => void;
  executionForPod: (pod: Pod) => PodExecutionSettings;
  resolveBranchSource: (parent: Pod) => Pod;
  cleanupContainer: (
    pod: Pod,
    label: string,
    mode?: 'kill' | 'stop',
    assertReleaseAllowed?: (() => void) | undefined,
  ) => Promise<void>;
  providerBindingForFixPod: (
    source: Pod,
  ) => Pick<Pod, 'providerAccountIdSnapshot' | 'providerIdSnapshot'>;
  enqueueSession: (podId: string) => void;
  eventBus: EventBus;
}

export interface FixDeliveryCaptured {
  assertGuidanceCollected: (podId: string) => void;
  executionForPod: (pod: Pod) => PodExecutionSettings;
  podRepo: PodRepository;
  logger: Logger;
  emitActivityStatus: (podId: string, message: string) => void;
  mergeQueue: MergeQueue;
  worktreeManager: WorktreeManager;
  resolveGitCredential: (profile: PodExecutionSettings) => Promise<string | undefined>;
  parkFixPodDeliveryFailure: (fixPod: Pod, err: unknown) => void;
  postFixPodReviewFeedbackReplies: (fixPod: Pod) => Promise<void>;
  cleanupContainer: (
    pod: Pod,
    label: string,
    mode?: 'kill' | 'stop',
    assertReleaseAllowed?: (() => void) | undefined,
  ) => Promise<void>;
  transition: (pod: Pod, to: PodStatus, extraUpdates?: Partial<PodUpdates> | undefined) => Pod;
  eventBus: EventBus;
}

export interface FixControlsCaptured {
  podRepo: PodRepository;
  executionForPod: (pod: Pod) => PodExecutionSettings;
  transition: (pod: Pod, to: PodStatus, extraUpdates?: Partial<PodUpdates> | undefined) => Pod;
  emitActivityStatus: (podId: string, message: string) => void;
  startMergePolling: (podId: string) => void;
  logger: Logger;
  fixFeedbackRepo: FixFeedbackRepository;
  maybeSpawnFixSession: (parentSessionId: string, _status: PrMergeStatus) => Promise<void>;
  isFixCycleTerminal: (status: PodStatus) => boolean;
}
