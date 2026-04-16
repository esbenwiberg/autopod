import type { Logger } from 'pino';
import type {
  CiFailureDetail,
  CreatePrConfig,
  MergePrConfig,
  MergePrResult,
  PrManager,
  PrMergeStatus,
  ReviewCommentDetail,
} from '../interfaces/pr-manager.js';
import { buildPrBody, buildPrTitle } from './pr-body-builder.js';

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

  private async adoFetch(path: string, options: RequestInit): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
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
      throw new Error(`ADO API ${options.method ?? 'GET'} ${url} → ${response.status}: ${text}`);
    }
    return text ? JSON.parse(text) : null;
  }

  async createPr(config: CreatePrConfig): Promise<string> {
    const title = buildPrTitle(config.task);
    const description = buildPrBody({
      task: config.task,
      sessionId: config.sessionId,
      profileName: config.profileName,
      validationResult: config.validationResult,
      filesChanged: config.filesChanged,
      linesAdded: config.linesAdded,
      linesRemoved: config.linesRemoved,
      previewUrl: config.previewUrl,
      screenshots: config.screenshots,
      taskSummary: config.taskSummary,
      inlineImages: false,
    });

    this.logger.info(
      { sessionId: config.sessionId, branch: config.branch, baseBranch: config.baseBranch },
      'Creating ADO pull request',
    );

    const body = {
      title,
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
      { sessionId: config.sessionId, prUrl, prId: pr.pullRequestId },
      'ADO pull request created',
    );
    return prUrl;
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
    })) as { status: string; mergeStatus?: string };

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

    // PR is still active — check policy evaluations
    const reasons: string[] = [];
    const ciFailures: CiFailureDetail[] = [];
    try {
      const evaluations = (await this.adoFetch(`/pullrequests/${prId}/statuses?api-version=7.1`, {
        method: 'GET',
      })) as { value: Array<{ context: { name: string }; state: string }> };

      // If any check is still running/queued, old failures are potentially stale —
      // new commits may have already been pushed and CI hasn't settled yet.
      // Don't report failures until all checks reach a terminal state.
      // ADO states: notSet | pending | succeeded | failed | error
      const inFlight = evaluations.value.filter(
        (e) => e.state === 'pending' || e.state === 'notSet',
      );
      if (inFlight.length > 0) {
        reasons.push(`CI in progress: ${inFlight.map((e) => e.context.name).join(', ')}`);
        // ciFailures stays empty — no fixer spawn while CI is running
      } else {
        const blocking = evaluations.value.filter(
          (e) => e.state === 'failed' || e.state === 'error',
        );
        if (blocking.length > 0) {
          const names = blocking.map((e) => `${e.context.name} (${e.state})`).join(', ');
          reasons.push(`Policies: ${names}`);
          for (const e of blocking) {
            ciFailures.push({
              name: e.context.name,
              conclusion: e.state,
              detailsUrl: null,
              annotations: [],
            });
          }
        }
      }
    } catch {
      // Policy status endpoint may not be available — fall through
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
    } catch {
      // Non-fatal — reviewComments stays empty
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
