import type { EscalationRequest, ReviewBatchResult, ValidationFinding } from '@autopod/shared';
import { AutopodError, generateId } from '@autopod/shared';
import type { ValidationEngine } from '../interfaces/index.js';
import { detectRecurringFindings, extractFindings } from '../validation/finding-fingerprint.js';
import { applyOverrides } from '../validation/override-applicator.js';
import { addTokenUsage } from '../validation/review-synthesizer.js';
import {
  assertValidationExecutionSettled,
  assertValidationMutationSettled,
  captureValidationMutationGuard,
  guardValidationContainer,
  requiresValidationSettlement,
} from './validation-recovery-policy.js';

import { AgentContinuationSupersededError } from './continuation-preflight.js';
import { buildCorrectionMessage } from './correction-context.js';
import { persistEscalation } from './escalation-coordinator.js';
import { resolvePodModel, resolvePodRuntime } from './runtime-resolver.js';
import { isTerminalState } from './state-machine.js';
import { TaskRetryBlockedError } from './task-retry-ledger.js';
import {
  isReviewInfrastructureOnlyFailure,
  isValidationInfrastructureOnlyFailure,
  reviewInfrastructureFailureLabel,
} from './validation-infrastructure.js';
import { ValidationSupersededError } from './validation-ownership.js';
import {
  failedValidationPhases,
  hasPendingFactDecision,
  makeUnexpectedValidationFailureResult,
  summarizeValidationPhases,
} from './validation-workflow-policy.js';
import type {
  AgentRunOutcome,
  ValidationTriggerCaptured,
  ValidationWorkflowCalls,
  ValidationWorkflowLiveDependencies,
} from './validation-workflow-ports.js';
import { ValidationWorkspaceReconcileError } from './validation-workspace.js';
import { waitForContainerReachable } from './workspace-transfer.js';

