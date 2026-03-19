import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from 'pino';
import type { PrManager, CreatePrConfig, MergePrConfig } from '../interfaces/pr-manager.js';
import { buildPrTitle, buildPrBody } from './pr-body-builder.js';

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
    });

    this.logger.info(
      { sessionId: config.sessionId, branch: config.branch, baseBranch: config.baseBranch },
      'Creating pull request',
    );

    const args = [
      'pr', 'create',
      '--head', config.branch,
      '--base', config.baseBranch,
      '--title', title,
      '--body', body,
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
      'pr', 'merge', config.prUrl,
      config.squash ? '--squash' : '--merge',
      '--delete-branch',
      '--auto',
    ];

    this.logger.info({ prUrl: config.prUrl, squash: config.squash ?? false }, 'Merging pull request');

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
