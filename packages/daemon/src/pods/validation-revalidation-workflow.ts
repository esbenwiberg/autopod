import { AutopodError } from '@autopod/shared';
import { isExpectedDockerError } from '../containers/docker-helpers.js';
import { parseDiffFilePaths } from '../validation/review-context-builder.js';
import { publishScreenshotArtifacts } from '../validation/screenshot-artifacts.js';
import { buildValidationContextEnv } from '../validation/validation-context-env.js';
import { resolveReviewerModel, resolveReviewerProvider } from './runtime-resolver.js';
import { isTerminalState } from './state-machine.js';
import { TaskRetryBlockedError } from './task-retry-ledger.js';
import {
  isReviewInfrastructureOnlyFailure,
  isValidationInfrastructureOnlyFailure,
  reviewInfrastructureFailureLabel,
} from './validation-infrastructure.js';
import { ValidationSupersededError } from './validation-ownership.js';
import {
  assertProtectedOperationalPathsInScope,
  getPodValidationSkipPhases,
  getPodValidationSuite,
  loadCodeReviewSkill,
  summarizeValidationPhases,
} from './validation-workflow-policy.js';
import type {
  ValidationWorkflowCalls,
  ValidationWorkflowDependencies,
  ValidationWorkflowLiveDependencies,
} from './validation-workflow-ports.js';
import { ValidationWorkspaceReconcileError } from './validation-workspace.js';

type Captured = Pick<
  ValidationWorkflowDependencies,
  | 'CONTAINER_APP_PORT'
  | 'warnIfSinglePrSeriesMissingSeriesMeta'
  | 'resolvePrBaseBranch'
  | 'podRepo'
  | 'eventBus'
  | 'containerManagerFactory'
  | 'worktreeManager'
  | 'validationEngine'
  | 'enqueueSession'
  | 'logger'
  | 'validationRepo'
  | 'executionForPod'
  | 'validationEnvironmentForPod'
  | 'prManagerFactory'
  | 'assertExecutionTerminationVerified'
  | 'assertGuidanceCollected'
  | 'resolveGitCredential'
  | 'refreshReadiness'
  | 'runPushCheckpointScan'
  | 'getLatestPushFindings'
  | 'validationAbortControllers'
  | 'buildReviewerExecEnv'
  | 'getEffectiveReviewerConfig'
  | 'getReviewerExecutor'
  | 'prepareWorkspaceForValidation'
  | 'buildPhaseEventCallbacks'
  | 'validateWithInfrastructureRetries'
  | 'publishValidationResult'
  | 'parkOnRetryAdmission'
  | 'parkOnValidationInfrastructureFailure'
  | 'parkOnReviewInfrastructureFailure'
  | 'emitActivityStatus'
  | 'emitActivityError'
  | 'sanitizeFailureReason'
  | 'tryRecoverAfterWorkspaceSyncFailure'
  | 'advisoryPublicationOwnership'
  | 'runAdvisoryAfterValidation'
  | 'handleDeletionGuardError'
  | 'parkOnWorktreeSyncFailure'
  | 'ensurePrBaseBranchOnOrigin'
  | 'transition'
  | 'applySkipValidationDecision'
  | 'claimValidation'
  | 'maybeTriggerDependents'
>;

