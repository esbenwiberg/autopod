import type { Logger } from 'pino';
import type {
  CiFailureDetail,
  CreatePrConfig,
  CreatePrResult,
  MergePrConfig,
  MergePrResult,
  PrManager,
  PrMergeStatus,
  ReviewCommentDetail,
} from '../interfaces/pr-manager.js';
import { buildPrBody } from './pr-body-builder.js';
import {
  type PrNarrativeResult,
  type PrTitleResult,
  generatePrNarrative,
  generatePrTitle,
} from './pr-description-generator.js';

/**
 * Compose the `CreatePrResult` from generator outcomes. Mirrors the helper
 * in pr-manager.ts — narrative fallback wins over title fallback for the
 * top-level reason.
 */
function buildCreatePrResult(
  url: string,
  title: PrTitleResult,
  narrative: PrNarrativeResult,
): CreatePrResult {
  const usedFallback = title.usedFallback || narrative.usedFallback;
  if (!usedFallback) return { url, usedFallback: false };
  const primary = narrative.usedFallback ? narrative : title;
  return {
    url,
    usedFallback: true,
    fallbackReason: primary.fallbackReason,
    fallbackDetail: primary.fallbackDetail,
    titleUsedFallback: title.usedFallback,
    narrativeUsedFallback: narrative.usedFallback,
  };
}

export interface AdoPrManagerConfig {
  /** e.g. https://dev.azure.com/myorg */
  orgUrl: string;
  /** ADO project name */
  project: string;
  /** Git repository name */
  repoName: string;
  /** Personal access token with Code (Read & Write) scope */
  pat: string;
  logger: Logger;
}

/**
 * Parse an ADO git remote URL into org URL, project, and repo name.
 *
 * Supports:
 *   https://dev.azure.com/{org}/{project}/_git/{repo}
 *   https://{org}.visualstudio.com/{project}/_git/{repo}
 */
export function parseAdoRepoUrl(repoUrl: string): {
  orgUrl: string;
  project: string;
  repoName: string;
} {
  const url = new URL(repoUrl);

  if (url.hostname === 'dev.azure.com') {
    // /org/project/_git/repo
    const parts = url.pathname.replace(/^\//, '').split('/');
    if (parts.length < 4 || parts[2] !== '_git') {
      throw new Error(`Cannot parse ADO repo URL: ${repoUrl}`);
    }
    return {
      orgUrl: `https://dev.azure.com/${parts[0]}`,
      project: decodeURIComponent(parts[1]),
      repoName: decodeURIComponent(parts[3]),
    };
  }

  if (url.hostname.endsWith('.visualstudio.com')) {
    // /project/_git/repo
    const org = url.hostname.replace('.visualstudio.com', '');
    const parts = url.pathname.replace(/^\//, '').split('/');
    if (parts.length < 3 || parts[1] !== '_git') {
      throw new Error(`Cannot parse ADO repo URL: ${repoUrl}`);
    }
    return {
      orgUrl: `https://dev.azure.com/${org}`,
      project: decodeURIComponent(parts[0]),
      repoName: decodeURIComponent(parts[2]),
    };
  }

  throw new Error(`Not an ADO repo URL: ${repoUrl}`);
}

/**
 * Typed HTTP error from the ADO REST API, carrying the response status code.
 * Allows callers to distinguish 404 (resource not found / no policies configured)
 * from auth failures, server errors, etc.
 */
export class AdoHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdoHttpError';
  }
}

/**
 * Creates and completes pull requests via the Azure DevOps REST API.
 *
 * Authentication: PAT via HTTP Basic auth (empty username, PAT as password).
 * API version: 7.1
 */
export class AdoPrManager implements PrManager {
  private readonly orgUrl: string;
  private readonly project: string;
  private readonly repoName: string;
  private readonly authHeader: string;
  private readonly logger: Logger;

  constructor(config: AdoPrManagerConfig) {
    this.orgUrl = config.orgUrl.replace(/\/$/, '');
    this.project = config.project;
    this.repoName = config.repoName;
    this.authHeader = `Basic ${Buffer.from(`:${config.pat}`).toString('base64')}`;
    this.logger = config.logger;
  }

  private get baseUrl(): string {
    return `${this.orgUrl}/${encodeURIComponent(this.project)}/_apis/git/repositories/${encodeURIComponent(this.repoName)}`;
  }

