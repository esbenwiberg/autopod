import { afterEach, vi } from 'vitest';
import type { PrManager, PrMergeStatus } from '../interfaces/pr-manager.js';
import { createApprovalReadiness, createReadinessRefresh } from '../pods/approval-readiness.js';
import { createCompletionEvents } from '../pods/completion-events.js';
import { createCompletionGuards } from '../pods/completion-guards.js';
import type { DeliveryPollingCaptured, DeliveryPrCaptured } from '../pods/delivery-contracts.js';
import { createDeliveryCredentials } from '../pods/delivery-credentials.js';
import { resolvePrBaseBranch } from '../pods/delivery-policy.js';
import { createDeliveryPolling } from '../pods/delivery-polling.js';
import { createDeliveryPr } from '../pods/delivery-pr.js';
import { createDeliveryMergeQueue, createDeliveryPollingState } from '../pods/delivery-state.js';
import { createEscalationRepository } from '../pods/escalation-repository.js';
import { createEventBus } from '../pods/event-bus.js';
import { createEventRepository } from '../pods/event-repository.js';
import { createFixFeedbackRepository } from '../pods/fix-feedback-repository.js';
import { createNudgeRepository } from '../pods/nudge-repository.js';
import { createRevalidationPassDelivery } from '../pods/revalidation-pass-delivery.js';
import { createValidationPassDelivery } from '../pods/validation-pass-delivery.js';
import { createValidationRepository } from '../pods/validation-repository.js';
import type {
  RevalidationPassCaptured,
  ValidationPassCaptured,
  ValidationPassContext,
} from '../pods/validation-workflow-ports.js';
import { createScanRepository } from '../security/scan-repository.js';
import { publishSource } from '../worktrees/durable-source-publication.js';
import { createApprovalFixture } from './approval-helpers.js';
import { createPassingValidationResult } from './mock-helpers.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
  vi.useRealTimers();
});

export function pendingStatus(overrides: Partial<PrMergeStatus> = {}): PrMergeStatus {
  return {
    merged: false,
    open: true,
    blockReason: 'Waiting',
    ciFailures: [],
    reviewComments: [],
    ...overrides,
  };
}