export function createValidationTriggerWorkflow(
  deps: ValidationWorkflowLiveDependencies,
  captured: ValidationTriggerCaptured,
) {
  const {
    buildManualReworkReason,
    mergeOverrides,
    podRepo,
    escalationRepo,
    eventBus,
    containerManagerFactory,
    validationEngine,
    enqueueSession,
    logger,
    validationRepo,
    scanRepo,
    assertExecutionTerminationVerified,
    resolveEffectiveBoundProfile,
    beginGoalTaskRework,
    taskFeedbackEvents,
    destroyPodNetwork,
    cleanupContainer,
    stopSandboxPreviewProxy,
    killSidecarsForPod,
    cleanupTestRunBranches,
    validationAbortControllers,
    ownsLifecycle,
    pendingUpdateFromBaseIntents,
    parkFixPodDeliveryFailure,
    isParkedHostPushRecovery,
    runUpdateFromBaseAfterAbort,
    persistRuntimeCredentialsForPod,
    prepareWorkspaceForValidation,
    preservePodWorkspace,
    checkpointSandboxWorkspaceForPod,
    startValidationAttempt,
    prepareValidationInputs,
    buildPhaseEventCallbacks,
    ownedValidationCallbacks,
    recordValidationProvenance,
    withReviewerLaunchPreflight,
    validateWithInfrastructureRetries,
    collectValidationEvidence,
    publishValidationResult,
    parkOnRetryAdmission,
    parkOnValidationInfrastructureFailure,
    parkOnReviewInfrastructureFailure,
    emitActivityStatus,
    emitActivityError,
    sanitizeFailureReason,
    tryRecoverAfterWorkspaceSyncFailure,
    parkOnWorktreeSyncFailure,
    transition,
    applySkipValidationDecision,
    claimValidation,
    maybeTriggerDependents,
    completeValidationPass,
  } = captured;

  async function triggerValidation(
    this: Pick<
      ValidationWorkflowCalls,
      | 'triggerValidation'
      | 'assertCanRework'
      | 'approveSession'
      | 'consumeAgentEvents'
      | 'handleCompletion'
    >,
    podId: string,
    options?: { force?: boolean; validationOnly?: boolean },
  ): Promise<void> {
    assertExecutionTerminationVerified(podId);
    let pod = podRepo.getOrThrow(podId);
    assertValidationExecutionSettled(pod, podRepo.validationExecutions?.isSettled(pod));
    if (deps.launchConfiguration?.read(podId)?.intent === 'goal') {
      const goal = deps.launchConfiguration.goals?.get(podId);
      if (goal?.state !== 'achieved' || !goal.executionStopped)
        throw new AutopodError(
          'Native Goal must be achieved before the delivery validation pipeline',
          'GOAL_NOT_ACHIEVED',
          409,
        );
    }
    if (
      options?.force &&
      !options.validationOnly &&
      ['failed', 'review_required', 'validated'].includes(pod.status)
    ) {
      await beginGoalTaskRework(pod, buildManualReworkReason(pod));
      pod = podRepo.getOrThrow(podId);
    }
    const lifecycleGeneration = pod.lifecycleGeneration;
    const lifecycleContainerId = pod.containerId;
    const force = options?.force ?? false;

    const triggerValidationFromUpdateIntent = () => {
      setImmediate(() =>
        this.triggerValidation(podId).catch((e: unknown) =>
          logger.error({ err: e, podId }, 'update-from-base follow-up validation failed'),
        ),
      );
    };
    // Must be checked before sending correction feedback to the agent.
    const tryConsumeUpdateIntent = (): boolean => {
      if (!pendingUpdateFromBaseIntents.has(podId)) return false;
      pendingUpdateFromBaseIntents.delete(podId);
      runUpdateFromBaseAfterAbort(podId, triggerValidationFromUpdateIntent).catch((e: unknown) =>
        logger.error({ err: e, podId }, 'update-from-base after abort failed'),
      );
      return true;
    };

    if (pod.worktreeCompromised) {
      emitActivityStatus(
        podId,
        'Validation blocked — recover the worktree before retrying validation.',
      );
      throw new AutopodError(
        `Pod ${podId} worktree is compromised — recover it before validation`,
        'WORKTREE_COMPROMISED',
        409,
      );
    }

    const profile = resolveEffectiveBoundProfile(pod);

    // When force-reworking from a terminal state, re-provision the pod from scratch
    // instead of trying to restart a potentially stale container. Docker Desktop's VirtioFS
    // mounts can break after long idle periods, making the old container unreachable.
    const fromTerminal =
      pod.status === 'failed' ||
      pod.status === 'review_required' ||
      pod.status === 'killed' ||
      pod.status === 'validated';
    // Interactive pods can always be re-provisioned: no agent, no validation, no worktree required.
    const isInteractive = pod.options.agentMode === 'interactive';
    if (force && fromTerminal && (pod.worktreePath || isInteractive || !pod.containerId)) {
      this.assertCanRework(podId);
      emitActivityStatus(podId, 'Re-provisioning pod with fresh container…');

      // Fence stale validation and agent cleanup before awaiting any teardown.
      const reworkGeneration = podRepo.incrementLifecycleGeneration(podId);
      validationAbortControllers.get(podId)?.abort();

      if (
        !isInteractive &&
        pod.executionTarget === 'sandbox' &&
        pod.containerId &&
        pod.worktreePath
      ) {
        try {
          await preservePodWorkspace(
            { ...pod, lifecycleGeneration: reworkGeneration },
            'forced Rework',
          );
        } catch (preserveErr) {
          emitActivityStatus(
            podId,
            'Rework blocked — the old workspace could not be preserved. The container was retained for recovery.',
          );
          throw new AutopodError(
            `Pod ${podId} workspace could not be preserved before Rework: ${preserveErr instanceof Error ? preserveErr.message : String(preserveErr)}`,
            'WORKSPACE_SYNC_FAILED',
            409,
          );
        }
      }

      // Kill the old container with the same hard ceiling used by terminal cleanup.
      // Azure sandbox deletion can stall while polling the data plane; rework must
      // still clear the stale container reference and return to the provisioning queue.
      await killSidecarsForPod(podId);
      await cleanupTestRunBranches(podId);
      await cleanupContainer(pod, 'Rework');
      // The new container will be attached to a freshly-created per-pod
      // bridge below; blow away any stale bridge from the prior attempt.
      await destroyPodNetwork(podId);

      const failedBeforeAgentWork =
        pod.status === 'failed' &&
        // A recorded worker reservation is enough to retain its existing source.
        // Missing session/token/summary telemetry does not prove no work happened.
        (podRepo.workerRetries?.state(podId).admissionCount ?? 0) === 0 &&
        pod.validationAttempts === 0 &&
        pod.lastValidationResult === null &&
        pod.taskSummary === null &&
        pod.claudeSessionId === null &&
        pod.codexSessionId === null &&
        pod.piSessionId === null &&
        pod.prUrl === null;
      const recoveryWorktreePath = failedBeforeAgentWork ? null : (pod.worktreePath ?? null);

      // Re-queue through processPod. Preserve the worktree only when the
      // previous run got far enough that it may contain agent-authored work.
      // Setup-only failures (image pull, provider auth, registry probes, etc.)
      // need a fresh baseline; otherwise a persistent hosted daemon can
      // resurrect stale VM worktree/branch state and show it as this run's diff.
      // Clear claudeSessionId so the agent gets a fresh spawn instead of resuming
      // a stale/broken pod context. Set reworkReason so processPod builds
      // a rework-specific prompt instead of the generic "you were interrupted" recovery prompt.
      // Interactive pods don't need a rework prompt — they get a fresh container.
      let blockedPushScan: import('../security/index.js').StoredScan | undefined;
      if (
        !isInteractive &&
        pod.status === 'failed' &&
        pod.failureReason?.includes('Pre-push security scan blocked') &&
        scanRepo
      ) {
        try {
          const latestPushScan = scanRepo.getLatestForPod(pod.id, 'push');
          if (latestPushScan?.decision === 'block') blockedPushScan = latestPushScan;
        } catch (err) {
          logger.warn({ err, podId }, 'Failed to load blocked push scan for manual rework context');
        }
      }
      const reworkReason = isInteractive ? null : buildManualReworkReason(pod, blockedPushScan);
      const runtime = resolvePodRuntime(profile, pod.runtime, logger);
      const model = resolvePodModel(profile, pod.model, runtime, logger);
      podRepo.update(podId, {
        runtime,
        model,
        validationAttempts: 0,
        lastValidationResult: null,
        containerId: null,
        worktreePath: recoveryWorktreePath,
        claudeSessionId: null,
        codexSessionId: null,
        piSessionId: null,
        recoveryWorktreePath,
        reworkReason,
        reworkCount: (pod.reworkCount ?? 0) + 1,
        recoveryCount: 0,
        preSubmitReview: null,
        completedAt: null,
        failureReason: null,
        infrastructureFailure: null,
        infrastructureRecoveryCount: pod.infrastructureRecoveryCount,
        ...(failedBeforeAgentWork
          ? {
              filesChanged: 0,
              linesAdded: 0,
              linesRemoved: 0,
              commitCount: 0,
              lastCommitAt: null,
              startCommitSha: null,
            }
          : {}),
      });
      transition(podRepo.getOrThrow(podId), 'queued');
      enqueueSession(podId);

      logger.info(
        {
          podId,
          worktreePath: pod.worktreePath,
          reworkReason,
          isInteractive,
          previousRuntime: pod.runtime,
          runtime,
          previousModel: pod.model,
          model,
        },
        'Rework: re-queued with fresh container provisioning',
      );
      return;
    }

    const { s1, attempt, validationSuite } = await startValidationAttempt(
      pod,
      profile,
      fromTerminal,
    );

    const assertPreflight = captureValidationMutationGuard(podRepo, s1);

    try {
      if (!pod.containerId) {
        throw new Error(`Pod ${podId} has no container — cannot validate`);
      }

      // Restart the container if it was stopped (e.g. after max attempts exhausted)
      if (force) {
        const cm = guardValidationContainer(
          containerManagerFactory.get(pod.executionTarget),
          assertPreflight,
        );
        await cm.start(pod.containerId);
      } else {
        // Guard: if the container exited before we got here (e.g. agent gave up after a
        // push rejection), fail fast with a human-readable message instead of getting a
        // cryptic Docker 409 "container stopped/paused" error from the exec call below.
        const cm = guardValidationContainer(
          containerManagerFactory.get(pod.executionTarget),
          assertPreflight,
        );
        const containerStatus = await cm.getStatus(pod.containerId);
        if (containerStatus === 'unknown') {
          emitActivityStatus(
            podId,
            'Sandbox status is unavailable before validation — waiting for recovery…',
          );
          const recovery = await waitForContainerReachable(pod.containerId, cm, 30_000);
          if (recovery !== 'ready') {
            const result = makeUnexpectedValidationFailureResult(
              podId,
              attempt,
              new Error(`Sandbox status remained ${recovery} before validation could run`),
            );
            result.infrastructureFailure = {
              phase: 'setup',
              code: 'SANDBOX_STATUS_UNAVAILABLE',
              message: `Sandbox status remained ${recovery} before validation could run`,
              retryable: true,
            };
            podRepo.update(podId, { lastValidationResult: result });
            validationRepo?.insert(podId, attempt, result);
            eventBus.emit({
              type: 'pod.validation_completed',
              timestamp: new Date().toISOString(),
              podId,
              result,
            });
            await parkOnValidationInfrastructureFailure(podRepo.getOrThrow(podId), result);
            return;
          }
        } else if (containerStatus !== 'running') {
          throw new Error(
            `Container exited before validation could run — check agent logs for errors (container status: ${containerStatus})`,
          );
        }
      }

      // Sync workspace back before reading diff/commit log from host worktree
      emitActivityStatus(podId, 'Syncing workspace…');
      let validationSyncOk = true;
      if (pod.containerId && pod.worktreePath) {
        try {
          if (pod.executionTarget === 'sandbox') {
            const checkpoint = await checkpointSandboxWorkspaceForPod(s1);
            validationSyncOk =
              checkpoint.promoted && checkpoint.materialized && checkpoint.lineageVerified;
          } else {
            const cm = containerManagerFactory.get(pod.executionTarget);
            await prepareWorkspaceForValidation(
              pod.containerId,
              pod.worktreePath,
              cm,
              podId,
              pod.executionTarget,
            );
          }
        } catch (err) {
          logger.warn({ err, podId }, 'Failed to sync workspace before validation');
          validationSyncOk =
            err instanceof ValidationWorkspaceReconcileError
              ? false
              : await tryRecoverAfterWorkspaceSyncFailure(s1, err, 'validation');
        }
      }
      if (!validationSyncOk) {
        parkOnWorktreeSyncFailure(
          podId,
          'Workspace sync failed before validation — validation blocked.',
        );
        return;
      }

      const { validationConfig, previousValidation } = await prepareValidationInputs(
        pod,
        profile,
        s1,
        attempt,
        validationSuite,
      );

      let result: Awaited<ReturnType<typeof validationEngine.validate>>;
      const validationController = new AbortController();
      const ownership = claimValidation(pod, validationController);
      try {
        result = await validateWithInfrastructureRetries(
          validationConfig,
          validationController,
          buildPhaseEventCallbacks(podId),
          'Validation engine threw unexpectedly',
          ownership,
        );
        ownership.assertCurrent();
        emitActivityStatus(podId, 'Validation checks finished — finalizing result…');
        validationSyncOk = await collectValidationEvidence(
          podId,
          s1,
          result,
          validationSyncOk,
          () => {
            ownership.assertCurrent();
            assertExecutionTerminationVerified(podId);
            assertValidationMutationSettled(podRepo, podId);
          },
        );
        ownership.assertCurrent();
      } finally {
        if (validationAbortControllers.get(podId) === validationController)
          validationAbortControllers.delete(podId);
      }

      if (!ownsLifecycle(podId, lifecycleGeneration, lifecycleContainerId)) {
        logger.info(
          { podId, containerId: lifecycleContainerId, generation: lifecycleGeneration },
          'Discarded stale lifecycle validation result',
        );
        return;
      }

      const validationRecord = publishValidationResult(podId, attempt, result);

      let s2 = podRepo.getOrThrow(podId);

      // Pod may have been killed while validation was running — bail out
      if (isTerminalState(s2.status) || s2.status === 'killing') {
        logger.info(
          { podId, status: s2.status },
          'Pod killed during validation, skipping post-validation',
        );
        return;
      }

      // Emit detailed validation result
      emitActivityStatus(
        podId,
        `Validation ${result.overall} — ${summarizeValidationPhases(result)}`,
      );

      // Surface review feedback so the user can see why it failed
      if (result.taskReview && result.taskReview.status !== 'pass') {
        if (result.taskReview.reasoning) {
          emitActivityStatus(podId, `Review: ${result.taskReview.reasoning}`);
        }
        for (const issue of result.taskReview.issues) {
          emitActivityStatus(podId, `  → ${issue}`);
        }
      }

      // Native termination evidence is independent of overall, dismissals and waivers.
      if (requiresValidationSettlement({ lastValidationResult: result })) {
        if (result.infrastructureFailure?.code === 'VALIDATION_ENGINE_TERMINATION_UNVERIFIED') {
          emitActivityStatus(
            podId,
            'Validation engine failed without termination evidence; retain original source and reports. Retry and source mutation remain blocked.',
          );
          transition(s2, 'review_required');
        } else await parkOnValidationInfrastructureFailure(s2, result);
        return;
      }
      assertValidationMutationSettled(podRepo, podId);

      // ── Validation overrides: apply existing dismissals, detect recurring findings ──
      let effectiveResult = result;
      if (s2.validationOverrides && s2.validationOverrides.length > 0) {
        effectiveResult = applyOverrides(result, s2.validationOverrides);
        if (effectiveResult.overall !== result.overall) {
          logger.info(
            {
              podId,
              originalOverall: result.overall,
              patchedOverall: effectiveResult.overall,
            },
            'Validation overrides changed overall result',
          );
          emitActivityStatus(podId, 'Human overrides applied — re-evaluated result');
        }
      }

      // Container/data-plane failures are daemon infrastructure, not agent work.
      if (isValidationInfrastructureOnlyFailure(effectiveResult)) {
        if (tryConsumeUpdateIntent()) return;
        await parkOnValidationInfrastructureFailure(s2, effectiveResult);
        return;
      }

      // Reviewer process failures are daemon infrastructure, not agent work.
      if (isReviewInfrastructureOnlyFailure(effectiveResult)) {
        if (tryConsumeUpdateIntent()) return;
        await parkOnReviewInfrastructureFailure(s2);
        return;
      }

      // Retry-cycle review findings need an independent council on the same
      // frozen bytes before they can trigger another correction or escalation.
      if (effectiveResult.overall === 'fail' && previousValidation) {
        const previousResult = previousValidation.result;

        if (previousResult) {
          const currentFindings = extractFindings(effectiveResult);
          const previousFindings = extractFindings(previousResult);
          const reviewCandidates = currentFindings.filter(
            (finding) => finding.source === 'task_review',
          );
          const recurring = detectRecurringFindings(reviewCandidates, previousFindings);
          const retryBatchHealthy = effectiveResult.taskReview?.reviewBatch?.quality === 'healthy';
          const closureStatus =
            effectiveResult.taskReview?.reviewBatch?.closureVerification?.status;
          const closureConclusive = closureStatus === undefined || closureStatus === 'completed';

          if (reviewCandidates.length > 0 && retryBatchHealthy && closureConclusive) {
            logger.info(
              {
                podId,
                candidateCount: reviewCandidates.length,
                recurringCount: recurring.length,
                attempt,
              },
              'Retry validation findings require independent confirmation',
            );
            emitActivityStatus(
              podId,
              `${reviewCandidates.length} retry finding(s) detected — confirming with an independent council`,
            );

            // Re-run only a fresh council. Deterministic evidence is already
            // durable for this exact attempt; a second opinion must not execute
            // the suite or revive the broad discovery reviewer.
            let hoistedResult: typeof effectiveResult | null = null;
            let hoistError: unknown;
            let confirmedRecurring: ValidationFinding[] = [];
            let confirmedNew: ValidationFinding[] = [];
            let adjudicationReviewBatch: ReviewBatchResult | undefined;
            const recurringIds = new Set(recurring.map((finding) => finding.id));
            const candidateIds = new Set(reviewCandidates.map((finding) => finding.id));
            const candidateFindingIds = [...candidateIds].sort();
            const originalReviewBatchId = effectiveResult.taskReview?.reviewBatch?.id;
            const councilController = new AbortController();
            const councilOwnership = claimValidation(pod, councilController);
            try {
              const reviewConfig: Parameters<ValidationEngine['validate']>[0] = {
                ...validationConfig,
                reviewDepth: 'deep',
                reviewOnly: true,
                councilOnly: true,
                preSubmitReview: null,
                // This is an independent adjudication of the current bytes,
                // not another ledger-reconciliation pass. Reusing the prior
                // batch here can carry the same historical finding into both
                // opinions without either reviewer rediscovering the defect.
                priorReviewBatch: undefined,
                skipPhases: ['setup', 'lint', 'sast', 'build', 'test', 'health', 'pages', 'facts'],
              };
              await recordValidationProvenance(
                reviewConfig,
                'review',
                councilOwnership.assertCurrent,
              );
              councilOwnership.assertCurrent();
              const reviewOnly = await validationEngine.validate(
                withReviewerLaunchPreflight(reviewConfig, councilOwnership),
                (phase) => {
                  if (councilOwnership.isCurrent()) emitActivityStatus(podId, phase);
                },
                councilController.signal,
                ownedValidationCallbacks(councilOwnership, buildPhaseEventCallbacks(podId)),
              );
              councilOwnership.assertCurrent();
              if (
                isReviewInfrastructureOnlyFailure(reviewOnly) ||
                reviewOnly.taskReview?.reviewBatch?.quality !== 'healthy'
              ) {
                throw new Error('Independent retry-finding council did not complete healthily');
              }
              const independentFindings = extractFindings(reviewOnly);
              const confirmed = independentFindings.filter((finding) =>
                candidateIds.has(finding.id),
              );
              const confirmedIds = new Set(confirmed.map((finding) => finding.id));
              confirmedRecurring = confirmed.filter((finding) => recurringIds.has(finding.id));
              confirmedNew = confirmed.filter((finding) => !recurringIds.has(finding.id));
              adjudicationReviewBatch = reviewOnly.taskReview?.reviewBatch;
              const primaryTaskReview = effectiveResult.taskReview;
              const hasUnmetRequirements =
                primaryTaskReview?.requirementsCheck?.some((item) => !item.met) ?? false;
              const combinedReviewUsage = addTokenUsage(
                primaryTaskReview?.tokenUsage,
                reviewOnly.taskReview?.tokenUsage,
              );
              const adjudicatedTaskReview = primaryTaskReview
                ? {
                    ...primaryTaskReview,
                    status:
                      confirmed.length > 0 || hasUnmetRequirements
                        ? ('fail' as const)
                        : ('pass' as const),
                    reasoning:
                      confirmed.length > 0
                        ? `Independent council confirmed ${confirmed.length} retry finding(s).`
                        : 'Independent council did not reproduce any retry finding.',
                    issues: reviewCandidates
                      .filter((finding) => confirmedIds.has(finding.id))
                      .map((finding) => finding.description),
                    ...(combinedReviewUsage ? { tokenUsage: combinedReviewUsage } : {}),
                    ...(primaryTaskReview.reviewBatch
                      ? {
                          reviewBatch: {
                            ...primaryTaskReview.reviewBatch,
                            ledger: primaryTaskReview.reviewBatch.ledger?.filter(
                              (entry) =>
                                !candidateIds.has(entry.semanticId) ||
                                confirmedIds.has(entry.semanticId),
                            ),
                            adjudication: {
                              kind: 'recurrence-hoist' as const,
                              ...(originalReviewBatchId ? { originalReviewBatchId } : {}),
                              candidateFindingIds,
                              confirmedFindingIds: [...confirmedIds].sort(),
                            },
                          },
                        }
                      : {}),
                  }
                : null;
              const deterministicFailures = failedValidationPhases(effectiveResult).filter(
                (phase) => phase !== 'review',
              );
              hoistedResult = {
                ...effectiveResult,
                taskReview: adjudicatedTaskReview,
                reviewSkipReason: reviewOnly.reviewSkipReason,
                reviewSkipKind: reviewOnly.reviewSkipKind,
                reviewTokenUsage: combinedReviewUsage,
                duration: effectiveResult.duration + reviewOnly.duration,
                overall:
                  deterministicFailures.length === 0 && adjudicatedTaskReview?.status === 'pass'
                    ? 'pass'
                    : 'fail',
              };
              if (s2.validationOverrides && s2.validationOverrides.length > 0) {
                hoistedResult = applyOverrides(hoistedResult, s2.validationOverrides);
              }
              // Persist the second opinion even when it remains blocking.
              podRepo.update(podId, { lastValidationResult: hoistedResult });
              // The first pass for this attempt is already recorded. Replace
              // exactly that immutable history row with its adjudicated result.
              if (validationRecord) {
                validationRepo?.updateResult(validationRecord.id, hoistedResult);
              }
            } catch (err) {
              councilOwnership.assertCurrent();
              hoistError = err;
              logger.warn({ err, podId }, 'Auto-hoist deeper review failed');
            } finally {
              if (validationAbortControllers.get(podId) === councilController)
                validationAbortControllers.delete(podId);
            }

            // The review call is asynchronous: honor a concurrent kill or
            // skip-validation update instead of continuing with stale s2.
            s2 = podRepo.getOrThrow(podId);
            if (isTerminalState(s2.status) || s2.status === 'killing') return;
            if (hoistError && !s2.skipValidation) {
              emitActivityStatus(
                podId,
                'Independent retry-finding review failed — moving to review required',
              );
              transition(s2, 'review_required');
              return;
            }
            if (
              hoistedResult &&
              isReviewInfrastructureOnlyFailure(hoistedResult) &&
              !s2.skipValidation
            ) {
              emitActivityStatus(
                podId,
                `${reviewInfrastructureFailureLabel(hoistedResult)} during deeper review — moving to review required`,
              );
              await parkOnReviewInfrastructureFailure(s2);
              return;
            }

            if (hoistedResult && hoistedResult.overall === 'pass') {
              // Independent review did not reproduce the candidates.
              effectiveResult = hoistedResult;
              emitActivityStatus(podId, 'Independent council cleared retry findings');
              logger.info({ podId }, 'Independent council cleared retry findings');
            } else {
              // Recurring findings need a human decision; confirmed new
              // findings continue through ordinary correction.
              if (confirmedRecurring.length > 0) {
                emitActivityStatus(
                  podId,
                  `Deeper review still flagged ${confirmedRecurring.length} recurring finding(s) — escalating to human`,
                );

                const adjudicationBatch = adjudicationReviewBatch;

                const escalation: EscalationRequest = {
                  id: generateId(12),
                  podId,
                  type: 'validation_override',
                  timestamp: new Date().toISOString(),
                  payload: {
                    findings: confirmedRecurring,
                    attempt,
                    maxAttempts: s2.maxValidationAttempts,
                    adjudication: {
                      ...(adjudicationBatch?.reviewedHead
                        ? { reviewedHead: adjudicationBatch.reviewedHead }
                        : {}),
                      ...(adjudicationBatch?.diffHash
                        ? { diffHash: adjudicationBatch.diffHash }
                        : {}),
                      ...(originalReviewBatchId ? { originalReviewBatchId } : {}),
                      ...(adjudicationBatch?.id
                        ? { adjudicationReviewBatchId: adjudicationBatch.id }
                        : {}),
                      candidateFindingIds,
                      confirmedFindingIds: confirmedRecurring.map((finding) => finding.id).sort(),
                    },
                  },
                  response: null,
                };

                persistEscalation(podRepo, escalationRepo, escalation, () => {
                  transition(s2, 'awaiting_input', {
                    pendingEscalation: escalation,
                    escalationCount: s2.escalationCount + 1,
                  });
                });

                logger.info(
                  {
                    podId,
                    escalationId: escalation.id,
                    findingCount: confirmedRecurring.length,
                  },
                  'Validation override escalation created — waiting for human',
                );
                return; // Wait for human response via sendMessage()
              }
              if (confirmedNew.length > 0) {
                emitActivityStatus(
                  podId,
                  `Independent council confirmed ${confirmedNew.length} new retry finding(s)`,
                );
              }
              // Only primary retry findings reproduced by the independent
              // council remain actionable. Findings first seen by the second
              // opinion are evidence, never a fresh correction-cycle veto.
              if (hoistedResult) effectiveResult = hoistedResult;
            }
          }
        }
      }

      // Downstream persistence, PR metadata, and advisory QA must all use the
      // independently adjudicated result rather than the pre-adjudication pass.
      result = effectiveResult;

      // Skip-validation may have been toggled while this run was in flight — bypass result.
      const skipValidatedPod = applySkipValidationDecision(s2, result);
      if (skipValidatedPod) {
        maybeTriggerDependents(skipValidatedPod);
        return;
      }

      if (hasPendingFactDecision(effectiveResult)) {
        emitActivityStatus(
          podId,
          'Required fact pending human decision — moving to review required',
        );
        transition(s2, 'review_required');

        if (s2.containerId) {
          try {
            emitActivityStatus(podId, 'Stopping post-validation container…');
            await stopSandboxPreviewProxy(podId);
            const cm = containerManagerFactory.get(s2.executionTarget);
            await cm.stop(s2.containerId);
            logger.info({ podId }, 'Container stopped while awaiting fact deviation decision');
          } catch (stopErr) {
            logger.warn({ err: stopErr, podId }, 'Failed to stop container post-validation');
          }
        }
        return;
      }

      if (isReviewInfrastructureOnlyFailure(effectiveResult)) {
        emitActivityStatus(
          podId,
          `${reviewInfrastructureFailureLabel(effectiveResult)} — retry budget exhausted, moving to review required`,
        );
        transition(s2, 'review_required');

        if (s2.containerId) {
          try {
            emitActivityStatus(podId, 'Stopping post-validation container…');
            await stopSandboxPreviewProxy(podId);
            const cm = containerManagerFactory.get(s2.executionTarget);
            await cm.stop(s2.containerId);
            logger.info(
              { podId },
              'Container stopped after review infrastructure retries exhausted',
            );
          } catch (stopErr) {
            logger.warn({ err: stopErr, podId }, 'Failed to stop container post-validation');
          }
        }
        return;
      }

      if (effectiveResult.overall === 'pass') {
        await completeValidationPass.call(this, {
          podId,
          pod,
          profile,
          s2,
          result,
          validationSyncOk,
          attempt,
          validationConfig,
          validationRecord,
        });
      } else if (force || attempt < s2.maxValidationAttempts) {
        if (tryConsumeUpdateIntent()) return;

        if (options?.validationOnly) {
          emitActivityStatus(podId, 'Validation-only resume failed — agent rework was not started');
          transition(s2, 'failed');
          return;
        }

        emitActivityStatus(
          podId,
          `Validation failed (attempt ${attempt}/${s2.maxValidationAttempts}) — retrying`,
        );
        // Build correction message with structured feedback for the agent
        emitActivityStatus(podId, 'Sending validation feedback to agent…');
        const cm = containerManagerFactory.get(s2.executionTarget);
        let correctionMessage = await buildCorrectionMessage(s2, profile, effectiveResult, cm);
        const goalRework = await beginGoalTaskRework(s2, correctionMessage);

        // Flush overrides that arrived during the await above (race window: pod was still
        // `validating` so the override route couldn't queue a nudge for a running agent)
        const raceOverrides = deps.pendingOverrideRepo?.flush(podId) ?? [];
        if (raceOverrides.length > 0) {
          const merged = mergeOverrides(s2.validationOverrides ?? [], raceOverrides);
          podRepo.update(podId, { validationOverrides: merged });
          const overrideLines = raceOverrides.map((o) => {
            const detail =
              o.action === 'guidance' && o.guidance
                ? `Guidance: ${o.guidance}`
                : `Dismissed${o.reason ? `: ${o.reason}` : ''}`;
            return `- "${o.description}" — ${detail}`;
          });
          correctionMessage += `\n\n### Overridden Findings (a human reviewed these — do NOT address them)\n${overrideLines.join('\n')}`;
        }

        podRepo.update(podId, { lastCorrectionMessage: correctionMessage });

        // Transition back to running for retry
        transition(s2, 'running');

        // Only the runtime may retry a known idempotent setup command.
        // Replaying a whole turn after a timeout is unsafe even before the
        // first event: the provider may have accepted execution already.
        if (!s2.containerId) throw new Error(`Pod ${podId} has no container`);
        let outcome: AgentRunOutcome;
        emitActivityStatus(podId, 'Agent working on fixes…');
        try {
          const events = await taskFeedbackEvents(podId, correctionMessage, goalRework);
          outcome = await this.consumeAgentEvents(podId, events, attempt);
        } catch (error) {
          if (error instanceof AutopodError && error.code === 'AZURE_SANDBOX_TIMEOUT')
            throw new AutopodError(
              'Agent continuation timed out with an unverified execution outcome. No automatic replay was started; retained workspace and provider history require reconciliation before another turn.',
              'CONTINUATION_OUTCOME_UNVERIFIED',
              409,
            );
          throw error;
        }
        if (outcome === 'stopped') return;
        await persistRuntimeCredentialsForPod(
          podId,
          'Failed to persist rotated credentials after validation-feedback resume',
        );
        if (outcome !== 'completed') {
          logger.info(
            { podId, attempt, maxAttempts: s2.maxValidationAttempts, outcome },
            'Validation retry agent run did not complete',
          );
          return;
        }
        emitActivityStatus(podId, 'Agent finished applying fixes');
        await this.handleCompletion(podId);

        logger.info(
          {
            podId,
            attempt,
            maxAttempts: s2.maxValidationAttempts,
          },
          'Retrying after validation failure',
        );
      } else {
        if (tryConsumeUpdateIntent()) return;

        emitActivityStatus(
          podId,
          `Validation failed — max attempts (${s2.maxValidationAttempts}) exhausted, needs review`,
        );
        transition(s2, 'review_required');

        // Stop the container (not remove) so it can be restarted for preview
        if (s2.containerId) {
          try {
            emitActivityStatus(podId, 'Stopping post-validation container…');
            await stopSandboxPreviewProxy(podId);
            const cm = containerManagerFactory.get(s2.executionTarget);
            await cm.stop(s2.containerId);
            logger.info({ podId }, 'Container stopped after max validation attempts');
          } catch (stopErr) {
            logger.warn({ err: stopErr, podId }, 'Failed to stop container post-validation');
          }
        }
      }
    } catch (err) {
      if (
        err instanceof AgentContinuationSupersededError ||
        err instanceof ValidationSupersededError
      )
        return;
      logger.error({ err, podId }, 'Validation error');
      const s2 = podRepo.getOrThrow(podId);
      if (err instanceof TaskRetryBlockedError) {
        await parkOnRetryAdmission(s2, err);
        return;
      }

      if (isParkedHostPushRecovery(s2)) {
        logger.info({ podId, status: s2.status }, 'Validation error already parked for retry');
        return;
      }
      if (s2.status === 'validated' && s2.linkedPodId) {
        parkFixPodDeliveryFailure(s2, err);
        return;
      }

      if (podRepo.validationExecutions?.unsettled(podId) || requiresValidationSettlement(s2)) {
        emitActivityStatus(
          podId,
          'Validation custody remains held; original source and reports retained. Inspect execution recovery evidence before any retry or source mutation.',
        );
        if (s2.status === 'validating') transition(s2, 'review_required');
        return;
      }
      // Pod is still `validating`; runUpdateFromBaseAfterAbort handles status transitions.
      if (tryConsumeUpdateIntent()) return;

      const failureReason = sanitizeFailureReason(
        err,
        'Validation failed before checks could complete',
      );
      emitActivityError(podId, failureReason);
      transition(s2, 'failed', { failureReason });

      // Stop the container (not remove) so it can be restarted for preview
      if (s2.containerId) {
        try {
          emitActivityStatus(podId, 'Stopping post-validation container…');
          await stopSandboxPreviewProxy(podId);
          const cm = containerManagerFactory.get(s2.executionTarget);
          await cm.stop(s2.containerId);
        } catch (stopErr) {
          logger.warn({ err: stopErr, podId }, 'Failed to stop container post-validation');
        }
      }
    }
  }

  return { triggerValidation };
}
