import { AutopodError } from '@autopod/shared';
import { createCompletionDecision } from './completion-decision.js';
import { createCompletionHumanGate } from './completion-human-gate.js';
import type {
  CompletionCalls,
  CompletionLiveDependencies,
  CompletionOwnersCaptured,
  CompletionWorkflowCaptured,
} from './completion-ports.js';
import { createCompletionSource } from './completion-source.js';
import { REWORK_IN_PROGRESS_PREFIX } from './continuation-policy.js';
import { isTerminalState } from './state-machine.js';
import { assertValidationMutationSettled } from './validation-recovery-policy.js';
import { getPodValidationSuite, isPodValidationDisabled } from './validation-workflow-policy.js';

export function createCompletionOwners(captured: CompletionOwnersCaptured) {
  const {
    podRepo,
    nudgeRepo,
    escalationRepo,
    preservePodWorkspace,
    ownsArtifactCompletion,
    transition,
    logger,
    emitActivityStatus,
    containerManagerFactory,
    worktreeManager,
    checkpointSandboxWorkspaceForPod,
    syncSandboxSeriesHandover,
    syncWorkspaceBack,
    tryRecoverAfterWorkspaceSyncFailure,
    recoverWorktreeFromContainer,
    parkOnWorktreeSyncFailure,
    handleDeletionGuardError,
    executionForPod,
    cleanupContainer,
    emitPodCompletedEvent,
    maybeTriggerDependents,
  } = captured;

  const { holdCompletionForHumanWork } = createCompletionHumanGate({
    podRepo,
    nudgeRepo,
    escalationRepo,
    preservePodWorkspace,
    ownsArtifactCompletion,
    transition,
    logger,
    emitActivityStatus,
  });

  const { prepareSourceForCompletion } = createCompletionSource({
    podRepo,
    getContainerManager: (target) => containerManagerFactory.get(target),
    worktreeManager,
    checkpointSandboxWorkspaceForPod,
    syncSandboxSeriesHandover,
    syncWorkspaceBack,
    tryRecoverAfterWorkspaceSyncFailure,
    recoverWorktreeFromContainer,
    parkOnWorktreeSyncFailure,
    handleDeletionGuardError,
    transition,
    executionForPod,
    emitActivityStatus,
    logger,
  });

  const { applyCompletionDecision } = createCompletionDecision({
    podRepo,
    executionForPod,
    isPodValidationDisabled,
    getPodValidationSuite,
    reworkInProgressPrefix: REWORK_IN_PROGRESS_PREFIX,
    cleanupContainer,
    transition,
    emitPodCompletedEvent,
    maybeTriggerDependents,
    emitActivityStatus,
    logger,
  });
  return { holdCompletionForHumanWork, prepareSourceForCompletion, applyCompletionDecision };
}

