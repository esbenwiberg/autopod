import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FactValidationResult, PageResult, ScreenshotRef } from '@autopod/shared';
import type { ScreenshotStore } from '../pods/screenshot-store.js';
import { slugifyPagePath } from '../pods/screenshot-store.js';

export interface CollectedScreenshot {
  /** Validation page path (e.g. '/', '/about') */
  pagePath: string;
  /** The stored screenshot reference */
  ref: ScreenshotRef;
}

export interface CollectScreenshotsOptions {
  /**
   * Host-side Playwright writes screenshots outside the worktree. When set,
   * absolute screenshot paths under this directory are accepted.
   */
  allowedHostScreenshotDir?: string | null;
}

export interface CollectedFactScreenshot {
  factId: string;
  attachmentPath: string;
  ref: ScreenshotRef;
}

function isInsideDirectory(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolveSmokeScreenshotPath(
  worktreePath: string,
  screenshotPath: string,
  options: CollectScreenshotsOptions,
): string | null {
  const worktreeRoot = path.resolve(worktreePath);

  if (screenshotPath.startsWith('/workspace/')) {
    const relativePath = screenshotPath.replace(/^\/workspace\//, '');
    const hostPath = path.resolve(worktreeRoot, relativePath);
    return isInsideDirectory(hostPath, worktreeRoot) ? hostPath : null;
  }

  if (!path.isAbsolute(screenshotPath)) {
    const hostPath = path.resolve(worktreeRoot, screenshotPath);
    return isInsideDirectory(hostPath, worktreeRoot) ? hostPath : null;
  }

  const allowedRoot = options.allowedHostScreenshotDir
    ? path.resolve(options.allowedHostScreenshotDir)
    : null;
  if (!allowedRoot) return null;

  const hostPath = path.resolve(screenshotPath);
  return isInsideDirectory(hostPath, allowedRoot) ? hostPath : null;
}

/**
 * After page validation, reads screenshot PNGs from the host filesystem,
 * writes them to the on-disk screenshot store, and returns refs.
 *
 * Container screenshots map from `/workspace` to the worktree. Host
 * Playwright screenshots are accepted only under the allowed host screenshot
 * directory provided by the caller.
 *
 * The `.autopod/screenshots/` directory is left in place — it is committed
 * to the feature branch so GitHub PR reviewers can see screenshots.
 */
export async function collectScreenshots(
  worktreePath: string,
  pageResults: PageResult[],
  store: ScreenshotStore,
  podId: string,
  options: CollectScreenshotsOptions = {},
): Promise<CollectedScreenshot[]> {
  const collected: CollectedScreenshot[] = [];

  for (let idx = 0; idx < pageResults.length; idx++) {
    const page = pageResults[idx];
    if (!page?.screenshotPath) continue;

    const hostPath = resolveSmokeScreenshotPath(worktreePath, page.screenshotPath, options);
    if (!hostPath) continue;

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

/**
 * Collect PNG screenshots declared by required-fact attachments and promote
 * them into the same on-disk screenshot store used by smoke/review evidence.
 *
 * Fact commands still own what constitutes meaningful proof. The validator's
 * job here is plumbing: if a fact wrote `.autopod/evidence/<fact-id>/*.png`,
 * make that image visible in Proof of Work instead of burying it in YAML.
 */
export async function collectFactScreenshots(
  worktreePath: string,
  factValidation: FactValidationResult | null | undefined,
  store: ScreenshotStore,
  podId: string,
): Promise<CollectedFactScreenshot[]> {
  const collected: CollectedFactScreenshot[] = [];
  const facts = factValidation?.results ?? [];

  for (const fact of facts) {
    const attachments = fact.attachments ?? [];
    for (let idx = 0; idx < attachments.length; idx++) {
      const attachment = attachments[idx];
      if (!attachment || attachment.kind !== 'screenshot') continue;
      if (path.isAbsolute(attachment.path)) continue;
      if (!attachment.path.toLowerCase().endsWith('.png')) continue;

      const hostPath = path.resolve(worktreePath, attachment.path);
      const worktreeRoot = path.resolve(worktreePath);
      if (hostPath !== worktreeRoot && !hostPath.startsWith(`${worktreeRoot}${path.sep}`)) {
        continue;
      }

      try {
        const buffer = await fsp.readFile(hostPath);
        const basename = path.basename(attachment.path, path.extname(attachment.path));
        const safeFactId = fact.factId.replace(/[^A-Za-z0-9._-]/g, '_') || 'fact';
        const safeBase = basename.replace(/[^A-Za-z0-9._-]/g, '_') || 'screenshot';
        const filename = `${safeFactId}-${idx}-${safeBase}.png`;
        const ref = await store.write(podId, 'fact', filename, buffer);
        attachment.screenshot = ref;
        collected.push({ factId: fact.factId, attachmentPath: attachment.path, ref });
      } catch {
        // Screenshot file doesn't exist or could not be read; keep the textual attachment.
      }
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

/**
 * Build a PR-body screenshot ref from a stored on-disk ref and the attachment
 * URL returned by the ADO PR attachments API.
 *
 * This is the ADO counterpart to buildGitHubImageUrl — it maps a stored
 * ScreenshotRef + the upload-response URL to the { pagePath, imageUrl } shape
 * consumed by pr-body-builder.ts:buildPrBody.
 */
export function buildAdoAttachmentRef(
  pagePath: string,
  attachmentUrl: string,
): { pagePath: string; imageUrl: string } {
  return { pagePath, imageUrl: attachmentUrl };
}
