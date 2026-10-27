import { AutopodError, type OperatorActor } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { actorLabel } from './approval-policy.js';
import type { PodRepository } from './pod-repository.js';

export function createTerminationReconciliation(deps: {
  podRepo: PodRepository;
  getContainerManager: () => Pick<ContainerManager, 'getStatus'>;
  isAgentActive(podId: string): boolean;
  emitActivityStatus(podId: string, message: string): void;
}) {
  const fail = (message: string): never => {
    throw new AutopodError(message, 'TERMINATION_RECONCILIATION_REFUSED', 409);
  };
  async function reconcileTermination(
    podId: string,
    runId: string,
    reason: string,
    actor: OperatorActor,
  ) {
    if (actor.type !== 'human' || !actor.userId.trim())
      throw new AutopodError('Authenticated human identity required', 'UNAUTHORIZED', 401);
    if (reason.trim().length < 10 || reason.length > 4000)
      fail('Provide a meaningful reason (10–4000 characters)');
    const ledger = deps.podRepo.taskExecutions;
    if (!ledger) return fail('Task execution ledger unavailable');
    const state = ledger.terminationReconciliations(podId);
    const existing = state.receipts.find((row) => row.runId === runId && row.podId === podId);
    if (existing) return existing;
    const run = state.pending.find((row) => row.runId === runId);
    if (!run) return fail('Exact unresolved run unavailable; refresh termination evidence');
    if (run.podId !== podId)
      return fail(`Reconcile the retained owner pod ${run.podId}, not ${podId}`);
    if (!run.resource)
      return fail(
        'Versioned sandbox resource ownership unavailable; cannot infer it from the current pod',
      );
    const assertCurrent = () => {
      deps.podRepo.deletionOwnership?.assertTaskAvailable(podId);
      const pod = deps.podRepo.getOrThrow(podId);
      if (
        pod.status !== 'failed' ||
        pod.lifecycleGeneration !== run.generation ||
        deps.isAgentActive(podId)
      )
        fail('Pod must be failed with no active worker in the recorded lifecycle');
    };
    assertCurrent();
    // Bounded read only. stopped includes suspended sandboxes that can execute again.
    // An empty current containerId is NOT proof; look up the dispatch-bound UUID.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let status: Awaited<ReturnType<ContainerManager['getStatus']>>;
    try {
      status = await Promise.race([
        deps.getContainerManager().getStatus(run.resource.containerId),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Backend deletion lookup timed out')), 15_000);
        }),
      ]);
    } catch {
      return fail('Backend deletion lookup unavailable; retained execution remains blocked');
    } finally {
      if (timer) clearTimeout(timer);
    }
    assertCurrent();
    if (status !== 'deleted')
      return fail(`Recorded sandbox is ${status}; only confirmed deletion permits reconciliation`);
    const task = ledger.snapshot(podId);
    const receipt = ledger.reconcileUnverifiedRun({
      ...run,
      resource: run.resource,
      taskId: task.taskId,
      actor,
      reason,
      proof: 'sandbox-deleted',
      observedAt: new Date().toISOString(),
      reconciledAt: new Date().toISOString(),
      originalFailureCategory: 'execution_termination_unverified',
    });
    deps.emitActivityStatus(
      podId,
      `Termination reconciled by ${actorLabel(receipt.actor)} for run ${runId}: sandbox ${receipt.resource.containerId} confirmed deleted. Original exit code remains unknown. ${receipt.reason}`,
    );
    return receipt;
  }
  return { reconcileTermination };
}
