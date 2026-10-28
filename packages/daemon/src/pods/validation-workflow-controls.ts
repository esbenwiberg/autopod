import type { OperatorActor, Pod, UpdateFromBaseResponse, ValidationResult } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import { applyOverrides } from '../validation/override-applicator.js';
import { captureValidationOwnership } from './validation-ownership.js';
import type {
  ValidationWorkflowCalls,
  ValidationWorkflowDependencies,
  ValidationWorkflowLiveDependencies,
} from './validation-workflow-ports.js';

type Captured = Pick<
  ValidationWorkflowDependencies,
  | 'actorLabel'
  | 'legacyRespondedBy'
  | 'buildValidationWaiver'
  | 'mergeOverrides'
  | 'podRepo'
  | 'escalationRepo'
  | 'nudgeRepo'
  | 'worktreeManager'
  | 'logger'
  | 'executionForPod'
  | 'assertExecutionTerminationVerified'
  | 'resolveGitCredential'
  | 'validationAbortControllers'
  | 'attemptExtensionRuns'
  | 'pendingUpdateFromBaseIntents'
  | 'forceWithLeaseAllowances'
  | 'emitActivityStatus'
  | 'transition'
  | 'maybeTriggerDependents'
>;

export function createValidationWorkflowControls(
  deps: ValidationWorkflowLiveDependencies,
  captured: Captured,
) {
  const {
    actorLabel,
    legacyRespondedBy,
    buildValidationWaiver,
    mergeOverrides,
    podRepo,
    escalationRepo,
    nudgeRepo,
    worktreeManager,
    logger,
    executionForPod,
    assertExecutionTerminationVerified,
    resolveGitCredential,
    validationAbortControllers,
    attemptExtensionRuns,
    pendingUpdateFromBaseIntents,
    forceWithLeaseAllowances,
    emitActivityStatus,
    transition,
    maybeTriggerDependents,
  } = captured;

  /**
   * Performs the rebase-and-revalidate flow for a pod whose update-from-base
   * intent was consumed during validation unwind. Pod must be in `validating`
   * state; this function handles all status transitions.
   * `startFollowUpValidation` is called (fire-and-forget) when the rebase is clean.
   */
  async function runUpdateFromBaseAfterAbort(
    podId: string,
    startFollowUpValidation: () => void,
  ): Promise<void> {
    const pod = podRepo.getOrThrow(podId);
    if (!pod.worktreePath) {
      transition(pod, 'failed');
      return;
    }
    const profile = executionForPod(pod);
    const baseBranch = pod.baseBranch ?? profile.defaultBranch ?? 'main';

    emitActivityStatus(podId, `Update from base: rebasing onto '${baseBranch}'…`);

    const rebaseResult = await worktreeManager.rebaseOntoBase({
      worktreePath: pod.worktreePath,
      baseBranch,
      pat: await resolveGitCredential(profile),
    });

    const freshPod = podRepo.getOrThrow(podId);

    if (rebaseResult.alreadyUpToDate) {
      emitActivityStatus(podId, `Branch already up to date with '${baseBranch}'`);
      transition(freshPod, 'failed');
      return;
    }

    if (!rebaseResult.rebased) {
      emitActivityStatus(
        podId,
        `Rebase conflict with '${baseBranch}': ${rebaseResult.conflicts.join(', ')}`,
      );
      transition(freshPod, 'review_required');
      return;
    }

    emitActivityStatus(podId, `Rebased onto '${baseBranch}' — restarting validation…`);
    forceWithLeaseAllowances.add(podId);
    transition(freshPod, 'failed');
    podRepo.update(podId, { validationAttempts: 0 });
    startFollowUpValidation();
  }

  function applySkipValidationDecision(pod: Pod, result: ValidationResult): Pod | null {
    if (!pod.skipValidation) return null;

    const skipActor = pod.skipValidationActor ?? {
      type: 'automation' as const,
      id: 'legacy-skip-validation',
    };
    const validationWaiver =
      result.overall === 'fail'
        ? buildValidationWaiver(result, 'Validation skipped by operator', skipActor)
        : null;
    emitActivityStatus(
      pod.id,
      validationWaiver
        ? `Validation waived by ${actorLabel(skipActor)} — failed phases: ${validationWaiver.failedPhases.join(', ') || 'unknown'}`
        : `Validation skipped by ${actorLabel(skipActor)} — marking as validated`,
    );
    logger.info(
      { podId: pod.id, attempt: result.attempt, validationWaiver },
      'skip_validation set — bypassing result',
    );
    pendingUpdateFromBaseIntents.delete(pod.id);
    return transition(pod, 'validated', {
      failureReason: null,
      validationWaiver,
    });
  }

  function claimValidation(expectedPod: Pod, validationController: AbortController) {
    assertExecutionTerminationVerified(expectedPod.id);
    let claimed = false;
    const ownership = captureValidationOwnership(expectedPod, {
      readCurrent: () => {
        podRepo.sourceAdoptions?.assertAvailable(expectedPod.id);
        return podRepo.getOrThrow(expectedPod.id);
      },
      isCurrentInvocation: () =>
        !podRepo.taskExecutions?.hasUnverifiedTermination(expectedPod.id) &&
        (claimed
          ? validationAbortControllers.get(expectedPod.id) === validationController
          : !validationAbortControllers.has(expectedPod.id)),
      hasPendingDecision: () =>
        nudgeRepo.hasPending(expectedPod.id) ||
        (podRepo.hasUnansweredDecision?.(expectedPod.id) ??
          Boolean(podRepo.getOrThrow(expectedPod.id).pendingEscalation)),
    });
    ownership.assertCurrent();
    validationAbortControllers.set(expectedPod.id, validationController);
    claimed = true;
    return ownership;
  }

  async function extendAttempts(
    this: Pick<ValidationWorkflowCalls, 'triggerValidation'>,
    podId: string,
    additionalAttempts: number,
  ): Promise<void> {
    if (attemptExtensionRuns.has(podId)) {
      logger.info({ podId }, 'Coalesced duplicate attempt extension during active recovery');
      return;
    }

    const pod = podRepo.getOrThrow(podId);
    if (pod.status !== 'review_required') {
      throw new AutopodError(
        `Cannot extend attempts for pod ${podId} in status ${pod.status} — only review_required pods`,
        'INVALID_STATE',
        409,
      );
    }
    const newMax = pod.maxValidationAttempts + additionalAttempts;
    if (newMax > 10) {
      throw new AutopodError(
        `Cannot exceed 10 total validation attempts (current: ${pod.maxValidationAttempts}, requested: +${additionalAttempts})`,
        'VALIDATION_ERROR',
        400,
      );
    }
    podRepo.update(podId, { maxValidationAttempts: newMax });
    logger.info(
      { podId, oldMax: pod.maxValidationAttempts, newMax, additionalAttempts },
      'Extended validation attempts',
    );
    emitActivityStatus(podId, `Validation attempts extended to ${newMax} — resuming validation`);
    // Recovery can spend minutes preserving a hosted workspace and provisioning Azure.
    // Detach it from the HTTP acknowledgement and keep one authoritative run per pod so a
    // client retry after an ambiguous timeout cannot increment the budget or race cleanup.
    const recovery = this.triggerValidation(podId, { force: true })
      .catch((err: unknown) => {
        logger.warn({ err, podId }, 'Attempt-extension recovery failed after acceptance');
        emitActivityStatus(
          podId,
          `Attempt extension accepted, but recovery failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        attemptExtensionRuns.delete(podId);
      });
    attemptExtensionRuns.set(podId, recovery);
    void recovery;
  }

  async function applyOverridesInstant(podId: string): Promise<{ advanced: boolean }> {
    const pod = podRepo.getOrThrow(podId);
    if (pod.status !== 'review_required' && pod.status !== 'failed') {
      throw new AutopodError(
        `Cannot apply overrides instantly for pod ${podId} in status ${pod.status} — only failed or review_required pods`,
        'INVALID_STATE',
        409,
      );
    }
    if (!pod.lastValidationResult) {
      return { advanced: false };
    }

    // Flush pending overrides and merge into permanent overrides
    const pendingOverrides = deps.pendingOverrideRepo?.flush(podId) ?? [];
    const existingOverrides = pod.validationOverrides ?? [];
    const currentOverrides =
      pendingOverrides.length > 0
        ? mergeOverrides(existingOverrides, pendingOverrides)
        : existingOverrides;

    if (currentOverrides.length === 0) {
      return { advanced: false };
    }

    podRepo.update(podId, { validationOverrides: currentOverrides });

    // Re-evaluate the cached result with overrides applied
    const patched = applyOverrides(pod.lastValidationResult, currentOverrides);
    podRepo.update(podId, { lastValidationResult: patched });

    emitActivityStatus(podId, 'Human overrides applied — re-evaluating cached result…');

    if (patched.overall === 'pass') {
      transition(pod, 'validated');
      emitActivityStatus(podId, 'All findings resolved — validation passed');
      logger.info(
        { podId, overrideCount: currentOverrides.length },
        'Instant override advanced pod to validated',
      );
      return { advanced: true };
    }

    emitActivityStatus(podId, 'Some findings remain — pod still needs review');
    return { advanced: false };
  }

  function interruptValidation(podId: string): void {
    validationAbortControllers.get(podId)?.abort();
  }

  async function updateFromBase(
    this: Pick<ValidationWorkflowCalls, 'triggerValidation'>,
    podId: string,
  ): Promise<UpdateFromBaseResponse> {
    const pod = podRepo.getOrThrow(podId);

    const eligibleStatuses = ['validating', 'failed', 'review_required'] as const;
    if (!(eligibleStatuses as readonly string[]).includes(pod.status)) {
      throw new AutopodError(
        `Cannot run update-from-base on pod ${podId} in status '${pod.status}'`,
        'INVALID_STATE',
        409,
      );
    }

    if (!pod.worktreePath) {
      throw new AutopodError(
        `Pod ${podId} has no worktree — cannot update from base`,
        'INVALID_STATE',
        400,
      );
    }

    if (pod.worktreeCompromised) {
      throw new AutopodError(
        `Pod ${podId} worktree is compromised — recover it before updating from base`,
        'WORKTREE_COMPROMISED',
        409,
      );
    }

    // For validating pods: store the intent, abort current validation, return immediately.
    // The validation unwind (retry or catch path) consumes the intent and runs the rebase.
    if (pod.status === 'validating') {
      pendingUpdateFromBaseIntents.add(podId);
      validationAbortControllers.get(podId)?.abort();
      return { ok: true, action: 'queued_after_abort' };
    }

    // For failed / review_required pods: run the rebase directly.
    const profile = executionForPod(pod);
    const baseBranch = pod.baseBranch ?? profile.defaultBranch ?? 'main';

    emitActivityStatus(podId, `Update from base: rebasing onto '${baseBranch}'…`);

    const rebaseResult = await worktreeManager.rebaseOntoBase({
      worktreePath: pod.worktreePath,
      baseBranch,
      pat: await resolveGitCredential(profile),
    });
    const rebasedBaseCommitSha = rebaseResult.baseCommitSha?.trim() || null;

    if (rebaseResult.alreadyUpToDate) {
      if (rebasedBaseCommitSha && rebasedBaseCommitSha !== pod.startCommitSha) {
        podRepo.update(podId, { startCommitSha: rebasedBaseCommitSha });
      }
      emitActivityStatus(podId, `Branch already up to date with '${baseBranch}'`);
      return { ok: true, action: 'already_up_to_date', baseBranch };
    }

    if (!rebaseResult.rebased) {
      emitActivityStatus(
        podId,
        `Rebase conflict with '${baseBranch}': ${rebaseResult.conflicts.join(', ')}`,
      );
      return { ok: false, action: 'conflict', baseBranch, conflicts: rebaseResult.conflicts };
    }

    // Clean rebase: mark for force-with-lease, reset attempts, start validation async.
    emitActivityStatus(podId, `Rebased onto '${baseBranch}' — starting validation…`);
    forceWithLeaseAllowances.add(podId);
    podRepo.update(podId, {
      validationAttempts: 0,
      ...(rebasedBaseCommitSha ? { startCommitSha: rebasedBaseCommitSha } : {}),
    });
    setImmediate(() => {
      this.triggerValidation(podId).catch((e: unknown) =>
        logger.error({ err: e, podId }, 'update-from-base follow-up validation failed'),
      );
    });

    return { ok: true, action: 'rebased', baseBranch, validation: 'started' };
  }

  function setSkipValidation(
    podId: string,
    skip: boolean,
    actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
  ): void {
    const pod = podRepo.getOrThrow(podId);
    podRepo.update(podId, {
      skipValidation: skip,
      skipValidationActor: skip ? actor : null,
    });
    const msg = skip
      ? 'Skip-validation toggled on — next validation result will be bypassed'
      : 'Skip-validation toggled off — validation will run normally';
    emitActivityStatus(podId, msg);
    logger.info({ podId, skip }, 'skip_validation updated by user');

    // Pods parked in awaiting_input on a validation_override escalation never
    // re-enter the validation flow on their own — the flag alone leaves them
    // hung. Treat skip=true as "I don't care about validation, just approve":
    // resolve the escalation and transition straight to validated.
    if (
      skip &&
      pod.status === 'awaiting_input' &&
      pod.pendingEscalation?.type === 'validation_override'
    ) {
      const escalationId = pod.pendingEscalation.id;
      escalationRepo.update(escalationId, {
        respondedAt: new Date().toISOString(),
        respondedBy: legacyRespondedBy(actor),
        actor,
        response: `[skip-validation] dismissed by ${actorLabel(actor)}`,
      });
      const validationWaiver =
        pod.lastValidationResult?.overall === 'fail'
          ? buildValidationWaiver(
              pod.lastValidationResult,
              `Validation skipped — recurring findings dismissed by ${actorLabel(actor)}`,
              actor,
            )
          : null;
      const updated = transition(pod, 'validated', {
        pendingEscalation: null,
        ...(validationWaiver ? { validationWaiver } : {}),
      });
      emitActivityStatus(
        podId,
        validationWaiver
          ? `Validation waived — recurring findings dismissed by ${actorLabel(actor)}`
          : `Validation skipped — recurring findings dismissed by ${actorLabel(actor)}`,
      );
      logger.info(
        { podId, escalationId },
        'skip_validation resolved validation_override escalation',
      );
      maybeTriggerDependents(updated);
    }
  }

  return {
    runUpdateFromBaseAfterAbort,
    applySkipValidationDecision,
    claimValidation,
    extendAttempts,
    applyOverridesInstant,
    interruptValidation,
    updateFromBase,
    setSkipValidation,
  };
}
