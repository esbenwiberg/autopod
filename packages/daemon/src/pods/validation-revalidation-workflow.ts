import { AutopodError } from '@autopod/shared';
import { isExpectedDockerError } from '../containers/docker-helpers.js';
import { parseDiffFilePaths } from '../validation/review-context-builder.js';
import { buildValidationContextEnv } from '../validation/validation-context-env.js';
import {
  type AdoptedSourceValidationRequest,
  openAdoptedSourceValidation,
} from './adopted-source-validation.js';
import { resolveReviewerModel, resolveReviewerProvider } from './runtime-resolver.js';
import { sourceAdoptionError } from './source-adoption-repository.js';
import { isTerminalState } from './state-machine.js';
import { TaskRetryBlockedError } from './task-retry-ledger.js';
import {
  isReviewInfrastructureOnlyFailure,
  isValidationInfrastructureOnlyFailure,
  reviewInfrastructureFailureLabel,
} from './validation-infrastructure.js';
import { ValidationSupersededError } from './validation-ownership.js';
import {
  assertValidationExecutionSettled,
  assertValidationMutationSettled,
  captureValidationMutationGuard,
  guardValidationContainer,
  requiresValidationSettlement,
} from './validation-recovery-policy.js';
import {
  assertProtectedOperationalPathsInScope,
  getPodValidationSkipPhases,
  getPodValidationSuite,
  loadCodeReviewSkill,
  summarizeValidationPhases,
} from './validation-workflow-policy.js';
import type {
  ValidationRevalidationCaptured,
  ValidationWorkflowCalls,
  ValidationWorkflowLiveDependencies,
} from './validation-workflow-ports.js';
import { ValidationWorkspaceReconcileError } from './validation-workspace.js';