export function createValidationRevalidationWorkflow(
  _deps: ValidationWorkflowLiveDependencies,
  captured: Captured,
) {
  const {
    CONTAINER_APP_PORT,
    warnIfSinglePrSeriesMissingSeriesMeta,
    resolvePrBaseBranch,
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
    prManagerFactory,
    assertExecutionTerminationVerified,
    assertGuidanceCollected,
    resolveGitCredential,
    refreshReadiness,
    runPushCheckpointScan,
    getLatestPushFindings,
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
    advisoryPublicationOwnership,
    runAdvisoryAfterValidation,
    handleDeletionGuardError,
    parkOnWorktreeSyncFailure,
    ensurePrBaseBranchOnOrigin,
    transition,
    applySkipValidationDecision,
    claimValidation,
    maybeTriggerDependents,
  } = captured;

  async function revalidateSession(
    this: Pick<ValidationWorkflowCalls, 'approveSession'>,
    podId: string,
    options?: { force?: boolean },
  ): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }> {
    assertExecutionTerminationVerified(podId);
    assertGuidanceCollected(podId);
    const pod = podRepo.getOrThrow(podId);
    const force = options?.force ?? false;
    if (pod.status !== 'failed' && pod.status !== 'review_required') {
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
    emitActivityStatus(podId, 'Pulling latest changes from remote branch…');
    try {
      const pullResult = await worktreeManager.pullBranch(
        pod.worktreePath,
        await resolveGitCredential(profile),
      );
      newCommits = pullResult.newCommits;
    } catch (err) {
      if (!force) throw err;
      logger.warn({ err, podId }, 'pullBranch failed — proceeding (force=true)');
      emitActivityStatus(podId, 'Could not pull from remote — revalidating local worktree');
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
    podRepo.update(podId, { validationAttempts: 0 });

    // Pre-push security scan: human-pushed fixes also need to clear the gate.
    await runPushCheckpointScan(pod, profile);

    // Transition to validating
    if (!pod.containerId && force) {
      return requeueValidationOnly(
        'Resume: container missing — re-provisioning for validation only',
      );
    }
    transition(pod, 'validating', { failureReason: null });

    // Re-run validation (force=true restarts container, but we don't want agent retry on failure)
    const attempt = 1;
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
      const cm = containerManagerFactory.get(pod.executionTarget);
      try {
        await cm.start(pod.containerId);
      } catch (err) {
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
      if (pod.containerId && pod.worktreePath) {
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
              : await tryRecoverAfterWorkspaceSyncFailure(pod, err, 'validation');
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
        ...((await validationEnvironmentForPod(pod, profile)) ?? {}),
        ...buildValidationContextEnv({
          podId,
          headBranch: pod.branch,
          baseBranch: revalDefaultBranch,
          startCommitSha: pod.startCommitSha,
        }),
      };
      const [diff, commitLog] = pod.worktreePath
        ? await Promise.all([
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
          ])
        : ['', ''];
      const changedPathsAgainstBase =
        pod.worktreePath && worktreeManager.getChangedPathsAgainstBase
          ? await worktreeManager.getChangedPathsAgainstBase(pod.worktreePath, revalDefaultBranch)
          : parseDiffFilePaths(diff);
      assertProtectedOperationalPathsInScope(pod, changedPathsAgainstBase);

      const codeReviewSkill = pod.worktreePath
        ? await loadCodeReviewSkill(pod.worktreePath, logger)
        : undefined;

      const { profile: reviewerProfile, credentials: reviewerProviderCredentials } =
        getEffectiveReviewerConfig(pod);
      const reviewerExecEnv = await buildReviewerExecEnv(pod);
      const priorReviewBatch = validationRepo?.getLatestReviewBatch(podId);
      const validationConfig = {
        podId,
        containerId: pod.containerId,
        executionTarget: pod.executionTarget,
        previewUrl: pod.previewUrl ?? `http://127.0.0.1:${CONTAINER_APP_PORT}`,
        containerBaseUrl: `http://127.0.0.1:${CONTAINER_APP_PORT}`,
        webProbeMode:
          pod.executionTarget === 'sandbox' ? ('container' as const) : ('host' as const),
        validationSetupCommand: profile.validationSetupCommand ?? undefined,
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
        preSubmitReview: pod.preSubmitReview ?? undefined,
        skipPhases: getPodValidationSkipPhases(profile, pod),
        priorReviewBatch,
        extraExecEnv: revalidationExecEnv,
      };

      let result: Awaited<ReturnType<typeof validationEngine.validate>>;
      const revalidateController = new AbortController();
      const ownership = claimValidation(pod, revalidateController);
      try {
        result = await validateWithInfrastructureRetries(
          validationConfig,
          revalidateController,
          buildPhaseEventCallbacks(podId),
          'Revalidation engine threw unexpectedly',
          ownership,
        );
        ownership.assertCurrent();
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

      const skipValidatedPod = applySkipValidationDecision(s2, result);
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
        emitActivityStatus(podId, 'Revalidation passed — human fix worked!');

        // Push branch and create PR (same as triggerValidation pass path).
        // Fix pods already have prUrl set — carry it forward and skip PR creation.
        let prUrl: string | null = s2.prUrl ?? null;
        const prManager = prManagerFactory ? prManagerFactory(profile) : null;
        if (prManager && s2.worktreePath && s2.options.output === 'pr') {
          // Same artifact ref as the validation-pass path — never the reviewed
          // branch. This path builds no PR body, so the ref is simply where a
          // reviewer can find the screenshots.
          if (profile.prProvider !== 'ado') {
            await publishScreenshotArtifacts({
              worktreeManager,
              logger,
              podId,
              worktreePath: s2.worktreePath,
              pat: await resolveGitCredential(profile),
            });
          }

          try {
            // revalidateSession runs on a worktree just pushed by a human — nothing should
            // be uncommitted. If git add -A finds phantom deletions, it's a sync artifact,
            // not real work; block it.
            await worktreeManager.mergeBranch({
              worktreePath: s2.worktreePath,
              // Push the feature branch up — the PR is opened against revalDefaultBranch
              // separately by the PR manager.
              targetBranch: s2.branch,
              // Pass the PAT explicitly — revalidation often runs after a daemon restart,
              // when the in-memory PAT cache for this bare repo is cold.
              pat: await resolveGitCredential(profile),
              maxDeletions: 0,
              podTask: pod.task,
              profile,
              podModel: pod.model,
            });
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to push branch for PR');
            if (!handleDeletionGuardError(podId, err)) {
              throw err;
            }
          }

          try {
            const failSinceCommit = s2.startCommitSha ?? undefined;
            const failBaseBranch = s2.baseBranch ?? revalDefaultBranch;
            const stats = await worktreeManager.getDiffStats(
              s2.worktreePath,
              failBaseBranch,
              failSinceCommit,
            );
            podRepo.update(podId, {
              filesChanged: stats.filesChanged,
              linesAdded: stats.linesAdded,
              linesRemoved: stats.linesRemoved,
            });
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to recompute diff stats');
          }

          if (!prUrl) {
            try {
              emitActivityStatus(podId, 'Creating PR…');
              const s3 = podRepo.getOrThrow(podId);
              warnIfSinglePrSeriesMissingSeriesMeta(s2, logger);
              const baseBranch = resolvePrBaseBranch(s2, profile);
              await ensurePrBaseBranchOnOrigin(s2, profile, baseBranch, 'revalidation_pass');
              const createResult = await prManager.createPr({
                // biome-ignore lint/style/noNonNullAssertion: worktreePath is non-null here — PR creation only occurs for non-artifact pods which always have a worktree
                worktreePath: s2.worktreePath!,
                repoUrl: profile.repoUrl ?? undefined,
                branch: s2.branch,
                baseBranch,
                podId,
                task: s2.task,
                profileName: s2.profileName,
                profile,
                podModel: s2.model,
                handoffInstructions: s2.handoffInstructions ?? undefined,
                validationResult: result,
                validationWaiver: s3.validationWaiver,
                filesChanged: s3.filesChanged,
                linesAdded: s3.linesAdded,
                linesRemoved: s3.linesRemoved,
                previewUrl: s2.previewUrl,
                screenshots: [],
                taskSummary: s3.taskSummary ?? undefined,
                seriesDescription: s2.seriesDescription ?? undefined,
                seriesName: s2.seriesName ?? undefined,
                securityFindings: getLatestPushFindings(podId),
              });
              prUrl = createResult.url;
              if (createResult.usedFallback) {
                const which = createResult.narrativeUsedFallback
                  ? createResult.titleUsedFallback
                    ? 'title + body'
                    : 'body'
                  : 'title';
                const reason = createResult.fallbackReason ?? 'unknown';
                logger.error(
                  {
                    podId,
                    profile: profile.name,
                    modelProvider: profile.modelProvider,
                    fallbackReason: reason,
                    fallbackDetail: createResult.fallbackDetail,
                  },
                  'PR description used template fallback during revalidation',
                );
                emitActivityStatus(podId, `PR ${which} used template fallback: ${reason}`);
              }
              if (prUrl) emitActivityStatus(podId, `PR created: ${prUrl}`);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              logger.warn({ err, podId }, 'Failed to create PR — pod still validated');
              emitActivityStatus(podId, `PR creation failed: ${message} — pod still validated`);
            }
          } else {
            emitActivityStatus(podId, `Carrying forward existing PR: ${prUrl}`);
          }
        }

        const revalidatedPod = transition(s2, 'validated', { prUrl });
        refreshReadiness(podId, {
          advisoryQaInFlight:
            validationConfig.advisoryBrowserQaEnabled && !!validationEngine.runAdvisoryBrowserQa,
        });
        maybeTriggerDependents(revalidatedPod);
        await runAdvisoryAfterValidation(
          podId,
          validationConfig,
          result,
          validationRecord?.id,
          revalidatedPod,
        );
        advisoryPublicationOwnership(revalidatedPod, result, validationRecord?.id).assertCurrent();
        const postAdvisoryPod = podRepo.getOrThrow(podId);
        if (isTerminalState(postAdvisoryPod.status) || postAdvisoryPod.status === 'killing') {
          return { newCommits, result: 'pass' };
        }

        // Stop the container
        if (postAdvisoryPod.containerId) {
          try {
            emitActivityStatus(podId, 'Stopping post-validation container…');
            const cm2 = containerManagerFactory.get(postAdvisoryPod.executionTarget);
            await cm2.stop(postAdvisoryPod.containerId);
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to stop container post-revalidation');
          }
        }

        if (postAdvisoryPod.autoApprove) {
          emitActivityStatus(podId, 'Auto-approving…');
          logger.info({ podId }, 'Auto-approving pod after revalidation');
          setImmediate(() => {
            this.approveSession(podId, { automation: true }).catch((err) =>
              logger.warn({ err, podId }, 'Auto-approve failed after revalidation'),
            );
          });
        }

        return { newCommits, result: 'pass' };
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
      transition(s2, 'failed', { failureReason });
      return { newCommits, result: 'fail' };
    }
  }

  return { revalidateSession };
}
