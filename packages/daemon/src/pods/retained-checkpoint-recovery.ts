import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  ApprovalRewriteRepairCheckRequest,
  ApprovalRewriteRepairRequest,
  EffectiveLaunchConfig,
  OperatorActor,
  Pod,
  PodStatus,
  RetainedContinuationCheckRequest,
  RetainedContinuationRequest,
} from '@autopod/shared';
import type { Logger } from 'pino';
import {
  type RetainedExecutionSelection,
  retainedContinuationLaunch,
} from '../configuration/retained-continuation-launch.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import { assertApprovalRepairStorage } from '../worktrees/approval-rewrite-repair-source.js';
import { inspectCheckpointSource } from '../worktrees/checkpoint-source-identity.js';
import { assertMergeRepository } from '../worktrees/merge-source-identity.js';
import {
  assertCheckpointRepository,
  prepareRetainedCheckpointWorkspace,
} from '../worktrees/retained-checkpoint-workspace.js';
import { rewriteHash } from './approval-source-rewrite-repository.js';
import { rewriteConfiguration } from './approval-source-rewrite.js';
import type { PodRepository } from './pod-repository.js';
import {
  type CheckpointOutcomeRequest,
  type CheckpointRecoveryBinding,
  type CheckpointRecoveryRecord,
  type CheckpointRecoveryRequest,
  checkpointError,
  checkpointHash,
} from './retained-checkpoint-repository.js';
import {
  assertValidationExecutionSettled,
  requiresValidationSettlement,
} from './validation-recovery-policy.js';
import {
  getPodValidationSkipPhases,
  isPodValidationDisabled,
} from './validation-workflow-policy.js';

