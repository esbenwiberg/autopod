import { publishScreenshotArtifacts } from '../validation/screenshot-artifacts.js';
import { isTerminalState } from './state-machine.js';
import type {
  RevalidationPassCaptured,
  RevalidationPassContext,
  ValidationWorkflowCalls,
} from './validation-workflow-ports.js';
export function createRevalidationPassDelivery(captured: RevalidationPassCaptured) {
  const {
    warnIfSinglePrSeriesMissingSeriesMeta,
    resolvePrBaseBranch,
    podRepo,
    containerManagerFactory,
    worktreeManager,
    validationEngine,
    logger,
    prManagerFactory,
    resolveGitCredential,
    refreshReadiness,
    getLatestPushFindings,
    emitActivityStatus,
    advisoryPublicationOwnership,
    runAdvisoryAfterValidation,
    handleDeletionGuardError,
    ensurePrBaseBranchOnOrigin,
    transition,
    maybeTriggerDependents,
  } = captured;
  async function completeRevalidationPass(
    this: Pick<ValidationWorkflowCalls, 'approveSession'>,
    {
      podId,
      pod,
      profile,
      s2,
      result,
      revalDefaultBranch,
      newCommits,
      validationConfig,
      validationRecord,
      checksOnly = false,
    }: RevalidationPassContext,
  ): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }> {
    emitActivityStatus(
      podId,
      checksOnly
        ? 'Validation checks passed — delivery was not requested.'
        : 'Revalidation passed — human fix worked!',
    );
    let prUrl: string | null = s2.prUrl ?? null;
    const prManager = !checksOnly && prManagerFactory ? prManagerFactory(profile) : null;
    if (!checksOnly && prManager && s2.worktreePath && s2.options.output === 'pr') {
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
        !checksOnly &&
        validationConfig.advisoryBrowserQaEnabled &&
        !!validationEngine.runAdvisoryBrowserQa,
    });
    if (!checksOnly) maybeTriggerDependents(revalidatedPod);
    if (!checksOnly) {
      await runAdvisoryAfterValidation(
        podId,
        validationConfig,
        result,
        validationRecord?.id,
        revalidatedPod,
      );
      advisoryPublicationOwnership(revalidatedPod, result, validationRecord?.id).assertCurrent();
    }
    const postAdvisoryPod = podRepo.getOrThrow(podId);
    if (isTerminalState(postAdvisoryPod.status) || postAdvisoryPod.status === 'killing') {
      return { newCommits, result: 'pass' };
    }
    // The source coordinator still needs the original Running resource for its
    // final exact-source verification. A pass does not release source/report
    // custody or authorize a stop that would make that verification impossible.
    if (
      postAdvisoryPod.containerId &&
      !podRepo.sourceAdoptions?.retains(postAdvisoryPod.containerId)
    ) {
      try {
        emitActivityStatus(podId, 'Stopping post-validation container…');
        const cm2 = containerManagerFactory.get(postAdvisoryPod.executionTarget);
        await cm2.stop(postAdvisoryPod.containerId);
      } catch (err) {
        logger.warn({ err, podId }, 'Failed to stop container post-revalidation');
      }
    }
    if (!checksOnly && postAdvisoryPod.autoApprove) {
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
  return { completeRevalidationPass };
}
