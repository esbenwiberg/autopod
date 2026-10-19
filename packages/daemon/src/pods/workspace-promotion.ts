import type { PodOptions } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import { canPromote } from './state-machine.js';
import type {
  WorkspacePromotionCaptured,
  WorkspacePromotionLiveDependencies,
} from './workspace-contracts.js';

export function createWorkspacePromotion(
  deps: WorkspacePromotionLiveDependencies,
  captured: WorkspacePromotionCaptured,
) {
  const { podRepo, executionForPod, transition, enqueueSession, logger, profileStore, eventBus } =
    captured;

  async function promoteToAuto(
    podId: string,
    targetOutput: 'pr' | 'branch' | 'artifact' | 'none',
    options?: { instructions?: string; skipAgent?: boolean },
  ): Promise<void> {
    const pod = podRepo.getOrThrow(podId);

    if (!canPromote(pod.status, pod.options)) {
      throw new AutopodError(
        `Cannot promote pod ${podId} in status '${pod.status}' — must be an interactive, promotable, running pod`,
        'INVALID_STATE',
        409,
      );
    }

    const profile = executionForPod(pod);
    if (targetOutput === 'pr' && !profile.repoUrl) {
      throw new AutopodError(
        `Cannot promote to 'pr' — profile '${profile.name}' has no repoUrl`,
        'INVALID_CONFIGURATION',
        400,
      );
    }

    const skipAgent = !!options?.skipAgent;
    if (skipAgent && targetOutput === 'none') {
      // No PR, no push, no artifact, no agent — pod would just die. Refuse
      // explicitly so the caller picks a real promotion target.
      throw new AutopodError(
        "--skip-agent requires a promotion target ('--pr' or '--artifact')",
        'INVALID_OUTPUT_MODE',
        400,
      );
    }

    if (pod.launchConfigDigest) {
      const configuration = deps.launchConfiguration;
      if (!configuration?.prepareWorker)
        throw new AutopodError(
          'Frozen workspace handoff is unavailable',
          'CONFIG_EXECUTION_UNAVAILABLE',
          503,
        );
      const instructions = options?.instructions?.trim() || pod.handoffInstructions || undefined;
      await configuration.prepareWorker(
        {
          source: { podId, digest: pod.launchConfigDigest, kind: 'worker' },
          task: pod.task,
          output: targetOutput,
          work: { ...(instructions ? { handoffInstructions: instructions } : {}) },
        },
        (config) => {
          const current = podRepo.getOrThrow(podId);
          transition(current, 'handoff', {
            options: {
              agentMode: 'auto',
              output: targetOutput,
              validate: config.workflow.validationPhases.length > 0,
              validationSuite: config.workflow.validationPhases.length > 0 ? 'custom' : 'off',
              advisoryBrowserQaEnabled: config.workflow.advisoryBrowserQaEnabled,
              promotable: false,
            },
            recoveryWorktreePath: current.worktreePath,
            ...(instructions ? { handoffInstructions: instructions } : {}),
            skipAgent,
            autoApprove: false,
          });
        },
      );
      enqueueSession(podId);
      logger.info({ podId, targetOutput }, 'Workspace handoff prepared from frozen configuration');
      return;
    }

    // Capture the human's handoff instructions BEFORE the transition so they
    // survive the recovery restart. The recovery path inside processPod reads
    // them after `syncWorkspaceBack()` completes and composes `handoffContext`.
    // (When skipAgent is set the agent never sees these — the field stays on
    // the pod for audit/UI purposes only.)
    //
    // DETERMINISTIC PROMOTION RULE — REPLACEMENT (not append/merge):
    // A non-empty promotion-time correction *replaces* whatever
    // `handoffInstructions` the pod already carried (e.g. the initial Pi
    // handoff persisted at creation). When no correction is supplied, the
    // existing value is reused verbatim. We never concatenate the two, so a
    // large initial handoff can't be silently duplicated. The composed
    // `## Handoff` section always shows the single authoritative instruction
    // (initial OR correction) distinct from the machine-generated summary.
    const trimmedInstructions = options?.instructions?.trim();
    if (trimmedInstructions && trimmedInstructions.length > 0) {
      podRepo.update(podId, { handoffInstructions: trimmedInstructions });
    }

    if (skipAgent) {
      podRepo.update(podId, { skipAgent: true, autoApprove: false });
    }

    // Swap to the worker profile if one is configured — this lets the
    // interactive profile keep a minimal setup and delegate the heavy
    // agent config (model, validation, PR provider) to a sibling profile.
    const targetProfileName = profileStore.get(pod.profileName).workerProfile ?? pod.profileName;
    const targetProfile = profileStore.get(targetProfileName);

    const newPod: PodOptions = {
      agentMode: 'auto',
      output: targetOutput,
      validate: targetOutput === 'pr',
      promotable: false,
    };

    transition(pod, 'handoff', {
      options: newPod,
      // Reuse the existing worktree in recovery mode so the agent resumes
      // on the human's in-flight work.
      recoveryWorktreePath: pod.worktreePath,
      // containerId is intentionally kept — processPod reads it to sync the
      // workspace and stop the container before spawning the agent container.
    });

    // If we're switching profiles for the worker phase, snapshot the new
    // one so the agent runs under the right model/validation config.
    if (targetProfile.name !== pod.profileName) {
      podRepo.update(podId, {
        profileSnapshot: targetProfile,
      });
    }

    eventBus.emit({
      type: 'pod.status_changed',
      timestamp: new Date().toISOString(),
      podId,
      previousStatus: 'handoff',
      newStatus: 'handoff',
    });

    enqueueSession(podId);
    logger.info(
      { podId, targetOutput, targetProfile: targetProfile.name },
      'Pod promoted interactive → auto',
    );
  }
  return { promoteToAuto };
}