  private async rawFetch(url: string, options: RequestInit): Promise<unknown> {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers as Record<string, string>),
      },
    });

    const text = await response.text();
    if (!response.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (typeof parsed.message === 'string') detail = parsed.message;
      } catch {
        // use raw text
      }
      throw new AdoHttpError(response.status, detail);
    }
    return text ? JSON.parse(text) : null;
  }

  private async adoFetch(path: string, options: RequestInit): Promise<unknown> {
    return this.rawFetch(`${this.baseUrl}${path}`, options);
  }

  /** Fetch from the project-level API base (e.g. policy evaluations). */
  private async projectFetch(path: string, options: RequestInit): Promise<unknown> {
    return this.rawFetch(
      `${this.orgUrl}/${encodeURIComponent(this.project)}/_apis${path}`,
      options,
    );
  }

  async createPr(config: CreatePrConfig): Promise<CreatePrResult> {
    const descInput = {
      task: config.task,
      worktreePath: config.worktreePath,
      baseBranch: config.baseBranch,
      taskSummary: config.taskSummary,
      seriesName: config.seriesName,
      seriesDescription: config.seriesDescription,
      filesChanged: config.filesChanged,
      linesAdded: config.linesAdded,
      linesRemoved: config.linesRemoved,
      profile: config.profile,
      podModel: config.podModel,
      handoffInstructions: config.handoffInstructions,
    };
    const [titleResult, narrativeResult] = await Promise.all([
      generatePrTitle(descInput, this.logger),
      generatePrNarrative(descInput, this.logger, true),
    ]);
    const description = buildPrBody({
      task: config.task,
      podId: config.podId,
      profileName: config.profileName,
      validationResult: config.validationResult,
      filesChanged: config.filesChanged,
      linesAdded: config.linesAdded,
      linesRemoved: config.linesRemoved,
      previewUrl: config.previewUrl,
      screenshots: config.screenshots,
      taskSummary: config.taskSummary,
      inlineImages: false,
      seriesDescription: config.seriesDescription,
      seriesName: config.seriesName,
      securityFindings: config.securityFindings,
      narrative: narrativeResult.narrative,
      narrativeFallback: narrativeResult.usedFallback
        ? {
            reason: narrativeResult.fallbackReason ?? 'unknown',
            detail: narrativeResult.fallbackDetail,
          }
        : undefined,
      budgetChars: 4000,
    });

    this.logger.info(
      { podId: config.podId, branch: config.branch, baseBranch: config.baseBranch },
      'Creating ADO pull request',
    );

    const body = {
      title: titleResult.title,
      description,
      sourceRefName: `refs/heads/${config.branch}`,
      targetRefName: `refs/heads/${config.baseBranch}`,
    };

    const pr = (await this.adoFetch('/pullrequests?api-version=7.1', {
      method: 'POST',
      body: JSON.stringify(body),
    })) as { pullRequestId: number; webUrl?: string; _links?: { web?: { href?: string } } };

    const prUrl =
      pr.webUrl ??
      pr._links?.web?.href ??
      `${this.orgUrl}/${encodeURIComponent(this.project)}/_git/${encodeURIComponent(this.repoName)}/pullrequest/${pr.pullRequestId}`;

    this.logger.info(
      { podId: config.podId, prUrl, prId: pr.pullRequestId },
      'ADO pull request created',
    );
    return buildCreatePrResult(prUrl, titleResult, narrativeResult);
  }

  private extractPrId(prUrl: string): string {
    const prId = prUrl.split('/').at(-1);
    if (!prId || Number.isNaN(Number(prId))) {
      throw new Error(`Cannot extract PR ID from URL: ${prUrl}`);
    }
    return prId;
  }

  async mergePr(config: MergePrConfig): Promise<MergePrResult> {
    const prId = this.extractPrId(config.prUrl);

    this.logger.info(
      { prUrl: config.prUrl, prId, squash: config.squash ?? false },
      'Completing ADO pull request',
    );

    // Fetch current PR to get lastMergeSourceCommit
    const pr = (await this.adoFetch(`/pullrequests/${prId}?api-version=7.1`, {
      method: 'GET',
    })) as { lastMergeSourceCommit: { commitId: string } };

    const patchBody = {
      status: 'completed',
      lastMergeSourceCommit: pr.lastMergeSourceCommit,
      completionOptions: {
        mergeStrategy: config.squash ? 'squash' : 'noFastForward',
        deleteSourceBranch: true,
      },
    };

    const result = (await this.adoFetch(`/pullrequests/${prId}?api-version=7.1`, {
      method: 'PATCH',
      body: JSON.stringify(patchBody),
    })) as { status: string; autoCompleteSetBy?: { displayName: string } };

    // If the PR is still active after the PATCH, policies are blocking the merge
    // and ADO set auto-complete instead
    if (result.status === 'active') {
      this.logger.info(
        { prUrl: config.prUrl, prId, autoCompleteSetBy: result.autoCompleteSetBy?.displayName },
        'ADO auto-complete set — policies blocking merge',
      );
      return { merged: false, autoMergeScheduled: true };
    }

    this.logger.info({ prUrl: config.prUrl, prId }, 'ADO pull request completed');
    return { merged: true, autoMergeScheduled: false };
  }

  async getPrStatus(config: { prUrl: string }): Promise<PrMergeStatus> {
    const prId = this.extractPrId(config.prUrl);

    const pr = (await this.adoFetch(`/pullrequests/${prId}?api-version=7.1`, {
      method: 'GET',
    })) as { status: string; mergeStatus?: string; repository: { id: string } };

    if (pr.status === 'completed') {
      return { merged: true, open: false, blockReason: null, ciFailures: [], reviewComments: [] };
    }
    if (pr.status === 'abandoned') {
      return {
        merged: false,
        open: false,
        blockReason: 'PR was abandoned',
        ciFailures: [],
        reviewComments: [],
      };
    }

    // PR is still active — check blocking policy evaluations.
    //
    // We use the /policy/evaluations endpoint (not /statuses) because it is the
    // authoritative source for branch policy results and — crucially — it exposes
    // configuration.isBlocking so we can distinguish required from optional checks.
    //
    // The /statuses endpoint does NOT carry required/optional metadata.  Optional
    // checks left in a queued/pending state would cause the old code to treat CI
    // as "still running" indefinitely, preventing fix pods from ever spawning.
    const reasons: string[] = [];
    const ciFailures: CiFailureDetail[] = [];
    try {
      // ADO policy artifact ID for a pull request:
      //   vstfs:///Git/PullRequestId/{repositoryId}/{pullRequestId}
      const artifactId = encodeURIComponent(
        `vstfs:///Git/PullRequestId/${pr.repository.id}/${prId}`,
      );
      const evaluations = (await this.projectFetch(
        `/policy/evaluations?artifactId=${artifactId}&api-version=7.2-preview.1`,
        { method: 'GET' },
      )) as {
        value: Array<{
          policyEvaluationId: string;
          // ADO policy evaluation statuses:
          //   approved | running | queued | rejected | notApplicable | broken
          status: string;
          configuration: {
            isBlocking: boolean;
            settings: { displayName?: string };
          };
        }>;
      };

      // Only required (blocking) policies drive fix-pod decisions.
      // Optional policies can stay queued indefinitely and must not suppress
      // fix pods that are needed for genuinely failing required checks.
      const required = evaluations.value.filter((e) => e.configuration.isBlocking);

      const inFlightRequired = required.filter(
        (e) => e.status === 'running' || e.status === 'queued',
      );

      if (inFlightRequired.length > 0) {
        reasons.push(
          `CI in progress: ${inFlightRequired
            .map((e) => e.configuration.settings.displayName ?? 'unknown')
            .join(', ')}`,
        );
        // ciFailures stays empty — don't spawn a fix while required checks are still running
      } else {
        const failedRequired = required.filter(
          (e) => e.status === 'rejected' || e.status === 'broken',
        );
        if (failedRequired.length > 0) {
          reasons.push(
            `Required policies failed: ${failedRequired
              .map((e) => `${e.configuration.settings.displayName ?? 'unknown'} (${e.status})`)
              .join(', ')}`,
          );
          for (const e of failedRequired) {
            ciFailures.push({
              name: e.configuration.settings.displayName ?? e.policyEvaluationId,
              conclusion: e.status,
              detailsUrl: null,
              annotations: [],
            });
          }
        }
      }
    } catch (evalErr) {
      // 404 = no branch policies are configured on this repo/branch — that's fine, treat as "no blocking checks"
      if (evalErr instanceof AdoHttpError && evalErr.status === 404) {
        this.logger.debug(
          { prUrl: config.prUrl },
          'ADO policy evaluations returned 404 — no branch policies configured',
        );
      } else {
        // Permissions issue, unexpected API version, network error, etc.
        // Log at warn so operators can see why auto-detection failed — fall through with empty ciFailures
        this.logger.warn(
          { err: evalErr, prUrl: config.prUrl },
          'ADO policy evaluations fetch failed — fix pods may not auto-spawn',
        );
      }
    }

    if (pr.mergeStatus === 'conflicts') {
      reasons.push('Merge conflicts');
    }

    // Collect active reviewer thread comments
    const reviewComments: ReviewCommentDetail[] = [];
    try {
      const threads = (await this.adoFetch(
        `/pullrequests/${prId}/threads?api-version=7.1&$top=500`,
        { method: 'GET' },
      )) as {
        value: Array<{
          status: string | number | undefined;
          isDeleted?: boolean;
          pullRequestThreadContext?: { filePath?: string } | null;
          comments: Array<{ author: { displayName: string }; content: string }>;
        }>;
      };
      for (const thread of threads.value) {
        if (thread.isDeleted) continue;
        // ADO REST API may return status as the string "active" or the integer 1
        const isActive = thread.status === 'active' || thread.status === 1;
        if (!isActive) continue;
        const first = thread.comments?.[0];
        if (!first?.content?.trim()) continue; // skip empty system/policy threads
        reviewComments.push({
          author: first.author.displayName,
          body: first.content,
          path: thread.pullRequestThreadContext?.filePath ?? null,
        });
      }
    } catch (threadErr) {
      // Non-fatal — reviewComments stays empty
      this.logger.warn({ err: threadErr, prUrl: config.prUrl }, 'ADO PR threads fetch failed');
    }

    return {
      merged: false,
      open: true,
      blockReason: reasons.length > 0 ? reasons.join('; ') : 'Waiting for policies to pass',
      ciFailures,
      reviewComments,
    };
  }
}
