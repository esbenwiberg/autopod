import type {
  OperatorActor,
  Pod,
  PodStatus,
  RetainedFinalizationReceipt,
  RetainedFinalizationRequest,
  RetainedFinalizationView,
} from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { PrManager } from '../interfaces/pr-manager.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import { assertMergeTarget, sourceCommit } from '../worktrees/merge-source-identity.js';
import type { EventBus } from './event-bus.js';
import type { PodRepository } from './pod-repository.js';
import { recordRetainedFinalizationEvents } from './retained-finalization-events.js';
import {
  type FinalizationBinding,
  finalizationError,
  finalizationHash,
  finalizationSourceLocations,
} from './retained-finalization-repository.js';
import { inspectRetainedSource, resolveRetainedSource } from './retained-finalization-source.js';
import { validateTransition } from './state-machine.js';
import { assertValidationMutationSettled } from './validation-recovery-policy.js';

export function createRetainedFinalization(deps: {
  podRepo: PodRepository;
  executionForPod(pod: Pod): PodExecutionSettings;
  getContainerManager(target: Pod['executionTarget']): ContainerManager;
  worktreeManager: WorktreeManager;
  prManagerFactory?: (settings: PodExecutionSettings) => PrManager | null;
  isIdle(podId: string): boolean;
  isGoal(podId: string): boolean;
  assertGuidanceCollected(podId: string): void;
  eventBus: Pick<EventBus, 'emitAfterCommit'>;
}) {
  const pods = deps.podRepo;
  const ledger =
    pods.retainedFinalizations ?? finalizationError('Finalization ledger unavailable.');
  const pending = new Map<
    string,
    { hash: string; promise: Promise<RetainedFinalizationReceipt> }
  >();
  function snapshot(pod: Pod) {
    const continuation = pods.retainedCheckpoints?.latest(pod.id);
    const rewrite = pods.approvalRewrites?.latest(pod);
    const custody: RetainedFinalizationView['custody'] = [];
    if (continuation?.binding.continuation)
      custody.push({ kind: 'continuation', id: continuation.id });
    if (rewrite) custody.push({ kind: 'approval-rewrite', id: rewrite.id });
    const settings = deps.executionForPod(pod);
    const taskId = pods.taskExecutions?.snapshot(pod.id).taskId ?? '';
    const historical = ledger.historicalClaims(pod.id);
    const sourceLocations = finalizationSourceLocations(
      [
        ...historical.sourceLocations,
        pod.artifactsPath,
        pod.worktreePath,
        pod.recoveryWorktreePath,
        continuation?.worktreePath,
        continuation?.prepared?.worktree,
        continuation?.prepared?.bare,
        continuation?.prepared?.snapshot,
        continuation?.prepared?.bundle,
        rewrite?.binding.worktreePath,
        rewrite?.binding.root,
        rewrite?.prepared?.worktreePath,
      ].filter((location): location is string => Boolean(location)),
    );
    const fingerprint = finalizationHash([
      sourceLocations,
      deps.getContainerManager(pod.executionTarget).executionResourceScope ?? null,
      taskId,
      pod.lifecycleGeneration,
      pod.status,
      pod.containerId,
      pod.executionTarget,
      pod.worktreePath,
      pod.recoveryWorktreePath,
      pod.branch,
      pod.baseBranch,
      pod.prUrl,
      pod.launchConfigDigest,
      pod.profileSnapshot,
      pod.options,
      pod.contract,
      pod.lastValidationResult,
      pod.preSubmitReview,
      pod.worktreeCompromised,
      pod.pendingEscalation,
      pod.sidecarContainerIds,
      continuation,
      rewrite,
      settings,
    ]);
    const resources = [
      ...new Set(
        [
          ...historical.resources,
          pod.containerId,
          continuation?.containerId,
          rewrite?.binding.containerId,
        ].filter((id): id is string => Boolean(id)),
      ),
    ];
    return {
      custody,
      continuation,
      rewrite,
      settings,
      binding: {
        fingerprint,
        generation: pod.lifecycleGeneration,
        containerId: pod.containerId,
        target: pod.executionTarget,
        worktreePath: pod.worktreePath,
        resources,
        taskId,
        owners: custody,
        sourceLocations,
      } satisfies FinalizationBinding,
    };
  }
  function policy(pod: Pod) {
    const s = snapshot(pod);
    if (
      !s.custody.length ||
      (s.continuation &&
        !s.continuation.binding.continuation &&
        !s.continuation.binding.approvalRewrite)
    )
      finalizationError('Only retained-continuation or approval-rewrite custody is supported.');
    if (
      deps.isGoal(pod.id) ||
      pod.options.agentMode !== 'auto' ||
      pod.options.output !== 'pr' ||
      !['failed', 'review_required', 'validated'].includes(pod.status) ||
      pod.linkedPodId ||
      pod.pendingEscalation ||
      pods.hasUnansweredDecision?.(pod.id) ||
      (pod.sidecarContainerIds && Object.keys(pod.sidecarContainerIds).length) ||
      (pod.requireSidecars?.length ?? 0) > 0 ||
      pods.sourceAdoptions?.hasCustody(pod.id)
    )
      finalizationError(
        'Finalization requires a quiescent ordinary PR task without pending decisions, sidecars or unsupported custody.',
      );
    if (!pods.atomically || !pods.afterCommit || !deps.eventBus)
      finalizationError('Managed atomic terminal events are required.');
    if (!pods.taskExecutions || !pods.validationExecutions || !pods.sourceAdoptions)
      finalizationError('Execution and source ledgers are required.');
    pods.taskExecutions.assertCanDelete(pod.id); // Settlement only. Never deletes.
    pods.validationExecutions.assertNoActiveTaskExecution(pod.id);
    if (pod.containerId) pods.validationExecutions.assertResourceUnshared(pod.id, pod.containerId);
    pods.validationExecutions.assertNoPendingRecovery(pod.id);
    assertValidationMutationSettled(pods, pod.id);
    pods.sourceAdoptions.assertControlPlaneSettled(pod.id);
    pods.deletionOwnership?.assertTaskAvailable(pod.id);
    pods.sandboxWakeups?.recovery.assertAvailable(pod.id);
    for (const id of new Set([pod.id, ...pods.sourceAdoptions.taskPodIds(pod.id)]))
      if (!deps.isIdle(id))
        finalizationError('A worker, control or validation invocation is active.');
    deps.assertGuidanceCollected(pod.id);
    if (pod.containerId) pods.sandboxWakeups?.assertReleasable(pod.containerId);
    // Never infer that an unfinished source-preparation command is quiescent.
    if (s.continuation && !s.continuation.prepared && !s.continuation.blocked)
      finalizationError('Continuation preparation is unresolved.');
    if (s.rewrite && !s.rewrite.prepared) finalizationError('Rewrite preparation is unresolved.');
    const anchor = resolveRetainedSource(
      pods,
      pod,
      s.settings.repoUrl ?? finalizationError('Frozen repository is unavailable.'),
      pod.baseBranch ??
        s.settings.defaultBranch ??
        finalizationError('Frozen base branch is unavailable.'),
    );
    return { ...s, anchor };
  }
  function current(podId: string, binding: FinalizationBinding) {
    const pod = pods.getOrThrow(podId);
    const s = policy(pod);
    if (s.binding.fingerprint !== binding.fingerprint || s.binding.target !== binding.target)
      finalizationError(
        'Generation, ownership, source or resource binding changed; retain resources for reconciliation.',
      );
    return pod;
  }
  async function proof(pod: Pod, binding: FinalizationBinding) {
    const assertCurrent = () => current(pod.id, binding);
    const settings = deps.executionForPod(pod);
    if (!pod.profileSnapshot && !pod.launchConfigDigest)
      finalizationError('Frozen execution repository authority is unavailable.');
    if (
      !pod.prUrl ||
      !pod.worktreePath ||
      pod.worktreeCompromised ||
      !deps.worktreeManager.inspectSource
    )
      finalizationError('Clean retained source and recorded PR authority are required.');
    const provider = deps.prManagerFactory?.(settings);
    if (
      !provider ||
      !settings.repoUrl ||
      !pod.branch ||
      !(pod.baseBranch ?? settings.defaultBranch)
    )
      finalizationError(
        'Authenticated provider and frozen repository/source/base authority are required.',
      );
    let repository = settings.repoUrl;
    if (!repository.startsWith('git@github.com:')) {
      const url = new URL(repository);
      url.username = '';
      url.password = '';
      repository = url.toString();
    }
    const baseBranch =
      pod.baseBranch ??
      settings.defaultBranch ??
      finalizationError('Frozen base branch unavailable.');
    const target = { repository, branch: pod.branch, baseBranch };
    const selected = policy(pod).anchor;
    const { source, anchor, lineage } = await inspectRetainedSource(
      pod.id,
      selected,
      deps.worktreeManager,
      assertCurrent,
    );
    assertCurrent();
    const status = await provider.getPrStatus({ prUrl: pod.prUrl, worktreePath: pod.worktreePath });
    assertCurrent();
    if (!status.merged || !status.sourceTarget || !sourceCommit(status.headSha))
      finalizationError(
        'Provider did not prove this recorded PR merged with exact source identity.',
      );
    assertMergeTarget(target, status.sourceTarget);
    const ancestry =
      anchor.head === status.headSha
        ? null
        : await provider.verifyMergedSourceAncestry?.({
            prUrl: pod.prUrl,
            publishedHeadSha: anchor.head,
            mergedHeadSha: status.headSha as string,
            expectedTarget: target,
          });
    assertCurrent();
    if (anchor.head !== status.headSha) {
      if (
        !ancestry ||
        ancestry.publishedHeadSha !== anchor.head ||
        ancestry.mergedHeadSha !== status.headSha ||
        !Number.isFinite(Date.parse(ancestry.observedAt))
      )
        finalizationError('Merged source inclusion was not proven.');
      assertMergeTarget(target, ancestry.target);
    }
    const after = await inspectRetainedSource(
      pod.id,
      selected,
      deps.worktreeManager,
      assertCurrent,
    );
    assertCurrent();
    if (finalizationHash(after) !== finalizationHash({ anchor, lineage, source }))
      finalizationError('Retained source changed during provider observation.');
    return {
      prUrl: pod.prUrl,
      target,
      source,
      anchor,
      lineage,
      mergedHeadSha: status.headSha,
      ancestry,
      observedAt: new Date().toISOString(),
      validation:
        'unchanged; external delivery is not validation or approval of additional commits',
    };
  }
  function inspectRetainedFinalization(podId: string): RetainedFinalizationView {
    const pod = pods.getOrThrow(podId);
    const s = snapshot(pod);
    const operation = ledger.get(podId)?.receipt ?? null;
    const blockers: string[] = [];
    try {
      policy(pod);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : 'Finalization unavailable');
    }
    if (operation)
      blockers.push('An admitted finalization owns this task; retry only its exact saved request.');
    return {
      podId,
      generation: pod.lifecycleGeneration,
      status: pod.status,
      binding: s.binding.fingerprint,
      custody: s.custody,
      canStop: !blockers.length,
      canCompleteMerged:
        !blockers.length &&
        Boolean(
          pod.prUrl &&
            pod.worktreePath &&
            !pod.worktreeCompromised &&
            (pod.profileSnapshot || pod.launchConfigDigest) &&
            deps.prManagerFactory &&
            deps.worktreeManager.inspectSource,
        ),
      blockers,
      operation,
    };
  }
  async function run(
    podId: string,
    request: RetainedFinalizationRequest,
    actor: OperatorActor,
    hash: string,
  ) {
    let record = ledger.get(podId);
    if (record && record.requestHash !== hash)
      finalizationError(
        'Conflicting request key, body or actor; use the admitted request unchanged.',
      );
    if (record?.receipt.state === 'finalized') return record.receipt;
    if (!record) {
      ledger.assertAvailable(podId);
      const pod = pods.getOrThrow(podId);
      const { binding, anchor } = policy(pod);
      if (
        request.expectedGeneration !== binding.generation ||
        request.expectedBinding !== binding.fingerprint
      )
        finalizationError('Stale generation or binding; inspect again before submitting.');
      const bound: FinalizationBinding = binding;
      if (binding.containerId) {
        const manager = deps.getContainerManager(binding.target);
        if (!manager.getResourceKey)
          finalizationError('Exact provider resource namespace unavailable.');
        bound.resourceKey = await manager.getResourceKey(binding.containerId);
        current(podId, binding);
        if (!bound.resourceKey) finalizationError('Exact provider resource namespace unavailable.');
        if (anchor.resourceKey && anchor.resourceKey !== bound.resourceKey)
          finalizationError(
            'Current resource namespace differs from the immutable original owner.',
          );
        const initialStatus = await manager.getStatus(binding.containerId);
        current(podId, binding);
        if (
          initialStatus !== 'running' &&
          initialStatus !== 'stopped' &&
          initialStatus !== 'deleted'
        )
          finalizationError(
            'Current execution resource status is unknown; no finalization intent admitted.',
          );
      }
      const evidence = request.mode === 'complete-merged' ? await proof(pod, binding) : null;
      current(podId, binding);
      const receipt: RetainedFinalizationReceipt = {
        podId,
        request,
        actor,
        state: 'pending',
        createdAt: new Date().toISOString(),
        finalizedAt: null,
        message:
          'Intent retained. Stop outcome must be confirmed; retries observe without repeating a dispatched stop.',
        resourcesRetained: true,
      };
      ledger.admit(binding, receipt, hash, evidence);
      record = ledger.get(podId)!;
    }
    const { binding } = record;
    current(podId, binding);
    const cm = deps.getContainerManager(binding.target);
    if (binding.containerId) {
      // Identity reads never wake execution. A changed engine/provider namespace is not the held resource.
      if (!cm.getResourceKey) finalizationError('Exact provider resource namespace unavailable.');
      const resourceKey = await cm.getResourceKey(binding.containerId);
      current(podId, binding);
      if (resourceKey !== binding.resourceKey)
        finalizationError('Provider resource namespace changed.');
      let status: Awaited<ReturnType<ContainerManager['getStatus']>>;
      try {
        status = await cm.getStatus(binding.containerId);
      } catch {
        current(podId, binding);
        return record.receipt;
      }
      current(podId, binding);
      if (status === 'running' && !record.stopDispatched) {
        try {
          await ledger.dispatchStop(
            podId,
            () => cm.stop(binding.containerId!),
            () => {
              current(podId, binding);
            },
          );
        } catch {
          current(podId, binding);
          return ledger.get(podId)!.receipt;
        }
        current(podId, binding);
        try {
          status = await cm.getStatus(binding.containerId);
        } catch {
          current(podId, binding);
          return ledger.get(podId)!.receipt;
        }
        current(podId, binding);
      }
      if (status !== 'stopped' && status !== 'deleted') return ledger.get(podId)!.receipt;
    }
    // Fresh proof after execution is stopped, also on restart; failures retain the fence.
    const evidence =
      request.mode === 'complete-merged' ? await proof(current(podId, binding), binding) : null;
    current(podId, binding);
    if (evidence) {
      const admitted = record.evidence;
      if (
        !admitted ||
        typeof admitted !== 'object' ||
        !('source' in admitted) ||
        !('anchor' in admitted) ||
        !('lineage' in admitted) ||
        finalizationHash(admitted.source) !== finalizationHash(evidence.source) ||
        finalizationHash(admitted.anchor) !== finalizationHash(evidence.anchor) ||
        finalizationHash(admitted.lineage) !== finalizationHash(evidence.lineage)
      )
        finalizationError(
          'Retained source changed since admission; the operation remains pending with resources held.',
        );
      // Provider proof awaits must not hide an out-of-band restart of the resource.
      if (binding.containerId) {
        let finalStatus: Awaited<ReturnType<ContainerManager['getStatus']>>;
        try {
          finalStatus = await cm.getStatus(binding.containerId);
        } catch {
          current(podId, binding);
          return ledger.get(podId)!.receipt;
        }
        current(podId, binding);
        if (finalStatus !== 'stopped' && finalStatus !== 'deleted')
          return ledger.get(podId)!.receipt;
        const after = await inspectRetainedSource(
          podId,
          policy(current(podId, binding)).anchor,
          deps.worktreeManager,
          () => {
            current(podId, binding);
          },
        );
        current(podId, binding);
        if (
          finalizationHash(after.source) !== finalizationHash(evidence.source) ||
          finalizationHash(after.lineage) !== finalizationHash(evidence.lineage)
        )
          finalizationError(
            'Retained source changed after final stop observation; resources remain held.',
          );
      }
    }
    if (!pods.atomically) finalizationError('Managed terminal transaction unavailable.');
    return pods.atomically(() =>
      ledger.terminal(podId, () => {
        let pod = current(podId, binding);
        const originalStatus = pod.status;
        const change = (status: PodStatus) => {
          validateTransition(podId, pod.status, status);
          pods.update(podId, { status });
          pod = pods.getOrThrow(podId);
        };
        if (request.mode === 'stop-retain') {
          change('killing');
          change('killed');
        } else if (pod.status === 'failed') change('complete');
        else {
          if (pod.status === 'review_required') change('validated');
          change('approved');
          change('merging');
          change('complete');
        }
        pods.update(podId, { completedAt: new Date().toISOString() });
        const receipt = ledger.finish(podId, evidence);
        const completed = pods.getOrThrow(podId);
        recordRetainedFinalizationEvents(pods, deps.eventBus, completed, originalStatus);
        return receipt;
      }),
    );
  }
  function finalizeRetained(
    podId: string,
    request: RetainedFinalizationRequest,
    actor: OperatorActor,
  ) {
    if (
      actor.type !== 'human' ||
      !actor.userId.trim() ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(request.requestKey) ||
      !Number.isSafeInteger(request.expectedGeneration) ||
      request.expectedGeneration < 1 ||
      !/^[a-f0-9]{64}$/.test(request.expectedBinding) ||
      !['stop-retain', 'complete-merged'].includes(request.mode) ||
      request.reason.trim().length < 10 ||
      request.reason.length > 4000 ||
      Object.keys(request).sort().join(',') !==
        'expectedBinding,expectedGeneration,mode,reason,requestKey'
    )
      finalizationError(
        'Authenticated human, strict bound request and meaningful reason required.',
      );
    const hash = finalizationHash([
      podId,
      request.requestKey,
      request.expectedGeneration,
      request.expectedBinding,
      request.mode,
      request.reason,
      actor,
    ]);
    const active = pending.get(podId);
    if (active) {
      if (active.hash !== hash)
        finalizationError('A conflicting finalization request is in progress.');
      return active.promise;
    }
    const promise = run(podId, Object.freeze({ ...request }), Object.freeze({ ...actor }), hash);
    pending.set(podId, { hash, promise });
    void promise
      .finally(() => {
        if (pending.get(podId)?.promise === promise) pending.delete(podId);
      })
      .catch(() => {});
    return promise;
  }
  return {
    inspectRetainedFinalization,
    finalizeRetained,
    isActive: (id: string) => pending.has(id),
  };
}
