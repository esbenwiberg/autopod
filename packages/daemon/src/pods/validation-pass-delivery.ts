import { publishScreenshotArtifacts } from '../validation/screenshot-artifacts.js';
import { buildGitHubImageUrl } from '../validation/screenshot-collector.js';
import { GitCredentialError } from '../worktrees/local-worktree-manager.js';
import { isTerminalState } from './state-machine.js';
import type {
  ValidationPassCaptured,
  ValidationPassContext,
  ValidationWorkflowCalls,
} from './validation-workflow-ports.js';
export function createValidationPassDelivery(captured: ValidationPassCaptured) {
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
    stopSandboxPreviewProxy,
    pendingUpdateFromBaseIntents,
    completeFixPodAfterPush,
    emitActivityStatus,
    advisoryPublicationOwnership,
    runAdvisoryAfterValidation,
    parkOnCredentialFailure,
    handleDeletionGuardError,
    ensurePrBaseBranchOnOrigin,
    transition,
    maybeTriggerDependents,
  } = captured;
  async function completeValidationPass(
    this: Pick<ValidationWorkflowCalls, 'approveSession'>,
    {
      podId,
      pod,
      profile,
      s2,
      result,
      validationSyncOk,
      attempt,
      validationConfig,
      validationRecord,
    }: ValidationPassContext,
  ): Promise<void> {
    emitActivityStatus(podId, `Validation passed (attempt ${attempt})`);
    const passDefaultBranch = profile.defaultBranch ?? 'main';
    let prUrl: string | null = s2.prUrl ?? null;
    const prManager = prManagerFactory ? prManagerFactory(profile) : null;
    if (prManager && s2.worktreePath && s2.options.output === 'pr') {
      // Publish screenshots to their own ref so the PR body can embed them
      // without the reviewed branch carrying a file the agent never wrote.
      // ADO pods skip this entirely — they upload PR attachments instead.
      const screenshotBranch =
        profile.prProvider === 'ado'
          ? null
          : await publishScreenshotArtifacts({
              worktreeManager,
              logger,
              podId,
              worktreePath: s2.worktreePath,
              pat: await resolveGitCredential(profile),
            });

      // Push branch so `gh pr create --head` can reference it. If sync-back failed
      // earlier in this validation run, tighten the deletion guard so a ghost
      // mass-deletion cannot ship as "chore: auto-commit …".
      // Rethrow on non-guard errors: a swallowed push lets the carry-forward
      // path approve & merge a PR whose tip never advanced (real bug from
      // misrouted fix pods writing to the wrong branch).
      emitActivityStatus(podId, 'Branch validated — pushing…');
      try {
        await worktreeManager.mergeBranch({
          worktreePath: s2.worktreePath,
          // Push the feature branch up so `gh pr create --head <branch>` can reference it.
          // The PR is opened against passDefaultBranch separately by prManager.createPr.
          targetBranch: s2.branch,
          // Pass the PAT explicitly — the in-memory cache may be cold after a daemon
          // restart or for recovery pods that mount an existing worktree without
          // re-warming via create(). Without this, ADO URLs of the form
          // https://<org>@dev.azure.com/... cause git to prompt for a password.
          pat: await resolveGitCredential(profile),
          maxDeletions: validationSyncOk ? 100 : 0,
          podTask: pod.task,
          profile,
          podModel: pod.model,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err, podId }, 'Failed to push branch for PR');
        // Credential-class failures are recoverable: park the pod in
        // awaiting_input so the operator can update the PAT and resume,
        // instead of burning the validated work on a fixable error.
        if (err instanceof GitCredentialError) {
          parkOnCredentialFailure(podId, err);
          return;
        }
        if (handleDeletionGuardError(podId, err)) {
          const compromised = podRepo.getOrThrow(podId);
          if (compromised.status === 'validating') {
            transition(compromised, 'failed');
          }
          return;
        }
        emitActivityStatus(podId, `Branch push failed: ${message}`);
        throw err;
      }

      // Re-compute diff stats now that auto-commit has run.
      try {
        const prSinceCommit = s2.startCommitSha ?? undefined;
        const prBaseBranch = s2.baseBranch ?? passDefaultBranch;
        const stats = await worktreeManager.getDiffStats(
          s2.worktreePath,
          prBaseBranch,
          prSinceCommit,
        );
        podRepo.update(podId, {
          filesChanged: stats.filesChanged,
          linesAdded: stats.linesAdded,
          linesRemoved: stats.linesRemoved,
        });
      } catch (err) {
        logger.warn({ err, podId }, 'Failed to recompute diff stats after merge');
      }

      // Build screenshot refs for the PR body, provider-aware.
      // GitHub: embed raw GitHub URLs against the artifact ref. Requires the
      //         ref to exist — screenshotBranch is null when the push failed,
      //         and linking to a missing ref would only render broken images.
      // ADO: pass stored on-disk refs so AdoPrManager can upload them as
      //      PR attachments and embed the returned attachment URLs instead
      //      of GitHub URLs that would 404 on ADO reviewers.
      const isAdoPod = profile.prProvider === 'ado';
      const repoUrlForScreenshots = profile.repoUrl;
      const screenshotRefs =
        !isAdoPod && repoUrlForScreenshots && screenshotBranch
          ? result.smoke.pages
              .filter((p) => p.screenshotPath)
              .map((p) => ({
                pagePath: p.path,
                imageUrl: buildGitHubImageUrl(
                  repoUrlForScreenshots,
                  screenshotBranch,
                  p.screenshotPath.replace(/^\/workspace\//, ''),
                ),
              }))
          : [];
      // Raw refs for ADO: page.screenshot is set by collectScreenshots above.
      const rawScreenshots = isAdoPod
        ? result.smoke.pages.flatMap((p) =>
            p.screenshot != null ? [{ pagePath: p.path, ref: p.screenshot }] : [],
          )
        : undefined;

      if (!prUrl) {
        try {
          emitActivityStatus(podId, 'Creating PR…');
          const s3 = podRepo.getOrThrow(podId);
          warnIfSinglePrSeriesMissingSeriesMeta(s2, logger);
          const baseBranch = resolvePrBaseBranch(s2, profile);
          await ensurePrBaseBranchOnOrigin(s2, profile, baseBranch, 'validation_pass');
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
            screenshots: screenshotRefs,
            rawScreenshots,
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
              'PR description used template fallback during validation',
            );
            emitActivityStatus(podId, `PR ${which} used template fallback: ${reason}`);
          }
          if (prUrl) {
            emitActivityStatus(podId, `PR created: ${prUrl}`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn({ err, podId }, 'Failed to create PR — pod still validated');
          emitActivityStatus(podId, `PR creation failed: ${message} — pod still validated`);
        }
      } else {
        emitActivityStatus(podId, `Carrying forward existing PR: ${prUrl}`);
      }
    }
    podRepo.update(podId, { lastCorrectionMessage: null });
    pendingUpdateFromBaseIntents.delete(podId);
    const validatedPod = transition(s2, 'validated', { prUrl });
    refreshReadiness(podId, {
      advisoryQaInFlight:
        validationConfig.advisoryBrowserQaEnabled && !!validationEngine.runAdvisoryBrowserQa,
    });
    maybeTriggerDependents(validatedPod);
    await runAdvisoryAfterValidation(
      podId,
      validationConfig,
      result,
      validationRecord?.id,
      validatedPod,
    );
    advisoryPublicationOwnership(validatedPod, result, validationRecord?.id).assertCurrent();
    const postAdvisoryPod = podRepo.getOrThrow(podId);
    if (isTerminalState(postAdvisoryPod.status) || postAdvisoryPod.status === 'killing') {
      return;
    }
    if (postAdvisoryPod.linkedPodId) {
      await completeFixPodAfterPush(postAdvisoryPod);
      return;
    }
    if (postAdvisoryPod.containerId) {
      try {
        emitActivityStatus(podId, 'Stopping post-validation container…');
        await stopSandboxPreviewProxy(podId);
        const cm = containerManagerFactory.get(postAdvisoryPod.executionTarget);
        await cm.stop(postAdvisoryPod.containerId);
        logger.info({ podId }, 'Container stopped post-validation');
      } catch (err) {
        logger.warn({ err, podId }, 'Failed to stop container post-validation');
      }
    }
    if (postAdvisoryPod.autoApprove) {
      emitActivityStatus(podId, 'Auto-approving…');
      logger.info({ podId }, 'Auto-approving pod after validation');
      setImmediate(() => {
        this.approveSession(podId, { automation: true }).catch((err) =>
          logger.warn({ err, podId }, 'Auto-approve failed'),
        );
      });
    }
  }
  return { completeValidationPass };
}
