import type { OperatorActor } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import { deriveAgentAttempt } from './agent-execution-policy.js';
import { actorLabel } from './approval-policy.js';
import { REWORK_IN_PROGRESS_PREFIX } from './continuation-policy.js';
import { AgentContinuationSupersededError } from './continuation-preflight.js';
import { formatFeedback } from './feedback-formatter.js';
import type { OperatorRejectionCalls, OperatorRejectionCaptured } from './operator-contracts.js';
import { isTerminalState } from './state-machine.js';
export function createOperatorRejection(captured: OperatorRejectionCaptured) {
  const {
    podRepo,
    beginGoalTaskRework,
    emitActivityStatus,
    transition,
    containerManagerFactory,
    logger,
    taskFeedbackEvents,
    persistRuntimeCredentialsForPod,
  } = captured;
  async function rejectSession(
    this: OperatorRejectionCalls,
    podId: string,
    reason?: string,
    actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
  ): Promise<void> {
    const pod = podRepo.getOrThrow(podId);

    const rejectableStates = ['validated', 'failed', 'review_required'] as const;
    if (!(rejectableStates as readonly string[]).includes(pod.status)) {
      throw new AutopodError(
        `Cannot reject pod ${podId} in status ${pod.status}`,
        'INVALID_STATE',
        409,
      );
    }

    const goalRework = await beginGoalTaskRework(
      pod,
      `Address human feedback after Goal achievement: ${reason ?? 'Changes rejected. Please try again.'}`,
    );
    const previousStatus = pod.status as 'validated' | 'failed' | 'review_required';

    emitActivityStatus(
      podId,
      reason
        ? `Rejected by ${actorLabel(actor)}: ${reason}`
        : `Rejected by ${actorLabel(actor)} — resuming agent…`,
    );

    // Reset validation attempts — human is giving a fresh chance
    podRepo.update(podId, {
      validationAttempts: 0,
      lastValidationResult: null,
      lastCorrectionMessage: [
        REWORK_IN_PROGRESS_PREFIX,
        reason ? `${actorLabel(actor)} rejection: ${reason}` : `${actorLabel(actor)} rejection`,
      ].join(' '),
    });

    // Build rejection feedback message for the agent
    const rejectionMessage = formatFeedback({
      type: 'human_rejection',
      feedback: reason ?? 'Changes rejected. Please try again.',
      task: pod.task,
      previousStatus,
      attempt: 0,
      maxAttempts: pod.maxValidationAttempts,
    });

    // Transition to running
    transition(pod, 'running');

    try {
      if (!pod.containerId) throw new Error(`Pod ${podId} has no container`);

      // Container is stopped post-validation — restart it before resuming the agent
      const cm = containerManagerFactory.get(pod.executionTarget);
      await cm.start(pod.containerId);
      logger.info(
        { podId, containerId: pod.containerId },
        'Container restarted for rejection retry',
      );
      if (pod.executionTarget === 'local') {
        await this.refreshNetworkPolicy(pod.profileName);
      }

      // Resume agent with rejection feedback
      const events = await taskFeedbackEvents(podId, rejectionMessage, goalRework);
      const outcome = await this.consumeAgentEvents(
        podId,
        events,
        deriveAgentAttempt(pod.phaseTokenUsage),
      );
      if (outcome === 'stopped') return;
      await persistRuntimeCredentialsForPod(
        podId,
        'Failed to persist rotated credentials after rejection resume',
      );
      if (outcome === 'completed') {
        await this.handleCompletion(podId);
      }
    } catch (err) {
      // Roll back to failed — don't leave the pod stuck in 'running' with no agent
      if (err instanceof AgentContinuationSupersededError) throw err;
      logger.error({ err, podId }, 'Failed to resume agent after rejection');
      const s = podRepo.getOrThrow(podId);
      if (!isTerminalState(s.status)) {
        transition(s, 'failed');
        emitActivityStatus(
          podId,
          `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      throw err;
    }

    logger.info({ podId, reason, previousStatus }, 'Pod rejected, resuming agent with feedback');
  }
  return { rejectSession };
}
