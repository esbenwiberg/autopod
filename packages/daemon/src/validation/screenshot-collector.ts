import fsp from 'node:fs/promises';
import path from 'node:path';
import type { PageResult, ScreenshotRef } from '@autopod/shared';
import type { ScreenshotStore } from '../pods/screenshot-store.js';
import { slugifyPagePath } from '../pods/screenshot-store.js';

export interface CollectedScreenshot {
  /** Validation page path (e.g. '/', '/about') */
  pagePath: string;
  /** The stored screenshot reference */
  ref: ScreenshotRef;
}

/**
 * After page validation, reads screenshot PNGs from the host worktree,
 * writes them to the on-disk screenshot store, and returns refs.
 *
 * The screenshots exist on the host because `/workspace` inside the
 * container is volume-mounted from the worktree directory.
 *
 * The `.autopod/screenshots/` directory is left in place — it is committed
 * to the feature branch so GitHub PR reviewers can see screenshots.
 */
export async function collectScreenshots(
  worktreePath: string,
  pageResults: PageResult[],
  store: ScreenshotStore,
  podId: string,
): Promise<CollectedScreenshot[]> {
  const collected: CollectedScreenshot[] = [];

  for (let idx = 0; idx < pageResults.length; idx++) {
    const page = pageResults[idx];
    if (!page?.screenshotPath) continue;

    // Convert container path → host path
    // Container: /workspace/.autopod/screenshots/root.png
    // Host:      {worktreePath}/.autopod/screenshots/root.png
    const relativePath = page.screenshotPath.replace(/^\/workspace\//, '');
    const hostPath = path.join(worktreePath, relativePath);

    try {
      const buffer = await fsp.readFile(hostPath);
      const filename = `${slugifyPagePath(page.path, idx)}.png`;
      const ref = await store.write(podId, 'smoke', filename, buffer);
      collected.push({ pagePath: page.path, ref });
    } catch {
      // Screenshot file doesn't exist (validation may have failed before capture)
    }
  }

  return collected;
}

/** Build a GitHub raw content URL for a file on a branch. */
export function buildGitHubImageUrl(repoUrl: string, branch: string, relativePath: string): string {
  // repoUrl: https://github.com/org/repo or https://github.com/org/repo.git
  const clean = repoUrl.replace(/\.git$/, '');
  return `${clean}/blob/${branch}/${relativePath}?raw=true`;
}