export function createValidationRevalidationWorkflow(
  _deps: ValidationWorkflowLiveDependencies,
  captured: ValidationRevalidationCaptured,
) {
  const {
    CONTAINER_APP_PORT,
    podRepo,
    eventBus,
    containerManagerFactory,
    worktreeManager,
    validationEngine,
    enqueueSession,
    logger,
    validationRepo,
    executionForPod,
    validationEnvironmentForPod,
    assertExecutionTerminationVerified,
    assertGuidanceCollected,
    resolveGitCredential,
    runPushCheckpointScan,
    validationAbortControllers,
    buildReviewerExecEnv,
    getEffectiveReviewerConfig,
    getReviewerExecutor,
    prepareWorkspaceForValidation,
    buildPhaseEventCallbacks,
    validateWithInfrastructureRetries,
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
    completeRevalidationPass,
  } = captured;

  async function executeRevalidation(
    this: Pick<ValidationWorkflowCalls, 'approveSession'>,
    podId: string,
    options?: {
      force?: boolean;
      checksOnly?: boolean;
      adoptedSource?: AdoptedSourceValidationRequest;
    },
  ): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }> {
    const pod = podRepo.getOrThrow(podId);
    if (!options?.adoptedSource && podRepo.sourceAdoptions?.hasCustody(podId))
      sourceAdoptionError(
        'Use source-bound checks; ordinary revalidation may pull or rewrite preserved source.',
        'SOURCE_CHECKS_REQUIRED',
      );
    assertExecutionTerminationVerified(podId);
    assertGuidanceCollected(podId);
    assertValidationExecutionSettled(pod, podRepo.validationExecutions?.isSettled(pod));
    if (
      options?.adoptedSource &&
      (_deps.launchConfiguration?.read(podId)?.intent === 'goal' ||
        _deps.launchConfiguration?.goals?.get(podId))
    )
      sourceAdoptionError(
        'Native Goal source adoption requires its own reviewed revision flow',
        'SOURCE_GOAL_UNSUPPORTED',
      );
    if (options?.adoptedSource) assertValidationExecutionSettled(pod);
    const adopted = options?.adoptedSource
      ? openAdoptedSourceValidation(
          podRepo,
          podId,
          options.adoptedSource,
          executionForPod,
          assertGuidanceCollected,
        )
      : undefined;
    const owned = <T>(operation: () => Promise<T>) =>
      adopted ? adopted.owned(operation) : operation();
    let assertPreflight = captureValidationMutationGuard(podRepo, pod);
    const preflight = async <T>(operation: () => Promise<T>): Promise<T> => {
      assertPreflight();
      try {
        return await owned(operation);
      } finally {
        assertPreflight();
      }
    };
    const force = options?.force ?? false;
    if (
      pod.status !== 'failed' &&
      pod.status !== 'review_required' &&
      !(adopted && pod.status === 'validated')
    ) {
      throw new AutopodError(
        `Cannot revalidate pod ${podId} in status ${pod.status} — only failed or review_required pods can be revalidated`,
        'INVALID_STATE',
        409,
      );
    }
    if (!pod.worktreePath) {
      throw new AutopodError(
        `Pod ${podId} has no worktree — cannot pull latest`,
        'INVALID_STATE',
        400,
      );
    }
    const revalidationWorktreePath = pod.worktreePath;
    let newCommits = false;
    const requeueValidationOnly = (message: string): { newCommits: boolean; result: 'fail' } => {
      if (options?.checksOnly)
        throw new AutopodError(
          'Retained validation resource is unavailable. Restore it or request Fix validation; no new worker or delivery was queued.',
          'VALIDATION_RESOURCE_UNAVAILABLE',
          409,
        );
      emitActivityStatus(podId, message);
      podRepo.update(podId, {
        validationAttempts: 0,
        containerId: null,
        recoveryWorktreePath: revalidationWorktreePath,
        skipAgent: true,
        lastValidationResult: null,
        failureReason: null,
      });
      transition(podRepo.getOrThrow(podId), 'queued');
      enqueueSession(podId);
      logger.info({ podId }, 'Revalidation queued with fresh container and skipAgent');
      return { newCommits, result: 'fail' };
    };

    const profile = executionForPod(pod);
    // Pull latest from remote branch (human may have pushed fixes). Failures are
    // tolerated when force=true so a resume with no remote access (e.g. revoked
    // PAT) still reaches the validation engine on the existing worktree.
    if (adopted) {
      if (
        getPodValidationSuite(pod) !== 'full' ||
        pod.options.validate === false ||
        pod.skipValidation ||
        getPodValidationSkipPhases(profile, pod).length > 0
      )
        sourceAdoptionError(
          'Adopted-source checks require full validation without phase skips or waivers',
          'SOURCE_CHECKS_BYPASSED',
        );
      adopted.claimInvocation();
      await adopted.verify();
      newCommits = true;
    } else {
      emitActivityStatus(podId, 'Pulling latest changes from remote branch…');
      try {
        assertPreflight();
        const pat = await resolveGitCredential(profile);
        assertPreflight();
        const pullResult = await worktreeManager.pullBranch(revalidationWorktreePath, pat);
        assertPreflight();
        newCommits = pullResult.newCommits;
      } catch (err) {
        assertPreflight();
        if (!force) throw err;
        logger.warn({ err, podId }, 'pullBranch failed — proceeding (force=true)');
        emitActivityStatus(podId, 'Could not pull from remote — revalidating local worktree');
      }
    }

    // Without `force`, no-new-commits is a fast-fail: the only legitimate caller is
    // a human-fix workspace flow, where the human just pushed. With `force` (Resume),
    // the operator is asserting that the prior failure was infra/transient and wants
    // a fresh validation run against the same code.
    if (!newCommits && !force) {
      logger.info({ podId }, 'No new commits on branch — skipping revalidation');
      emitActivityStatus(podId, 'No new commits found — nothing to revalidate');
      return { newCommits: false, result: 'fail' };
    }
    if (!newCommits && force) {
      logger.info({ podId }, 'Resume: revalidating without new commits (force=true)');
      emitActivityStatus(podId, 'Resuming — revalidating with existing worktree');
    }

    const validationSuite = getPodValidationSuite(pod);
    logger.info({ podId, newCommits, force, validationSuite }, 'Running revalidation');
    if (newCommits) {
      emitActivityStatus(podId, `New commits detected — starting ${validationSuite} validation…`);
    } else {
      emitActivityStatus(podId, `Starting ${validationSuite} validation-only resume…`);
    }

    // Reset validation attempts for the fresh human-driven validation
    if (!adopted) podRepo.update(podId, { validationAttempts: 0 });

    // Pre-push security scan: human-pushed fixes also need to clear the gate.
    await preflight(() => runPushCheckpointScan(pod, profile));

    // Transition to validating
    if (!pod.containerId && force) {
      return requeueValidationOnly(
        'Resume: container missing — re-provisioning for validation only',
      );
    }
    assertPreflight();
    const validationPod = transition(pod, 'validating', { failureReason: null });
    assertPreflight = captureValidationMutationGuard(podRepo, validationPod);

    // Re-run validation (force=true restarts container, but we don't want agent retry on failure)
    const attempt = adopted ? pod.validationAttempts + 1 : 1;
    podRepo.update(podId, { validationAttempts: attempt });

    // Reset the desktop Validation tab chips for this fresh attempt — without this,
    // the UI keeps the previous run's stale ValidationProgress.
    eventBus.emit({
      type: 'pod.validation_started',
      timestamp: new Date().toISOString(),
      podId,
      attempt,
    });

    emitActivityStatus(
      podId,
      newCommits ? 'Starting revalidation (human fix)…' : 'Starting revalidation…',
    );

    try {
      if (!pod.containerId) {
        throw new Error(`Pod ${podId} has no container — cannot validate`);
      }

      // Restart the container with updated worktree
      const cm = guardValidationContainer(containerManagerFactory.get(pod.executionTarget), () =>
        assertPreflight(),
      );
      try {
        if (adopted) {
          const status = await owned(() => cm.getStatus(pod.containerId as string));
          if (status !== 'running')
            sourceAdoptionError(
              'The exact adopted resource must already be Running; no replacement or second wakeup is permitted.',
              'VALIDATION_RESOURCE_UNAVAILABLE',
            );
        } else await cm.start(pod.containerId);
      } catch (err) {
        if (adopted) throw err;
        if (isExpectedDockerError(err, [404])) {
          podRepo.update(podId, { containerId: null });
          if (force) {
            transition(podRepo.getOrThrow(podId), 'failed');
            return requeueValidationOnly(
              'Resume: container no longer exists — re-provisioning for validation only',
            );
          }
          throw new AutopodError(
            `Container for pod ${podId} no longer exists — use "Retry" to re-provision`,
            'CONTAINER_NOT_FOUND',
            409,
          );
        }
        throw err;
      }

      // Revalidation runs host-side browser facts from worktreePath, so the host
      // worktree must reflect the live /workspace before reading diffs or facts.
      emitActivityStatus(podId, 'Syncing workspace…');
      let validationSyncOk = true;
      if (adopted) await adopted.verify();
      if (!adopted && pod.containerId && pod.worktreePath) {
        try {
          await prepareWorkspaceForValidation(
            pod.containerId,
            pod.worktreePath,
            cm,
            podId,
            pod.executionTarget,
          );
        } catch (err) {
          logger.warn({ err, podId }, 'Failed to sync workspace before revalidation');
          // Under an explicit operator resume (force), a workspace-sync failure
          // against the *reused* container is almost always a cold/expired sandbox
          // that can no longer serve /workspace (or an in-place reconcile that can't
          // engage). The committed work lives in the recovery worktree, so the robust
          // move is to re-provision a fresh container from it and validate the existing
          // commits — a fresh container starts at the worktree HEAD, so there is no
          // divergence to reconcile — rather than parking the pod as compromised.
          if (force) {
            // Drop back to `failed` first — requeueValidationOnly re-queues from a
            // terminal state, and `validating → queued` is not a legal transition.
            transition(podRepo.getOrThrow(podId), 'failed');
            return requeueValidationOnly(
              'Resume: reused container could not serve workspace — re-provisioning fresh for validation only',
            );
          }
          validationSyncOk =
            err instanceof ValidationWorkspaceReconcileError
              ? false
              : await tryRecoverAfterWorkspaceSyncFailure(validationPod, err, 'validation');
        }
      }
      if (!validationSyncOk) {
        parkOnWorktreeSyncFailure(
          podId,
          'Workspace sync failed before revalidation — validation blocked.',
        );
        return { newCommits, result: 'fail' };
      }

      const revalDefaultBranch = pod.baseBranch ?? profile.defaultBranch ?? 'main';
      const revalidationExecEnv = {
        ...((await owned(() => validationEnvironmentForPod(pod, profile))) ?? {}),
        ...buildValidationContextEnv({
          podId,
          headBranch: pod.branch,
          baseBranch: revalDefaultBranch,
          startCommitSha: pod.startCommitSha,
        }),
      };
      const [diff, commitLog] = pod.worktreePath
        ? await owned(() =>
            Promise.all([
              worktreeManager.getDiff(
                pod.worktreePath,
                revalDefaultBranch,
                undefined,
                pod.startCommitSha ?? undefined,
              ),
              worktreeManager.getCommitLog(
                pod.worktreePath,
                revalDefaultBranch,
                undefined,
                pod.startCommitSha ?? undefined,
              ),
            ]),
          )
        : ['', ''];
      const changedPathsAgainstBase =
        pod.worktreePath && worktreeManager.getChangedPathsAgainstBase
          ? await owned(() =>
              worktreeManager.getChangedPathsAgainstBase!(
                pod.worktreePath as string,
                revalDefaultBranch,
              ),
            )
          : parseDiffFilePaths(diff);
      assertProtectedOperationalPathsInScope(pod, changedPathsAgainstBase);

      const codeReviewSkill = pod.worktreePath
        ? await owned(() => loadCodeReviewSkill(pod.worktreePath as string, logger))
        : undefined;

      const { profile: reviewerProfile, credentials: reviewerProviderCredentials } =
        getEffectiveReviewerConfig(pod);
      const reviewerExecEnv = await owned(() => buildReviewerExecEnv(pod));
      const priorReviewBatch = adopted ? undefined : validationRepo?.getLatestReviewBatch(podId);
      const validationConfig = {
        podId,
        containerId: pod.containerId,
        executionTarget: pod.executionTarget,
        previewUrl: pod.previewUrl ?? `http://127.0.0.1:${CONTAINER_APP_PORT}`,
        containerBaseUrl: `http://127.0.0.1:${CONTAINER_APP_PORT}`,
        webProbeMode:
          pod.executionTarget === 'sandbox' ? ('container' as const) : ('host' as const),
        validationSetupCommand:
          adopted?.setupCommand ?? profile.validationSetupCommand ?? undefined,
        buildCommand: profile.buildCommand ?? '',
        startCommand: profile.startCommand ?? '',
        buildWorkDir: profile.buildWorkDir ?? undefined,
        healthPath: profile.healthPath ?? '/',
        healthTimeout: profile.healthTimeout ?? 120,
        smokePages: profile.smokePages,
        attempt,
        validationSuite,
        task: pod.task,
        diff,
        testCommand: profile.testCommand,
        buildTimeout: (profile.buildTimeout ?? 300) * 1_000,
        testTimeout: (profile.testTimeout ?? 600) * 1_000,
        lintCommand: profile.lintCommand ?? undefined,
        lintTimeout: (profile.lintTimeout ?? 120) * 1_000,
        sastCommand: profile.sastCommand ?? undefined,
        sastTimeout: (profile.sastTimeout ?? 300) * 1_000,
        reviewerModel: resolveReviewerModel(reviewerProfile, logger),
        reviewerProvider: resolveReviewerProvider(reviewerProfile),
        reviewerProviderAccountId: reviewerProfile.providerAccountId ?? null,
        reviewerProviderCredentials,
        ...(reviewerExecEnv ? { reviewerExecEnv } : {}),
        reviewerExecutor: getReviewerExecutor(pod),
        contract: pod.contract ?? undefined,
        codeReviewSkill,
        commitLog: commitLog || undefined,
        plan: pod.plan ?? undefined,
        taskSummary: pod.taskSummary ?? undefined,
        worktreePath: pod.worktreePath ?? undefined,
        startCommitSha: pod.startCommitSha ?? undefined,
        hasWebUi: profile.hasWebUi ?? true,
        advisoryBrowserQaEnabled: pod.options.advisoryBrowserQaEnabled ?? false,
        preSubmitReview: adopted ? undefined : (pod.preSubmitReview ?? undefined),
        skipPhases: getPodValidationSkipPhases(profile, pod),
        priorReviewBatch,
        extraExecEnv: revalidationExecEnv,
      };

      let result: Awaited<ReturnType<typeof validationEngine.validate>>;
      const revalidateController = new AbortController();
      if (adopted) await adopted.verify();
      const baseOwnership = claimValidation(pod, revalidateController);
      const ownership = adopted
        ? {
            assertCurrent() {
              adopted.assertCurrent();
              return baseOwnership.assertCurrent();
            },
            isCurrent() {
              try {
                this.assertCurrent();
                return true;
              } catch {
                return false;
              }
            },
          }
        : baseOwnership;
      try {
        result = await validateWithInfrastructureRetries(
          validationConfig,
          revalidateController,
          buildPhaseEventCallbacks(podId),
          'Revalidation engine threw unexpectedly',
          ownership,
        );
        if (options?.adoptedSource)
          podRepo.sourceAdoptions?.observeChecksResult(options.adoptedSource.operationId, result);
        ownership.assertCurrent();
        if (adopted) {
          await adopted.verify();
          ownership.assertCurrent();
          if (result.overall === 'pass' && result.setup?.status !== 'pass')
            sourceAdoptionError(
              'Dependency setup did not produce passing execution evidence',
              'SOURCE_DEPENDENCY_SETUP_UNVERIFIED',
            );
        }
      } finally {
        if (validationAbortControllers.get(podId) === revalidateController)
          validationAbortControllers.delete(podId);
      }

      emitActivityStatus(podId, 'Validation checks finished — finalizing result…');

      const validationRecord = publishValidationResult(podId, attempt, result);

      const s2 = podRepo.getOrThrow(podId);

      if (isTerminalState(s2.status) || s2.status === 'killing') {
        return { newCommits, result: 'fail' };
      }

      if (requiresValidationSettlement({ lastValidationResult: result })) {
        if (result.infrastructureFailure?.code === 'VALIDATION_ENGINE_TERMINATION_UNVERIFIED') {
          emitActivityStatus(
            podId,
            'Validation engine failed without termination evidence; retain original source and reports. Retry and source mutation remain blocked.',
          );
          transition(s2, 'failed');
        } else await parkOnValidationInfrastructureFailure(s2, result);
        return { newCommits, result: 'fail' };
      }
      assertValidationMutationSettled(podRepo, podId);

      const skipValidatedPod = options?.checksOnly
        ? undefined
        : applySkipValidationDecision(s2, result);
      if (skipValidatedPod) {
        maybeTriggerDependents(skipValidatedPod);
        if (skipValidatedPod.containerId) {
          try {
            emitActivityStatus(podId, 'Stopping post-validation container…');
            const cm2 = containerManagerFactory.get(skipValidatedPod.executionTarget);
            await cm2.stop(skipValidatedPod.containerId);
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to stop container after waived revalidation');
          }
        }
        return { newCommits, result: 'pass' };
      }

      if (isValidationInfrastructureOnlyFailure(result)) {
        await parkOnValidationInfrastructureFailure(s2, result);
        return { newCommits, result: 'fail' };
      }

      if (isReviewInfrastructureOnlyFailure(result)) {
        await parkOnReviewInfrastructureFailure(s2);
        return { newCommits, result: 'fail' };
      }

      if (result.overall === 'pass') {
        return await owned(() =>
          completeRevalidationPass.call(this, {
            podId,
            pod,
            profile,
            s2,
            result,
            revalDefaultBranch,
            newCommits,
            validationConfig,
            validationRecord,
            checksOnly: options?.checksOnly,
          }),
        );
      }

      if (isReviewInfrastructureOnlyFailure(result)) {
        emitActivityStatus(
          podId,
          `${reviewInfrastructureFailureLabel(result)} — retry budget exhausted, moving to review required`,
        );
        transition(s2, 'review_required');

        if (s2.containerId) {
          try {
            emitActivityStatus(podId, 'Stopping post-validation container…');
            const cm2 = containerManagerFactory.get(s2.executionTarget);
            await cm2.stop(s2.containerId);
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to stop container post-revalidation');
          }
        }

        return { newCommits, result: 'fail' };
      }

      // Validation failed — stay in failed state, no agent rework
      emitActivityStatus(podId, `Revalidation fail — ${summarizeValidationPhases(result)}`);
      if (result.taskReview && result.taskReview.status !== 'pass') {
        if (result.taskReview.reasoning) {
          emitActivityStatus(podId, `Review: ${result.taskReview.reasoning}`);
        }
        for (const issue of result.taskReview.issues) {
          emitActivityStatus(podId, `  → ${issue}`);
        }
      }
      emitActivityStatus(podId, 'Revalidation failed — human fix did not resolve all issues');
      transition(s2, 'failed', {
        failureReason: `Revalidation failed — ${summarizeValidationPhases(result)}`,
      });

      if (s2.containerId) {
        try {
          emitActivityStatus(podId, 'Stopping post-validation container…');
          const cm2 = containerManagerFactory.get(s2.executionTarget);
          await cm2.stop(s2.containerId);
        } catch (err) {
          logger.warn({ err, podId }, 'Failed to stop container post-revalidation');
        }
      }

      return { newCommits, result: 'fail' };
    } catch (err) {
      if (adopted) {
        if (err instanceof ValidationSupersededError) throw err;
        adopted.assertCurrent();
        const current = podRepo.getOrThrow(podId);
        if (err instanceof TaskRetryBlockedError)
          await owned(() => parkOnRetryAdmission(current, err));
        else if (current.status === 'validating')
          transition(current, 'review_required', {
            failureReason: sanitizeFailureReason(
              err,
              'Source-bound validation could not be certified; original custody remains held',
            ),
          });
        throw err;
      }
      if (err instanceof ValidationSupersededError) return { newCommits, result: 'fail' };
      logger.error({ err, podId }, 'Revalidation error');
      const s2 = podRepo.getOrThrow(podId);
      if (err instanceof TaskRetryBlockedError) {
        await parkOnRetryAdmission(s2, err);
        return { newCommits, result: 'fail' };
      }
      const failureReason = sanitizeFailureReason(
        err,
        'Validation failed before checks could complete',
      );
      emitActivityError(podId, failureReason);
      if (s2.status === 'failed') podRepo.update(podId, { failureReason });
      else if (!isTerminalState(s2.status) && s2.status !== 'killing')
        transition(s2, 'failed', { failureReason });
      return { newCommits, result: 'fail' };
    }
  }

  function revalidateSession(
    this: Pick<ValidationWorkflowCalls, 'approveSession'>,
    podId: string,
    options?: { force?: boolean; checksOnly?: boolean },
  ) {
    return executeRevalidation.call(this, podId, options);
  }
  function revalidateAdoptedSource(podId: string, request: AdoptedSourceValidationRequest) {
    return executeRevalidation.call(
      {
        approveSession: async () => {
          sourceAdoptionError(
            'Source adoption never authorizes approval or merge',
            'SOURCE_ADOPTION_DELIVERY_HELD',
          );
        },
      },
      podId,
      { force: true, checksOnly: true, adoptedSource: request },
    );
  }
  return { revalidateSession, revalidateAdoptedSource };
}