export function createDeliveryFixture(disk = false) {
  const f = createApprovalFixture(disk);
  f.validated();
  cleanup.push(() => f.close());
  const provider = {
    findPr: vi.fn<NonNullable<PrManager['findPr']>>(async () => null),
    createPr: vi.fn<PrManager['createPr']>(async () => ({
      url: 'https://github.com/org/repo/pull/27',
      usedFallback: false,
    })),
    mergePr: vi.fn<PrManager['mergePr']>(async (config) => {
      config.onPrepared?.();
      return { merged: false, autoMergeScheduled: false };
    }),
    getPrStatus: vi.fn<PrManager['getPrStatus']>(async () => pendingStatus()),
  } satisfies PrManager;
  const prCaptured = {
    ...f.mainCaptured,
    assertGuidanceCollected: f.guards.assertGuidanceCollected,
    prManagerFactory: vi.fn(() => provider),
  } satisfies DeliveryPrCaptured;
  const credentialsCaptured = { ...f.mainCaptured, escalationRepo: f.deps.escalationRepo };
  const pr = () => createDeliveryPr(prCaptured);
  const credentials = () => createDeliveryCredentials(credentialsCaptured);
  const state = createDeliveryPollingState(f.deps.logger);
  const queue = createDeliveryMergeQueue();
  const pollingCaptured = {
    ...f.mainCaptured,
    ...state,
    ...queue,
    prManagerFactory: prCaptured.prManagerFactory,
    cleanupContainer: vi.fn<DeliveryPollingCaptured['cleanupContainer']>(
      async (_pod, _label, _mode, assertCurrent) => {
        assertCurrent?.();
      },
    ),
    buildActionableFailureSummary: vi.fn(() => 'Synthetic actionable failure'),
    fixFeedbackRepo: f.deps.fixFeedbackRepo,
    maybeSpawnFixSession: vi.fn<DeliveryPollingCaptured['maybeSpawnFixSession']>(async () => {}),
  } satisfies DeliveryPollingCaptured;
  cleanup.push(() => state.mergePolling.stop('prepare'));
  const polling = () => createDeliveryPolling(pollingCaptured);
  const advisoryCurrent = vi.fn();
  const passCaptured = {
    ...f.mainCaptured,
    prManagerFactory: prCaptured.prManagerFactory,
    resolvePrBaseBranch,
    validationEngine: f.deps.validationEngine,
    pendingUpdateFromBaseIntents: new Set<string>(),
    stopSandboxPreviewProxy: f.captured.stopSandboxPreviewProxy,
    parkOnCredentialFailure: credentials().parkOnCredentialFailure,
    warnIfSinglePrSeriesMissingSeriesMeta: vi.fn(),
    refreshReadiness: vi.fn(() => true),
    runAdvisoryAfterValidation: vi.fn<ValidationPassCaptured['runAdvisoryAfterValidation']>(
      async (_id, _config, result) => result,
    ),
    advisoryPublicationOwnership: vi.fn<ValidationPassCaptured['advisoryPublicationOwnership']>(
      () => ({ assertCurrent: advisoryCurrent, isCurrent: () => true }),
    ),
    completeFixPodAfterPush: vi.fn<ValidationPassCaptured['completeFixPodAfterPush']>(
      async () => {},
    ),
  } satisfies ValidationPassCaptured & RevalidationPassCaptured;
  const calls = { approveSession: vi.fn(async () => {}) };
  const passContext = (): ValidationPassContext => ({
    podId: 'prepare',
    pod: f.pod(),
    s2: f.pod(),
    profile: f.captured.resolveEffectiveBoundProfile(f.pod()),
    result: createPassingValidationResult('prepare'),
    validationSyncOk: true,
    attempt: 1,
    validationConfig: {
      podId: 'prepare',
      containerId: 'container-123',
      previewUrl: 'http://fixture',
      buildCommand: '',
      startCommand: '',
      healthPath: '/',
      healthTimeout: 1,
      smokePages: [],
      attempt: 1,
      task: 'Original task',
      diff: '',
    },
    validationRecord: undefined,
  });
  async function planMerge() {
    f.podRepo.update('prepare', {
      status: 'merging',
      prUrl: 'https://github.com/org/repo/pull/27',
    });
    const pod = f.pod();
    const ledger = f.podRepo.sourcePublications;
    const journal = f.podRepo.mergeJournal;
    if (!ledger || !journal) throw new Error('Missing native delivery repositories');
    const publication = await publishSource(
      ledger,
      pod,
      'https://github.com/org/repo',
      f.worktreeManager,
    );
    const entry = journal.plan(pod, pod, publication.publicationId, {
      prUrl: pod.prUrl ?? '',
      expectedHeadSha: publication.commitSha,
      expectedTarget: {
        repository: publication.repository,
        branch: publication.branch,
        baseBranch: 'main',
      },
    });
    f.mainCaptured.transition(pod, 'merge_pending');
    return { publication, entry };
  }
  function reopenPolling() {
    const next = f.reopen();
    const logger = f.deps.logger;
    const eventBus = createEventBus(createEventRepository(f.db), logger);
    const guards = createCompletionGuards({
      podRepo: next.pods,
      nudgeRepo: createNudgeRepository(f.db),
    });
    const refresh = createReadinessRefresh(
      {},
      {
        podRepo: next.pods,
        validationRepo: createValidationRepository(f.db),
        scanRepo: createScanRepository(f.db),
        escalationRepo: createEscalationRepository(f.db),
        qualityScoreRepo: undefined,
        logger,
      },
    );
    const events = createCompletionEvents({
      podRepo: next.pods,
      eventBus,
      bumpActivityTimestamp: vi.fn(),
      recordNotReportedMemoryUsage: vi.fn(),
      refreshReadiness: refresh.refreshReadiness,
    });
    const readiness = createApprovalReadiness({
      ...guards,
      advisoryRuns: new Map(),
      readinessService: refresh.readinessService,
      emitActivityStatus: events.emitActivityStatus,
      isSinglePrSeriesPod: () => false,
      podRepo: next.pods,
      eventBus,
    });
    const restartedState = createDeliveryPollingState(logger);
    const captured: DeliveryPollingCaptured = {
      ...pollingCaptured,
      ...restartedState,
      ...createDeliveryMergeQueue(),
      podRepo: next.pods,
      eventBus,
      assertApprovalCurrent: readiness.assertApprovalCurrent,
      transition: events.transition,
      emitActivityStatus: events.emitActivityStatus,
      fixFeedbackRepo: createFixFeedbackRepository(f.db),
      executionForPod: (pod) => pod.profileSnapshot ?? next.profiles.get(pod.profileName),
    };
    cleanup.push(() => restartedState.mergePolling.stop('prepare'));
    return { next, captured, poll: createDeliveryPolling(captured) };
  }
  return {
    ...f,
    get db() {
      return f.db;
    },
    provider,
    planMerge,
    reopenPolling,
    prCaptured,
    pr,
    credentialsCaptured,
    credentials,
    state,
    queue,
    pollingCaptured,
    polling,
    passCaptured,
    calls,
    advisoryCurrent,
    passContext,
    pass: () => createValidationPassDelivery(passCaptured),
    repass: () => createRevalidationPassDelivery(passCaptured),
    validating() {
      f.podRepo.update('prepare', { status: 'validating' });
    },
    mergePending() {
      f.podRepo.update('prepare', {
        status: 'merge_pending',
        prUrl: 'https://github.com/org/repo/pull/27',
      });
    },
  };
}
