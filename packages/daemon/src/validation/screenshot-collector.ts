import fs from 'node:fs/promises';
import path from 'node:path';
import type { PageResult } from '@autopod/shared';

export interface CollectedScreenshot {
  /** Validation page path (e.g. '/', '/about') */
  pagePath: string;
  /** Host filesystem path to the PNG file */
  hostPath: string;
  /** Path relative to the worktree root (for git add / PR URLs) */
  relativePath: string;
  /** Base64-encoded PNG data (for inline embedding in Teams cards) */
  base64: string;
}

/**
 * After page validation, reads screenshot PNGs from the host worktree
 * and returns them as base64-encoded data with paths for both git
 * (relative path) and Teams (base64 data URI).
 *
 * The screenshots exist on the host because `/workspace` inside the
 * container is volume-mounted from the worktree directory.
 */
export async function collectScreenshots(
  worktreePath: string,
  pageResults: PageResult[],
): Promise<CollectedScreenshot[]> {
  const screenshots: CollectedScreenshot[] = [];

  for (const page of pageResults) {
    if (!page.screenshotPath) continue;

    // Convert container path → host path
    // Container: /workspace/.autopod/screenshots/root.png
    // Host:      {worktreePath}/.autopod/screenshots/root.png
    const relativePath = page.screenshotPath.replace(/^\/workspace\//, '');
    const hostPath = path.join(worktreePath, relativePath);

    try {
      const buffer = await fs.readFile(hostPath);
      screenshots.push({
        pagePath: page.path,
        hostPath,
        relativePath,
        base64: buffer.toString('base64'),
      });
    } catch {
      // Screenshot file doesn't exist (validation may have failed before capture)
    }
  }

  return screenshots;
}

/** Build a GitHub raw content URL for a file on a branch. */
export function buildGitHubImageUrl(
  repoUrl: string,
  branch: string,
  relativePath: string,
): string {
  // repoUrl: https://github.com/org/repo or https://github.com/org/repo.git
  const clean = repoUrl.replace(/\.git$/, '');
  return `${clean}/blob/${branch}/${relativePath}?raw=true`;
}