export function createCompletionWorkflow(
  deps: CompletionLiveDependencies,
  captured: CompletionWorkflowCaptured,
) {
  const {
    podRepo,
    holdCompletionForHumanWork,
    artifactCompletionRuns,
    finalizeArtifactPod,
    prepareSourceForCompletion,
    applyCompletionDecision,
  } = captured;

  async function handleCompletion(this: CompletionCalls, podId: string): Promise<void> {
    const pod = podRepo.getOrThrow(podId);
    if (deps.launchConfiguration?.read(podId)?.intent === 'goal') {
      const goal = deps.launchConfiguration.goals?.get(podId);
      if (goal?.state !== 'achieved' || !goal.executionStopped)
        throw new AutopodError(
          'Native Goal achievement and confirmed termination are required before completion',
          'GOAL_NOT_ACHIEVED',
          409,
        );
    }
    if (pod.completionPolicy === 'accept-findings') {
      const config = deps.launchConfiguration?.read(podId);
      if (
        !config ||
        config.digest !== pod.launchConfigDigest ||
        config.workflow.completion !== 'accept-findings' ||
        config.intent !== 'task' ||
        config.workflow.agentMode !== 'auto' ||
        !['artifact', 'none'].includes(config.workflow.output) ||
        config.workflow.validationPhases.length > 0
      )
        throw new AutopodError(
          'Frozen findings contract is unavailable or incompatible',
          'FINDINGS_CONTRACT_INVALID',
          409,
        );
    }
    // Bail out if pod is already past the running stage (could happen when
    // processPod's spawn unblocks after sendMessage already drove completion)
    if (
      isTerminalState(pod.status) ||
      pod.status === 'killing' ||
      pod.status === 'paused' ||
      pod.status === 'validating' ||
      pod.status === 'validated' ||
      pod.status === 'research_ready' ||
      pod.status === 'failed' ||
      pod.status === 'review_required'
    ) {
      return;
    }

    const heldCompletion = holdCompletionForHumanWork(pod);
    if (heldCompletion) {
      await heldCompletion;
      return;
    }

    if (pod.options.output === 'artifact' || pod.completionPolicy === 'accept-findings') {
      const key = `${pod.id}:${pod.lifecycleGeneration}:${pod.finalization?.cycle ?? 0}`;
      const pending = artifactCompletionRuns.get(key);
      if (pending) return pending;
      const completion = Promise.resolve().then(() => finalizeArtifactPod(pod));
      artifactCompletionRuns.set(key, completion);
      try {
        await completion;
      } finally {
        if (artifactCompletionRuns.get(key) === completion) artifactCompletionRuns.delete(key);
      }
      return;
    }
    const preparedSource = await prepareSourceForCompletion(pod);
    if (!preparedSource) return;
    await applyCompletionDecision(pod, preparedSource, (id) => this.triggerValidation(id));
  }
  const infrastructureCompletions = new Map<string, Promise<void>>();
  /** Restart can finish an already-settled block, never manufacture termination or dispatch. */
  async function reconcileInfrastructureBlocker(podId: string): Promise<void> {
    const pod = podRepo.getOrThrow(podId);
    const cycle = pod.finalization?.cycle;
    if (
      (pod.status !== 'running' && pod.status !== 'awaiting_input') ||
      !podRepo.hasInfrastructureBlocker?.(podId) ||
      cycle === undefined ||
      !podRepo.taskExecutions?.hasSettledRun?.(pod, cycle)
    )
      return;
    assertValidationMutationSettled(podRepo, podId);
    podRepo.taskExecutions.assertCanDelete(podId);
    if (!podRepo.deletionOwnership) throw new Error('Cleanup ownership evidence unavailable');
    podRepo.deletionOwnership.assertTaskAvailable(podId);
    // Deliberately avoid general completion: this can only preserve/park existing
    // human or infrastructure work, not validate, publish or collect artifacts.
    const key = JSON.stringify([
      podId,
      pod.lifecycleGeneration,
      cycle,
      pod.containerId,
      pod.executionTarget,
    ]);
    const pending = infrastructureCompletions.get(key);
    if (pending) {
      await pending;
      const current = podRepo.getOrThrow(podId);
      // A reply can replace the pending question while its capture is in flight.
      // Coalesce the capture, not the newly required blocked/guidance transition.
      if (
        current.lifecycleGeneration === pod.lifecycleGeneration &&
        current.finalization?.cycle === cycle &&
        current.containerId === pod.containerId &&
        current.executionTarget === pod.executionTarget &&
        current.status === 'running' &&
        current.pendingEscalation === null
      )
        await reconcileInfrastructureBlocker(podId);
      return;
    }
    const completion = Promise.resolve().then(async () => {
      await holdCompletionForHumanWork(pod);
    });
    infrastructureCompletions.set(key, completion);
    try {
      await completion;
    } finally {
      if (infrastructureCompletions.get(key) === completion) infrastructureCompletions.delete(key);
    }
  }
  return { handleCompletion, reconcileInfrastructureBlocker };
}
