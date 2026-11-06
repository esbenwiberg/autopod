import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  ApprovalRewriteRepairCheckRequest,
  ApprovalRewriteRepairRequest,
  EffectiveLaunchConfig,
  InfrastructureRecoveryRequest,
  OperatorActor,
  Pod,
  PodStatus,
  RetainedContinuationCheckRequest,
  RetainedContinuationRequest,
} from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
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
import { rewriteConfiguration } from './approval-source-rewrite.js';
import { rewriteHash } from './approval-source-rewrite-repository.js';
import { verifyArtifactSnapshot } from './artifact-snapshot-receipt.js';
import { assertQualificationExecutionContextSupported } from './environment-qualification.js';
import type { PodRepository } from './pod-repository.js';
import { createRepairContinuation } from './repair-continuation.js';
import {
  type CheckpointOutcomeRequest,
  type CheckpointRecoveryBinding,
  type CheckpointRecoveryRecord,
  type CheckpointRecoveryRequest,
  checkpointError,
  checkpointHash,
  type PreparedCheckpoint,
} from './retained-checkpoint-repository.js';
import type { CodingBinding } from './retained-coding-repository.js';
import {
  assertValidationExecutionSettled,
  requiresValidationSettlement,
} from './validation-recovery-policy.js';
import {
  getPodValidationSkipPhases,
  isPodValidationDisabled,
} from './validation-workflow-policy.js';

