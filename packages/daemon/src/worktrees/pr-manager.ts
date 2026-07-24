import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from 'pino';
import { type DaemonGitHubAuth, GhCliDaemonGitHubAuth } from '../github/daemon-github-auth.js';
import type {
  CiFailureDetail,
  CreatePrConfig,
  CreatePrResult,
  MergePrConfig,
  MergePrResult,
  PrManager,
  PrMergeStatus,
  ReviewCommentDetail,
  ReviewFeedbackReply,
  ReviewFeedbackReplyResult,
} from '../interfaces/pr-manager.js';
import type { ProfileLlmClientDeps } from '../providers/llm-client.js';
import { buildPrBody } from './pr-body-builder.js';
import {
  type PrNarrativeResult,
  type PrTitleResult,
  generatePrNarrative,
  generatePrTitle,
} from './pr-description-generator.js';

const execFileAsync = promisify(execFile);

/**
 * Compose the `CreatePrResult` from generator outcomes. Narrative fallback
 * wins precedence over title fallback for the top-level `fallbackReason`
 * because the narrative drives the visible PR body — that's what reviewers
 * actually read and what the user complained about.
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

const GITHUB_REVIEW_THREADS_QUERY = `
query AutopodReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        nodes {
          id
          isResolved
          path
          comments(first: 1) {
            nodes {
              databaseId
              author {
                login
              }
              body
              path
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}`;

const GITHUB_RESOLVE_REVIEW_THREAD_MUTATION = `
mutation AutopodResolveReviewThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread {
      id
      isResolved
    }
  }
}`;

interface GitHubReviewThreadGraphqlResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: Array<{
            id?: string;
            isResolved?: boolean;
            path?: string | null;
            comments?: {
              nodes?: Array<{
                databaseId?: number | null;
                author?: { login?: string | null } | null;
                body?: string | null;
                path?: string | null;
              }> | null;
            } | null;
          }> | null;
          pageInfo?: {
            hasNextPage?: boolean;
            endCursor?: string | null;
          } | null;
        } | null;
      } | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
}

function getGitHubReviewThreadsConnection(data: GitHubReviewThreadGraphqlResponse) {
  return data.data?.repository?.pullRequest?.reviewThreads ?? null;
}

function formatGitHubGraphqlErrors(data: GitHubReviewThreadGraphqlResponse): string | null {
  if (!data.errors?.length) return null;
  return data.errors.map((error) => error.message ?? 'Unknown GraphQL error').join('; ');
}

function buildGitHubThreadFeedbackId(threadNodeId: string, commentId: number): string {
  return `gh-thread-${encodeURIComponent(threadNodeId)}-comment-${commentId}`;
}

function parseGitHubThreadFeedbackId(
  feedbackId: string,
): { threadNodeId: string; commentId: number } | null {
  const match = feedbackId.match(/^gh-thread-(.+)-comment-(\d+)$/);
  if (!match) return null;
  try {
    return {
      threadNodeId: decodeURIComponent(match[1]),
      commentId: Number.parseInt(match[2], 10),
    };
  } catch {
    return null;
  }
}

function mapGitHubReviewThreadComments(
  data: GitHubReviewThreadGraphqlResponse,
): ReviewCommentDetail[] {
  const threads = getGitHubReviewThreadsConnection(data)?.nodes ?? [];
  const comments: ReviewCommentDetail[] = [];

  for (const thread of threads) {
    if (!thread.id || thread.isResolved) continue;
    const comment = thread.comments?.nodes?.[0];
    const body = comment?.body?.trim();
    if (!body || !comment?.databaseId) continue;

    comments.push({
      id: buildGitHubThreadFeedbackId(thread.id, comment.databaseId),
      author: comment.author?.login ?? undefined,
      body,
      path: comment.path ?? thread.path ?? null,
    });
  }

  return comments;
}

function getGitHubReviewThreadsPageInfo(data: GitHubReviewThreadGraphqlResponse): {
  hasNextPage: boolean;
  endCursor: string | null;
} {
  const pageInfo = getGitHubReviewThreadsConnection(data)?.pageInfo;
  return {
    hasNextPage: pageInfo?.hasNextPage === true,
    endCursor: pageInfo?.endCursor ?? null,
  };
}

async function fetchGitHubReviewThreadCommentsWithGh(config: {
  owner: string;
  repo: string;
  number: number;
  worktreePath?: string;
  execGh: (
    args: string[],
    options: { cwd?: string; timeout: number },
  ) => Promise<{ stdout: string }>;
}): Promise<ReviewCommentDetail[]> {
  const comments: ReviewCommentDetail[] = [];
  let after: string | null = null;

  do {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${GITHUB_REVIEW_THREADS_QUERY}`,
      '-F',
      `owner=${config.owner}`,
      '-F',
      `repo=${config.repo}`,
      '-F',
      `number=${config.number}`,
    ];
    if (after) {
      args.push('-F', `after=${after}`);
    }

    const { stdout } = await config.execGh(args, {
      cwd: config.worktreePath,
      timeout: 15_000,
    });
    const data = JSON.parse(stdout) as GitHubReviewThreadGraphqlResponse;
    const graphqlError = formatGitHubGraphqlErrors(data);
    if (graphqlError) throw new Error(`GitHub GraphQL review-thread error: ${graphqlError}`);

    comments.push(...mapGitHubReviewThreadComments(data));
    const pageInfo = getGitHubReviewThreadsPageInfo(data);
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (after);

  return comments;
}

async function fetchGitHubReviewThreadCommentsWithApi(config: {
  owner: string;
  repo: string;
  number: number;
  headers: Record<string, string>;
}): Promise<ReviewCommentDetail[]> {
  const comments: ReviewCommentDetail[] = [];
  let after: string | null = null;

  do {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: config.headers,
      body: JSON.stringify({
        query: GITHUB_REVIEW_THREADS_QUERY,
        variables: {
          owner: config.owner,
          repo: config.repo,
          number: config.number,
          after,
        },
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub GraphQL review-thread error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as GitHubReviewThreadGraphqlResponse;
    const graphqlError = formatGitHubGraphqlErrors(data);
    if (graphqlError) throw new Error(`GitHub GraphQL review-thread error: ${graphqlError}`);

    comments.push(...mapGitHubReviewThreadComments(data));
    const pageInfo = getGitHubReviewThreadsPageInfo(data);
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (after);

  return comments;
}

export interface GhPrManagerConfig {
  logger: Logger;
  /** Stores so PR-body LLM helpers resolve live provider-account credentials. */
  llmDeps?: ProfileLlmClientDeps;
  githubAuth?: DaemonGitHubAuth;
}