export function createRetainedCheckpointRecovery(deps: {
  podRepo: PodRepository;
  executionForPod(pod: Pod): PodExecutionSettings;
  readLaunch?(podId: string): EffectiveLaunchConfig | null;
  executionSettings?(config: EffectiveLaunchConfig): PodExecutionSettings;
  previewExecution?(podId: string, profileId: string): Promise<RetainedExecutionSelection>;
  getContainerManager(target?: Pod['executionTarget']): ContainerManager;
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
  const configuration = (pod: Pod, settings = deps.executionForPod(pod)) =>
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
      settings,
    ]);
  function policy(
    pod: Pod,
    continuation = false,
    repair?: CheckpointRecoveryBinding['approvalRewrite'],
  ) {
    if (
      continuation &&
      (!['pr', 'branch'].includes(pod.options.output ?? 'pr') ||
        (pod.requireSidecars?.length ?? 0) > 0 ||
        (deps.readLaunch?.(pod.id)?.requiredSidecarIds.length ?? 0) > 0)
    )
      checkpointError(
        'Retained continuation supports reviewed PR/branch tasks without declared sidecars; artifact completion has a separate preservation workflow',
      );
    if (deps.podRepo.approvalRewrites?.latest(pod) && !repair)
      checkpointError(
        'Approval rewrite owns this source; a competing checkpoint recovery is not authorized',
      );
    if (
      (!continuation && pod.executionTarget !== 'sandbox') ||
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
    if (repair) {
      const rewrite = deps.podRepo.approvalRewrites?.get(repair.id);
      const selected = deps.podRepo.approvalRewrites?.latest(pod);
      const dispatch = deps.podRepo.validationExecutions.find(pod);
      if (
        pod.executionTarget !== 'sandbox' ||
        !deps.podRepo.sandboxWakeups ||
        !deps.podRepo.deletionOwnership ||
        deps.podRepo.validationExecutions.hasGoal(pod.id) ||
        rewriteHash(pod.task) !== repair.taskHash ||
        !rewrite ||
        selected?.id !== rewrite.id ||
        selected.repairId ||
        !rewrite.activated ||
        !rewrite.prepared ||
        rewrite.checked ||
        rewrite.aborted ||
        rewrite.activated.generation !== pod.lifecycleGeneration ||
        rewrite.prepared.worktreePath !== pod.worktreePath ||
        rewrite.binding.prUrl !== pod.prUrl ||
        rewrite.binding.predecessor.branch !== pod.branch ||
        rewrite.binding.baseBranch !==
          (pod.baseBranch ?? deps.executionForPod(pod).defaultBranch ?? 'main') ||
        rewrite.binding.configurationHash !==
          rewriteConfiguration(pod, deps.executionForPod(pod)) ||
        rewriteHash(rewrite) !== repair.evidenceHash ||
        !['failed', 'review_required'].includes(pod.status) ||
        pod.lastValidationResult?.overall !== 'fail' ||
        !dispatch ||
        dispatch.id !== repair.dispatchId ||
        dispatch.binding.containerId !== pod.containerId ||
        dispatch.binding.worktreePath !== pod.worktreePath ||
        dispatch.binding.generation !== rewrite.activated.generation ||
        deps.podRepo.taskRetries?.state(pod.id).latest?.id !== dispatch.binding.admissionId ||
        !dispatch.binding.resourceScope ||
        deps.getContainerManager('sandbox').executionResourceScope !==
          dispatch.binding.resourceScope ||
        dispatch.intent
      )
        checkpointError('Exact failed sandbox rewrite dispatch/source/configuration required');
      const repository =
        deps.executionForPod(pod).repoUrl ?? checkpointError('Frozen repository unavailable');
      assertCheckpointRepository(repository);
      assertMergeRepository(
        {
          repository: rewrite.binding.predecessor.repository,
          branch: pod.branch,
          baseBranch: rewrite.binding.baseBranch,
        },
        repository,
      );
      deps.podRepo.validationExecutions.assertFailedChecksSelection(pod, repair.dispatchId);
      for (const id of deps.podRepo.sourceAdoptions.taskPodIds(pod.id))
        if (deps.podRepo.sandboxWakeups?.listForPod(id).some((intent) => intent.endedAt === null))
          checkpointError('Unsettled wakeup requires separate reconciliation');
    }
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
      continuation &&
      (pod.options.validationSuite === 'thin' ||
        getPodValidationSkipPhases(deps.executionForPod(pod), pod).includes('review'))
    )
      checkpointError(
        'Retained continuation requires configured independent review without waivers',
      );
    if (
      !continuation &&
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
    policy(current, Boolean(record.binding.continuation), record.binding.approvalRewrite);
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
    let prepared = await (deps.prepare ?? prepareRetainedCheckpointWorkspace)({
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
    if (record.binding.continuation && !record.binding.approvalRewrite) {
      const select =
        deps.worktreeManager.selectRetainedContinuationSource ??
        checkpointError('Independent remote source selection is unavailable');
      const selected = await select.call(deps.worktreeManager, {
        worktreePath: prepared.worktree,
        originalWorktreePath: record.worktreePath,
        branch: record.binding.branch,
        repository: record.binding.repository,
        head: prepared.head,
        remoteHead: record.binding.continuation.remoteHead,
        baseBranch:
          original(record).baseBranch ??
          deps.executionForPod(original(record)).defaultBranch ??
          'main',
        assertCurrent,
      });
      assertCurrent();
      prepared = { ...prepared, ...selected };
    }
    if (record.binding.approvalRewrite) {
      const rewrite = deps.podRepo.approvalRewrites?.get(record.binding.approvalRewrite.id);
      prepared = { ...prepared, baseCommitSha: rewrite?.binding.baseCommitSha };
    }
    repo.append(id, 'prepared', prepared);
    if (record.binding.continuation?.prepareOnly) {
      deps.emit(
        record.podId,
        'Independent repair checkout prepared. Original source/resource remain retained; no worker, checks or delivery started. Select the exact final candidate through retained continuation before checks.',
      );
      return;
    }
    activate(repo.get(id) ?? checkpointError('Prepared recovery unavailable'));
  }
  function activate(
    record: CheckpointRecoveryRecord,
    selection?: NonNullable<CheckpointRecoveryRecord['selected']>,
  ) {
    const prepared = record.prepared ?? checkpointError('Prepared source required');
    const atomically =
      deps.podRepo.atomically ?? checkpointError('Managed atomic activation is required');
    atomically(() => {
      const pod = original(record);
      if (selection) repo.select(record.id, selection);
      const generation = deps.podRepo.incrementLifecycleGeneration(record.podId);
      const execution = selection?.execution ?? record.binding.continuation?.execution;
      // Detach only after the durable original-resource hold exists; never stop/delete it.
      if (execution) deps.podRepo.update(record.podId, { containerId: null });
      deps.podRepo.update(record.podId, {
        ...(execution ? { executionTarget: execution.target } : {}),
        worktreePath: prepared.worktree,
        recoveryWorktreePath: prepared.worktree,
        containerId: null,
        skipAgent: true,
        autoApprove: false,
        lastValidationResult: null,
        preSubmitReview: null,
        validationWaiver: null,
        failureReason: null,
        ...(record.binding.approvalRewrite
          ? {
              readinessReview: null,
              lastRecoveryTrigger: null,
              lastCorrectionMessage: null,
              infrastructureFailure: null,
            }
          : {}),
        artifactsPath: null,
        previewUrl: null,
        claudeSessionId: null,
        codexSessionId: null,
        piSessionId: null,
      });
      if (execution) repo.activateExecution(record.id);
      repo.append(record.id, 'activated', { generation });
      deps.transition({ ...pod, lifecycleGeneration: generation }, 'queued');
    });
    deps.emit(
      record.podId,
      'Selected retained source queued for fresh checks only. Original resource, execution and reports remain quarantined; no coding worker or delivery was authorized.',
    );
    deps.enqueue(record.podId);
  }
  async function submit(
    podId: string,
    input: CheckpointRecoveryRequest | RetainedContinuationRequest | ApprovalRewriteRepairRequest,
    actor: OperatorActor,
    continuation = false,
    repair?: CheckpointRecoveryBinding['approvalRewrite'],
  ) {
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
    policy(pod, continuation, repair);
    const containerManager = deps.getContainerManager(pod.executionTarget);
    if (!containerManager.getResourceKey || !deps.worktreeManager.inspectSourceAdoption)
      checkpointError('Exact provider namespace and clean source inspection are required');
    const anchor = configuration(pod);
    const assertCurrent = () => {
      const current = deps.podRepo.getOrThrow(podId);
      policy(current, continuation, repair);
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
    if (repair) {
      const dispatch = deps.podRepo.validationExecutions?.find(pod);
      if (
        !dispatch?.binding.resourceScope ||
        containerManager.executionResourceScope !== dispatch.binding.resourceScope
      )
        checkpointError('Validation provider namespace changed');
      if (
        (await containerManager.getStatus(containerId)) !== 'stopped' ||
        (await containerManager.getResourceKey(containerId)) !== resourceKey
      )
        checkpointError('Failed rewrite resource changed during source observation');
      assertCurrent();
      const rewrite = deps.podRepo.approvalRewrites?.get(repair.id);
      if (
        source.branch !== pod.branch ||
        source.commitSha !== rewrite?.prepared?.head ||
        source.treeSha !== rewrite.prepared.tree
      )
        checkpointError('Failed candidate source identity changed');
    }
    const profile = deps.executionForPod(pod);
    if (!profile.repoUrl) checkpointError('Original frozen repository is unavailable');
    assertCheckpointRepository(profile.repoUrl); // Never persist credential-bearing repository URLs.
    let execution: RetainedExecutionSelection | undefined;
    const selection = input as RetainedContinuationRequest;
    if (continuation && selection.executionProfileId) {
      execution = await resolveExecutionSelection(pod, selection, assertCurrent);
    }
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
        ...(repair ? { approvalRewrite: repair } : {}),
        branch: pod.branch,
        head: input.checkpointHead,
        repository: profile.repoUrl,
        cycle: pod.finalization?.cycle ?? 0,
        resultHash: input.expectedResultHash,
        configurationHash: anchor,
        ...(continuation
          ? {
              continuation: {
                remoteHead: (input as RetainedContinuationRequest).remoteHead,
                prepareOnly: repair
                  ? true
                  : ((input as RetainedContinuationRequest).prepareOnly ?? false),
                ...(execution ? { execution } : {}),
              },
            }
          : {}),
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
  async function prepareRewriteRepair(
    podId: string,
    input: ApprovalRewriteRepairRequest,
    actor: OperatorActor,
  ) {
    const keys = [
      'id',
      'rewriteId',
      'failedDispatchId',
      'expectedGeneration',
      'expectedResultHash',
      'checkpointHead',
      'reason',
    ];
    if (
      Object.keys(input).some((key) => !keys.includes(key)) ||
      !input.rewriteId?.trim() ||
      !input.failedDispatchId?.trim()
    )
      checkpointError('Unsupported or missing rewrite repair identity');
    // Replay must observe the original claim even after its selection changed lifecycle.
    const prior = repo.get(input.id);
    if (prior) {
      if (
        !prior.binding.approvalRewrite ||
        prior.podId !== podId ||
        prior.requestHash !== checkpointHash([podId, input, actor])
      )
        checkpointError(
          'Repair request differs from saved identity/actor',
          'CHECKPOINT_RECOVERY_CONFLICT',
        );
      return prior;
    }
    const pod = deps.podRepo.getOrThrow(podId);
    const rewrite =
      deps.podRepo.approvalRewrites?.get(input.rewriteId) ?? checkpointError('Rewrite unavailable');
    return submit(podId, input, actor, true, {
      id: input.rewriteId,
      dispatchId: input.failedDispatchId,
      evidenceHash: rewriteHash(rewrite),
      taskHash: rewriteHash(pod.task),
      artifactsPath: pod.artifactsPath,
    });
  }
  async function checkRewriteRepair(
    podId: string,
    recoveryId: string,
    input: ApprovalRewriteRepairCheckRequest,
    actor: OperatorActor,
  ) {
    const keys = [
      'rewriteId',
      'failedDispatchId',
      'expectedGeneration',
      'expectedResultHash',
      'candidateHead',
      'reason',
    ];
    if (Object.keys(input).some((key) => !keys.includes(key)))
      checkpointError('Unsupported rewrite repair authority');
    return checkCandidate(podId, recoveryId, input, actor, true);
  }
  async function previewExecution(podId: string, profileId: string) {
    if (!profileId.trim() || profileId.length > 128)
      checkpointError('Explicit replacement profile required');
    const pod = deps.podRepo.getOrThrow(podId);
    policy(pod, true);
    const preview =
      deps.previewExecution ?? checkpointError('Explicit execution selection is unavailable');
    return preview(podId, profileId);
  }
  function validateExecutionSelection(
    input: Pick<RetainedContinuationRequest, 'executionProfileId' | 'expectedExecutionDigest'>,
  ) {
    if (
      Boolean(input.executionProfileId) !== Boolean(input.expectedExecutionDigest) ||
      (input.expectedExecutionDigest !== undefined &&
        !/^[a-f0-9]{64}$/.test(input.expectedExecutionDigest))
    )
      checkpointError(
        'Replacement execution requires an explicit profile and its exact preview digest',
      );
  }
  async function resolveExecutionSelection(
    pod: Pod,
    input: Pick<RetainedContinuationRequest, 'executionProfileId' | 'expectedExecutionDigest'>,
    assertCurrent: () => void,
  ): Promise<RetainedExecutionSelection> {
    const execution = await previewExecution(pod.id, input.executionProfileId!);
    assertCurrent();
    if (execution.digest !== input.expectedExecutionDigest)
      checkpointError(
        'Replacement execution preview changed; inspect it again',
        'CONTINUATION_EXECUTION_CHANGED',
      );
    const parent = deps.readLaunch?.(pod.id) ?? checkpointError('Original launch unavailable');
    const next = retainedContinuationLaunch(parent, pod.id, execution);
    const settings =
      deps.executionSettings?.(next) ??
      checkpointError('Replacement execution settings unavailable');
    return {
      ...execution,
      configurationHash: configuration(
        { ...pod, executionTarget: execution.target, launchConfigDigest: execution.digest },
        settings,
      ),
    };
  }
  async function continueRetained(
    podId: string,
    input: RetainedContinuationRequest,
    actor: OperatorActor,
  ) {
    if (input.remoteHead !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.remoteHead))
      checkpointError('Exact published source head required');
    validateExecutionSelection(input);
    return submit(podId, { ...input, prepareOnly: input.prepareOnly ?? false }, actor, true);
  }
  async function checkCandidate(
    podId: string,
    recoveryId: string,
    input: RetainedContinuationCheckRequest,
    actor: OperatorActor,
    rewriteRepair = false,
  ) {
    if (
      actor.type !== 'human' ||
      !actor.userId.trim() ||
      input.reason.trim().length < 10 ||
      input.reason.length > 4000 ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.candidateHead)
    )
      checkpointError('Authenticated human and exact candidate selection with reason required');
    validateExecutionSelection(input);
    if (
      input.testBudget &&
      (!Number.isInteger(input.testBudget.seconds) ||
        input.testBudget.seconds < 1 ||
        input.testBudget.seconds > 3600 ||
        input.testBudget.reason.trim().length < 10 ||
        input.testBudget.reason.length > 4000)
    )
      checkpointError(
        'A finite test allowance of 1–3600 seconds and separate human reason are required',
      );
    const record = repo.get(recoveryId) ?? checkpointError('Recovery unavailable');
    if (Boolean(record.binding.approvalRewrite) !== rewriteRepair)
      checkpointError('Use the dedicated rewrite repair operation for rewrite-owned source');
    if (rewriteRepair) {
      const exact = input as ApprovalRewriteRepairCheckRequest;
      if (
        exact.rewriteId !== record.binding.approvalRewrite?.id ||
        exact.failedDispatchId !== record.binding.approvalRewrite.dispatchId ||
        actor.userId !== record.actor.userId ||
        input.executionProfileId ||
        input.expectedExecutionDigest ||
        input.testBudget
      )
        checkpointError('Rewrite repair identity/actor changed or expanded authority requested');
    }
    const requestHash = checkpointHash([podId, recoveryId, input, actor]);
    if (record.podId !== podId || !record.binding.continuation?.prepareOnly)
      checkpointError('Prepared continuation required');
    if (record.selected) {
      if (record.selected.requestHash !== requestHash)
        checkpointError(
          'Candidate selection differs from saved request',
          'CHECKPOINT_RECOVERY_CONFLICT',
        );
      return record;
    }
    if (
      record.blocked ||
      record.activated ||
      !record.prepared ||
      record.generation !== input.expectedGeneration ||
      record.binding.resultHash !== input.expectedResultHash
    )
      checkpointError('Original continuation changed', 'STALE_CHECKPOINT_RECOVERY');
    if (input.executionProfileId && record.binding.continuation.execution)
      checkpointError('Execution was already selected at preparation; it cannot be replaced');
    return repo.owned(recoveryId, async () => {
      const assertCurrent = () => {
        original(record);
      };
      assertCurrent();
      if (record.binding.approvalRewrite) {
        const cm = deps.getContainerManager('sandbox');
        if (
          (await cm.getResourceKey?.(record.containerId)) !== record.resourceKey ||
          (await cm.getStatus(record.containerId)) !== 'stopped'
        )
          checkpointError('Failed rewrite resource is no longer known stopped');
        assertCurrent();
        const failed = deps.podRepo.approvalRewrites?.get(record.binding.approvalRewrite.id);
        await inspectCheckpointSource({
          podId,
          worktreePath: record.worktreePath,
          branch: record.binding.branch,
          head: record.binding.head,
          tree: failed?.prepared?.tree ?? checkpointError('Failed tree unavailable'),
          worktreeManager: deps.worktreeManager,
          assertCurrent,
        });
      }
      const execution = input.executionProfileId
        ? await resolveExecutionSelection(original(record), input, assertCurrent)
        : undefined;
      assertCurrent();
      const frozenTimeoutSeconds = deps.executionForPod(original(record)).testTimeout ?? 600;
      if (
        input.testBudget &&
        (!Number.isInteger(frozenTimeoutSeconds) ||
          frozenTimeoutSeconds < 1 ||
          (execution?.target ??
            record.binding.continuation?.execution?.target ??
            original(record).executionTarget) !== 'local' ||
          input.testBudget.seconds <= frozenTimeoutSeconds)
      )
        checkpointError(
          'A retained Docker test allowance must exceed its unchanged frozen test timeout',
        );
      if (record.binding.approvalRewrite)
        await assertApprovalRepairStorage(
          record.prepared!,
          record.binding.repository,
          assertCurrent,
          { generation: record.generation, cycle: record.binding.cycle },
        );
      const inspect =
        deps.worktreeManager.inspectSourceAdoption ??
        checkpointError('Source inspection unavailable');
      const source = await inspect.call(
        deps.worktreeManager,
        record.prepared!.worktree,
        record.binding.branch,
      );
      assertCurrent();
      if (
        !source.worktreeClean ||
        source.branch !== record.binding.branch ||
        source.commitSha !== input.candidateHead
      )
        checkpointError('Select the exact clean committed repair candidate');
      if (source.commitSha !== record.prepared!.head) {
        const ancestry =
          deps.worktreeManager.assertSourceDescendsFrom ??
          checkpointError('Repair ancestry verification unavailable');
        await ancestry.call(deps.worktreeManager, record.prepared!.worktree, record.prepared!.head);
        assertCurrent();
      }
      if (record.binding.approvalRewrite)
        await assertApprovalRepairStorage(
          record.prepared!,
          record.binding.repository,
          assertCurrent,
          { generation: record.generation, cycle: record.binding.cycle },
        );
      if (record.binding.approvalRewrite) {
        const cm = deps.getContainerManager('sandbox');
        if (
          (await cm.getStatus(record.containerId)) !== 'stopped' ||
          (await cm.getResourceKey?.(record.containerId)) !== record.resourceKey
        )
          checkpointError('Failed rewrite resource changed during candidate selection');
        assertCurrent();
      }
      const after = await inspect.call(
        deps.worktreeManager,
        record.prepared!.worktree,
        record.binding.branch,
      );
      assertCurrent();
      if (
        after.branch !== record.binding.branch ||
        after.commitSha !== source.commitSha ||
        after.treeSha !== source.treeSha ||
        !after.worktreeClean
      )
        checkpointError('Candidate changed during selection');
      activate(record, {
        head: source.commitSha,
        tree: source.treeSha,
        ...(execution ? { execution } : {}),
        ...(input.testBudget
          ? {
              testBudget: {
                seconds: input.testBudget.seconds,
                reason: input.testBudget.reason.trim(),
                frozenTimeoutSeconds,
              },
            }
          : {}),
        actor,
        reason: input.reason.trim(),
        requestHash,
      });
      return repo.get(recoveryId) ?? checkpointError('Selection unavailable');
    });
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
            const checkedSource = await verifySource(podId);
            if (
              record.binding.continuation &&
              current.lastValidationResult.overall === 'pass' &&
              current.lastValidationResult.taskReview?.status !== 'pass'
            )
              checkpointError(
                'Retained continuation lacks a passing independent review',
                'CONTINUATION_REVIEW_UNVERIFIED',
              );
            if (
              current.lastValidationResult.overall === 'pass' &&
              (!current.artifactsPath || !current.containerId)
            )
              checkpointError(
                'Fresh checks passed but report capture did not complete',
                'CHECKPOINT_REPORTS_UNVERIFIED',
              );
            repo.append(record.id, 'checked', {
              ...(record.binding.approvalRewrite ? { source: checkedSource } : {}),
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
  /** Observe an already-published failing replacement outcome. Never replay checks,
   * certify a pass, settle the unknown original, or waive the failed validation.
   */
  async function reconcileOutcome(
    podId: string,
    recoveryId: string,
    input: CheckpointOutcomeRequest,
    actor: OperatorActor,
  ) {
    if (
      actor.type !== 'human' ||
      !actor.userId.trim() ||
      input.reason.trim().length < 10 ||
      input.reason.length > 4000 ||
      !Number.isInteger(input.expectedGeneration) ||
      input.expectedGeneration < 1 ||
      !/^[a-f0-9]{64}$/.test(input.expectedResultHash) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.expectedHead)
    )
      checkpointError(
        'Authenticated human and exact generation/result/source with reason required',
      );
    const requestHash = checkpointHash([podId, recoveryId, input, actor]);
    const record = repo.get(recoveryId) ?? checkpointError('Checkpoint recovery unavailable');
    if (record.podId !== podId) checkpointError('Recovery belongs to another pod');
    if (record.reconciled) {
      if (record.reconciled.requestHash !== requestHash)
        checkpointError(
          'Reconciliation request differs from saved receipt',
          'CHECKPOINT_RECOVERY_CONFLICT',
        );
      return record;
    }
    if (
      !record.prepared ||
      !record.activated ||
      !record.checking ||
      record.checked ||
      record.blocked?.code !== 'CHECKPOINT_SOURCE_CHANGED'
    )
      checkpointError('Only a source-blocked completed checks invocation can be reconciled');
    if (record.binding.continuation)
      checkpointError(
        'Continuation source failures require their own retained evidence; legacy outcome reconciliation cannot supersede a selected repair',
      );
    const executions =
      deps.podRepo.validationExecutions ?? checkpointError('Validation ledger required');
    const tasks = deps.podRepo.taskExecutions ?? checkpointError('Task ledger required');
    const sources =
      deps.podRepo.sourceAdoptions ?? checkpointError('Source custody ledger required');
    const replacementContainerId = deps.podRepo.getOrThrow(podId).containerId;
    const assertCurrent = () => {
      const pod = deps.podRepo.getOrThrow(podId);
      if (
        repo.latest(podId)?.id !== recoveryId ||
        !deps.isIdle(podId) ||
        pod.lifecycleGeneration !== input.expectedGeneration ||
        pod.lifecycleGeneration !== record.activated?.generation ||
        pod.worktreePath !== record.prepared?.worktree ||
        !pod.containerId ||
        pod.containerId !== replacementContainerId ||
        pod.containerId === record.containerId ||
        !['review_required', 'failed'].includes(pod.status) ||
        pod.lastValidationResult?.overall !== 'fail' ||
        pod.validationWaiver ||
        isPodValidationDisabled(pod) ||
        (pod.validationOverrides?.length ?? 0) > 0 ||
        pod.linkedPodId ||
        (pod.sidecarContainerIds && Object.keys(pod.sidecarContainerIds).length > 0) ||
        pod.pendingEscalation ||
        deps.podRepo.hasUnansweredDecision?.(podId) ||
        pod.worktreeCompromised ||
        configuration(pod) !== record.binding.configurationHash ||
        checkpointHash(pod.lastValidationResult) !== input.expectedResultHash ||
        deps.isGoal(podId)
      )
        checkpointError('Replacement generation/result/configuration changed or is not idle');
      for (const id of sources.taskPodIds(podId))
        if (!deps.isIdle(id)) checkpointError('A task invocation remains active');
      tasks.assertCanDelete(podId);
      executions.assertTaskSettled(podId);
      executions.assertNoActiveTaskExecution(podId);
      executions.assertNoPendingRecovery(podId);
      if (sources.hasCustody(podId)) checkpointError('Another source recovery retains custody');
      sources.assertControlPlaneSettled(podId);
      deps.podRepo.deletionOwnership?.assertTaskAvailable(podId);
      deps.assertGuidanceCollected(podId);
      assertValidationExecutionSettled(pod);
      return pod;
    };
    const pod = assertCurrent();
    const execution = executions.find(pod);
    if (!execution || execution.binding.containerId !== pod.containerId)
      checkpointError('Exact published replacement execution binding required');
    executions.assertResourceUnshared(podId, execution.binding.containerId);
    const evidence = executions.evidence(podId, execution.id, input.expectedResultHash);
    if (
      evidence.evidenceKind !== 'published-result' ||
      checkpointHash(evidence.result) !== input.expectedResultHash
    )
      checkpointError('Exact immutable published failing result required');
    const source = await inspectCheckpointSource({
      podId,
      worktreePath: record.prepared.worktree,
      branch: record.binding.branch,
      head: record.prepared.head,
      tree: record.prepared.tree,
      worktreeManager: deps.worktreeManager,
      assertCurrent,
    });
    if (source.head !== input.expectedHead || source.checkpoints.length === 0)
      checkpointError(
        'Reconciliation requires the exact owned no-op lineage',
        'CHECKPOINT_SOURCE_CHANGED',
      );
    const atomic =
      deps.podRepo.atomically ?? checkpointError('Managed atomic reconciliation required');
    const saved = atomic(() => {
      assertCurrent();
      return repo.reconcile(recoveryId, {
        requestHash,
        actor,
        reason: input.reason.trim(),
        generation: pod.lifecycleGeneration,
        dispatchId: execution.id,
        containerId: execution.binding.containerId,
        source,
        checked: { result: evidence.result, resultHash: input.expectedResultHash, snapshot: null },
        observedAt: new Date().toISOString(),
      });
    });
    deps.emit(
      podId,
      'Reconciled already-completed failing checkpoint checks; no execution, waiver, delivery or original-resource release was authorized.',
    );
    return saved;
  }
  async function verifySource(podId: string) {
    const record = repo.latest(podId);
    if (!record?.activated || !record.prepared || record.checked) return;
    repo.assertAvailable(podId);
    if (!deps.worktreeManager.inspectSourceAdoption)
      checkpointError('Source inspection is unavailable');
    const assertCurrent = () => {
      repo.assertAvailable(podId);
      const current = deps.podRepo.getOrThrow(podId);
      if (
        current.lifecycleGeneration !== record.activated?.generation ||
        current.worktreePath !== record.prepared?.worktree ||
        (record.binding.approvalRewrite &&
          rewriteHash(current.task) !== record.binding.approvalRewrite.taskHash) ||
        configuration(current) !==
          (record.selected?.execution?.configurationHash ??
            record.binding.continuation?.execution?.configurationHash ??
            record.binding.configurationHash)
      )
        checkpointError(
          'Fresh checks no longer match the selected source/configuration',
          'CHECKPOINT_SOURCE_CHANGED',
        );
    };
    if (record.binding.approvalRewrite)
      await assertApprovalRepairStorage(record.prepared, record.binding.repository, assertCurrent, {
        generation: record.generation,
        cycle: record.binding.cycle,
      });
    return inspectCheckpointSource({
      podId,
      worktreePath: record.prepared.worktree,
      branch: record.binding.branch,
      head: record.selected?.head ?? record.prepared.head,
      tree: record.selected?.tree ?? record.prepared.tree,
      worktreeManager: deps.worktreeManager,
      assertCurrent,
    });
  }
  return {
    submit,
    prepareRewriteRepair,
    checkRewriteRepair,
    continueRetained,
    previewExecution,
    checkCandidate,
    process,
    verifySource,
    reconcileOutcome,
    list: (podId: string) => repo.list(podId),
    wait: (id: string) => pending.get(id) ?? Promise.resolve(),
  };
}
