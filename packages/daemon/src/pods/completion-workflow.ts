import { AutopodError } from '@autopod/shared';
import { createCompletionDecision } from './completion-decision.js';
import { createCompletionHumanGate } from './completion-human-gate.js';
import type {
  CompletionCalls,
  CompletionLiveDependencies,
  CompletionWorkflowCaptured,
} from './completion-ports.js';
import type { CompletionOwnersCaptured } from './completion-ports.js';
import { createCompletionSource } from './completion-source.js';
import { REWORK_IN_PROGRESS_PREFIX } from './continuation-policy.js';
import { isTerminalState } from './state-machine.js';
import { getPodValidationSuite, isPodValidationDisabled } from './validation-workflow-policy.js';

export function createCompletionOwners(captured: CompletionOwnersCaptured) {
  const {
    podRepo,
    nudgeRepo,
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
  return { handleCompletion };
}
