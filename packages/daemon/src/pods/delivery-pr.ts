import type { Pod } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import { reconcilePublication } from '../worktrees/durable-source-publication.js';
import { GitCredentialError } from '../worktrees/local-worktree-manager.js';
import type { DeliveryPrCaptured } from './delivery-contracts.js';
import { resolvePrBaseBranch } from './delivery-policy.js';
import { publishValidatedSource } from './validated-source-publication.js';
import { validationSourceError } from './validation-source-evidence.js';

export function createDeliveryPr(captured: DeliveryPrCaptured) {
  const {
    worktreeManager,
    logger,
    resolveGitCredential,
    emitActivityStatus,
    assertGuidanceCollected,
    executionForPod,
    prManagerFactory,
    handleDeletionGuardError,
    getLatestPushFindings,
    podRepo,
  } = captured;
  async function ensurePrBaseBranchOnOrigin(
    pod: Pod,
    profile: PodExecutionSettings,
    baseBranch: string,
    callerLabel: string,
  ): Promise<void> {
    if (!pod.worktreePath) return;
    const defaultBranch = profile.defaultBranch ?? 'main';
    if (baseBranch === pod.branch || baseBranch === defaultBranch) return;

    const ensureRemoteBranch = worktreeManager.ensureRemoteBranch?.bind(worktreeManager);
    if (!ensureRemoteBranch) {
      logger.warn(
        { podId: pod.id, baseBranch, callerLabel },
        'Worktree manager cannot ensure PR base branch exists on origin',
      );
      return;
    }

    try {
      const result = await ensureRemoteBranch({
        worktreePath: pod.worktreePath,
        branch: baseBranch,
        sourceRef: `refs/heads/${baseBranch}`,
        pat: await resolveGitCredential(profile),
      });
      if (result.created) {
        emitActivityStatus(pod.id, `Base branch published: ${baseBranch}`);
      }
    } catch (err) {
      // Best effort: if the branch already exists but the check/push failed for a
      // transient reason, PR creation can still succeed. If it truly is absent,
      // the PR provider will return the authoritative error below.
      logger.warn(
        { err, podId: pod.id, baseBranch, callerLabel },
        'Failed to ensure PR base branch exists on origin',
      );
    }
  }

  async function reconcilePendingPublication(pod: Pod): Promise<void> {
    const ledger = podRepo.sourcePublications;
    const pending = ledger?.pending?.(pod);
    if (!ledger || !pending) return;
    assertGuidanceCollected(pod.id);
    const profile = executionForPod(pod);
    await reconcilePublication(
      ledger,
      pod,
      profile.repoUrl ?? '',
      worktreeManager,
      pending,
      () => assertGuidanceCollected(pod.id),
      await resolveGitCredential(profile),
    );
    emitActivityStatus(
      pod.id,
      'Original publication observed; current checks and all other recovery holds remain unchanged.',
    );
  }

  async function pushAndCreatePr(pod: Pod, callerLabel: string): Promise<string> {
    if (pod.options.output !== 'pr') {
      throw new AutopodError(
        'PR delivery requires explicit PR output.',
        'INVALID_OUTPUT_MODE',
        409,
      );
    }
    assertGuidanceCollected(pod.id);
    const podId = pod.id;
    if (!pod.worktreePath) {
      throw new AutopodError(
        `Pod ${podId} has no worktree — cannot push branch`,
        'INVALID_STATE',
        409,
      );
    }
    const profile = executionForPod(pod);
    const prManager = prManagerFactory ? prManagerFactory(profile) : null;
    if (!prManager) {
      throw new AutopodError(
        `No PR manager configured for profile ${pod.profileName}`,
        'INVALID_STATE',
        409,
      );
    }

    const baseBranch = resolvePrBaseBranch(pod, profile);
    const assertCurrent = () => {
      assertGuidanceCollected(podId);
      if (!podRepo.validationSources)
        validationSourceError('Checked publication support is unavailable.');
      podRepo.validationSources.checked(pod, profile);
    };
    assertCurrent();
    const pat = await resolveGitCredential(profile);
    try {
      await publishValidatedSource({ pod, profile, podRepo, worktreeManager, pat, assertCurrent });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ podId, err, callerLabel }, 'pushAndCreatePr: branch push failed');
      // Bubble GitCredentialError up untouched so the caller can park the pod
      // in awaiting_input instead of failing terminally on a fixable PAT issue.
      if (
        err instanceof GitCredentialError ||
        (err instanceof AutopodError && err.code === 'SOURCE_PUBLICATION_RECONCILIATION_REQUIRED')
      ) {
        throw err;
      }
      if (handleDeletionGuardError(podId, err)) {
        throw new AutopodError(message, 'WORKTREE_COMPROMISED', 409);
      }
      emitActivityStatus(podId, `Branch push failed: ${message}`);
      throw new AutopodError(message, 'BRANCH_PUSH_FAILED', 502);
    }

    try {
      assertCurrent();
      await ensurePrBaseBranchOnOrigin(pod, profile, baseBranch, callerLabel);
      assertCurrent();
      const result = await prManager.createPr({
        worktreePath: pod.worktreePath,
        repoUrl: profile.repoUrl ?? undefined,
        branch: pod.branch,
        baseBranch,
        podId,
        task: pod.task,
        profileName: pod.profileName,
        profile,
        podModel: pod.model,
        handoffInstructions: pod.handoffInstructions ?? undefined,
        validationResult: pod.lastValidationResult ?? null,
        validationWaiver: pod.validationWaiver,
        filesChanged: pod.filesChanged,
        linesAdded: pod.linesAdded,
        linesRemoved: pod.linesRemoved,
        previewUrl: pod.previewUrl,
        screenshots: [],
        taskSummary: pod.taskSummary ?? undefined,
        seriesDescription: pod.seriesDescription ?? undefined,
        seriesName: pod.seriesName ?? undefined,
        securityFindings: getLatestPushFindings(podId),
      });
      assertCurrent();
      if (result.usedFallback) {
        const which = result.narrativeUsedFallback
          ? result.titleUsedFallback
            ? 'title + body'
            : 'body'
          : 'title';
        const reason = result.fallbackReason ?? 'unknown';
        logger.error(
          {
            podId,
            callerLabel,
            profile: profile.name,
            modelProvider: profile.modelProvider,
            fallbackReason: reason,
            fallbackDetail: result.fallbackDetail,
            titleUsedFallback: result.titleUsedFallback,
            narrativeUsedFallback: result.narrativeUsedFallback,
          },
          'PR description used template fallback — daemon-side LLM helper failed',
        );
        emitActivityStatus(podId, `PR ${which} used template fallback: ${reason}`);
      }
      return result.url;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ podId, err, callerLabel }, 'pushAndCreatePr: PR creation failed');
      emitActivityStatus(podId, `PR creation failed: ${message}`);
      throw new AutopodError(message, 'PR_CREATION_FAILED', 502);
    }
  }

  async function retryCreatePr(podId: string): Promise<void> {
    const pod = podRepo.getOrThrow(podId);
    if (pod.completionPolicy === 'accept-findings')
      throw new AutopodError(
        'Findings acceptance grants no source publication authority',
        'FINDINGS_PUBLICATION_FORBIDDEN',
        409,
      );
    if (pod.status !== 'complete' && pod.status !== 'validated') {
      throw new AutopodError(
        `Cannot retry PR creation for ${podId} in status ${pod.status} — only validated or complete pods`,
        'INVALID_STATE',
        409,
      );
    }
    if (pod.prUrl) {
      throw new AutopodError(`Pod ${podId} already has a PR: ${pod.prUrl}`, 'INVALID_STATE', 409);
    }
    if (!pod.worktreePath) {
      throw new AutopodError(
        `Pod ${podId} has no worktree — cannot create PR`,
        'INVALID_STATE',
        409,
      );
    }
    if (podRepo.sourcePublications?.pending?.(pod)) await reconcilePendingPublication(pod);
    emitActivityStatus(podId, 'Retrying PR creation…');
    const newPrUrl = await pushAndCreatePr(pod, 'retryCreatePr');
    podRepo.update(podId, { prUrl: newPrUrl });
    emitActivityStatus(podId, `PR created: ${newPrUrl}`);
    logger.info({ podId, prUrl: newPrUrl }, 'PR created via retryCreatePr');
  }
  return {
    ensurePrBaseBranchOnOrigin,
    pushAndCreatePr,
    retryCreatePr,
    reconcilePendingPublication,
  };
}
