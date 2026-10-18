import type {
  ExecutionTarget,
  OperatorActor,
  Pod,
  ReadinessApproval,
  ReadinessReview,
  ReadinessStatus,
  ScanFinding,
  ValidationResult,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { ActionAuditRepository } from '../actions/audit-repository.js';
import type { ContainerManager, PrManager, WorktreeManager } from '../interfaces/index.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { ScanRepository } from '../security/scan-repository.js';
import type { MergeQueue } from '../worktrees/merge-queue.js';
import type { createApprovalReadiness, createReadinessRefresh } from './approval-readiness.js';
import type { createCompletionEvents } from './completion-events.js';
import type { createCompletionGuards } from './completion-guards.js';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventBus } from './event-bus.js';
import type { EventRepository } from './event-repository.js';
import type { NudgeRepository } from './nudge-repository.js';
import type { PodRepository } from './pod-repository.js';
import type { ProviderAttemptRepository } from './provider-attempt-repository.js';
import type { QualityScoreRepository } from './quality-score-repository.js';
import type { createReadinessService } from './readiness-review.js';
import type { ValidationRepository } from './validation-repository.js';

export interface ApproveSessionOptions {
  squash?: boolean;
  reason?: string;
  automation?: boolean;
  actor?: OperatorActor;
}

export interface ApproveAllSkippedPod {
  podId: string;
  status: ReadinessStatus;
  reason: string;
}

export type ApprovalReadiness = {
  status: ReadinessStatus;
  summary: string;
  scope: ReadinessApproval['scope'];
  seriesId?: string;
  podReview: ReadinessReview;
};

export interface ApprovalControlCalls {
  approveSession(podId: string, options?: ApproveSessionOptions): Promise<void>;
  revalidateSession(
    podId: string,
    options?: { force?: boolean },
  ): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }>;
}

export interface ApprovalConstructionLiveDependencies {
  actionAuditRepo?: ActionAuditRepository;
  eventRepo?: EventRepository;
  providerAttemptRepo?: ProviderAttemptRepository;
}

export interface ReadinessRefreshCaptured {
  podRepo: PodRepository;
  validationRepo: ValidationRepository | undefined;
  scanRepo: ScanRepository | undefined;
  escalationRepo: EscalationRepository;
  qualityScoreRepo: QualityScoreRepository | undefined;
  logger: Logger;
}

export interface ApprovalReadinessCaptured {
  assertGuidanceCollected: ReturnType<typeof createCompletionGuards>['assertGuidanceCollected'];
  advisoryRuns: Map<string, Promise<ValidationResult>>;
  readinessService: ReturnType<typeof createReadinessService>;
  emitActivityStatus: ReturnType<typeof createCompletionEvents>['emitActivityStatus'];
  isSinglePrSeriesPod: (pod: Pick<Pod, 'prMode' | 'seriesId'>) => boolean;
  podRepo: PodRepository;
  eventBus: EventBus;
  assertExecutionTerminationVerified: ReturnType<
    typeof createCompletionGuards
  >['assertExecutionTerminationVerified'];
}

export interface ApprovalWorkflowCaptured {
  podRepo: PodRepository;
  resolveApprovalReadiness: ReturnType<typeof createApprovalReadiness>['resolveApprovalReadiness'];
  assertApprovalCurrent: ReturnType<typeof createApprovalReadiness>['assertApprovalCurrent'];
  executionForPod: (pod: Pod) => PodExecutionSettings;
  worktreeManager: WorktreeManager;
  emitActivityError: ReturnType<typeof createCompletionEvents>['emitActivityError'];
  containerManagerFactory: { get(target: ExecutionTarget): ContainerManager };
  logger: Logger;
  prManagerFactory: ((profile: PodExecutionSettings) => PrManager | null) | undefined;
  emitActivityStatus: ReturnType<typeof createCompletionEvents>['emitActivityStatus'];
  failBranchPreservation: (pod: Pod) => never;
  forceWithLeaseAllowances: Set<string>;
  transition: ReturnType<typeof createCompletionEvents>['transition'];
  persistReadinessApproval: ReturnType<typeof createApprovalReadiness>['persistReadinessApproval'];
  cleanupContainerAfterAdvisorySettles: (
    pod: Pod,
    label: string,
    mode?: 'kill' | 'stop',
    assertReleaseAllowed?: (() => void) | undefined,
  ) => Promise<void>;
  eventBus: EventBus;
  maybeTriggerDependents: (completedPod: Pod) => void;
  resolveGitCredential: (profile: PodExecutionSettings) => Promise<string | undefined>;
  mergeQueue: MergeQueue;
  formatRebaseConflictReason: (baseBranch: string, conflicts: readonly string[]) => string;
  startMergePolling: (podId: string) => void;
  resolvePrBaseBranch: (pod: Pod, profile: PodExecutionSettings) => string;
  ensurePrBaseBranchOnOrigin: (
    pod: Pod,
    profile: PodExecutionSettings,
    baseBranch: string,
    callerLabel: string,
  ) => Promise<void>;
  getLatestPushFindings: (podId: string) => ScanFinding[];
  handleDeletionGuardError: (podId: string, err: unknown) => boolean;
}

export interface ApprovalControlsCaptured {
  podRepo: PodRepository;
  resolveApprovalReadiness: ReturnType<typeof createApprovalReadiness>['resolveApprovalReadiness'];
  logger: Logger;
  nudgeRepo: NudgeRepository;
  validationRepo: ValidationRepository | undefined;
  emitActivityStatus: ReturnType<typeof createCompletionEvents>['emitActivityStatus'];
  escalationRepo: EscalationRepository;
  transition: ReturnType<typeof createCompletionEvents>['transition'];
  maybeTriggerDependents: (completedPod: Pod) => void;
  refreshReadiness: ReturnType<typeof createReadinessRefresh>['refreshReadiness'];
}
