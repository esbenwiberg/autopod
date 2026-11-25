import { AutopodError, type OperatorActor, type Pod } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { EventBus } from './event-bus.js';
import type { PodRepository } from './pod-repository.js';

function blocked(message: string): never {
  throw new AutopodError(message, 'FAILURE_CLOSEOUT_BLOCKED', 409);
}

export function createFailureCloseout(deps: {
  pods: PodRepository;
  eventBus: EventBus;
  manager(target: Pod['executionTarget']): ContainerManager;
  isIdle(id: string): boolean;
  isGoal(id: string): boolean;
}) {
  const { pods } = deps;
  return async (id: string, expectedUpdatedAt: string, actor: OperatorActor) => {
    if (actor.type !== 'human' || !actor.userId.trim())
      throw new AutopodError('Authenticated human required', 'UNAUTHORIZED', 401);

    function inspect() {
      const pod = pods.getOrThrow(id);
      if (pod.status !== 'failed') blocked('Only a failed pod can be closed as failed.');
      if (pod.failureClosedAt) return pod;
      if (pod.updatedAt !== expectedUpdatedAt)
        blocked('The pod has changed. Refresh and review the current failure before closing it.');
      if (
        pod.fleetArchivedAt ||
        pod.options.agentMode !== 'auto' ||
        deps.isGoal(id) ||
        pods.validationExecutions?.hasGoal(id) ||
        pod.linkedPodId ||
        pod.fixPodId ||
        pods.sourceAdoptions?.taskPodIds(id).some((member) => member !== id) ||
        Object.keys(pod.sidecarContainerIds ?? {}).length ||
        Object.keys(pod.testRunBranches ?? {}).length ||
        pod.requireSidecars?.length ||
        pods.retainedCheckpoints?.latest(id) ||
        pods.approvalRewrites?.has(id)
      )
        blocked('This pod has a specialized execution or recovery path. Inspect Recovery instead.');
      if (
        !deps.isIdle(id) ||
        pod.pendingEscalation ||
        pods.hasUnansweredDecision?.(id) ||
        pod.recoveryWorktreePath
      )
        blocked('A worker, operation, recovery, or human decision is still pending.');
      // These are read-only settlement checks. They grant no permission to delete or rerun.
      pods.assertRerunSourceAvailable(id);
      pods.assertFailureCloseoutSettled(id);
      pods.sourceAdoptions?.assertControlPlaneSettled(id);
      pods.externalDeliveries?.assertDeletable(id);
      pods.sandboxWakeups?.assertPodReleasable(id);
      if (pod.prUrl) pods.mergeJournal?.assertPublicationAllowed?.(pod.prUrl);
      return pod;
    }

    const before = inspect();
    if (before.failureClosedAt) return { failureClosedAt: before.failureClosedAt };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped: boolean | undefined;
    try {
      const manager = deps.manager(before.executionTarget);
      stopped = await Promise.race([
        manager.isPodExecutionStopped?.(id, before.containerId),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 10_000);
          timer.unref();
        }),
      ]);
    } catch {
      // Unknown/unavailable is not proof of stopped execution.
    } finally {
      clearTimeout(timer);
    }
    if (!stopped)
      blocked(
        'Autopod could not confirm all execution has stopped. The pod is still in Needs attention.',
      );

    // No await between rechecking current custody and committing visibility.
    if (!pods.atomically || !pods.afterCommit) blocked('Durable failure closeout is unavailable.');
    const afterCommit = pods.afterCommit;
    return pods.atomically(() => {
      const current = inspect();
      if (current.failureClosedAt) return { failureClosedAt: current.failureClosedAt };
      if (
        current.lifecycleGeneration !== before.lifecycleGeneration ||
        current.executionTarget !== before.executionTarget ||
        current.containerId !== before.containerId
      )
        blocked('The execution changed. Refresh the pod before closing the failure.');
      const at = new Date().toISOString();
      pods.update(id, { failureCloseout: { at, userId: actor.userId } });
      deps.eventBus.emitAfterCommit(
        { type: 'pod.failure_closed', timestamp: at, podId: id, userId: actor.userId },
        afterCommit,
      );
      return { failureClosedAt: at };
    });
  };
}