/** Read-only diagnostics may retain expected selection refusals, never invent evidence. */
export function observeCheckpointSelection<T>(read: () => T) {
  try {
    return { selection: read(), refusal: null };
  } catch (error) {
    if (
      !(error instanceof AutopodError) ||
      error.code !== 'CHECKPOINT_RECOVERY_BLOCKED' ||
      error.statusCode !== 409
    )
      throw error;
    return { selection: null, refusal: { code: error.code, reason: error.message } };
  }
}

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
  qualifyCoding?: Parameters<typeof createRepairContinuation>[0]['qualify'];
  beforeCodingActivation?(pod: Pod): void;
  isCodingWorkerActive?(podId: string, runId: string): boolean;
}) {
  const repo =
    deps.podRepo.retainedCheckpoints ?? checkpointError('Checkpoint recovery ledger unavailable');
  const pending = new Map<string, Promise<void>>();
  const executions = new Map<string, Promise<void>>();
  const reconciliations = new Map<string, Promise<CheckpointRecoveryRecord>>();
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
    addReview = false,
    infrastructure?: NonNullable<CheckpointRecoveryBinding['continuation']>['infrastructure'],
  ) {
    deps.podRepo.retainedFinalizations?.assertAvailable(pod.id);
    if (infrastructure?.mode === 'rework' && repo.hasTypedPrerequisiteBlocker(pod))
      checkpointError(
        'Typed prerequisite repair requires actual environment qualification through repair continuation, not infrastructure rework',
        'REPAIR_QUALIFICATION_REQUIRED',
      );
    if (
      infrastructure &&
      (pod.executionTarget !== 'local' ||
        pod.status !== 'failed' ||
        deps.readLaunch?.(pod.id)?.ai.reviewer.mode !== 'independent' ||
        !deps.podRepo.hasInfrastructureBlocker?.(pod.id) ||
        pod.finalization?.generation !== pod.lifecycleGeneration ||
        pod.finalization.phase !== 'ready' ||
        !pod.finalization.agentSettledAt ||
        !pod.finalization.sourcePreservedAt)
    )
      checkpointError(
        'Infrastructure recovery requires a native idle failed Docker task with preserved settled source and current recorded needs',
      );
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
      (!pod.lastValidationResult && (!continuation || !repo.selectionEvidence(pod))) ||
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
        (getPodValidationSkipPhases(deps.executionForPod(pod), pod).includes('review') &&
          !(addReview && deps.readLaunch?.(pod.id)?.ai.reviewer.mode === 'independent')))
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
    policy(
      current,
      Boolean(record.binding.continuation),
      record.binding.approvalRewrite,
      record.binding.continuation?.reviewPolicy === 'independent-v1',
      record.binding.continuation?.infrastructure,
    );
    if (
      current.lifecycleGeneration !== record.generation ||
      current.containerId !== record.containerId ||
      current.worktreePath !== record.worktreePath ||
      repo.selectionEvidence(current)?.expectedResultHash !== record.binding.resultHash ||
      configuration(current) !== record.binding.configurationHash
    )
      checkpointError('Original checkpoint selection was superseded', 'STALE_CHECKPOINT_RECOVERY');
    const coding = deps.podRepo.retainedCoding?.get(record.id);
    if (
      coding &&
      deps.podRepo.retainedCoding?.reports(record.podId, record.generation).hash !==
        coding.binding.reportSetHash
    )
      checkpointError('Original report set changed', 'STALE_CHECKPOINT_RECOVERY');
    return current;
  }
  /** Observation only. Successful row checks are not admission or environment qualification. */
  function inspect(podId: string) {
    const pod = deps.podRepo.getOrThrow(podId);
    const check = (id: string, run: () => void) => {
      try {
        run();
        return { id, state: 'no_recorded_blocker' as const, code: null, reason: null };
      } catch (error) {
        // Storage/programming failures must fail the request, never look eligible.
        if (!(error instanceof AutopodError) || error.statusCode !== 409) throw error;
        return { id, state: 'blocked' as const, code: error.code, reason: error.message };
      }
    };
    const checks = [
      // Reuse admission's policy verbatim, reporting its first conservative refusal.
      check('continuation_policy', () => policy(pod, true)),
      check('retained_custody', () => repo.assertAvailable(podId)),
      check('worker_settlement', () => {
        const tasks = deps.podRepo.taskExecutions ?? checkpointError('Task ledger unavailable');
        tasks.assertCanDelete(podId); // This assertion reads only; no deletion is performed.
      }),
      check('validation_settlement', () => {
        const validations =
          deps.podRepo.validationExecutions ?? checkpointError('Validation ledger unavailable');
        validations.assertNoActiveTaskExecution(podId);
        if (validations.unsettled(podId))
          checkpointError(
            'An immutable validation dispatch requires its own exact-execution recovery',
          );
      }),
      check('source_and_delivery_custody', () => {
        const sources =
          deps.podRepo.sourceAdoptions ?? checkpointError('Source ledger unavailable');
        if (sources.hasCustody(podId)) checkpointError('Another source recovery retains custody');
        sources.assertControlPlaneSettled(podId);
        deps.podRepo.deletionOwnership?.assertTaskAvailable(podId);
      }),
      check('human_guidance', () => deps.assertGuidanceCollected(podId)),
    ];
    const observed = observeCheckpointSelection(() => repo.selectionEvidence(pod));
    if (observed.refusal)
      checks.push({ id: 'selection_evidence', state: 'blocked', ...observed.refusal });
    const selection = observed.selection;
    const infrastructure = repo.infrastructureNeeds(pod);
    const currentFinalization = pod.finalization?.generation === pod.lifecycleGeneration;
    return {
      version: 1 as const,
      mode: 'read_only' as const,
      generation: pod.lifecycleGeneration,
      status: checks.some((item) => item.state === 'blocked')
        ? ('blocked' as const)
        : ('requires_selection' as const),
      selection: selection
        ? {
            expectedGeneration: selection.expectedGeneration,
            expectedResultHash: selection.expectedResultHash,
          }
        : null,
      infrastructure: {
        state: infrastructure.needs.length ? ('reported' as const) : ('none_recorded' as const),
        ...infrastructure,
      },
      prerequisites: {
        hostPathRecorded: Boolean(pod.worktreePath),
        sourcePreservationRecorded: Boolean(
          currentFinalization && pod.finalization?.sourcePreservedAt,
        ),
        workerSettlementRecorded: Boolean(currentFinalization && pod.finalization?.agentSettledAt),
        pendingDecision: Boolean(
          pod.pendingEscalation || deps.podRepo.hasUnansweredDecision?.(podId),
        ),
        hostSource: 'not_checked' as const,
        originalFilesAndReports: 'not_checked' as const,
        resourceStateAndIdentity: 'not_checked' as const,
        environmentQualification: 'not_checked' as const,
        retryAdmission: 'not_checked' as const,
      },
      checks,
      nextSteps: [
        'Inspect recorded needs and resolve pending decisions/guidance or custody through their owning controls; never clear a hold to retry.',
        'Select the exact retained host HEAD and generation/result hash. Host preservation does not collect unsynced original files or reports.',
        'Use --preview-execution PROFILE for configuration only; it does not qualify the actual environment. Sandbox wakeup is machine-only, not task continuation.',
        'Use --apply --prepare-only for an independent repair checkout, or --apply for checks-only selection. All existing admission/source/resource checks still apply; no coding worker starts.',
        'After preparation, use --check with the exact committed candidate. Inspect ap retry-state POD --stage validation; any authorize-retry is a separate human action, not implied by selection.',
        'Fresh configured checks and independent review must run on the selected source. A pass still requires separate human approval; historical reports and budgets remain retained.',
      ],
    };
  }
  async function quiesce(id: string): Promise<boolean> {
    let record = repo.get(id) ?? checkpointError('Recovery unavailable');
    const selected = record.binding.continuation?.infrastructure;
    if (!selected || !record.prepared || record.activated || record.blocked)
      checkpointError('Prepared infrastructure recovery required');
    const assertCurrent = () => {
      original(repo.get(id) ?? checkpointError('Recovery unavailable'));
    };
    assertCurrent();
    const pod = original(record);
    const cm = deps.getContainerManager(pod.executionTarget);
    deps.podRepo.validationExecutions?.assertResourceUnshared(pod.id, record.containerId);
    const source = await deps.worktreeManager.inspectSourceAdoption!(
      record.worktreePath,
      record.binding.branch,
    );
    assertCurrent();
    if (
      !source.worktreeClean ||
      source.branch !== record.binding.branch ||
      source.commitSha !== record.binding.head ||
      source.treeSha !== selected.originalTree
    )
      checkpointError('Original source changed before quiescence');
    if ((await cm.getResourceKey?.(record.containerId)) !== record.resourceKey)
      checkpointError('Original provider namespace changed');
    assertCurrent();
    let status: Awaited<ReturnType<ContainerManager['getStatus']>>;
    try {
      status = await cm.getStatus(record.containerId);
    } catch {
      assertCurrent();
      return false;
    }
    assertCurrent();
    if (status === 'running' && !record.infrastructure?.stopDispatched) {
      try {
        await repo.stopOriginal(id, () => cm.stop(record.containerId), assertCurrent);
      } catch {
        assertCurrent(); /* An uncertain stop is observed, never replayed. */
      }
      try {
        status = await cm.getStatus(record.containerId);
      } catch {
        assertCurrent();
        return false;
      }
      assertCurrent();
    }
    if (status !== 'stopped') return false;
    if ((await cm.getResourceKey?.(record.containerId)) !== record.resourceKey)
      checkpointError('Original provider namespace changed after stop observation');
    assertCurrent();
    const after = await deps.worktreeManager.inspectSourceAdoption!(
      record.worktreePath,
      record.binding.branch,
    );
    assertCurrent();
    if (checkpointHash(after) !== checkpointHash(source))
      checkpointError('Original source changed during quiescence');
    record = repo.get(id) ?? checkpointError('Recovery unavailable');
    if (!record.infrastructure?.stopped)
      repo.infrastructureEvent(id, 'stopped', { resourceKey: record.resourceKey });
    return true;
  }
  async function prepare(id: string) {
    const record = repo.get(id) ?? checkpointError('Recovery record is unavailable');
    const assertCurrent = () => {
      original(record);
    };
    assertCurrent();
    await mkdir(path.join(deps.root, record.podId), { recursive: true, mode: 0o700 });
    assertCurrent();
    let prepared: PreparedCheckpoint = await (deps.prepare ?? prepareRetainedCheckpointWorkspace)({
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
    const coding = deps.podRepo.retainedCoding?.get(record.id);
    if (coding) {
      prepared = {
        ...prepared,
        baseCommitSha:
          original(record).startCommitSha ??
          checkpointError('Pinned original review base unavailable'),
      };
    }
    if (record.binding.continuation && !record.binding.approvalRewrite && !coding) {
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
    if (record.binding.continuation?.infrastructure && !(await quiesce(record.id))) return;
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
    const infrastructure = record.binding.continuation?.infrastructure;
    if (infrastructure && !repo.get(record.id)?.infrastructure?.stopped)
      checkpointError('Confirmed non-destructive original stop required before activation');
    const atomically =
      deps.podRepo.atomically ?? checkpointError('Managed atomic activation is required');
    atomically(() => {
      const pod = original(record);
      if (selection) repo.select(record.id, selection);
      if (deps.podRepo.retainedCoding?.get(record.id)) deps.beforeCodingActivation?.(pod);
      const generation = deps.podRepo.incrementLifecycleGeneration(record.podId);
      const execution = selection?.execution ?? record.binding.continuation?.execution;
      // Detach only after durable original custody (and confirmed stop for infrastructure recovery); never delete it.
      if (execution) deps.podRepo.update(record.podId, { containerId: null });
      deps.podRepo.update(record.podId, {
        ...(execution ? { executionTarget: execution.target } : {}),
        worktreePath: prepared.worktree,
        recoveryWorktreePath: prepared.worktree,
        containerId: null,
        skipAgent:
          !deps.podRepo.retainedCoding?.get(record.id) && infrastructure?.mode !== 'rework',
        ...(deps.podRepo.retainedCoding?.get(record.id)
          ? {
              taskSummary: null,
              plan: null,
              progress: null,
              readinessReview: null,
              lastRecoveryTrigger: null,
              lastCorrectionMessage: null,
              completedAt: null,
              pauseReason: null,
              reworkReason: null,
              infrastructureFailure: null,
            }
          : {}),
        ...(infrastructure?.mode === 'rework'
          ? {
              reworkReason: `Qualified infrastructure repair of preserved source ${record.binding.head}. Original resource/source/reports remain retained. Work only on this independent checkout within the original task and authority. No publication is authorized.\nDiagnosis: ${infrastructure.qualification}\nOperator-supplied repair context (not passing evidence):\n${infrastructure.instructions?.content ?? ''}`,
              reworkCount: pod.reworkCount + 1,
            }
          : {}),
        autoApprove: false,
        lastValidationResult: null,
        preSubmitReview: null,
        validationWaiver: null,
        failureReason: null,
        ...(record.binding.approvalRewrite || infrastructure
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
      infrastructure?.mode === 'rework' || deps.podRepo.retainedCoding?.get(record.id)
        ? 'Preserved source queued for one owned coding repair, then fresh checks and independent review. Original resource/reports remain retained; no delivery was authorized.'
        : 'Selected retained source queued for fresh checks only. Original resource, execution and reports remain quarantined; no coding worker or delivery was authorized.',
    );
    deps.enqueue(record.podId);
  }
  async function submit(
    podId: string,
    input: CheckpointRecoveryRequest | RetainedContinuationRequest | ApprovalRewriteRepairRequest,
    actor: OperatorActor,
    continuation = false,
    repair?: CheckpointRecoveryBinding['approvalRewrite'],
    infrastructureRequest?: InfrastructureRecoveryRequest,
    codingClaim?: {
      request: unknown;
      requestHash: string;
      binding: CodingBinding;
      assertCurrent(): void;
    },
  ) {
    if (codingClaim && infrastructureRequest)
      checkpointError('Recovery protocols cannot share a coding capability');
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
    const addReview = continuation && !repair;
    const infrastructure = infrastructureRequest
      ? {
          version: 1 as const,
          mode: infrastructureRequest.mode,
          qualification: infrastructureRequest.qualification,
          instructions: infrastructureRequest.instructions,
          originalTree: '',
        }
      : undefined;
    policy(pod, continuation, repair, addReview, infrastructure);
    const containerManager = deps.getContainerManager(pod.executionTarget);
    if (!containerManager.getResourceKey || !deps.worktreeManager.inspectSourceAdoption)
      checkpointError('Exact provider namespace and clean source inspection are required');
    const anchor = configuration(pod);
    const assertCurrent = () => {
      codingClaim?.assertCurrent();
      const current = deps.podRepo.getOrThrow(podId);
      policy(current, continuation, repair, addReview, infrastructure);
      if (
        current.lifecycleGeneration !== input.expectedGeneration ||
        current.containerId !== pod.containerId ||
        current.worktreePath !== pod.worktreePath ||
        repo.selectionEvidence(current)?.expectedResultHash !== input.expectedResultHash ||
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
    if (status !== 'stopped' && !(infrastructure && status === 'running'))
      checkpointError(
        'Only a retained stopped original is eligible; no original wake, stop, clone or deletion is performed',
      );
    const source = await deps.worktreeManager.inspectSourceAdoption(worktreePath, pod.branch);
    const afterSource = replay();
    if (afterSource) return afterSource;
    assertCurrent();
    if (
      !source.worktreeClean ||
      source.commitSha !== input.checkpointHead ||
      source.branch !== pod.branch
    )
      checkpointError('Selected commit must match the clean retained host checkpoint');
    if (infrastructure) {
      deps.podRepo.validationExecutions?.assertResourceUnshared(pod.id, containerId);
      infrastructure.originalTree = source.treeSha;
    }
    if (repair) {
      const rewrite = deps.podRepo.approvalRewrites?.get(repair.id);
      const prepared = rewrite?.prepared ?? checkpointError('Failed candidate source unavailable');
      // Validation promotes pod-owned no-op checkpoints before/after checks.
      // Prove their exact lineage from the frozen rewrite, not tree equality alone.
      const verified = await inspectCheckpointSource({
        podId,
        worktreePath,
        branch: pod.branch,
        head: prepared.head,
        tree: prepared.tree,
        worktreeManager: deps.worktreeManager,
        assertCurrent,
      });
      if (verified.head !== source.commitSha)
        checkpointError('Failed candidate source changed during observation');
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
    }
    const profile = deps.executionForPod(pod);
    if (!profile.repoUrl) checkpointError('Original frozen repository is unavailable');
    assertCheckpointRepository(profile.repoUrl); // Never persist credential-bearing repository URLs.
    let execution: RetainedExecutionSelection | undefined;
    const selection = input as RetainedContinuationRequest;
    if (continuation && selection.executionProfileId) {
      execution = await resolveExecutionSelection(
        pod,
        selection,
        assertCurrent,
        Boolean(codingClaim),
      );
    }
    if (codingClaim) {
      const finalOriginalKey = await containerManager.getResourceKey(containerId);
      const afterKey = replay();
      if (afterKey) return afterKey;
      assertCurrent();
      const finalOriginalStatus = await containerManager.getStatus(containerId);
      const afterStatus = replay();
      if (afterStatus) return afterStatus;
      assertCurrent();
      if (finalOriginalKey !== resourceKey || finalOriginalStatus !== 'stopped')
        checkpointError('Original resource identity/state changed before retained claim');
      const parent = deps.readLaunch?.(podId) ?? checkpointError('Original launch unavailable');
      const replacement = retainedContinuationLaunch(
        parent,
        podId,
        execution ?? checkpointError('Coding replacement required'),
      );
      const settings =
        deps.executionSettings?.(replacement) ??
        checkpointError('Replacement execution settings unavailable');
      assertQualificationExecutionContextSupported(settings);
    }
    const claimed = repo.claim({
      pod,
      taskId: (deps.podRepo.taskExecutions ?? checkpointError('Task ledger unavailable')).snapshot(
        podId,
      ).taskId,
      resourceKey,
      ...(codingClaim
        ? {
            onClaim: () =>
              deps.podRepo.retainedCoding?.claim(
                input.id,
                pod,
                codingClaim.request,
                codingClaim.requestHash,
                codingClaim.binding,
              ),
          }
        : {}),
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
                ...(addReview ? { reviewPolicy: 'independent-v1' as const } : {}),
                ...(infrastructure ? { infrastructure } : {}),
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
    policy(pod, true, undefined, true);
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
    coding = false,
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
    if (coding) assertQualificationExecutionContextSupported(settings);
    return {
      ...execution,
      configurationHash: configuration(
        { ...pod, executionTarget: execution.target, launchConfigDigest: execution.digest },
        settings,
      ),
    };
  }
  async function recoverInfrastructure(
    podId: string,
    input: InfrastructureRecoveryRequest,
    actor: OperatorActor,
  ) {
    const keys = [
      'id',
      'expectedGeneration',
      'expectedResultHash',
      'checkpointHead',
      'reason',
      'mode',
      'qualification',
      'instructions',
      'executionProfileId',
      'expectedExecutionDigest',
    ];
    if (
      Object.keys(input).some((key) => !keys.includes(key)) ||
      !['checks', 'rework'].includes(input.mode) ||
      typeof input.qualification !== 'string' ||
      input.qualification.trim().length < 20 ||
      input.qualification.length > 4000 ||
      (input.mode === 'checks' && input.instructions !== undefined) ||
      (input.mode === 'rework' &&
        (!input.instructions ||
          typeof input.instructions.content !== 'string' ||
          input.instructions.content.trim().length < 10 ||
          Buffer.byteLength(input.instructions.content) > 65536 ||
          Object.keys(input.instructions).sort().join(',') !== 'content,sha256' ||
          createHash('sha256').update(input.instructions.content).digest('hex') !==
            input.instructions.sha256))
    )
      checkpointError(
        'Explicit mode, qualification and exact checksummed credential-free repair instructions required',
      );
    validateExecutionSelection(input);
    const request = infrastructureRequest(input);
    return submit(podId, request, actor, true, undefined, request);
  }
  function infrastructureRequest(
    input: InfrastructureRecoveryRequest,
  ): InfrastructureRecoveryRequest {
    // One wire/facade ordering for durable request identity; context bytes are never normalized.
    return {
      id: input.id,
      expectedGeneration: input.expectedGeneration,
      expectedResultHash: input.expectedResultHash,
      checkpointHead: input.checkpointHead,
      mode: input.mode,
      qualification: input.qualification,
      reason: input.reason.trim(),
      ...(input.instructions
        ? {
            instructions: {
              content: input.instructions.content,
              sha256: input.instructions.sha256,
            },
          }
        : {}),
      ...(input.executionProfileId
        ? {
            executionProfileId: input.executionProfileId,
            expectedExecutionDigest: input.expectedExecutionDigest,
          }
        : {}),
    };
  }
  async function replyToCoding(podId: string, actor: OperatorActor, send: () => Promise<void>) {
    if (actor.type !== 'human' || !actor.userId.trim())
      checkpointError('Authenticated human reply required');
    const store = deps.podRepo.retainedCoding ?? checkpointError('Coding custody unavailable');
    const pod = deps.podRepo.getOrThrow(podId);
    const record =
      store.workerDecision(pod) ??
      checkpointError('Only the live typed worker pending question may be answered');
    const root = repo.get(record.id) ?? checkpointError('Coding root unavailable');
    const question = checkpointHash(pod.pendingEscalation);
    const assertCurrent = () => {
      const current = deps.podRepo.getOrThrow(podId);
      const decision = store.workerDecision(current);
      if (
        decision?.id !== record.id ||
        checkpointHash(current.pendingEscalation) !== question ||
        !deps.isCodingWorkerActive?.(podId, record.facts.worker!.runId) ||
        configuration(current) !== root.binding.continuation?.execution?.configurationHash ||
        store.reports(podId, root.generation).hash !== record.binding.reportSetHash ||
        deps.podRepo.hasInfrastructureBlocker?.(podId)
      )
        checkpointError('Typed worker question ownership changed before reply');
    };
    assertCurrent();
    // This is the typed worker's own scope, never infrastructure stop/Rework
    // authority. No qualification TTL is re-applied after worker admission.
    return repo.owned(record.id, () =>
      store.owned(record.id, () => {
        repo.assertAvailable(podId);
        store.assertOwned(podId);
        assertCurrent();
        return send();
      }),
    );
  }
  async function replyToRepair(podId: string, actor: OperatorActor, send: () => Promise<void>) {
    if (actor.type !== 'human' || !actor.userId.trim())
      checkpointError('Authenticated human reply required');
    const pod = deps.podRepo.getOrThrow(podId);
    const record =
      repo.repairDecision(pod) ??
      checkpointError('Only the retained repair worker pending question may be answered');
    if (
      configuration(pod) !==
      (record.binding.continuation?.execution?.configurationHash ??
        record.binding.configurationHash)
    )
      checkpointError('Repair execution configuration changed before reply');
    // A reply is guidance custody, never permission to resume a dead run, extend budgets,
    // answer credential/override decisions, or create another coding worker.
    return repo.owned(record.id, () => {
      repo.assertAvailable(podId);
      const current = deps.podRepo.getOrThrow(podId);
      if (
        repo.repairDecision(current)?.id !== record.id ||
        current.pendingEscalation?.id !== pod.pendingEscalation?.id
      )
        checkpointError('Repair question ownership changed before reply');
      return send();
    });
  }
  async function reconcileInfrastructure(
    podId: string,
    input: InfrastructureRecoveryRequest,
    actor: OperatorActor,
  ) {
    const record = repo.get(input.id) ?? checkpointError('Recovery unavailable');
    if (
      record.podId !== podId ||
      !record.binding.continuation?.infrastructure ||
      record.requestHash !== checkpointHash([podId, infrastructureRequest(input), actor])
    )
      checkpointError('Reconciliation requires the exact original request and authenticated actor');
    if (record.activated || record.checked || record.blocked) return record;
    if (pending.has(input.id)) return record;
    if (!record.prepared)
      checkpointError('Source preparation is incomplete; do not replay unknown preparation');
    const existing = reconciliations.get(record.id);
    if (existing) return existing;
    const run = repo
      .owned(record.id, async () => {
        if (await quiesce(record.id))
          activate(repo.get(record.id) ?? checkpointError('Recovery unavailable'));
        return repo.get(record.id) ?? checkpointError('Recovery unavailable');
      })
      .finally(() => reconciliations.delete(record.id));
    reconciliations.set(record.id, run);
    return run;
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
        record.actor.type !== 'human' ||
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
      (deps.podRepo.retainedCoding?.get(record.id) ||
      record.binding.continuation?.infrastructure?.mode === 'rework'
        ? pod.skipAgent
        : !pod.skipAgent) ||
      pod.lifecycleGeneration !== record.activated.generation ||
      pod.worktreePath !== record.prepared.worktree ||
      pod.containerId !== null
    )
      checkpointError('Checkpoint execution is not eligible for fresh queue dispatch');
    const generation = record.activated.generation;
    const coding = deps.podRepo.retainedCoding?.get(record.id);
    const execution = repo
      .owned(record.id, async () => {
        if (coding)
          deps.podRepo.retainedCoding!.enter(record.id, repo.providerIdentity(podId, generation));
        else repo.append(record.id, 'checking', { generation });
        try {
          repo.assertAvailable(podId);
          await verifySource(podId);
          if (coding) await deps.podRepo.retainedCoding!.owned(record.id, run);
          else await run();
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
              ...(record.binding.approvalRewrite || record.binding.continuation?.infrastructure
                ? { source: checkedSource }
                : {}),
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
      const worker = repo.get(record.id)?.infrastructure?.worker;
      if (
        (worker &&
          (current.containerId !== worker.containerId ||
            current.lifecycleGeneration !== worker.generation)) ||
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
    const final = deps.podRepo.retainedCoding?.finalSource(podId, record.activated.generation);
    if (final) {
      await verifyArtifactSnapshot(
        final.snapshot,
        path.dirname(final.snapshot),
        final.generation,
        final.cycle,
        final.reportsHash,
      );
      assertCurrent();
    }
    if (record.binding.approvalRewrite)
      await assertApprovalRepairStorage(record.prepared, record.binding.repository, assertCurrent, {
        generation: record.generation,
        cycle: record.binding.cycle,
      });
    assertCurrent();
    if (
      record.binding.continuation?.infrastructure?.mode === 'rework' &&
      record.infrastructure?.worker &&
      !record.infrastructure.candidate
    ) {
      deps.podRepo.taskExecutions?.assertCanDelete(podId);
      deps.assertGuidanceCollected(podId);
      const source = await deps.worktreeManager.inspectSourceAdoption(
        record.prepared.worktree,
        record.binding.branch,
      );
      assertCurrent();
      if (!source.worktreeClean || source.branch !== record.binding.branch)
        checkpointError('Repair candidate must be clean and committed');
      const ancestry =
        deps.worktreeManager.assertSourceDescendsFrom ??
        checkpointError('Repair ancestry proof unavailable');
      await ancestry.call(deps.worktreeManager, record.prepared.worktree, record.prepared.head);
      assertCurrent();
      const after = await deps.worktreeManager.inspectSourceAdoption(
        record.prepared.worktree,
        record.binding.branch,
      );
      assertCurrent();
      if (checkpointHash(source) !== checkpointHash(after))
        checkpointError('Repair candidate changed during capture');
      repo.freezeRepairCandidate(record.id, { head: source.commitSha, tree: source.treeSha });
    }
    const candidate = repo.get(record.id)?.infrastructure?.candidate;
    return inspectCheckpointSource({
      podId,
      worktreePath: record.prepared.worktree,
      branch: record.binding.branch,
      head: final?.head ?? candidate?.head ?? record.selected?.head ?? record.prepared.head,
      tree: final?.tree ?? candidate?.tree ?? record.selected?.tree ?? record.prepared.tree,
      worktreeManager: deps.worktreeManager,
      assertCurrent,
    });
  }
  const repair = deps.podRepo.retainedCoding
    ? createRepairContinuation({
        ...deps,
        assertPolicy: (podId) => {
          if (!deps.qualifyCoding || !deps.beforeCodingActivation)
            checkpointError('Repair execution integration unavailable');
          policy(deps.podRepo.getOrThrow(podId), true);
        },
        selection: (podId) => repo.selectionEvidence(deps.podRepo.getOrThrow(podId)),
        previewExecution,
        submitCoding: (podId, input, actor, claim) =>
          submit(podId, input, actor, true, undefined, undefined, claim),
        qualify:
          deps.qualifyCoding ?? (() => checkpointError('Actual-resource qualifier unavailable')),
      })
    : undefined;
  return {
    repair,
    isActive: (podId: string) =>
      executions.has(podId) ||
      [...pending.keys(), ...reconciliations.keys()].some((id) => repo.get(id)?.podId === podId),
    submit,
    prepareRewriteRepair,
    checkRewriteRepair,
    continueRetained,
    recoverInfrastructure,
    reconcileInfrastructure,
    replyToRepair,
    replyToCoding,
    previewExecution,
    checkCandidate,
    process,
    verifySource,
    reconcileOutcome,
    inspect,
    selection: (podId: string) => repo.selectionEvidence(deps.podRepo.getOrThrow(podId)),
    list: (podId: string) => repo.list(podId),
    wait: (id: string) => pending.get(id) ?? Promise.resolve(),
  };
}
