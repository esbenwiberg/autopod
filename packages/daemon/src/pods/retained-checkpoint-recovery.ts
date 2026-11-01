import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { OperatorActor, Pod, PodStatus } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import {
  assertCheckpointRepository,
  prepareRetainedCheckpointWorkspace,
} from '../worktrees/retained-checkpoint-workspace.js';
import type { PodRepository } from './pod-repository.js';
import {
  type CheckpointRecoveryRecord,
  type CheckpointRecoveryRequest,
  checkpointError,
  checkpointHash,
} from './retained-checkpoint-repository.js';
import {
  assertValidationExecutionSettled,
  requiresValidationSettlement,
} from './validation-recovery-policy.js';
import { isPodValidationDisabled } from './validation-workflow-policy.js';

export function createRetainedCheckpointRecovery(deps: {
  podRepo: PodRepository;
  executionForPod(pod: Pod): PodExecutionSettings;
  getContainerManager(): ContainerManager;
  worktreeManager: WorktreeManager;
  isIdle(podId: string): boolean;
  isGoal(podId: string): boolean;
  assertGuidanceCollected(podId: string): void;
  enqueue(podId: string): void;
  transition(pod: Pod, status: PodStatus): Pod;
  emit(podId: string, message: string): void;
  root: string;
  logger: Pick<Logger, 'error'>;
  prepare?: typeof prepareRetainedCheckpointWorkspace;
}) {
  const repo =
    deps.podRepo.retainedCheckpoints ?? checkpointError('Checkpoint recovery ledger unavailable');
  const pending = new Map<string, Promise<void>>();
  const executions = new Map<string, Promise<void>>();
  const configuration = (pod: Pod) =>
    checkpointHash([
      pod.launchConfigDigest,
      pod.branch,
      pod.baseBranch,
      pod.startCommitSha,
      pod.contract,
      pod.options,
      pod.executionTarget,
      pod.runtime,
      pod.model,
      pod.providerIdSnapshot,
      pod.providerAccountIdSnapshot,
      deps.executionForPod(pod),
    ]);
  function policy(pod: Pod) {
    if (
      pod.executionTarget !== 'sandbox' ||
      deps.isGoal(pod.id) ||
      pod.options.agentMode === 'interactive' ||
      !['failed', 'review_required', 'validated'].includes(pod.status) ||
      !pod.containerId ||
      !pod.worktreePath ||
      pod.worktreeCompromised ||
      !pod.lastValidationResult ||
      pod.pendingEscalation ||
      deps.podRepo.hasUnansweredDecision?.(pod.id) ||
      isPodValidationDisabled(pod) ||
      pod.validationWaiver ||
      (pod.validationOverrides?.length ?? 0) > 0 ||
      pod.linkedPodId ||
      (pod.sidecarContainerIds && Object.keys(pod.sidecarContainerIds).length > 0)
    )
      checkpointError(
        'Checkpoint recovery requires an idle ordinary sandbox, retained source/result, no waivers, sidecars or pending decisions',
      );
    if (
      !deps.podRepo.taskExecutions ||
      !deps.podRepo.validationExecutions ||
      !deps.podRepo.sourceAdoptions
    )
      checkpointError('Task, source and validation custody ledgers are required');
    deps.podRepo.taskExecutions.assertCanDelete(pod.id); // Settled WORKERS only; no deletion follows.
    deps.podRepo.validationExecutions.assertNoActiveTaskExecution(pod.id);
    if (deps.podRepo.validationExecutions.unsettled(pod.id))
      checkpointError(
        'An immutable validation dispatch requires its own exact-execution recovery; this legacy checkpoint path cannot detach it',
      );
    if (deps.podRepo.sourceAdoptions.hasCustody(pod.id))
      checkpointError('Another source recovery retains custody');
    deps.podRepo.sourceAdoptions.assertControlPlaneSettled(pod.id);
    deps.podRepo.deletionOwnership?.assertTaskAvailable(pod.id);
    for (const id of deps.podRepo.sourceAdoptions.taskPodIds(pod.id))
      if (!deps.isIdle(id)) checkpointError('A task invocation is still active');
    deps.assertGuidanceCollected(pod.id);
    if (
      !requiresValidationSettlement(pod) &&
      !deps.podRepo.sandboxWakeups
        ?.listForPod(pod.id)
        .some((intent) => intent.endedAt === null && intent.sandboxId === pod.containerId)
    )
      checkpointError(
        'Use ordinary checks/approval recovery when no retained legacy execution or wakeup blocks it',
      );
  }
  function original(record: CheckpointRecoveryRecord) {
    const current = deps.podRepo.getOrThrow(record.podId);
    policy(current);
    if (
      current.lifecycleGeneration !== record.generation ||
      current.containerId !== record.containerId ||
      current.worktreePath !== record.worktreePath ||
      checkpointHash(current.lastValidationResult) !== record.binding.resultHash ||
      configuration(current) !== record.binding.configurationHash
    )
      checkpointError('Original checkpoint selection was superseded', 'STALE_CHECKPOINT_RECOVERY');
    return current;
  }
  async function prepare(id: string) {
    const record = repo.get(id) ?? checkpointError('Recovery record is unavailable');
    const assertCurrent = () => {
      original(record);
    };
    assertCurrent();
    await mkdir(path.join(deps.root, record.podId), { recursive: true, mode: 0o700 });
    assertCurrent();
    const prepared = await (deps.prepare ?? prepareRetainedCheckpointWorkspace)({
      source: record.worktreePath,
      root: path.join(deps.root, record.podId, id),
      branch: record.binding.branch,
      repository: record.binding.repository,
      head: record.binding.head,
      generation: record.generation,
      cycle: record.binding.cycle,
      assertCurrent,
    });
    assertCurrent();
    const atomically =
      deps.podRepo.atomically ?? checkpointError('Managed atomic activation is required');
    atomically(() => {
      const pod = original(record);
      repo.append(id, 'prepared', prepared);
      const generation = deps.podRepo.incrementLifecycleGeneration(record.podId);
      deps.podRepo.update(record.podId, {
        worktreePath: prepared.worktree,
        recoveryWorktreePath: prepared.worktree,
        containerId: null,
        skipAgent: true,
        autoApprove: false,
        lastValidationResult: null,
        preSubmitReview: null,
        validationWaiver: null,
        failureReason: null,
        artifactsPath: null,
        previewUrl: null,
        claudeSessionId: null,
        codexSessionId: null,
        piSessionId: null,
      });
      repo.append(id, 'activated', { generation });
      deps.transition({ ...pod, lifecycleGeneration: generation }, 'queued');
    });
    deps.emit(
      record.podId,
      'Selected retained checkpoint queued for fresh checks only. Original sandbox, unknown execution and reports remain quarantined; no coding worker or delivery was authorized.',
    );
    deps.enqueue(record.podId);
  }
  async function submit(podId: string, input: CheckpointRecoveryRequest, actor: OperatorActor) {
    if (
      actor.type !== 'human' ||
      !actor.userId.trim() ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(input.id) ||
      input.reason.trim().length < 10 ||
      input.reason.length > 4000
    )
      checkpointError('Authenticated human, stable request ID and meaningful reason required');
    const replay = () => {
      const prior = repo.get(input.id);
      if (
        prior &&
        (prior.podId !== podId || prior.requestHash !== checkpointHash([podId, input, actor]))
      )
        checkpointError(
          'Recovery request ID has different source or actor',
          'CHECKPOINT_RECOVERY_CONFLICT',
        );
      return prior;
    };
    const prior = replay();
    if (prior) return prior; // Lost responses/restarts never repeat preparation or dispatch.
    const pod = deps.podRepo.getOrThrow(podId);
    policy(pod);
    const containerManager = deps.getContainerManager();
    if (!containerManager.getResourceKey || !deps.worktreeManager.inspectSourceAdoption)
      checkpointError('Exact provider namespace and clean source inspection are required');
    const anchor = configuration(pod);
    const assertCurrent = () => {
      const current = deps.podRepo.getOrThrow(podId);
      policy(current);
      if (
        current.lifecycleGeneration !== input.expectedGeneration ||
        current.containerId !== pod.containerId ||
        current.worktreePath !== pod.worktreePath ||
        checkpointHash(current.lastValidationResult) !== input.expectedResultHash ||
        configuration(current) !== anchor
      )
        checkpointError(
          'Pod changed; refresh generation/result/source selection',
          'STALE_CHECKPOINT_RECOVERY',
        );
    };
    assertCurrent();
    const containerId = pod.containerId ?? checkpointError('Original resource required');
    const worktreePath = pod.worktreePath ?? checkpointError('Original worktree required');
    const resourceKey = await containerManager.getResourceKey(containerId);
    const afterIdentity = replay();
    if (afterIdentity) return afterIdentity;
    assertCurrent();
    const status = await containerManager.getStatus(containerId);
    const afterProvider = replay();
    if (afterProvider) return afterProvider;
    assertCurrent();
    if (status !== 'stopped')
      checkpointError(
        'Only a retained stopped original is eligible; no original wake, stop, clone or deletion is performed',
      );
    const source = await deps.worktreeManager.inspectSourceAdoption(worktreePath, pod.branch);
    const afterSource = replay();
    if (afterSource) return afterSource;
    assertCurrent();
    if (!source.worktreeClean || source.commitSha !== input.checkpointHead)
      checkpointError('Selected commit must match the clean retained host checkpoint');
    const profile = deps.executionForPod(pod);
    if (!profile.repoUrl) checkpointError('Original frozen repository is unavailable');
    assertCheckpointRepository(profile.repoUrl); // Never persist credential-bearing repository URLs.
    const claimed = repo.claim({
      pod,
      taskId: (deps.podRepo.taskExecutions ?? checkpointError('Task ledger unavailable')).snapshot(
        podId,
      ).taskId,
      resourceKey,
      request: input,
      actor,
      assertCurrent,
      binding: {
        branch: pod.branch,
        head: input.checkpointHead,
        repository: profile.repoUrl,
        cycle: pod.finalization?.cycle ?? 0,
        resultHash: input.expectedResultHash,
        configurationHash: anchor,
      },
    });
    if (claimed.acquired) {
      const run = repo
        .owned(input.id, () => prepare(input.id))
        .catch((error: unknown) => {
          deps.logger.error(
            { err: error, podId, recoveryId: input.id },
            'Checkpoint recovery preparation failed',
          );
          const live = repo.get(input.id);
          if (live && !live.blocked && !live.checked)
            repo.append(input.id, 'blocked', {
              code:
                error instanceof Error && 'code' in error
                  ? String(error.code)
                  : 'CHECKPOINT_PREPARATION_FAILED',
            });
          deps.emit(
            podId,
            'Checkpoint recovery stopped. Original source/reports remain held; inspect the durable operation rather than resubmitting.',
          );
        })
        .finally(() => pending.delete(input.id));
      pending.set(input.id, run);
    }
    return repo.get(input.id) ?? checkpointError('Recovery claim was not retained');
  }
  /** Only queue processing can enter this private checks capability, never a caller's force flag. */
  async function process(podId: string, run: () => Promise<void>) {
    const existing = executions.get(podId);
    if (existing) return existing;
    const record = repo.latest(podId);
    if (!record || record.checked) return run();
    const pod = deps.podRepo.getOrThrow(podId);
    if (
      !record.activated ||
      !record.prepared ||
      record.checking ||
      record.blocked ||
      pod.status !== 'queued' ||
      !pod.skipAgent ||
      pod.lifecycleGeneration !== record.activated.generation ||
      pod.worktreePath !== record.prepared.worktree ||
      pod.containerId !== null
    )
      checkpointError('Checkpoint execution is not eligible for fresh queue dispatch');
    const generation = record.activated.generation;
    const execution = repo
      .owned(record.id, async () => {
        repo.append(record.id, 'checking', { generation });
        try {
          repo.assertAvailable(podId);
          await verifySource(podId);
          await run();
          const current = deps.podRepo.getOrThrow(podId);
          if (
            current.lastValidationResult &&
            current.lifecycleGeneration === generation &&
            ['validated', 'review_required', 'failed'].includes(current.status)
          ) {
            assertValidationExecutionSettled(current);
            await verifySource(podId);
            if (
              current.lastValidationResult.overall === 'pass' &&
              (!current.artifactsPath || !current.containerId)
            )
              checkpointError(
                'Fresh checks passed but report capture did not complete',
                'CHECKPOINT_REPORTS_UNVERIFIED',
              );
            repo.append(record.id, 'checked', {
              result: current.lastValidationResult,
              resultHash: checkpointHash(current.lastValidationResult),
              snapshot:
                current.artifactsPath && current.containerId
                  ? {
                      path: current.artifactsPath,
                      cycle: current.finalization?.cycle ?? 0,
                      containerId: current.containerId,
                    }
                  : null,
            });
          } else {
            checkpointError(
              'Fresh checkpoint checks did not produce a result; inspect the retained execution',
              'CHECKPOINT_CHECKS_UNVERIFIED',
            );
          }
        } catch (error) {
          const live = repo.get(record.id) ?? checkpointError('Recovery record is unavailable');
          if (!live.blocked && !live.checked)
            repo.append(record.id, 'blocked', {
              code:
                error instanceof Error && 'code' in error
                  ? String(error.code)
                  : 'CHECKPOINT_CHECKS_UNVERIFIED',
            });
          throw error;
        }
      })
      .finally(() => executions.delete(podId));
    executions.set(podId, execution);
    return execution;
  }
  async function verifySource(podId: string) {
    const record = repo.latest(podId);
    if (!record?.activated || !record.prepared || record.checked) return;
    repo.assertAvailable(podId);
    const pod = deps.podRepo.getOrThrow(podId);
    if (!deps.worktreeManager.inspectSourceAdoption)
      checkpointError('Source inspection is unavailable');
    const actual = await deps.worktreeManager.inspectSourceAdoption(
      record.prepared.worktree,
      record.binding.branch,
    );
    repo.assertAvailable(podId);
    if (
      pod.lifecycleGeneration !== record.activated.generation ||
      pod.worktreePath !== record.prepared.worktree ||
      configuration(pod) !== record.binding.configurationHash ||
      !actual.worktreeClean ||
      actual.commitSha !== record.prepared.head ||
      actual.treeSha !== record.prepared.tree
    )
      checkpointError(
        'Fresh checks no longer match the selected source/configuration',
        'CHECKPOINT_SOURCE_CHANGED',
      );
  }
  return {
    submit,
    process,
    verifySource,
    list: (podId: string) => repo.list(podId),
    wait: (id: string) => pending.get(id) ?? Promise.resolve(),
  };
}
