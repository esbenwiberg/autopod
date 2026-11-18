import { AutopodError, type Pod } from '@autopod/shared';
import { atomicPodChange } from '../db/unit-of-work.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodRepository, PodUpdates } from './pod-repository.js';
import type { ValidationWorkflowCalls } from './validation-workflow-ports.js';

/** A routing hint only. This string/field never authorizes another worker. */
export function isBudgetStopped(pod: Pod): boolean {
  return (
    ['failed', 'review_required'].includes(pod.status) &&
    (pod.pauseReason === 'budget' ||
      pod.failureReason?.startsWith('Token budget exceeded (') === true)
  );
}

export const BUDGET_CONTINUATION_PENDING = '[budget-continuation:pending]';
export const BUDGET_CONTINUATION_CODING = '[budget-continuation:coding]';
export const BUDGET_CONTINUATION_CHECKS_ONLY = '[budget-continuation:checks-only]';

export function assertBudgetCodingNotInterrupted(pod: Pod): void {
  if (isBudgetStopped(pod))
    throw new AutopodError(
      'This worker stopped on its token budget. Raise or remove the task limit, then choose Continue coding (durable Rework). Retry checks and Resume cannot finish interrupted coding.',
      'BUDGET_CODING_CONTINUATION_REQUIRED',
      409,
    );
}

/** Require prospective, resource-bound stop proof; never backfill historical completion. */
export function assertBudgetStopContinuation(
  repo: Pick<PodRepository, 'taskExecutions' | 'hasUnansweredDecision'>,
  pod: Pod,
): void {
  const cycle = pod.finalization?.cycle;
  if (
    !pod.containerId ||
    !pod.worktreePath ||
    !pod.finalization?.agentSettledAt ||
    !pod.finalization.sourcePreservedAt ||
    cycle === undefined ||
    !repo.taskExecutions?.hasSettledRun?.(pod, cycle, 'token_budget')
  )
    throw new AutopodError(
      'Budget-stopped coding needs verified worker termination and source preservation for this exact resource. Keep the original; historical missing receipts require owning recovery, not validation-only Resume.',
      'BUDGET_STOP_EVIDENCE_UNAVAILABLE',
      409,
    );
  const task = repo.taskExecutions.snapshot(pod.id);
  if (!['unlimited', 'below_recorded_limit'].includes(task.budgetCheck?.status ?? ''))
    throw new AutopodError(
      'Raise or remove the task token limit before continuing coding. If final usage is unavailable, reconcile accounting or explicitly remove the limit; a larger finite limit cannot certify unknown spending.',
      'TASK_BUDGET_UNAVAILABLE',
      409,
    );
  if (pod.pendingEscalation || repo.hasUnansweredDecision?.(pod.id))
    throw new AutopodError(
      'Resolve the pending human decision first.',
      'HUMAN_DECISION_PENDING',
      409,
    );
  if (
    pod.requireSidecars.length ||
    Object.keys(pod.sidecarContainerIds ?? {}).length ||
    pod.options.agentMode !== 'auto'
  )
    throw new AutopodError(
      'Use the owning recovery for interactive or sidecar tasks.',
      'BUDGET_CONTINUATION_UNSUPPORTED',
      409,
    );
}

type Calls = Pick<
  ValidationWorkflowCalls,
  'assertCanRework' | 'consumeAgentEvents' | 'handleCompletion'
>;

