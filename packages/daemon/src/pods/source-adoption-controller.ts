import path from 'node:path';
import type { OperatorActor, Pod } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import type { AdoptedSourceValidationRequest } from './adopted-source-validation.js';
import type { PodRepository } from './pod-repository.js';
import { preserveSourceWorkspaces } from './source-adoption-preservation.js';
import {
  type SourceAdoptionRecord,
  sourceAdoptionError,
  sourceAdoptionState,
  sourceHash,
  sourcePodFingerprint,
} from './source-adoption-repository.js';
import type { SourceAdoptionState } from './source-adoption-types.js';
import { createSourceContainerAdoption } from './source-container-adoption.js';
import { assertValidationExecutionSettled } from './validation-recovery-policy.js';
import { getPodValidationSkipPhases, getPodValidationSuite } from './validation-workflow-policy.js';

export type { SourceAdoptionRequest } from './source-adoption-types.js';
import type { SourceAdoptionRequest } from './source-adoption-types.js';
export interface SourceAdoptionControllerDependencies {
  podRepo: PodRepository;
  worktreeManager: WorktreeManager;
  getContainerManager(target: Pod['executionTarget']): ContainerManager;
  executionForPod(pod: Pod): PodExecutionSettings;
  isNativeGoal(podId: string): boolean;
  assertGuidanceCollected(podId: string): void;
  assertIdle(podId: string): void;
  revalidate(
    podId: string,
    request: AdoptedSourceValidationRequest,
  ): Promise<{ result: 'pass' | 'fail' }>;
  archiveRoot: string;
  emit(podId: string, message: string): void;
}
/** One durable claimant, no automatic replay after errors, disconnect or process restart. */
export function createSourceAdoptionController(deps: SourceAdoptionControllerDependencies) {
  const { podRepo, worktreeManager: worktrees } = deps;
  const journal = podRepo.sourceAdoptions;
  const runs = new Map<string, Promise<void>>();
  function repository() {
    return (
      journal ??
      sourceAdoptionError('Durable source custody unavailable', 'SOURCE_JOURNAL_UNAVAILABLE')
    );
  }
  function policy(pod: Pod) {
    if (deps.isNativeGoal(pod.id))
      sourceAdoptionError(
        'Native Goals require their reviewed revision workflow',
        'SOURCE_GOAL_UNSUPPORTED',
      );
    if (
      !['failed', 'review_required', 'validated'].includes(pod.status) ||
      !pod.containerId ||
      !pod.worktreePath
    )
      sourceAdoptionError(
        'Adoption requires an original retained failed/review/validated pod resource',
      );
    if (
      pod.options.agentMode === 'interactive' ||
      pod.pendingEscalation ||
      podRepo.hasUnansweredDecision?.(pod.id)
    )
      sourceAdoptionError('Resolve human decisions and workspace ownership first');
    podRepo.deletionOwnership?.assertTaskAvailable(pod.id);
    if (!podRepo.taskExecutions) sourceAdoptionError('Original execution ownership unavailable');
    podRepo.taskExecutions.assertCanDelete(pod.id); // Any unsettled original task run, not just known failures.
    assertValidationExecutionSettled(pod);
    for (const peer of repository().taskPodIds(pod.id)) deps.assertIdle(peer);
    deps.assertGuidanceCollected(pod.id);
    repository().assertControlPlaneSettled(pod.id);
    const profile = deps.executionForPod(pod);
    if (
      getPodValidationSuite(pod) !== 'full' ||
      pod.options.validate === false ||
      pod.skipValidation ||
      getPodValidationSkipPhases(profile, pod).length
    )
      sourceAdoptionError(
        'Adoption requires full fresh checks without bypassed phases',
        'SOURCE_CHECKS_BYPASSED',
      );
  }
  function context(row: SourceAdoptionRecord) {
    const repo = repository();
    const current = () => {
      const live = repo.get(row.id);
      const pod = podRepo.getOrThrow(row.podId);
      if (
        !live ||
        live.error ||
        live.stage === 'checked' ||
        pod.lifecycleGeneration !== (live.adoptedGeneration ?? row.binding.generation) ||
        sourcePodFingerprint(pod) !== row.binding.fingerprint ||
        !['failed', 'review_required', 'validated', 'validating'].includes(pod.status) ||
        podRepo.hasUnansweredDecision?.(pod.id) ||
        pod.pendingEscalation ||
        deps.isNativeGoal(pod.id)
      )
        sourceAdoptionError(
          'Source adoption was superseded; current work and originals remain held',
          'STALE_SOURCE_ADOPTION',
        );
      repo.assertAvailable(pod.id, row.id);
      deps.assertGuidanceCollected(pod.id);
      const profile = deps.executionForPod(pod);
      if (
        profile.repoUrl !== row.binding.repository ||
        (pod.baseBranch ?? profile.defaultBranch ?? 'main') !== row.binding.baseBranch
      )
        sourceAdoptionError('Source repository/base binding changed', 'STALE_SOURCE_ADOPTION');
      return pod;
    };
    const owned = async <T>(operation: () => Promise<T>): Promise<T> => {
      current();
      try {
        const value = await operation();
        current();
        return value;
      } catch (error) {
        current();
        throw error;
      }
    };
    return { current, owned };
  }
  async function run(id: string) {
    const repo = repository();
    let row = repo.get(id);
    if (!row) sourceAdoptionError('Missing original adoption claim');
    const { current, owned } = context(row);
    policy(current());
    const cm = deps.getContainerManager(current().executionTarget);
    const status = await owned(() => cm.getStatus(row!.binding.containerId));
    if (status === 'stopped')
      await owned(() => cm.start(row!.binding.containerId, { assertCurrent: current }));
    else if (status !== 'running')
      sourceAdoptionError(
        'Original resource unavailable; no replacement is allocated',
        'VALIDATION_RESOURCE_UNAVAILABLE',
      );
    let adapter = createSourceContainerAdoption({
      record: row,
      journal: repo,
      containerManager: cm,
      backend: current().executionTarget === 'sandbox' ? 'sandbox' : 'docker',
      assertCurrent: current,
    });
    await owned(() => adapter.resource());
    const original = await owned(() => adapter.inspect('original-source'));
    const host = await owned(() =>
      worktrees.inspectSourceAdoption!(row!.binding.worktreePath, row!.binding.branch),
    );
    if (
      !original.worktreeClean ||
      !host.worktreeClean ||
      original.commitSha !== row.binding.oldHead ||
      host.commitSha !== row.binding.oldHead ||
      original.treeSha !== host.treeSha
    )
      sourceAdoptionError(
        'Host/container original source is dirty or does not match; preserve and reconcile it without resetting',
      );
    const root = path.join(deps.archiveRoot, row.podId, row.id);
    const snapshots = await owned(() =>
      preserveSourceWorkspaces({
        containerManager: cm,
        containerId: row!.binding.containerId,
        worktreePath: row!.binding.worktreePath,
        archiveRoot: root,
        generation: row!.binding.generation,
        assertCurrent: current,
      }),
    );
    const config = {
      worktreePath: row.binding.worktreePath,
      repository: row.binding.repository,
      branch: row.binding.branch,
      oldHead: row.binding.oldHead,
      targetHead: row.binding.targetHead,
      id: row.id,
      bundle: path.join(root, 'source.bundle'),
      assertCurrent: current,
    };
    const git = await owned(() => worktrees.prepareSourceAdoption!(config));
    repo.advance(id, 'claimed', 'preserved', { preservation: { ...snapshots, ...git } });
    // Old execution and delivery fences are inspected BEFORE invalidation, never erased to pass admission.
    policy(current());
    podRepo.transaction(() => {
      const old = current();
      repo.observePriorEvidence(id, old);
      const generation = podRepo.incrementLifecycleGeneration(row!.podId);
      repo.advance(id, 'preserved', 'applying', { generation });
      podRepo.update(old.id, {
        lastValidationResult: null,
        lastValidatedCommitSha: null,
        preSubmitReview: null,
        validationWaiver: null,
      });
    });
    row = repo.get(id)!;
    await owned(() => worktrees.applySourceAdoption!(config));
    adapter = createSourceContainerAdoption({
      record: row,
      journal: repo,
      containerManager: cm,
      backend: current().executionTarget === 'sandbox' ? 'sandbox' : 'docker',
      assertCurrent: current,
    });
    await owned(() => adapter.apply());
    let sequence = 0;
    const verify = async () => {
      const local = await owned(() =>
        worktrees.inspectSourceAdoption!(row!.binding.worktreePath, row!.binding.branch),
      );
      const guest = await owned(() => adapter.inspect(`verify-${++sequence}`));
      const remote = await owned(() =>
        worktrees.observeSourceBranch!(
          row!.binding.worktreePath,
          row!.binding.repository,
          row!.binding.branch,
        ),
      );
      if (
        !local.worktreeClean ||
        !guest.worktreeClean ||
        local.commitSha !== row!.binding.targetHead ||
        guest.commitSha !== row!.binding.targetHead ||
        local.treeSha !== row!.preservation?.tree ||
        guest.treeSha !== row!.preservation?.tree ||
        remote !== row!.binding.targetHead
      )
        sourceAdoptionError(
          'Pinned source changed; current validation cannot be certified',
          'SOURCE_CHANGED_DURING_CHECKS',
        );
      repo.commands.assertSettled(id);
    };
    await verify();
    repo.advance(id, 'applying', 'adopted');
    repo.advance(id, 'adopted', 'checking');
    deps.emit(
      row.podId,
      'Exact source adopted; running fresh source-bound checks. Delivery and original reports remain held.',
    );
    await owned(() => deps.revalidate(row!.podId, { operationId: id, verifySource: verify }));
    await verify();
    const result = current().lastValidationResult;
    if (!result)
      sourceAdoptionError(
        'No genuine current-source validation result was published',
        'SOURCE_CHECKS_UNVERIFIED',
      );
    repo.advance(id, 'checking', 'checked', {
      validationHash: sourceHash(result),
      validation: result.overall,
    });
    deps.emit(
      row.podId,
      `Adopted-source checks ${result.overall}; no approval, publication, merge or report release was authorized.`,
    );
  }
  async function submit(
    podId: string,
    input: SourceAdoptionRequest,
    actor: OperatorActor,
  ): Promise<SourceAdoptionState> {
    const repo = repository();
    if (
      actor.type !== 'human' ||
      !actor.userId ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(input.id) ||
      !Number.isSafeInteger(input.expectedGeneration) ||
      input.expectedGeneration < 1 ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.oldHeadSha) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.targetHeadSha) ||
      input.oldHeadSha === input.targetHeadSha ||
      input.reason.trim().length < 10 ||
      input.reason.length > 4000 ||
      !input.dependencySetupCommand.trim() ||
      input.dependencySetupCommand.length > 16000
    )
      sourceAdoptionError(
        'Explicit human reason, exact distinct heads/epoch and dependency preparation are required',
      );
    const requestHash = sourceHash([
      podId,
      input.id,
      input.expectedGeneration,
      input.oldHeadSha,
      input.targetHeadSha,
      input.dependencySetupCommand,
      input.reason,
    ]);
    const replay = () => {
      const prior = repo.get(input.id);
      if (prior) {
        if (
          prior.podId !== podId ||
          prior.binding.requestHash !== requestHash ||
          sourceHash(prior.actor) !== sourceHash(actor)
        )
          sourceAdoptionError(
            'Request ID belongs to a different source/actor request',
            'SOURCE_ADOPTION_CONFLICT',
          );
        return sourceAdoptionState(prior); // No restart/replay, including after disconnect or restart.
      }
      return null;
    };
    const duplicate = replay();
    if (duplicate) return duplicate;
    if (
      !worktrees.prepareSourceAdoption ||
      !worktrees.applySourceAdoption ||
      !worktrees.observeSourceBranch ||
      !worktrees.inspectSourceAdoption
    )
      sourceAdoptionError('This worktree backend cannot establish pinned source custody');
    const pod = podRepo.getOrThrow(podId);
    const fingerprint = sourcePodFingerprint(pod);
    const anchor = () => {
      const live = podRepo.getOrThrow(podId);
      policy(live);
      repo.assertAvailable(podId);
      if (
        live.lifecycleGeneration !== input.expectedGeneration ||
        sourcePodFingerprint(live) !== fingerprint ||
        live.status !== pod.status
      )
        sourceAdoptionError(
          'Source request no longer matches the original lifecycle',
          'STALE_SOURCE_ADOPTION',
        );
    };
    anchor();
    const cm = deps.getContainerManager(pod.executionTarget);
    if (
      !cm.getResourceKey ||
      cm.supportsExecRecovery !== true ||
      cm.supportsStreamingExec === false
    )
      sourceAdoptionError('Original backend lacks exact recoverable source identity');
    let resourceKey: string;
    try {
      resourceKey = await cm.getResourceKey(pod.containerId!);
      const concurrent = replay();
      if (concurrent) return concurrent;
      anchor();
    } catch (error) {
      const concurrent = replay();
      if (concurrent) return concurrent;
      anchor();
      throw error;
    }
    const profile = deps.executionForPod(pod);
    if (!profile.repoUrl) sourceAdoptionError('Original repository is unavailable');
    const claimed = repo.claim(
      input.id,
      podId,
      {
        generation: pod.lifecycleGeneration,
        fingerprint,
        repository: profile.repoUrl,
        branch: pod.branch,
        baseBranch: pod.baseBranch ?? profile.defaultBranch ?? 'main',
        containerId: pod.containerId!,
        worktreePath: pod.worktreePath!,
        resourceKey,
        oldHead: input.oldHeadSha,
        targetHead: input.targetHeadSha,
        dependencySetupCommand: input.dependencySetupCommand,
        requestHash,
      },
      actor,
      input.reason,
      anchor,
    );
    if (claimed.acquired) {
      const running = repo
        .owned(input.id, () => run(input.id))
        .catch((error: unknown) => {
          const live = repo.get(input.id);
          if (live && live.stage !== 'checked')
            repo.fail(
              input.id,
              error &&
                typeof error === 'object' &&
                'code' in error &&
                typeof error.code === 'string'
                ? error.code
                : 'SOURCE_ADOPTION_FAILED',
            );
          deps.emit(
            podId,
            'Source recovery stopped. Observe its durable status; original resources and evidence remain held.',
          );
        })
        .finally(() => runs.delete(input.id));
      runs.set(input.id, running);
    }
    return sourceAdoptionState(repo.get(input.id)!);
  }
  return {
    submit,
    list: (podId: string) => repository().list(podId).map(sourceAdoptionState),
    wait: (id: string) => runs.get(id) ?? Promise.resolve(),
  };
}
