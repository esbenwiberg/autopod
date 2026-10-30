import path from 'node:path';
import { AutopodError } from '@autopod/shared';
import { atomicPodChange } from '../db/unit-of-work.js';
import { hasInterruptedArtifactCollection } from './artifact-finalization-recovery.js';
import { verifyArtifactSnapshot } from './artifact-snapshot-receipt.js';
import type {
  ContinuationCaptured,
  ContinuationLiveDependencies,
  ContinuationResumeCalls,
} from './continuation-ports.js';
import { sandboxStartupRetryInput } from './sandbox-startup-admission.js';
import { isReviewInfrastructureOnlyFailure } from './validation-infrastructure.js';
import {
  assertFailedValidationRecoverable,
  assertValidationExecutionSettled,
} from './validation-recovery-policy.js';
import {
  WORKER_RETRY_BACKOFFS_MS,
  unavailableWorkerInputs,
  workerBindingHash,
} from './worker-retry-history.js';

type Captured = Pick<
  ContinuationCaptured,
  | 'podRepo'
  | 'containerManagerFactory'
  | 'enqueueSession'
  | 'logger'
  | 'assertExecutionTerminationVerified'
  | 'assertGuidanceCollected'
  | 'hasDurableAgentExecutionEvidence'
  | 'infrastructureResumeRuns'
  | 'artifactResumeRuns'
  | 'activeAgentRuns'
  | 'resolveEffectiveBoundProfile'
  | 'ownsLifecycle'
  | 'isRetryableFixDeliveryFailure'
  | 'completeFixPodAfterPush'
  | 'emitActivityStatus'
  | 'pushAndCreatePr'
  | 'transition'
>;