/** Explicit durable Rework only: retain the original container, source, session and history. */
export async function continueBudgetStoppedCoding(
  pod: Pod,
  calls: Calls,
  deps: {
    repo: PodRepository;
    container: ContainerManager;
    transition(
      pod: Pod,
      to: 'queued' | 'provisioning' | 'running' | 'failed',
      updates?: Partial<PodUpdates>,
    ): Pod;
    taskFeedbackEvents(
      podId: string,
      message: string,
      fresh: boolean,
    ): Promise<AsyncIterable<import('@autopod/shared').RuntimeEvent>>;
    persistRuntimeCredentialsForPod(podId: string, message: string): Promise<void>;
    emitActivityStatus(podId: string, message: string): void;
    onReworkQueued?: (generation: number, mode?: 'retained-budget') => void;
  },
): Promise<void> {
  const { repo, container } = deps;
  if (!deps.onReworkQueued)
    throw new AutopodError(
      'Use the durable coding continuation request.',
      'REWORK_REQUEST_REQUIRED',
      409,
    );
  calls.assertCanRework(pod.id);
  assertBudgetStopContinuation(repo, pod);
  const assertOriginal = () => {
    const current = repo.getOrThrow(pod.id);
    if (
      current.lifecycleGeneration !== pod.lifecycleGeneration ||
      current.containerId !== pod.containerId ||
      current.worktreePath !== pod.worktreePath ||
      current.finalization?.cycle !== pod.finalization?.cycle ||
      current.status !== pod.status ||
      current.launchConfigDigest !== pod.launchConfigDigest
    )
      throw new AutopodError(
        'Budget continuation was superseded.',
        'BUDGET_CONTINUATION_STALE',
        409,
      );
    calls.assertCanRework(pod.id);
    assertBudgetStopContinuation(repo, current);
  };
  const status = await container.getStatus(pod.containerId!);
  assertOriginal();
  if (status === 'stopped') {
    await container.start(pod.containerId!, { assertCurrent: assertOriginal });
    assertOriginal();
  } else if (status !== 'running') {
    throw new AutopodError(
      'Original resource is unavailable; retain it for recovery.',
      'BUDGET_RESOURCE_UNAVAILABLE',
      409,
    );
  }
  // Keep the original generation/proof until worker admission begins a new
  // completion cycle. A failed preparation can then be retried explicitly
  // without manufacturing stop receipts for a replacement lifecycle.
  const generation = pod.lifecycleGeneration;
  atomicPodChange(repo, () => {
    assertOriginal();
    deps.onReworkQueued?.(generation, 'retained-budget');
    deps.transition(repo.getOrThrow(pod.id), 'running', {
      // Keep the interrupted-coding guard through preparation/admission failures.
      pauseReason: 'budget',
      failureReason: pod.failureReason,
      reworkReason: BUDGET_CONTINUATION_PENDING,
      completedAt: null,
      preSubmitReview: null,
      reworkCount: pod.reworkCount + 1,
    });
  });
  const owns = () => {
    const current = repo.getOrThrow(pod.id);
    return current.lifecycleGeneration === generation && current.containerId === pod.containerId;
  };
  try {
    deps.emitActivityStatus(
      pod.id,
      'Continue coding: preparing the retained budget-stopped worker; prior checks and task spending remain recorded.',
    );
    const message = [
      'A human explicitly authorized continuing coding after a verified token-budget stop.',
      'Inspect the saved work first; do not repeat completed changes. The original task, permissions, task spending, retry limits and required validation/review remain in force. Read and acknowledge any check_messages guidance.',
      pod.lastCorrectionMessage ?? 'Finish the original task from its retained source and session.',
    ].join('\n\n');
    // Retained native continuation preflight requires the owned Running state;
    // no worker events are pulled until it has verified the exact resource.
    const events = await deps.taskFeedbackEvents(pod.id, message, false);
    if (!owns()) return;
    const outcome = await calls.consumeAgentEvents(pod.id, events, pod.validationAttempts);
    if (!owns() || outcome === 'stopped') return;
    await deps.persistRuntimeCredentialsForPod(
      pod.id,
      'Failed to persist credentials after budget continuation',
    );
    if (owns() && outcome === 'completed') {
      repo.update(pod.id, {
        pauseReason: null,
        failureReason: null,
        reworkReason: BUDGET_CONTINUATION_CHECKS_ONLY,
      });
      await calls.handleCompletion(pod.id);
    }
  } catch (error) {
    if (owns()) {
      const current = repo.getOrThrow(pod.id);
      if (['running', 'provisioning'].includes(current.status))
        deps.transition(current, 'failed', {
          failureReason: `${
            current.reworkReason === BUDGET_CONTINUATION_PENDING
              ? (pod.failureReason ?? 'Token budget exceeded (coding interrupted).')
              : 'Admitted coding worker failed.'
          } Coding continuation failed: ${error instanceof Error ? error.message : String(error)}. Original resources retained.`,
          pauseReason: current.reworkReason === BUDGET_CONTINUATION_PENDING ? 'budget' : null,
        });
    }
    throw error;
  }
}