/**
 * Creates and merges pull requests via the GitHub CLI (`gh`).
 *
 * Runs `gh` commands from the worktree directory so it inherits
 * the correct git remote context. Requires `gh` to be authenticated
 * for the daemon service account. Every invocation receives the credential
 * resolved by DaemonGitHubAuth and discards ambient token variables.
 */
export class GhPrManager implements PrManager {
  private logger: Logger;
  private llmDeps?: ProfileLlmClientDeps;
  private githubAuth: DaemonGitHubAuth;

  constructor(config: GhPrManagerConfig) {
    this.logger = config.logger;
    this.llmDeps = config.llmDeps;
    this.githubAuth = config.githubAuth ?? new GhCliDaemonGitHubAuth();
  }

  private async execGh(args: string[], options: { cwd?: string; timeout: number }) {
    const credential = await this.githubAuth.resolveCredential();
    const { GH_TOKEN: _ambientGh, GITHUB_TOKEN: _ambientGitHub, ...hostEnv } = process.env;
    const env = { ...hostEnv, GH_TOKEN: credential.token };
    return execFileAsync('gh', args, { ...options, env });
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
      generatePrNarrative(descInput, this.logger),
    ]);
    const body = buildPrBody({
      task: config.task,
      podId: config.podId,
      profileName: config.profileName,
      validationResult: config.validationResult,
      validationWaiver: config.validationWaiver,
      filesChanged: config.filesChanged,
      linesAdded: config.linesAdded,
      linesRemoved: config.linesRemoved,
      previewUrl: config.previewUrl,
      screenshots: config.screenshots,
      taskSummary: config.taskSummary,
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
    });

    this.logger.info(
      { podId: config.podId, branch: config.branch, baseBranch: config.baseBranch },
      'Creating pull request',
    );

    const args = [
      'pr',
      'create',
      '--head',
      config.branch,
      '--base',
      config.baseBranch,
      '--title',
      titleResult.title,
      '--body',
      body,
    ];

    try {
      const { stdout } = await this.execGh(args, {
        cwd: config.worktreePath,
        timeout: 30_000,
      });

      const prUrl = stdout.trim();
      this.logger.info({ podId: config.podId, prUrl }, 'Pull request created');
      return buildCreatePrResult(prUrl, titleResult, narrativeResult);
    } catch (err) {
      this.logger.error({ err, podId: config.podId }, 'Failed to create pull request');
      throw err;
    }
  }

  async mergePr(config: MergePrConfig): Promise<MergePrResult> {
    const args = [
      'pr',
      'merge',
      config.prUrl,
      config.squash ? '--squash' : '--merge',
      '--delete-branch',
      '--auto',
    ];

    this.logger.info(
      { prUrl: config.prUrl, squash: config.squash ?? false },
      'Merging pull request',
    );

    try {
      await this.execGh(args, {
        timeout: 30_000,
      });
    } catch (err) {
      this.logger.error({ err, prUrl: config.prUrl }, 'Failed to merge pull request');
      throw err;
    }

    // Check if the merge completed immediately or auto-merge was scheduled
    const status = await this.getPrStatus({
      prUrl: config.prUrl,
    });
    if (status.merged) {
      this.logger.info({ prUrl: config.prUrl }, 'Pull request merged immediately');
      return { merged: true, autoMergeScheduled: false };
    }

    this.logger.info(
      { prUrl: config.prUrl, blockReason: status.blockReason },
      'Auto-merge scheduled — PR not yet mergeable',
    );
    return { merged: false, autoMergeScheduled: true };
  }

  async getPrStatus(config: { prUrl: string; worktreePath?: string }): Promise<PrMergeStatus> {
    const args = [
      'pr',
      'view',
      config.prUrl,
      '--json',
      'state,mergedAt,statusCheckRollup,reviewDecision,autoMergeRequest',
    ];

    const { stdout } = await this.execGh(args, {
      timeout: 15_000,
    });

    const pr = JSON.parse(stdout) as {
      state: string;
      mergedAt: string | null;
      statusCheckRollup: Array<{ name: string; status: string; conclusion: string }> | null;
      reviewDecision: string;
      autoMergeRequest: unknown | null;
    };

    if (pr.state === 'MERGED') {
      return {
        merged: true,
        open: false,
        blockReason: null,
        ciFailures: [],
        reviewComments: [],
        reviewDecision: 'APPROVED',
      };
    }

    if (pr.state === 'CLOSED') {
      return {
        merged: false,
        open: false,
        blockReason: 'PR was closed without merging',
        ciFailures: [],
        reviewComments: [],
      };
    }

    // PR is still open — build a block reason from checks + review status
    const reasons: string[] = [];
    const ciFailures: CiFailureDetail[] = [];

    if (pr.statusCheckRollup?.length) {
      const pending = pr.statusCheckRollup.filter(
        (c) =>
          c.conclusion !== 'SUCCESS' && c.conclusion !== 'NEUTRAL' && c.conclusion !== 'SKIPPED',
      );
      if (pending.length > 0) {
        const checkNames = pending.map((c) => `${c.name} (${c.conclusion || c.status})`).join(', ');
        reasons.push(`Checks: ${checkNames}`);
        for (const c of pending) {
          if (
            c.conclusion === 'FAILURE' ||
            c.conclusion === 'TIMED_OUT' ||
            c.conclusion === 'ACTION_REQUIRED'
          ) {
            ciFailures.push({
              name: c.name,
              conclusion: c.conclusion,
              detailsUrl: null,
              annotations: [],
            });
          }
        }
      }
    }

    // Collect review comments for CHANGES_REQUESTED decisions
    const reviewComments: ReviewCommentDetail[] = [];
    if (pr.reviewDecision === 'CHANGES_REQUESTED') {
      reasons.push('Changes requested');
      try {
        const { stdout: reviewOut } = await this.execGh(
          ['pr', 'view', config.prUrl, '--json', 'reviews'],
          { cwd: config.worktreePath, timeout: 15_000 },
        );
        const reviewData = JSON.parse(reviewOut) as {
          reviews: Array<{
            id?: string;
            databaseId?: number;
            author: { login: string };
            state: string;
            body: string;
          }>;
        };
        for (const [index, review] of reviewData.reviews.entries()) {
          if (review.state === 'CHANGES_REQUESTED' && review.body) {
            const reviewId = review.databaseId ?? review.id ?? index + 1;
            reviewComments.push({
              id: `gh-review-${reviewId}`,
              author: review.author.login,
              body: review.body,
              path: null,
            });
          }
        }
      } catch {
        // Non-fatal — reviewComments stays empty
      }
      try {
        const { owner, repo, number } = parsePrUrl(config.prUrl);
        reviewComments.push(
          ...(await fetchGitHubReviewThreadCommentsWithGh({
            owner,
            repo,
            number,
            worktreePath: config.worktreePath,
            execGh: (args, options) => this.execGh(args, options),
          })),
        );
      } catch {
        try {
          const { owner, repo, number } = parsePrUrl(config.prUrl);
          const { stdout: commentsOut } = await this.execGh(
            ['api', `repos/${owner}/${repo}/pulls/${number}/comments`],
            { cwd: config.worktreePath, timeout: 15_000 },
          );
          const comments = JSON.parse(commentsOut) as Array<{
            id: number;
            in_reply_to_id?: number;
            user: { login: string };
            body: string;
            path: string | null;
          }>;
          for (const comment of comments) {
            if (comment.in_reply_to_id || !comment.body.trim()) continue;
            reviewComments.push({
              id: `gh-comment-${comment.id}`,
              author: comment.user.login,
              body: comment.body,
              path: comment.path,
            });
          }
        } catch {
          // Non-fatal — PR-level review bodies still give the fix pod context.
        }
      }
    } else if (pr.reviewDecision && pr.reviewDecision !== 'APPROVED') {
      const label = pr.reviewDecision === 'REVIEW_REQUIRED' ? 'Review required' : pr.reviewDecision;
      reasons.push(label);
    }

    return {
      merged: false,
      open: true,
      blockReason: reasons.length > 0 ? reasons.join('; ') : 'Waiting for merge conditions',
      ciFailures,
      reviewComments,
      reviewDecision: pr.reviewDecision || undefined,
    };
  }

  async replyToReviewFeedback(config: {
    prUrl: string;
    worktreePath?: string;
    responses: ReviewFeedbackReply[];
  }): Promise<ReviewFeedbackReplyResult> {
    const { owner, repo, number } = parsePrUrl(config.prUrl);
    let posted = 0;
    let skipped = 0;
    let resolved = 0;
    const errors: string[] = [];
    const resolutionErrors: string[] = [];
    const fallbackBodies: string[] = [];

    for (const response of config.responses) {
      const threadRef = parseGitHubThreadFeedbackId(response.feedbackId);
      const commentId = threadRef?.commentId ?? parseGitHubCommentFeedbackId(response.feedbackId);
      if (!commentId) {
        skipped++;
        fallbackBodies.push(`- ${response.feedbackId}: ${response.body}`);
        continue;
      }

      try {
        await this.execGh(
          [
            'api',
            '--method',
            'POST',
            `repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`,
            '-f',
            `body=${response.body}`,
          ],
          { cwd: config.worktreePath, timeout: 15_000 },
        );
        posted++;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
        continue;
      }

      if (response.outcome === 'fixed' && threadRef) {
        try {
          await this.execGh(
            [
              'api',
              'graphql',
              '-f',
              `query=${GITHUB_RESOLVE_REVIEW_THREAD_MUTATION}`,
              '-F',
              `threadId=${threadRef.threadNodeId}`,
            ],
            { cwd: config.worktreePath, timeout: 15_000 },
          );
          resolved++;
        } catch (err) {
          resolutionErrors.push(err instanceof Error ? err.message : String(err));
        }
      }
    }

    if (fallbackBodies.length > 0) {
      try {
        await this.execGh(
          [
            'api',
            '--method',
            'POST',
            `repos/${owner}/${repo}/issues/${number}/comments`,
            '-f',
            `body=Autopod fix pod review feedback responses:\n\n${fallbackBodies.join('\n\n')}`,
          ],
          { cwd: config.worktreePath, timeout: 15_000 },
        );
        posted++;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    return { posted, skipped, resolved, errors, resolutionErrors };
  }
}

export interface GitHubApiPrManagerConfig {
  pat: string;
  logger: Logger;
  /** Stores so PR-body LLM helpers resolve live provider-account credentials. */
  llmDeps?: ProfileLlmClientDeps;
}

export function parseGitHubRepoUrl(repoUrl: string): { owner: string; repo: string } {
  const httpsMatch = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (!httpsMatch) throw new Error(`Cannot parse GitHub repo URL: ${repoUrl}`);
  return { owner: httpsMatch[1], repo: httpsMatch[2] };
}

function parsePrUrl(prUrl: string): { owner: string; repo: string; number: number } {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) throw new Error(`Cannot parse PR URL: ${prUrl}`);
  return { owner: match[1], repo: match[2], number: Number.parseInt(match[3], 10) };
}

