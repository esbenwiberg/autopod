import { AutopodError, type ValidationResult } from '@autopod/shared';
import { vi } from 'vitest';
import { createAgentActivity } from '../pods/agent-activity.js';
import type {
  ApprovalControlsCaptured,
  ApprovalWorkflowCaptured,
} from '../pods/approval-contracts.js';
import { createApprovalControls } from '../pods/approval-controls.js';
import { createApprovalReadiness, createReadinessRefresh } from '../pods/approval-readiness.js';
import { createApprovalWorkflow } from '../pods/approval-workflow.js';
import { createCompletionEvents } from '../pods/completion-events.js';
import { createCompletionGuards } from '../pods/completion-guards.js';
import { MergeQueue } from '../worktrees/merge-queue.js';
import { createPassingValidationResult } from './mock-helpers.js';
import { createProvisioningFixture } from './provisioning-helpers.js';

export const pendingFact: NonNullable<ValidationResult['factValidation']>['results'][number] = {
  factId: 'fact-one',
  proves: ['criterion-one'],
  artifactPath: 'report.txt',
  command: 'synthetic-check',
  passed: false,
  status: 'pending_human',
  reasoning: 'Synthetic manual evidence required',
};

export function createApprovalFixture(disk = false) {
  const f = createProvisioningFixture(disk);
  const guards = createCompletionGuards({ podRepo: f.podRepo, nudgeRepo: f.deps.nudgeRepo });
  const refresh = createReadinessRefresh(f.deps, {
    podRepo: f.podRepo,
    validationRepo: f.deps.validationRepo,
    scanRepo: f.deps.scanRepo,
    escalationRepo: f.deps.escalationRepo,
    qualityScoreRepo: f.deps.qualityScoreRepo,
    logger: f.deps.logger,
  });
  const activity = createAgentActivity(f.deps, { podRepo: f.podRepo, logger: f.deps.logger });
  const events = createCompletionEvents({
    podRepo: f.podRepo,
    eventBus: f.deps.eventBus,
    bumpActivityTimestamp: activity.bumpActivityTimestamp,
    recordNotReportedMemoryUsage: activity.recordNotReportedMemoryUsage,
    refreshReadiness: refresh.refreshReadiness,
  });
  const advisoryRuns = new Map<string, Promise<ValidationResult>>();
  const isSinglePrSeriesPod = vi.fn(() => false);
  const context = createApprovalReadiness({
    ...guards,
    advisoryRuns,
    readinessService: refresh.readinessService,
    emitActivityStatus: events.emitActivityStatus,
    isSinglePrSeriesPod,
    podRepo: f.podRepo,
    eventBus: f.deps.eventBus,
  });
  const maybeTriggerDependents = vi.fn();
  const mainCaptured = {
    podRepo: f.podRepo,
    resolveApprovalReadiness: context.resolveApprovalReadiness,
    assertApprovalCurrent: context.assertApprovalCurrent,
    executionForPod: f.captured.resolveEffectiveBoundProfile,
    worktreeManager: f.worktreeManager,
    emitActivityError: events.emitActivityError,
    containerManagerFactory: f.deps.containerManagerFactory,
    logger: f.deps.logger,
    prManagerFactory: undefined,
    emitActivityStatus: events.emitActivityStatus,
    failBranchPreservation: vi.fn((): never => {
      throw new AutopodError('Synthetic preservation failure', 'BRANCH_PRESERVATION_FAILED', 409);
    }),
    forceWithLeaseAllowances: new Set<string>(),
    transition: events.transition,
    persistReadinessApproval: context.persistReadinessApproval,
    cleanupContainerAfterAdvisorySettles: vi.fn<
      ApprovalWorkflowCaptured['cleanupContainerAfterAdvisorySettles']
    >(async () => {}),
    eventBus: f.deps.eventBus,
    maybeTriggerDependents,
    resolveGitCredential: f.captured.resolveGitCredential,
    mergeQueue: new MergeQueue(),
    formatRebaseConflictReason: vi.fn(() => 'Synthetic rebase conflict'),
    startMergePolling: vi.fn(),
    resolvePrBaseBranch: vi.fn(() => 'main'),
    ensurePrBaseBranchOnOrigin: vi.fn(async () => {}),
    getLatestPushFindings: vi.fn(() => []),
    handleDeletionGuardError: vi.fn(() => false),
  } satisfies ApprovalWorkflowCaptured;
  const controlsCaptured = {
    podRepo: f.podRepo,
    resolveApprovalReadiness: context.resolveApprovalReadiness,
    logger: f.deps.logger,
    nudgeRepo: f.deps.nudgeRepo,
    validationRepo: f.deps.validationRepo,
    emitActivityStatus: events.emitActivityStatus,
    escalationRepo: f.deps.escalationRepo,
    transition: events.transition,
    maybeTriggerDependents,
    refreshReadiness: refresh.refreshReadiness,
  } satisfies ApprovalControlsCaptured;
  const calls = {
    approveSession: vi.fn(async () => {}),
    revalidateSession: vi.fn(async () => ({ newCommits: false, result: 'pass' as const })),
  };
  return {
    ...f,
    get db() {
      return f.db;
    },
    guards,
    refresh,
    activity,
    events,
    advisoryRuns,
    context,
    mainCaptured,
    controlsCaptured,
    calls,
    isSinglePrSeriesPod,
    workflow: () => createApprovalWorkflow(mainCaptured),
    controls: () => createApprovalControls(controlsCaptured),
    validated() {
      const result = createPassingValidationResult('prepare');
      f.podRepo.update('prepare', {
        status: 'validated',
        containerId: 'container-123',
        worktreePath: f.directory,
        lastValidationResult: result,
      });
      f.deps.validationRepo?.insert('prepare', 1, result);
      f.podRepo.completionJournal?.begin(f.pod());
      f.podRepo.completionJournal?.mark(f.pod(), 'finalizing');
    },
  };
}
