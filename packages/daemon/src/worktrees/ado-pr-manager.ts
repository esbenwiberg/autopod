import type { ScreenshotRef } from '@autopod/shared';
import type { Logger } from 'pino';
import type {
  CiFailureDetail,
  CreatePrConfig,
  CreatePrResult,
  FoundPr,
  MergePrConfig,
  MergePrResult,
  PrManager,
  PrMergeStatus,
  ReviewCommentDetail,
  ReviewFeedbackReply,
  ReviewFeedbackReplyResult,
} from '../interfaces/pr-manager.js';
import type { ScreenshotStore } from '../pods/screenshot-store.js';
import type { ProfileLlmClientDeps } from '../providers/llm-client.js';
import { buildAdoAttachmentRef } from '../validation/screenshot-collector.js';
import {
  assertMergeSource,
  expectedMergeSource,
  mergeReconciliation,
  sourceCommit,
} from './merge-source-identity.js';
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
  /** Canonical daemon Azure DevOps Entra token provider. */
  getToken: () => Promise<string>;
  logger: Logger;
  /**
   * On-disk screenshot store. When provided and rawScreenshots are passed to
   * createPr, screenshots are uploaded as ADO PR attachments after creation
   * and the PR description is patched with the returned attachment URLs.
   */
  screenshotStore?: ScreenshotStore;
  /** Stores so PR-body LLM helpers resolve live provider-account credentials. */
  llmDeps?: ProfileLlmClientDeps;
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
  private readonly getToken: () => Promise<string>;
  private readonly logger: Logger;
  private readonly screenshotStore: ScreenshotStore | undefined;
  private readonly llmDeps: ProfileLlmClientDeps | undefined;

  constructor(config: AdoPrManagerConfig) {
    this.orgUrl = config.orgUrl.replace(/\/$/, '');
    this.project = config.project;
    this.repoName = config.repoName;
    this.getToken = config.getToken;
    this.logger = config.logger;
    this.screenshotStore = config.screenshotStore;
    this.llmDeps = config.llmDeps;
  }

  private get baseUrl(): string {
    return `${this.orgUrl}/${encodeURIComponent(this.project)}/_apis/git/repositories/${encodeURIComponent(this.repoName)}`;
  }

  private async rawFetch(url: string, options: RequestInit): Promise<unknown> {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${await this.getToken()}`,
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

  /**
   * Upload screenshots as ADO PR attachments and return body refs with attachment URLs.
   *
   * Uploads are sequential — ADO rate-limits attachment bursts and parallel uploads
   * can fail half the set. Failures are non-fatal: the failed screenshot is skipped
   * and a warning is logged. If all uploads fail, an empty array is returned and the
   * PR body omits the screenshots section.
   *
   * Filename format: `{source}-{filename}` (e.g. `smoke-0-root.png`). Concatenating
   * the source bucket prevents collisions when smoke and review buckets contain
   * files with the same base name within the same PR.
   *
   * If uploads 401/403, the daemon Entra identity likely lacks repository write access.
   */
  private async uploadScreenshotAttachments(
    prId: number,
    rawScreenshots: Array<{ pagePath: string; ref: ScreenshotRef }>,
  ): Promise<Array<{ pagePath: string; imageUrl: string }>> {
    const results: Array<{ pagePath: string; imageUrl: string }> = [];

    for (const { pagePath, ref } of rawScreenshots) {
      try {
        // biome-ignore lint/style/noNonNullAssertion: screenshotStore is checked before this method is called
        const bytes = await this.screenshotStore!.read(ref);
        // Source prefix prevents filename collisions across smoke/review buckets
        const attachmentFilename = `${ref.source}-${ref.filename}`;
        const response = (await this.rawFetch(
          `${this.baseUrl}/pullRequests/${prId}/attachments/${encodeURIComponent(attachmentFilename)}?api-version=7.1`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: bytes as unknown as BodyInit,
          },
        )) as { url: string };
        results.push(buildAdoAttachmentRef(pagePath, response.url));
      } catch (err) {
        // Non-fatal — PR is already created.
        this.logger.warn(
          { err, pagePath, podId: ref.podId },
          'ADO screenshot attachment upload failed — screenshot omitted from PR body. ' +
            'If 401/403, verify the daemon Entra identity has repository write access.',
        );
      }
    }

    return results;
  }

  async findPr(
    config: Pick<CreatePrConfig, 'worktreePath' | 'repoUrl' | 'branch' | 'baseBranch'>,
  ): Promise<FoundPr | null> {
    const query = new URLSearchParams({
      'api-version': '7.1',
      'searchCriteria.status': 'all',
      'searchCriteria.sourceRefName': `refs/heads/${config.branch}`,
      'searchCriteria.targetRefName': `refs/heads/${config.baseBranch}`,
      $top: '2',
    });
    const response = (await this.adoFetch(`/pullrequests?${query}`, {
      signal: AbortSignal.timeout(30000),
    })) as {
      value?: Array<{
        pullRequestId: number;
        sourceRefName: string;
        targetRefName: string;
        status: string;
      }>;
    };
    if (!Array.isArray(response?.value) || response.value.length > 1)
      throw new Error('PR delivery lookup is ambiguous or malformed');
    const row = response.value[0];
    if (!row) return null;
    if (
      !Number.isSafeInteger(row.pullRequestId) ||
      row.pullRequestId <= 0 ||
      row.sourceRefName !== `refs/heads/${config.branch}` ||
      row.targetRefName !== `refs/heads/${config.baseBranch}` ||
      !['active', 'completed', 'abandoned'].includes(row.status)
    )
      throw new Error('PR delivery lookup did not confirm exact repository/head/base');
    return {
      url: `${this.orgUrl}/${encodeURIComponent(this.project)}/_git/${encodeURIComponent(this.repoName)}/pullrequest/${row.pullRequestId}`,
      disposition:
        row.status === 'active' ? 'open' : row.status === 'completed' ? 'merged' : 'closed',
    };
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
      deps: this.llmDeps,
    };
    const [titleResult, narrativeResult] = await Promise.all([
      generatePrTitle(descInput, this.logger),
      generatePrNarrative(descInput, this.logger, true),
    ]);

    const narrativeFallback = narrativeResult.usedFallback
      ? {
          reason: narrativeResult.fallbackReason ?? 'unknown',
          detail: narrativeResult.fallbackDetail,
        }
      : undefined;

    // Parameters shared between the initial body (no screenshots) and the patched
    // body (with uploaded attachment URLs).
    const bodyParams = {
      task: config.task,
      podId: config.podId,
      profileName: config.profileName,
      validationResult: config.validationResult,
      validationWaiver: config.validationWaiver,
      filesChanged: config.filesChanged,
      linesAdded: config.linesAdded,
      linesRemoved: config.linesRemoved,
      previewUrl: config.previewUrl,
      taskSummary: config.taskSummary,
      inlineImages: false as const,
      seriesDescription: config.seriesDescription,
      seriesName: config.seriesName,
      securityFindings: config.securityFindings,
      narrative: narrativeResult.narrative,
      narrativeFallback,
      budgetChars: 4000,
    };

    // ADO two-pass flow: create PR without screenshots first (PR ID is required for the
    // attachments endpoint), then upload and patch the description with attachment URLs.
    const hasRawScreenshots =
      (config.rawScreenshots?.length ?? 0) > 0 && this.screenshotStore != null;

    const description = buildPrBody({
      ...bodyParams,
      // Omit screenshots on initial creation when we'll be uploading them afterward.
      screenshots: hasRawScreenshots ? [] : (config.screenshots ?? []),
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

    if (hasRawScreenshots && config.rawScreenshots) {
      const uploadedRefs = await this.uploadScreenshotAttachments(
        pr.pullRequestId,
        config.rawScreenshots,
      );
      if (uploadedRefs.length > 0) {
        const patchedDescription = buildPrBody({
          ...bodyParams,
          screenshots: uploadedRefs,
        });
        try {
          await this.adoFetch(`/pullrequests/${pr.pullRequestId}?api-version=7.1`, {
            method: 'PATCH',
            body: JSON.stringify({ description: patchedDescription }),
          });
          this.logger.info(
            { podId: config.podId, count: uploadedRefs.length },
            'ADO PR description patched with screenshot attachments',
          );
        } catch (patchErr) {
          // Non-fatal — PR already created; screenshots just won't appear in the body.
          this.logger.warn(
            { err: patchErr, podId: config.podId },
            'Failed to patch ADO PR description with screenshot attachments',
          );
        }
      }
    }

    return buildCreatePrResult(prUrl, titleResult, narrativeResult);
  }

  private extractPrId(prUrl: string): string {
    // An explicit numeric reference is already scoped to the configured repository.
    if (/^[1-9][0-9]*$/.test(prUrl) && Number.isSafeInteger(Number(prUrl))) return prUrl;
    try {
      const url = new URL(prUrl);
      const match = url.pathname.match(/^(.*)\/pullrequest\/([1-9][0-9]*)\/?$/);
      if (
        url.protocol !== 'https:' ||
        url.port ||
        url.username ||
        url.password ||
        !match?.[1] ||
        !match[2] ||
        !Number.isSafeInteger(Number(match[2]))
      )
        throw new Error('Invalid PR address');
      const segments = match[1].split('/').slice(1);
      if (segments.length !== (url.hostname === 'dev.azure.com' ? 4 : 3))
        throw new Error('Unexpected repository path');
      const actual = parseAdoRepoUrl(`${url.origin}${match[1]}`);
      const expected = parseAdoRepoUrl(
        `${this.orgUrl}/${encodeURIComponent(this.project)}/_git/${encodeURIComponent(this.repoName)}`,
      );
      if (
        actual.orgUrl.toLowerCase() !== expected.orgUrl.toLowerCase() ||
        actual.project !== expected.project ||
        actual.repoName !== expected.repoName
      )
        throw new Error('Repository identity changed');
      return match[2];
    } catch {
      // Never reinterpret a foreign URL's numeric suffix inside this manager's
      // configured repository. Do not include credential-bearing input in errors.
      mergeReconciliation(
        'The ADO PR URL does not match the configured organization, project and repository.',
      );
    }
  }

  private parseAdoThreadFeedbackId(feedbackId: string): number | null {
    const match = feedbackId.match(/^ado-thread-(\d+)$/);
    if (!match) return null;
    return Number.parseInt(match[1], 10);
  }

  async mergePr(config: MergePrConfig): Promise<MergePrResult> {
    const expectedHeadSha = expectedMergeSource(config.expectedHeadSha);
    const prId = this.extractPrId(config.prUrl);

    this.logger.info(
      { prUrl: config.prUrl, prId, squash: config.squash ?? false },
      'Completing ADO pull request',
    );

    // Fetch current PR to get lastMergeSourceCommit
    const pr = (await this.adoFetch(`/pullrequests/${prId}?api-version=7.1`, {
      method: 'GET',
    })) as { lastMergeSourceCommit?: { commitId?: string } } | null;
    assertMergeSource(expectedHeadSha, pr?.lastMergeSourceCommit?.commitId);

    const patchBody = {
      status: 'completed',
      lastMergeSourceCommit: expectedHeadSha
        ? { commitId: expectedHeadSha }
        : pr?.lastMergeSourceCommit,
      completionOptions: {
        mergeStrategy: config.squash ? 'squash' : 'noFastForward',
        deleteSourceBranch: false,
      },
    };

    const result = (await this.adoFetch(`/pullrequests/${prId}?api-version=7.1`, {
      method: 'PATCH',
      body: JSON.stringify(patchBody),
    })) as {
      status?: string;
      lastMergeSourceCommit?: { commitId?: string };
      autoCompleteSetBy?: { id?: string };
    } | null;

    if (result?.status === 'active') {
      return {
        merged: false,
        autoMergeScheduled:
          typeof result.autoCompleteSetBy?.id === 'string' &&
          result.autoCompleteSetBy.id.length > 0,
      };
    }
    if (result?.status !== 'completed')
      mergeReconciliation('ADO did not confirm that the requested merge completed.');
    assertMergeSource(expectedHeadSha, result.lastMergeSourceCommit?.commitId);

    this.logger.info({ prUrl: config.prUrl, prId }, 'ADO pull request completed');
    return { merged: true, autoMergeScheduled: false };
  }

  async replyToReviewFeedback(config: {
    prUrl: string;
    responses: ReviewFeedbackReply[];
  }): Promise<ReviewFeedbackReplyResult> {
    const prId = this.extractPrId(config.prUrl);
    let posted = 0;
    let skipped = 0;
    const errors: string[] = [];
    const resolutionErrors: string[] = [];

    for (const response of config.responses) {
      const threadId = this.parseAdoThreadFeedbackId(response.feedbackId);
      if (!threadId) {
        skipped++;
        continue;
      }

      try {
        await this.adoFetch(`/pullrequests/${prId}/threads/${threadId}/comments?api-version=7.1`, {
          method: 'POST',
          body: JSON.stringify({
            content: response.body,
            commentType: 'text',
          }),
        });
        posted++;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    return { posted, skipped, resolved: 0, errors, resolutionErrors };
  }

  async getPrStatus(config: { prUrl: string }): Promise<PrMergeStatus> {
    const prId = this.extractPrId(config.prUrl);

    const pr = (await this.adoFetch(`/pullrequests/${prId}?api-version=7.1`, {
      method: 'GET',
    })) as {
      status: string;
      mergeStatus?: string;
      repository: { id: string };
      lastMergeSourceCommit?: { commitId?: string };
    };

    if (pr.status === 'completed') {
      return {
        headSha: sourceCommit(pr.lastMergeSourceCommit?.commitId),
        merged: true,
        open: false,
        blockReason: null,
        ciFailures: [],
        reviewComments: [],
      };
    }
    if (pr.status === 'abandoned') {
      return {
        headSha: sourceCommit(pr.lastMergeSourceCommit?.commitId),
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
          id: number;
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
          id: `ado-thread-${thread.id}`,
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
      headSha: sourceCommit(pr.lastMergeSourceCommit?.commitId),
      merged: false,
      open: true,
      blockReason: reasons.length > 0 ? reasons.join('; ') : 'Waiting for policies to pass',
      ciFailures,
      reviewComments,
    };
  }
}
