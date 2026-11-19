import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  type ApprovalRewriteAbandonmentRequest,
  type OperatorActor,
  PodNotFoundError,
} from '@autopod/shared';
import { recoveryHash } from '../containers/sandbox-recovery-journal.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import {
  abandonmentError,
  type RewriteAbandonmentDecision,
  type RewriteAbandonmentSnapshot,
} from './approval-rewrite-abandonment-repository.js';
import type { PodRepository } from './pod-repository.js';
import { retainedPathIdentity } from './retained-path-identity.js';

/** Cancellation is explicit destruction authority, never evidence that checks settled. */
export function createApprovalRewriteAbandonment(deps: {
  podRepo: PodRepository;
  getContainerManager(): ContainerManager;
  worktreeManager: Pick<WorktreeManager, 'cleanup'>;
  isIdle(podId: string): boolean;
  isGoal(podId: string): boolean;
  deleteSession(podId: string): Promise<void>;
}) {
  const repo = deps.podRepo;
  const store =
    repo.rewriteAbandonments ?? abandonmentError('Durable rewrite abandonment unavailable.');
  const journal =
    repo.sandboxWakeups?.recovery ?? abandonmentError('Durable sandbox recovery unavailable.');
  const flights = new Map<string, Promise<unknown>>();
  const active = new Set<string>();
  function policy(podId: string, cleanup = false) {
    const pod = repo.getOrThrow(podId);
    if (
      pod.executionTarget !== 'sandbox' ||
      !['failed', 'review_required'].includes(pod.status) ||
      !deps.isIdle(podId) ||
      deps.isGoal(podId)
    )
      abandonmentError(
        'Abandonment requires an idle failed/review-held sandbox task, not active work or a native Goal.',
      );
    repo.savedWorkDrafts?.assertAvailable(podId);
    repo.artifactChecks?.assertAvailable(podId);
    repo.recoveryForks?.assertOriginalAvailable(podId);
    repo.stalledRecoveries?.assertAvailable(podId);
    repo.retainedFinalizations?.assertAvailable(podId);
    if (repo.retainedCheckpoints?.latest(podId))
      abandonmentError('Independent recovery custody remains retained.');
    if (!cleanup) repo.deletionOwnership?.assertTaskAvailable(podId);
    repo.taskExecutions?.assertCanDelete(podId);
    repo.sourceAdoptions?.assertDeletable(podId);
    repo.externalDeliveries?.assertDeletable(podId);
    if (
      !repo.validationExecutions ||
      !repo.taskExecutions ||
      !repo.sourceAdoptions ||
      !repo.externalDeliveries
    )
      abandonmentError('Durable task/source/execution custody is required.');
    repo.validationExecutions.assertNoActiveTaskExecution(podId);
    repo.validationExecutions.assertNoPendingRecovery(podId);
    if (pod.prUrl) repo.mergeJournal?.assertPublicationAllowed?.(pod.prUrl);
    const merge = repo.mergeJournal?.find(pod);
    if (merge && merge.state !== 'planned')
      abandonmentError('A merge outcome owns this task; reconcile it first.');
    if (pod.pendingEscalation || repo.hasUnansweredDecision?.(podId))
      abandonmentError('Resolve pending human decisions first.');
    if (
      (pod.sidecarContainerIds && Object.keys(pod.sidecarContainerIds).length) ||
      (pod.testRunBranches && Object.keys(pod.testRunBranches).length)
    )
      abandonmentError('Sidecar/test resource cleanup requires a separate qualified protocol.');
    const rewrite = repo.approvalRewrites?.latest(pod);
    if (
      !rewrite?.prepared ||
      !rewrite.activated ||
      rewrite.repairId ||
      rewrite.activated.generation !== pod.lifecycleGeneration ||
      rewrite.prepared.worktreePath !== pod.worktreePath ||
      !pod.containerId
    )
      abandonmentError(
        'An exact activated unrepaired approval rewrite and current sandbox are required.',
      );
    store.assertSingleRewrite(podId, rewrite.id);
    return { pod, rewrite };
  }
  async function selection(podId: string) {
    const { pod, rewrite } = policy(podId);
    const cm = deps.getContainerManager();
    if (!cm.getResourceKey || !cm.executionResourceScope)
      abandonmentError('Exact sandbox provider namespace unavailable.');
    const source = store.source(pod);
    const worktrees = [...new Set([rewrite.binding.worktreePath, rewrite.prepared!.worktreePath])];
    if (
      worktrees.some((p) => !path.isAbsolute(p) || path.parse(p).root === p) ||
      worktrees.some((p, i) => worktrees.some((q, j) => i !== j && q.startsWith(p + path.sep)))
    )
      abandonmentError('Worktree cleanup identities overlap or are unsafe.');
    const ids = [
      ...new Set(
        [
          pod.containerId!,
          rewrite.binding.containerId,
          ...store.validationResources(podId, cm.executionResourceScope, worktrees),
          ...journal.resources(podId).map((r) => r.sandboxId),
        ].filter((id): id is string => !!id),
      ),
    ].sort();
    const validationEvidence = repo.validationExecutions!.captureAbandonment(
      pod,
      pod.containerId!,
      cm.executionResourceScope,
    );
    const resources: RewriteAbandonmentSnapshot['resources'] = [];
    for (const sandboxId of ids) {
      store.assertUnshared(podId, sandboxId, worktrees);
      repo.sourceAdoptions!.assertReleasable(sandboxId);
      repo.externalDeliveries!.assertReleasable(sandboxId);
      // Unknown historical executions cannot inherit the current result's loss decision.
      if (sandboxId !== pod.containerId)
        repo.rewriteAbandonments!.assertHistoricalResourceSettled(sandboxId);
      const resourceKey = await cm.getResourceKey(sandboxId);
      const recorded = journal.resources(podId).filter((r) => r.sandboxId === sandboxId);
      if (recorded.some((r) => r.resourceKey !== resourceKey))
        abandonmentError('A recorded sandbox belongs to a different provider namespace.');
      resources.push({
        sandboxId,
        resourceKey,
        recoveryId: '',
        validationEvidence: sandboxId === pod.containerId ? validationEvidence : null,
        intentIds: journal.pendingIntents(resourceKey),
      });
      policy(podId);
      if (store.source(repo.getOrThrow(podId)) !== source)
        abandonmentError('Rewrite/source evidence changed during inspection. Refresh.');
    }
    const pathIdentities = worktrees.map(retainedPathIdentity);
    if (
      pathIdentities.some((p, i) =>
        pathIdentities.some(
          (q, j) =>
            i !== j && (p === q || p.startsWith(q + path.sep) || q.startsWith(p + path.sep)),
        ),
      )
    )
      abandonmentError('Selected worktrees overlap through filesystem aliases.');
    const snapshot = { source, resources, worktrees, pathIdentities };
    return {
      generation: pod.lifecycleGeneration,
      rewriteId: rewrite.id,
      binding: recoveryHash(snapshot),
      snapshot,
    };
  }
  async function inspect(podId: string) {
    const decision = store.forPod(podId);
    if (decision) return { podId, decision, events: store.events(decision.id) };
    const selected = await selection(podId);
    return {
      podId,
      ...selected,
      warning:
        'Permanently discard unpreserved source/files/reports. This does not settle or pass validation, publish, or merge.',
    };
  }
  function assertCurrent(decision: RewriteAbandonmentDecision, cleanup = false) {
    const { pod } = policy(decision.podId, cleanup);
    if (
      pod.lifecycleGeneration !== decision.generation ||
      store.source(pod) !== decision.snapshot.source
    )
      abandonmentError(
        'The original rewrite/source selection changed; no replacement may be deleted.',
      );
    if (
      decision.snapshot.worktrees.some(
        (p, i) => retainedPathIdentity(p) !== decision.snapshot.pathIdentities[i],
      )
    )
      abandonmentError('Reserved worktree physical identity changed.');
    for (const r of decision.snapshot.resources)
      store.assertUnshared(pod.id, r.sandboxId, decision.snapshot.worktrees);
  }
  async function execute(decision: RewriteAbandonmentDecision) {
    if (store.has(decision.id, 'complete'))
      return { decision, events: store.events(decision.id), podDeleted: true };
    const cm = deps.getContainerManager();
    const guard = () =>
      assertCurrent(
        decision,
        decision.snapshot.resources.every((r) => store.has(decision.id, 'deleted', r.sandboxId)),
      );
    for (const resource of decision.snapshot.resources) {
      guard();
      if (
        !cm.getResourceKey ||
        (await cm.getResourceKey(resource.sandboxId)) !== resource.resourceKey
      )
        abandonmentError('The exact sandbox provider namespace changed.');
      guard();
      if (store.has(decision.id, 'deleted', resource.sandboxId)) continue;
      const state = await cm.getStatus(resource.sandboxId);
      guard();
      if (state !== 'deleted') {
        if (store.has(decision.id, 'dispatch', resource.sandboxId))
          abandonmentError(
            'A deletion was already dispatched. Observe confirmed deletion before reconciliation; no blind replay.',
          );
        if (state === 'unknown')
          abandonmentError('Provider state is unknown; no deletion dispatched.');
        store.append(decision.id, 'dispatch', resource.sandboxId);
        await store.withOwner(decision.id, resource.sandboxId, guard, () =>
          journal.withAbandonment(resource.recoveryId, guard, () => cm.kill(resource.sandboxId)),
        );
      }
      guard();
      if ((await cm.getStatus(resource.sandboxId)) !== 'deleted')
        abandonmentError('Sandbox deletion is unverified; original receipts remain retained.');
      guard();
      journal.complete(resource.recoveryId, 'deleted');
      store.append(decision.id, 'deleted', resource.sandboxId);
    }
    const cleanupGuard = () => assertCurrent(decision, true);
    for (const worktree of decision.snapshot.worktrees) {
      cleanupGuard();
      if (store.has(decision.id, 'worktree-cleaned', worktree)) continue;
      await store.withOwner(decision.id, undefined, cleanupGuard, () =>
        deps.worktreeManager.cleanup(worktree),
      );
      cleanupGuard();
      store.append(decision.id, 'worktree-cleaned', worktree);
    }
    // The current validation child supplies the existing, exact post-404 loss capability.
    const currentId = repo.getOrThrow(decision.podId).containerId;
    const current = decision.snapshot.resources.find((r) => r.sandboxId === currentId)!;
    await store.withOwner(decision.id, undefined, cleanupGuard, () =>
      journal.withAbandonmentCleanup(current.recoveryId, cleanupGuard, () =>
        deps.deleteSession(decision.podId),
      ),
    );
    store.assertCleanupCompleted(decision.podId);
    try {
      repo.getOrThrow(decision.podId);
      abandonmentError('Pod removal has not been confirmed.');
    } catch (error) {
      if (!(error instanceof PodNotFoundError)) throw error;
    }
    store.append(decision.id, 'complete');
    return { decision, events: store.events(decision.id), podDeleted: true };
  }
  async function submitOnce(
    podId: string,
    input: ApprovalRewriteAbandonmentRequest,
    actor: OperatorActor,
  ) {
    if (
      actor.type !== 'human' ||
      !actor.userId.trim() ||
      !input.acknowledgeDataLoss ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(input.id) ||
      input.reason.trim().length < 10 ||
      input.reason.length > 4000 ||
      !Number.isSafeInteger(input.expectedGeneration) ||
      input.expectedGeneration < 1 ||
      !/^[a-f0-9]{64}$/.test(input.expectedBinding)
    )
      abandonmentError(
        'Authenticated human, exact inspected binding, stable key, meaningful reason and explicit data-loss consent required.',
      );
    const requestHash = recoveryHash([podId, input, actor]);
    let decision = store.get(input.id);
    if (decision && decision.requestHash !== requestHash)
      abandonmentError('Abandonment request ID conflict.');
    if (!decision) {
      if (active.has(podId) || store.forPod(podId))
        abandonmentError('Another abandonment already owns this pod.');
      const selected = await selection(podId);
      if (
        selected.generation !== input.expectedGeneration ||
        selected.binding !== input.expectedBinding
      )
        abandonmentError('Stale rewrite abandonment selection. Refresh; no deletion admitted.');
      const snapshot = {
        ...selected.snapshot,
        resources: selected.snapshot.resources.map((r) => ({ ...r, recoveryId: randomUUID() })),
      };
      repo.atomically!(() => {
        policy(podId);
        if (store.source(repo.getOrThrow(podId)) !== snapshot.source)
          abandonmentError('Source changed before admission.');
        for (const resource of snapshot.resources) {
          store.assertUnshared(podId, resource.sandboxId, snapshot.worktrees);
          if (
            JSON.stringify(journal.pendingIntents(resource.resourceKey)) !==
            JSON.stringify(resource.intentIds)
          )
            abandonmentError('Sandbox execution evidence changed before admission. Refresh.');
        }
        if (
          snapshot.worktrees.some((p, i) => retainedPathIdentity(p) !== snapshot.pathIdentities[i])
        )
          abandonmentError('Source path identity changed before admission.');
        decision = store.admit({
          id: input.id,
          podId,
          generation: selected.generation,
          binding: selected.binding,
          requestHash,
          userId: actor.userId,
          reason: input.reason,
          snapshot,
        });
        for (const r of snapshot.resources)
          journal.admit({
            id: r.recoveryId,
            podId,
            sandboxId: r.sandboxId,
            resourceKey: r.resourceKey,
            generation: selected.generation,
            action: 'abandon',
            userId: actor.userId,
            reason: input.reason,
            requestHash: recoveryHash([requestHash, r]),
            binding: recoveryHash([selected.binding, r]),
            intentIds: r.intentIds,
            validationEvidence: r.validationEvidence,
          });
      });
    }
    const selected = decision!;
    if (store.has(selected.id, 'complete'))
      return { decision: selected, events: store.events(selected.id), podDeleted: true };
    const existing = flights.get(selected.id);
    if (existing) return existing;
    if (active.has(podId)) abandonmentError('Another abandonment request is in progress.');
    active.add(podId);
    const operation = (async () => {
      try {
        // A lost response between pod removal and final receipt is observation-only recovery.
        try {
          repo.getOrThrow(podId);
        } catch (e) {
          if (!(e instanceof PodNotFoundError)) throw e;
          if (
            selected.snapshot.resources.some(
              (r) => !store.has(selected.id, 'deleted', r.sandboxId),
            ) ||
            selected.snapshot.worktrees.some((p) => !store.has(selected.id, 'worktree-cleaned', p))
          )
            throw e;
          store.assertCleanupCompleted(podId);
          store.append(selected.id, 'complete');
          return { decision: selected, events: store.events(selected.id), podDeleted: true };
        }
        return await execute(selected);
      } finally {
        active.delete(podId);
        flights.delete(selected.id);
      }
    })();
    flights.set(selected.id, operation);
    return operation;
  }
  const requests = new Map<string, { hash: string; operation: Promise<unknown> }>();
  async function submit(
    podId: string,
    input: ApprovalRewriteAbandonmentRequest,
    actor: OperatorActor,
  ) {
    const hash = recoveryHash([podId, input, actor]);
    const pending = requests.get(input.id);
    if (pending) {
      if (pending.hash !== hash) abandonmentError('Abandonment request ID conflict.');
      return pending.operation;
    }
    const operation = submitOnce(podId, input, actor).finally(() => requests.delete(input.id));
    requests.set(input.id, { hash, operation });
    return operation;
  }
  return { inspect, submit, isActive: (id: string) => active.has(id) };
}