export function createContinuationControls(deps: ContinuationLiveDependencies, captured: Captured) {
  const {
    podRepo,
    containerManagerFactory,
    enqueueSession,
    logger,
    assertExecutionTerminationVerified,
    assertGuidanceCollected,
    hasDurableAgentExecutionEvidence,
    infrastructureResumeRuns,
    artifactResumeRuns,
    activeAgentRuns,
    resolveEffectiveBoundProfile,
    ownsLifecycle,
    isRetryableFixDeliveryFailure,
    completeFixPodAfterPush,
    emitActivityStatus,
    pushAndCreatePr,
    transition,
  } = captured;

  async function resumeNativeGoal(podId: string, revision: number): Promise<void> {
    assertExecutionTerminationVerified(podId);
    const config = deps.launchConfiguration?.read(podId);
    const goals = deps.launchConfiguration?.goals;
    const pod = podRepo.getOrThrow(podId);
    if (
      !config ||
      config.intent !== 'goal' ||
      !goals ||
      !['paused', 'failed'].includes(pod.status) ||
      !pod.worktreePath ||
      pod.worktreeCompromised ||
      pod.pendingEscalation ||
      activeAgentRuns.has(podId)
    )
      throw new AutopodError(
        'Native Goal cannot resume in the current pod state',
        'GOAL_RESUME_UNAVAILABLE',
        409,
      );
    await deps.launchConfiguration?.assertCurrentCapabilities(config);
    atomicPodChange(podRepo, () => {
      const current = podRepo.getOrThrow(podId);
      if (current.lifecycleGeneration !== pod.lifecycleGeneration || current.status !== pod.status)
        throw new AutopodError('Pod changed before native Goal resume', 'GOAL_SUPERSEDED', 409);
      const usage = podRepo.taskExecutions?.snapshot(podId);
      if (
        !usage ||
        usage.budgetCheck?.status === 'unavailable' ||
        usage.budgetCheck?.status === 'exhausted'
      )
        throw new AutopodError(
          'Reconcile or extend the task budget before resuming',
          'GOAL_BUDGET_UNAVAILABLE',
          409,
        );
      goals.prepareResume(podId, revision);
      podRepo.incrementLifecycleGeneration(podId);
      transition(podRepo.getOrThrow(podId), 'queued', {
        recoveryWorktreePath: pod.worktreePath,
        failureReason: null,
        completedAt: null,
        pauseReason: null,
        skipAgent: false,
      });
      if (podRepo.afterCommit) podRepo.afterCommit(() => enqueueSession(podId));
      else enqueueSession(podId);
    });
  }

  function assertCanRetryValidation(podId: string): void {
    assertExecutionTerminationVerified(podId);
    assertGuidanceCollected(podId);
    const pod = podRepo.getOrThrow(podId);
    assertFailedValidationRecoverable(pod, podRepo.validationExecutions?.isSettled(pod));
    if (!pod.containerId)
      throw new AutopodError(
        'Retained validation resource is unavailable. Restore it or request Fix validation.',
        'VALIDATION_RESOURCE_UNAVAILABLE',
        409,
      );
    if (podRepo.taskExecutions?.hasActiveRun(podId))
      throw new AutopodError(
        'A worker is still settling; wait for its recorded termination.',
        'TASK_AGENT_RUN_ACTIVE',
        409,
      );
    if (deps.launchConfiguration?.read(podId)?.intent === 'goal') {
      const goal = deps.launchConfiguration.goals?.get(podId);
      if (goal?.state !== 'achieved' || !goal.executionStopped)
        throw new AutopodError(
          'Use the revision-bound native Goal controls.',
          'GOAL_NATIVE_RESUME_REQUIRED',
          409,
        );
    }
  }

  function assertCanRework(podId: string): void {
    assertExecutionTerminationVerified(podId);
    const pod = podRepo.getOrThrow(podId);
    assertValidationExecutionSettled(pod, podRepo.validationExecutions?.isSettled(pod));
    if (deps.launchConfiguration?.read(podId)?.intent === 'goal') {
      const goal = deps.launchConfiguration.goals?.get(podId);
      if (goal?.state !== 'achieved' || !goal.executionStopped)
        throw new AutopodError(
          'Use native Goal controls until the objective is achieved',
          'GOAL_NATIVE_RESUME_REQUIRED',
          409,
        );
    }
    if (pod.options.agentMode === 'interactive') return;
    const retries = podRepo.workerRetries;
    if (!retries?.state(podId).retryFailure) return;
    const profile = resolveEffectiveBoundProfile(pod);
    retries.assertCanAdmit(
      podId,
      pod.lifecycleGeneration,
      unavailableWorkerInputs,
      workerBindingHash({
        runtime: pod.runtime,
        model: pod.model,
        providerAccountId: profile.providerAccountId ?? null,
      }),
      [...(deps.workerInfrastructureRetryBackoffMs ?? WORKER_RETRY_BACKOFFS_MS)],
    );
  }

  async function resumePod(
    this: Pick<
      ContinuationResumeCalls,
      'handleCompletion' | 'revalidateSession' | 'approveSession'
    >,
    podId: string,
  ): Promise<{
    action: 'retry-pr' | 'revalidate' | 'retry-fix-delivery' | 'retry-agent' | 'collect-artifacts';
  }> {
    if (deps.launchConfiguration?.read(podId)?.intent === 'goal') {
      const goal = deps.launchConfiguration.goals?.get(podId);
      if (goal?.state !== 'achieved' || !goal.executionStopped)
        throw new AutopodError(
          'Use the revision-bound native Goal resume control',
          'GOAL_NATIVE_RESUME_REQUIRED',
          409,
        );
    }
    assertExecutionTerminationVerified(podId);
    assertGuidanceCollected(podId);
    const pendingCollection = artifactResumeRuns.get(podId);
    if (pendingCollection) {
      await pendingCollection;
      return { action: 'collect-artifacts' };
    }
    const pod = podRepo.getOrThrow(podId);
    if (pod.status === 'failed' && hasInterruptedArtifactCollection(pod)) {
      if (!pod.finalization?.sourcePreservedAt && !pod.containerId)
        throw new AutopodError(
          'Artifact source container is unavailable. Restore the preserved source before retrying collection.',
          'ARTIFACT_SOURCE_UNAVAILABLE',
          409,
        );
      const collection = Promise.resolve().then(async () => {
        if (pod.finalization?.sourcePreservedAt) {
          const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), '.autopod-data');
          await verifyArtifactSnapshot(
            pod.artifactsPath ?? '',
            path.join(dataDir, 'artifacts', pod.id),
            pod.lifecycleGeneration,
            pod.finalization.cycle,
          );
        }
        const current = podRepo.getOrThrow(podId);
        if (
          !ownsLifecycle(podId, pod.lifecycleGeneration, pod.containerId) ||
          current.status !== 'failed' ||
          current.pendingEscalation
        )
          throw new AutopodError(
            'Artifact retry was superseded; current lifecycle retained.',
            'STALE_ARTIFACT_COLLECTION',
            409,
          );
        transition(current, 'running', { failureReason: null });
        emitActivityStatus(podId, 'Resume: retrying artifact collection from the settled worker…');
        await this.handleCompletion(podId);
        const collected = podRepo.getOrThrow(podId);
        if (
          collected.lifecycleGeneration === pod.lifecycleGeneration &&
          collected.status === 'failed' &&
          !collected.finalization?.sourcePreservedAt
        )
          throw new AutopodError(
            collected.failureReason ?? 'Artifact preservation failed. Original container retained.',
            'ARTIFACT_PRESERVATION_FAILED',
            502,
          );
        if (
          collected.lifecycleGeneration !== pod.lifecycleGeneration ||
          collected.status !== 'complete'
        )
          throw new AutopodError(
            'Artifact completion remains unresolved. Refresh the pod and reconcile its current lifecycle.',
            'ARTIFACT_COMPLETION_UNRESOLVED',
            409,
          );
      });
      artifactResumeRuns.set(podId, collection);
      try {
        await collection;
      } finally {
        artifactResumeRuns.delete(podId);
      }
      return { action: 'collect-artifacts' };
    }
    if (isRetryableFixDeliveryFailure(pod)) {
      if (!pod.worktreePath) {
        throw new AutopodError(
          `Pod ${podId} has no worktree — cannot retry fix delivery`,
          'INVALID_STATE',
          409,
        );
      }
      if (pod.worktreeCompromised) {
        throw new AutopodError(
          `Pod ${podId} worktree is marked compromised — recover the worktree before retrying fix delivery`,
          'WORKTREE_COMPROMISED',
          409,
        );
      }

      const validated = transition(pod, 'validated', { mergeBlockReason: null });
      emitActivityStatus(podId, 'Resume: retrying validated fix delivery…');
      await completeFixPodAfterPush(validated);
      return { action: 'retry-fix-delivery' };
    }

    const lastValidationResult = pod.lastValidationResult;
    const isInfrastructureReviewResume =
      pod.status === 'review_required' &&
      lastValidationResult !== null &&
      (lastValidationResult.infrastructureFailure !== undefined ||
        isReviewInfrastructureOnlyFailure(lastValidationResult));
    const hasSettledRetryFailure =
      pod.status === 'review_required' &&
      podRepo.taskRetries?.state(podId).latest?.outcome != null &&
      podRepo.taskRetries?.state(podId).latest?.outcome !== 'pass';
    if (pod.status !== 'failed' && !isInfrastructureReviewResume && !hasSettledRetryFailure) {
      throw new AutopodError(
        `Cannot resume pod ${podId} in status ${pod.status} — only failed pods or review_required pods with a recorded validation failure can be resumed`,
        'INVALID_STATE',
        409,
      );
    }
    if (isInfrastructureReviewResume && infrastructureResumeRuns.has(podId)) {
      logger.info({ podId }, 'Coalesced duplicate validation infrastructure Resume');
      return { action: 'revalidate' };
    }
    if (pod.executionTarget === 'sandbox' && podRepo.sandboxStartupRetries) {
      const latest = podRepo.sandboxStartupRetries.state(podId).latest;
      if (latest && latest.outcome !== 'pass') {
        const input = sandboxStartupRetryInput(pod);
        podRepo.sandboxStartupRetries.assertCanAdmit(
          podId,
          pod.lifecycleGeneration,
          input.identity,
          input.bindingHash,
          [...(deps.sandboxInfrastructureRetryBackoffMs ?? [30_000])],
        );
      }
    }
    if (!pod.worktreePath) {
      throw new AutopodError(`Pod ${podId} has no worktree — cannot resume`, 'INVALID_STATE', 409);
    }
    if (pod.worktreeCompromised) {
      throw new AutopodError(
        `Pod ${podId} worktree is marked compromised — recover the worktree before resuming`,
        'WORKTREE_COMPROMISED',
        409,
      );
    }

    const isAzureSandboxInfrastructureFailure =
      pod.status === 'failed' &&
      pod.executionTarget === 'sandbox' &&
      pod.infrastructureFailure?.source === 'azure-sandbox' &&
      pod.infrastructureFailure.code === 'AZURE_SANDBOX_TRANSIENT_FORBIDDEN' &&
      pod.infrastructureFailure.safeAgentRestart;
    const isSafeValidationOnlyInfrastructureResume =
      isAzureSandboxInfrastructureFailure && pod.skipAgent && pod.worktreePath !== null;
    const isSafeAgentInfrastructureResume =
      isAzureSandboxInfrastructureFailure &&
      pod.lastValidationResult === null &&
      pod.taskSummary === null &&
      pod.prUrl === null &&
      !hasDurableAgentExecutionEvidence(pod);
    const isSafeSandboxInfrastructureResume =
      isSafeValidationOnlyInfrastructureResume || isSafeAgentInfrastructureResume;
    if (isSafeSandboxInfrastructureResume) {
      const generation = podRepo.incrementLifecycleGeneration(podId);
      const oldContainerId = pod.containerId;
      if (oldContainerId) {
        try {
          await containerManagerFactory.get('sandbox').kill(oldContainerId);
        } catch (err) {
          throw new AutopodError(
            `Cannot prove old Azure sandbox deletion before Resume: ${err instanceof Error ? err.message : String(err)}`,
            'SANDBOX_CLEANUP_UNCONFIRMED',
            409,
          );
        }
      }
      const current = podRepo.getOrThrow(podId);
      if (current.lifecycleGeneration !== generation || current.containerId !== oldContainerId) {
        throw new AutopodError(
          'Resume was superseded by another lifecycle operation',
          'INVALID_STATE',
          409,
        );
      }
      podRepo.update(podId, {
        status: 'queued',
        containerId: null,
        recoveryWorktreePath: current.worktreePath,
        claudeSessionId: null,
        codexSessionId: null,
        piSessionId: null,
        infrastructureFailure: {
          ...pod.infrastructureFailure,
          recoveryDisposition: 'automatic_retry_scheduled',
          retryNotBefore: null,
        },
        infrastructureRecoveryCount: pod.infrastructureRecoveryCount,
        failureReason: null,
        completedAt: null,
        skipAgent: isSafeValidationOnlyInfrastructureResume,
      });
      emitActivityStatus(
        podId,
        isSafeValidationOnlyInfrastructureResume
          ? 'Resume accepted — retrying validation only in a fresh Azure sandbox.'
          : 'Resume accepted — restarting the original agent task in a fresh Azure sandbox.',
      );
      enqueueSession(podId);
      return { action: 'retry-agent' };
    }

    if (isInfrastructureReviewResume) {
      emitActivityStatus(podId, 'Resume accepted — re-running validation without agent rework');
      const recovery = this.revalidateSession(podId, { force: true })
        .catch((err: unknown) => {
          logger.warn({ err, podId }, 'Validation infrastructure Resume failed after acceptance');
          emitActivityStatus(
            podId,
            `Validation Resume failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(() => {
          infrastructureResumeRuns.delete(podId);
        });
      infrastructureResumeRuns.set(podId, recovery);
      void recovery;
      return { action: 'revalidate' };
    }

    // Path 1: validation already passed, downstream step (push / PR) blew up.
    // Push + open PR, no agent rework, no validation rerun. Cheapest possible recovery.
    if (pod.lastValidationResult?.overall === 'pass' && !pod.prUrl) {
      emitActivityStatus(podId, 'Resume: pushing branch + opening PR…');
      const newPrUrl = await pushAndCreatePr(pod, 'resume');
      // Transition the pod from `failed → validated` so it rejoins the normal
      // approval flow. The validation result on the pod is already the passing
      // one captured pre-push; no need to overwrite it.
      const refreshed = podRepo.getOrThrow(podId);
      const validated = transition(refreshed, 'validated', { prUrl: newPrUrl });
      emitActivityStatus(podId, `Resume succeeded — PR ready: ${newPrUrl}`);
      logger.info({ podId, prUrl: newPrUrl }, 'Pod resumed via push + PR');
      if (validated.autoApprove) {
        emitActivityStatus(podId, 'Auto-approving…');
        setImmediate(() => {
          this.approveSession(podId, { automation: true }).catch((err) =>
            logger.warn({ err, podId }, 'Auto-approve failed after resume'),
          );
        });
      }
      return { action: 'retry-pr' };
    }

    // Path 2: validation didn't pass (or never ran). Re-run validation only —
    // no agent rework. force=true skips the no-new-commits gate so a Resume
    // works even when the worktree wasn't touched between attempts.
    if (pod.prUrl) {
      emitActivityStatus(podId, 'Resume: PR already exists — re-running validation only');
    } else {
      emitActivityStatus(podId, 'Resume: re-running validation (no agent rework)');
    }
    await this.revalidateSession(podId, { force: true });
    return { action: 'revalidate' };
  }

  return { resumeNativeGoal, assertCanRework, assertCanRetryValidation, resumePod };
}
