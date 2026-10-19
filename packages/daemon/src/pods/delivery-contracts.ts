import type { OperatorActor } from '@autopod/shared';
import type { Pod, PodStatus, ScanFinding } from '@autopod/shared';
import type { Logger } from 'pino';
import type { PrManager, PrMergeStatus, WorktreeManager } from '../interfaces/index.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { RepoScanner, ScanRepository } from '../security/index.js';
import type {
  publishCommittedSource,
  publishSource,
} from '../worktrees/durable-source-publication.js';
import type { MergeQueue } from '../worktrees/merge-queue.js';
import type { ApprovalReadiness, ApproveSessionOptions } from './approval-contracts.js';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventBus } from './event-bus.js';
import type { FixFeedbackRepository } from './fix-feedback-repository.js';
import type { PodRepository, PodUpdates } from './pod-repository.js';
import type { createPollingCoordinator } from './polling-coordinator.js';
export interface DeliveryScanCaptured {
  repoScanner: RepoScanner | undefined;
  emitActivityStatus: (podId: string, message: string) => void;
  logger: Logger;
  emitBlockingSecurityScanFindings: (podId: string, findings: ScanFinding[]) => void;
  scanRepo: ScanRepository | undefined;
}

export interface DeliveryCredentialsCaptured {
  podRepo: PodRepository;
  escalationRepo: EscalationRepository;
  transition: (pod: Pod, to: PodStatus, extraUpdates?: Partial<PodUpdates> | undefined) => Pod;
  emitActivityStatus: (podId: string, message: string) => void;
  logger: Logger;
}

export interface DeliveryPrCaptured {
  worktreeManager: WorktreeManager;
  logger: Logger;
  resolveGitCredential: (profile: PodExecutionSettings) => Promise<string | undefined>;
  emitActivityStatus: (podId: string, message: string) => void;
  assertGuidanceCollected: (podId: string) => void;
  executionForPod: (pod: Pod) => PodExecutionSettings;
  prManagerFactory: ((profile: PodExecutionSettings) => PrManager | null) | undefined;
  handleDeletionGuardError: (podId: string, err: unknown) => boolean;
  getLatestPushFindings: (podId: string) => ScanFinding[];
  podRepo: PodRepository;
}

export interface DeliveryPollingCaptured {
  podRepo: PodRepository;
  assertApprovalCurrent: (
    pod: Pod,
    options?: { allowRemovedContainer?: boolean | undefined; allowComplete?: boolean | undefined },
  ) => void;
  executionForPod: (pod: Pod) => PodExecutionSettings;
  prManagerFactory: ((profile: PodExecutionSettings) => PrManager | null) | undefined;
  transition: (pod: Pod, to: PodStatus, extraUpdates?: Partial<PodUpdates> | undefined) => Pod;
  emitActivityStatus: (podId: string, message: string) => void;
  worktreeManager: WorktreeManager;
  mergeQueue: MergeQueue;
  cleanupContainer: (
    pod: Pod,
    label: string,
    mode?: 'kill' | 'stop',
    assertReleaseAllowed?: (() => void) | undefined,
  ) => Promise<void>;
  eventBus: EventBus;
  logger: Logger;
  maybeTriggerDependents: (completedPod: Pod) => void;
  buildActionableFailureSummary: (status: PrMergeStatus, profile: PodExecutionSettings) => string;
  fixFeedbackRepo: FixFeedbackRepository;
  maybeSpawnFixSession: (parentSessionId: string, _status: PrMergeStatus) => Promise<void>;
  DEFAULT_MERGE_POLL_INTERVAL_MS: number;
  mergePolling: ReturnType<typeof createPollingCoordinator>;
}

export type DeliveryStageResult = { kind: 'ready' } | { kind: 'halted' };
export interface ApprovalPreparationContext {
  podId: string;
  options: ApproveSessionOptions;
  pod: Pod;
  readiness: ApprovalReadiness;
  actor: OperatorActor;
  approvalReason: string | undefined;
}
export interface ApprovalPrepared {
  kind: 'ready';
  recoveredMerge: boolean;
  publishApprovalBranch: (
    anchor: Pod,
    pushOptions?: { force?: boolean; pat?: string },
  ) => ReturnType<typeof publishSource>;
  commitAndPublishApprovalBranch: (
    anchor: Pod,
    config: Parameters<WorktreeManager['mergeBranch']>[0],
  ) => ReturnType<typeof publishCommittedSource>;
}
export type ApprovalPreparationResult = ApprovalPrepared | { kind: 'halted' };
export type ApprovalExecutionContext = Pick<
  ApprovalPreparationContext,
  'podId' | 'options' | 'pod'
> &
  Omit<ApprovalPrepared, 'kind'> & { mergingAnchor: Pod; s2: Pod };