function parseGitHubCommentFeedbackId(feedbackId: string): number | null {
  const match = feedbackId.match(/^gh-comment-(\d+)$/);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

export class GitHubApiPrManager implements PrManager {
  private pat: string;
  private logger: Logger;
  private llmDeps?: ProfileLlmClientDeps;

  constructor(config: GitHubApiPrManagerConfig) {
    this.pat = config.pat;
    this.logger = config.logger;
    this.llmDeps = config.llmDeps;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }

  async createPr(config: CreatePrConfig): Promise<CreatePrResult> {
    if (!config.repoUrl) throw new Error('repoUrl is required for GitHubApiPrManager');
    const { owner, repo } = parseGitHubRepoUrl(config.repoUrl);
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
      generatePrNarrative(descInput, this.logger),
    ]);
    const body = buildPrBody({
      task: config.task,
      podId: config.podId,
      profileName: config.profileName,
      validationResult: config.validationResult,
      validationWaiver: config.validationWaiver,
      filesChanged: config.filesChanged,
      linesAdded: config.linesAdded,
      linesRemoved: config.linesRemoved,
      previewUrl: config.previewUrl,
      screenshots: config.screenshots,
      taskSummary: config.taskSummary,
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
    });

    this.logger.info(
      { podId: config.podId, branch: config.branch, baseBranch: config.baseBranch },
      'Creating pull request via GitHub API',
    );

    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        title: titleResult.title,
        body,
        head: config.branch,
        base: config.baseBranch,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as { html_url: string };
    this.logger.info({ podId: config.podId, prUrl: data.html_url }, 'Pull request created');
    return buildCreatePrResult(data.html_url, titleResult, narrativeResult);
  }

  async mergePr(config: MergePrConfig): Promise<MergePrResult> {
    const { owner, repo, number } = parsePrUrl(config.prUrl);

    this.logger.info(
      { prUrl: config.prUrl, squash: config.squash ?? false },
      'Merging pull request via GitHub API',
    );

    const prResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
      {
        headers: this.headers,
      },
    );
    if (!prResponse.ok) {
      const text = await prResponse.text();
      throw new Error(`GitHub API error fetching PR ${prResponse.status}: ${text}`);
    }
    const pr = (await prResponse.json()) as { head: { ref: string }; node_id: string };
    const headBranch = pr.head.ref;

    const mergeResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/merge`,
      {
        method: 'PUT',
        headers: this.headers,
        body: JSON.stringify({ merge_method: config.squash ? 'squash' : 'merge' }),
      },
    );

    // 405 = merge blocked (checks pending, reviews required, etc.)
    if (mergeResponse.status === 405) {
      this.logger.info({ prUrl: config.prUrl }, 'PR not mergeable yet — checks or reviews pending');
      return { merged: false, autoMergeScheduled: false };
    }

    if (!mergeResponse.ok) {
      const text = await mergeResponse.text();
      throw new Error(`GitHub API merge error ${mergeResponse.status}: ${text}`);
    }

    const deleteResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${headBranch}`,
      { method: 'DELETE', headers: this.headers },
    );

    if (!deleteResponse.ok && deleteResponse.status !== 422) {
      this.logger.warn(
        { status: deleteResponse.status, branch: headBranch },
        'Failed to delete branch after merge',
      );
    }

    this.logger.info({ prUrl: config.prUrl }, 'Pull request merged');
    return { merged: true, autoMergeScheduled: false };
  }

  async getPrStatus(config: { prUrl: string }): Promise<PrMergeStatus> {
    const { owner, repo, number } = parsePrUrl(config.prUrl);

    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
      headers: this.headers,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API error ${response.status}: ${text}`);
    }

    const pr = (await response.json()) as {
      state: string;
      merged: boolean;
      head: { sha: string };
    };

    if (pr.merged) {
      return {
        merged: true,
        open: false,
        blockReason: null,
        ciFailures: [],
        reviewComments: [],
        reviewDecision: 'APPROVED',
      };
    }
    if (pr.state === 'closed') {
      return {
        merged: false,
        open: false,
        blockReason: 'PR was closed without merging',
        ciFailures: [],
        reviewComments: [],
      };
    }

    // Check status of the head commit
    const statusResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs`,
      { headers: this.headers },
    );

    const reasons: string[] = [];
    const ciFailures: CiFailureDetail[] = [];
    if (statusResponse.ok) {
      const data = (await statusResponse.json()) as {
        check_runs: Array<{
          id: number;
          name: string;
          status: string;
          conclusion: string | null;
          details_url: string | null;
        }>;
      };
      const pending = data.check_runs.filter(
        (c) =>
          c.status !== 'completed' ||
          (c.conclusion !== 'success' && c.conclusion !== 'neutral' && c.conclusion !== 'skipped'),
      );
      if (pending.length > 0) {
        const checkNames = pending.map((c) => `${c.name} (${c.conclusion ?? c.status})`).join(', ');
        reasons.push(`Checks: ${checkNames}`);
      }
      // Collect CI failure details with annotations for actionable fix context
      const failed = data.check_runs.filter(
        (c) =>
          c.conclusion === 'failure' ||
          c.conclusion === 'timed_out' ||
          c.conclusion === 'action_required',
      );
      for (const run of failed) {
        const annotations: CiFailureDetail['annotations'] = [];
        try {
          const annResp = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/check-runs/${run.id}/annotations`,
            { headers: this.headers },
          );
          if (annResp.ok) {
            const annData = (await annResp.json()) as Array<{
              path: string;
              message: string;
              annotation_level: string;
            }>;
            annotations.push(
              ...annData.slice(0, 10).map((a) => ({
                path: a.path,
                message: a.message,
                annotationLevel: a.annotation_level,
              })),
            );
          }
        } catch {
          // Best-effort — leave annotations empty
        }
        ciFailures.push({
          name: run.name,
          conclusion: run.conclusion ?? 'failure',
          detailsUrl: run.details_url,
          annotations,
        });
      }
    }

    // Collect review comments and compute overall review decision
    const reviewComments: ReviewCommentDetail[] = [];
    let reviewDecision: string | undefined;
    try {
      const reviewsResp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/reviews`,
        { headers: this.headers },
      );
      if (reviewsResp.ok) {
        const reviews = (await reviewsResp.json()) as Array<{
          id: number;
          state: string;
          user: { login: string };
          body: string;
        }>;

        // Compute overall decision from most recent review per reviewer
        const latestByUser = new Map<string, string>();
        for (const r of reviews) {
          if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED') {
            latestByUser.set(r.user.login, r.state);
          }
        }
        const decisions = [...latestByUser.values()];
        if (decisions.includes('CHANGES_REQUESTED')) {
          reviewDecision = 'CHANGES_REQUESTED';
        } else if (decisions.includes('APPROVED')) {
          reviewDecision = 'APPROVED';
        }

        for (const r of reviews) {
          if (r.state === 'CHANGES_REQUESTED' && r.body) {
            reviewComments.push({
              id: `gh-review-${r.id}`,
              author: r.user.login,
              body: r.body,
              path: null,
            });
          }
        }
        if (reviewComments.length > 0) {
          reasons.push('Changes requested');
        }
      }
      if (reviewDecision === 'CHANGES_REQUESTED') {
        try {
          reviewComments.push(
            ...(await fetchGitHubReviewThreadCommentsWithApi({
              owner,
              repo,
              number,
              headers: this.headers,
            })),
          );
          if (reviewComments.length > 0 && !reasons.includes('Changes requested')) {
            reasons.push('Changes requested');
          }
        } catch {
          const commentsResp = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/comments`,
            { headers: this.headers },
          );
          if (commentsResp.ok) {
            const comments = (await commentsResp.json()) as Array<{
              id: number;
              in_reply_to_id?: number;
              user: { login: string };
              body: string;
              path: string | null;
            }>;
            for (const c of comments) {
              if (c.in_reply_to_id || !c.body.trim()) continue;
              reviewComments.push({
                id: `gh-comment-${c.id}`,
                author: c.user.login,
                body: c.body,
                path: c.path,
              });
            }
            if (comments.length > 0 && !reasons.includes('Changes requested')) {
              reasons.push('Changes requested');
            }
          }
        }
      }
    } catch {
      // Best-effort — leave reviewComments and reviewDecision empty
    }

    return {
      merged: false,
      open: true,
      blockReason: reasons.length > 0 ? reasons.join('; ') : 'Waiting for merge conditions',
      ciFailures,
      reviewComments,
      reviewDecision,
    };
  }

  async replyToReviewFeedback(config: {
    prUrl: string;
    responses: ReviewFeedbackReply[];
  }): Promise<ReviewFeedbackReplyResult> {
    const { owner, repo, number } = parsePrUrl(config.prUrl);
    let posted = 0;
    let skipped = 0;
    let resolved = 0;
    const errors: string[] = [];
    const resolutionErrors: string[] = [];
    const fallbackBodies: string[] = [];

    for (const response of config.responses) {
      const threadRef = parseGitHubThreadFeedbackId(response.feedbackId);
      const commentId = threadRef?.commentId ?? parseGitHubCommentFeedbackId(response.feedbackId);
      if (!commentId) {
        skipped++;
        fallbackBodies.push(`- ${response.feedbackId}: ${response.body}`);
        continue;
      }

      try {
        const reply = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`,
          {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({ body: response.body }),
          },
        );
        if (reply.ok) {
          posted++;
        } else {
          errors.push(`GitHub reply error ${reply.status}: ${await reply.text()}`);
          continue;
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
        continue;
      }

      if (response.outcome === 'fixed' && threadRef) {
        try {
          const resolve = await fetch('https://api.github.com/graphql', {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({
              query: GITHUB_RESOLVE_REVIEW_THREAD_MUTATION,
              variables: { threadId: threadRef.threadNodeId },
            }),
          });
          if (!resolve.ok) {
            resolutionErrors.push(
              `GitHub resolve error ${resolve.status}: ${await resolve.text()}`,
            );
            continue;
          }
          const data = (await resolve.json()) as GitHubReviewThreadGraphqlResponse;
          const graphqlError = formatGitHubGraphqlErrors(data);
          if (graphqlError) {
            resolutionErrors.push(`GitHub resolve error: ${graphqlError}`);
            continue;
          }
          resolved++;
        } catch (err) {
          resolutionErrors.push(err instanceof Error ? err.message : String(err));
        }
      }
    }

    if (fallbackBodies.length > 0) {
      try {
        const fallback = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`,
          {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({
              body: `Autopod fix pod review feedback responses:\n\n${fallbackBodies.join('\n\n')}`,
            }),
          },
        );
        if (fallback.ok) {
          posted++;
        } else {
          errors.push(`GitHub PR comment error ${fallback.status}: ${await fallback.text()}`);
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    return { posted, skipped, resolved, errors, resolutionErrors };
  }
}
