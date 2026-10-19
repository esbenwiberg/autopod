import type {
  ApprovalConstructionLiveDependencies,
  ReadinessRefreshCaptured,
} from './approval-contracts.js';
import { createReadinessService } from './readiness-review.js';

export function createReadinessRefresh(
  deps: ApprovalConstructionLiveDependencies,
  captured: ReadinessRefreshCaptured,
) {
  const { podRepo, validationRepo, scanRepo, escalationRepo, qualityScoreRepo, logger } = captured;

  const readinessService = createReadinessService({
    podRepo,
    validationRepo,
    scanRepo,
    actionAuditRepo: deps.actionAuditRepo,
    eventRepo: deps.eventRepo,
    escalationRepo,
    providerAttemptRepo: deps.providerAttemptRepo,
    qualityScoreRepo,
  });

  function refreshReadiness(
    podId: string,
    options: { advisoryQaInFlight?: boolean } = {},
  ): boolean {
    try {
      const pod = podRepo.getOrThrow(podId);
      const allowPostDecision = options.advisoryQaInFlight === false;
      const refreshableStatuses = allowPostDecision
        ? [
            'validated',
            'review_required',
            'failed',
            'approved',
            'merging',
            'merge_pending',
            'complete',
            'killed',
          ]
        : ['validated', 'review_required', 'failed'];
      if (!refreshableStatuses.includes(pod.status)) {
        return true;
      }
      readinessService.refreshPodReadiness(podId, options);
      return true;
    } catch (err) {
      logger.warn({ err, podId }, 'Failed to refresh Readiness Review');
      return false;
    }
  }
  return { readinessService, refreshReadiness };
}

import type { OperatorActor, Pod, ReadinessApproval } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import type { ApprovalReadiness, ApprovalReadinessCaptured } from './approval-contracts.js';
import { actorLabel } from './approval-policy.js';

export function createApprovalReadiness(captured: ApprovalReadinessCaptured) {
  const {
    assertGuidanceCollected,
    advisoryRuns,
    readinessService,
    emitActivityStatus,
    isSinglePrSeriesPod,
    podRepo,
    eventBus,
    assertExecutionTerminationVerified,
  } = captured;

  async function resolveApprovalReadiness(
    pod: Pod,
    options: { waitForAdvisory?: boolean } = {},
  ): Promise<ApprovalReadiness> {
    assertGuidanceCollected(pod.id);
    const advisoryRun = advisoryRuns.get(pod.id);
    let podReview = readinessService.refreshPodReadiness(pod.id, {
      advisoryQaInFlight: Boolean(advisoryRun),
    });
    if (options.waitForAdvisory && advisoryRun) {
      emitActivityStatus(pod.id, 'Waiting for advisory browser QA before approval…');
      await advisoryRun;
      podReview = readinessService.refreshPodReadiness(pod.id, { advisoryQaInFlight: false });
    }

    if (isSinglePrSeriesPod(pod) && pod.prUrl && pod.seriesId) {
      const seriesReview = readinessService.computeSeriesReadiness(pod.seriesId);
      return {
        status: seriesReview.status,
        summary: seriesReview.summary,
        scope: 'series',
        seriesId: pod.seriesId,
        podReview,
      };
    }

    return {
      status: podReview.status,
      summary: podReview.summary,
      scope: 'pod',
      podReview,
    };
  }

  function persistReadinessApproval(
    podId: string,
    readiness: ApprovalReadiness,
    actor: OperatorActor,
    reason?: string,
  ): void {
    const approval: ReadinessApproval = {
      approvedAt: new Date().toISOString(),
      statusAtApproval: readiness.status,
      scope: readiness.scope,
      approvedBy: actorLabel(actor),
      actor,
      ...(readiness.seriesId ? { seriesId: readiness.seriesId } : {}),
      ...(reason ? { reason } : {}),
    };
    podRepo.update(podId, {
      readinessReview: {
        ...readiness.podReview,
        approval,
      },
    });

    if (readiness.status !== 'ready') {
      eventBus.emit({
        type: 'pod.readiness_approved',
        timestamp: approval.approvedAt,
        podId,
        status: readiness.status,
        scope: readiness.scope,
        summary: readiness.summary,
        ...(readiness.seriesId ? { seriesId: readiness.seriesId } : {}),
        ...(reason ? { reason } : {}),
        actor,
      });
    }
  }

  function assertApprovalCurrent(
    pod: Pod,
    options: { allowRemovedContainer?: boolean; allowComplete?: boolean } = {},
  ): void {
    assertExecutionTerminationVerified(pod.id);
    const current = podRepo.getOrThrow(pod.id);
    if (
      current.lifecycleGeneration !== pod.lifecycleGeneration ||
      (current.status !== pod.status &&
        !(options.allowComplete && current.status === 'complete')) ||
      current.options.agentMode !== pod.options.agentMode ||
      current.options.output !== pod.options.output ||
      current.branch !== pod.branch ||
      current.baseBranch !== pod.baseBranch ||
      current.executionTarget !== pod.executionTarget ||
      current.worktreePath !== pod.worktreePath ||
      (current.containerId !== pod.containerId &&
        !(options.allowRemovedContainer && current.containerId === null))
    )
      throw new AutopodError(
        'Approval was superseded; the current lifecycle and resources are retained.',
        'STALE_APPROVAL',
        409,
      );
    assertGuidanceCollected(pod.id);
    if (podRepo.hasUnansweredDecision?.(pod.id))
      throw new AutopodError(
        'An unanswered human decision blocks approval.',
        'PENDING_HUMAN_DECISION',
        409,
      );
  }
  return { resolveApprovalReadiness, persistReadinessApproval, assertApprovalCurrent };
}
