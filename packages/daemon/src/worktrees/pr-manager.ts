import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

const execFileAsync = promisify(execFile);

export interface GhPrManagerConfig {
  logger: Logger;
}

/**
 * Creates and merges pull requests via the GitHub CLI (`gh`).
 *
 * Runs `gh` commands from the worktree directory so it inherits
 * the correct git remote context. Requires `gh` to be authenticated
 * on the daemon host (via `gh auth login` or `GH_TOKEN` env var).
 */
export class GhPrManager implements PrManager {
  private logger: Logger;

  constructor(config: GhPrManagerConfig) {
    this.logger = config.logger;
  }

  async createPr(config: CreatePrConfig): Promise<string> {
    const title = buildPrTitle(config.task, config.seriesName, config.seriesDescription);
    const body = buildPrBody({
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
      seriesDescription: config.seriesDescription,
      seriesName: config.seriesName,
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
      title,
      '--body',
      body,
    ];

    try {
      const { stdout } = await execFileAsync('gh', args, {
        cwd: config.worktreePath,
        timeout: 30_000,
      });

      const prUrl = stdout.trim();
      this.logger.info({ podId: config.podId, prUrl }, 'Pull request created');
      return prUrl;
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
      await execFileAsync('gh', args, {
        cwd: config.worktreePath,
        timeout: 30_000,
      });
    } catch (err) {
      this.logger.error({ err, prUrl: config.prUrl }, 'Failed to merge pull request');
      throw err;
    }

    // Check if the merge completed immediately or auto-merge was scheduled
    const status = await this.getPrStatus({
      prUrl: config.prUrl,
      worktreePath: config.worktreePath,
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

    const { stdout } = await execFileAsync('gh', args, {
      cwd: config.worktreePath,
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
      return { merged: true, open: false, blockReason: null, ciFailures: [], reviewComments: [] };
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
        const { stdout: reviewOut } = await execFileAsync(
          'gh',
          ['pr', 'view', config.prUrl, '--json', 'reviews'],
          { cwd: config.worktreePath, timeout: 15_000 },
        );
        const reviewData = JSON.parse(reviewOut) as {
          reviews: Array<{ author: { login: string }; state: string; body: string }>;
        };
        for (const review of reviewData.reviews) {
          if (review.state === 'CHANGES_REQUESTED' && review.body) {
            reviewComments.push({ author: review.author.login, body: review.body, path: null });
          }
        }
      } catch {
        // Non-fatal — reviewComments stays empty
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
    };
  }
}

export interface GitHubApiPrManagerConfig {
  pat: string;
  logger: Logger;
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

export class GitHubApiPrManager implements PrManager {
  private pat: string;
  private logger: Logger;

  constructor(config: GitHubApiPrManagerConfig) {
    this.pat = config.pat;
    this.logger = config.logger;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }

  async createPr(config: CreatePrConfig): Promise<string> {
    if (!config.repoUrl) throw new Error('repoUrl is required for GitHubApiPrManager');
    const { owner, repo } = parseGitHubRepoUrl(config.repoUrl);
    const title = buildPrTitle(config.task, config.seriesName, config.seriesDescription);
    const body = buildPrBody({
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
      seriesDescription: config.seriesDescription,
      seriesName: config.seriesName,
    });

    this.logger.info(
      { podId: config.podId, branch: config.branch, baseBranch: config.baseBranch },
      'Creating pull request via GitHub API',
    );

    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ title, body, head: config.branch, base: config.baseBranch }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as { html_url: string };
    this.logger.info({ podId: config.podId, prUrl: data.html_url }, 'Pull request created');
    return data.html_url;
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
      return { merged: true, open: false, blockReason: null, ciFailures: [], reviewComments: [] };
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

    // Collect review comments for CHANGES_REQUESTED decisions
    const reviewComments: ReviewCommentDetail[] = [];
    try {
      const reviewsResp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/reviews`,
        { headers: this.headers },
      );
      if (reviewsResp.ok) {
        const reviews = (await reviewsResp.json()) as Array<{
          state: string;
          user: { login: string };
          body: string;
        }>;
        for (const r of reviews) {
          if (r.state === 'CHANGES_REQUESTED' && r.body) {
            reviewComments.push({ author: r.user.login, body: r.body, path: null });
          }
        }
        if (reviewComments.length > 0) {
          reasons.push('Changes requested');
        }
      }
    } catch {
      // Best-effort — leave reviewComments empty
    }

    return {
      merged: false,
      open: true,
      blockReason: reasons.length > 0 ? reasons.join('; ') : 'Waiting for merge conditions',
      ciFailures,
      reviewComments,
    };
  }
}
