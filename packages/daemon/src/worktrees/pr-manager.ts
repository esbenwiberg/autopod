import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from 'pino';
import type { CreatePrConfig, MergePrConfig, PrManager } from '../interfaces/pr-manager.js';
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
    const title = buildPrTitle(config.task);
    const body = buildPrBody({
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
    });

    this.logger.info(
      { sessionId: config.sessionId, branch: config.branch, baseBranch: config.baseBranch },
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
      this.logger.info({ sessionId: config.sessionId, prUrl }, 'Pull request created');
      return prUrl;
    } catch (err) {
      this.logger.error({ err, sessionId: config.sessionId }, 'Failed to create pull request');
      throw err;
    }
  }

  async mergePr(config: MergePrConfig): Promise<void> {
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
      this.logger.info({ prUrl: config.prUrl }, 'Pull request merged');
    } catch (err) {
      this.logger.error({ err, prUrl: config.prUrl }, 'Failed to merge pull request');
      throw err;
    }
  }
}

export interface GitHubApiPrManagerConfig {
  pat: string;
  logger: Logger;
}

function parseGitHubRepoUrl(repoUrl: string): { owner: string; repo: string } {
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
    const title = buildPrTitle(config.task);
    const body = buildPrBody({
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
    });

    this.logger.info(
      { sessionId: config.sessionId, branch: config.branch, baseBranch: config.baseBranch },
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
    this.logger.info({ sessionId: config.sessionId, prUrl: data.html_url }, 'Pull request created');
    return data.html_url;
  }

  async mergePr(config: MergePrConfig): Promise<void> {
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
    const pr = (await prResponse.json()) as { head: { ref: string } };
    const headBranch = pr.head.ref;

    const mergeResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/merge`,
      {
        method: 'PUT',
        headers: this.headers,
        body: JSON.stringify({ merge_method: config.squash ? 'squash' : 'merge' }),
      },
    );

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
  }
}
