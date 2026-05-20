import type { ScreenshotRef, ValidationResult } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ScreenshotStore } from '../pods/screenshot-store.js';

export interface ReportGeneratorDeps {
  screenshotStore?: ScreenshotStore;
  logger: Logger;
}

/**
 * Read a screenshot from the store and return a `data:image/png;base64,...` URL.
 * Returns null when the file is missing (retention-pruned) or unreadable; logs a warning.
 */
async function readScreenshotAsDataUrl(
  ref: ScreenshotRef,
  store: ScreenshotStore,
  logger: Logger,
): Promise<string | null> {
  try {
    const buf = await store.read(ref);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.warn(
        { podId: ref.podId, source: ref.source, filename: ref.filename },
        'Screenshot missing from disk (retention-pruned?) — skipping in report',
      );
      return null;
    }
    throw err;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Generate an HTML validation report for a single validation result.
 * Screenshots are read from disk at render time and embedded as inline base64
 * `<img>` tags (same wire shape as before the screenshot-store migration).
 *
 * Fails-soft: missing screenshot files are omitted from the report; the report
 * is still generated in full.
 */
export async function generateValidationReport(
  result: ValidationResult,
  deps: ReportGeneratorDeps,
): Promise<string> {
  const { screenshotStore, logger } = deps;

  // Gather smoke page screenshots
  const pageScreenshots: Array<{ path: string; dataUrl: string }> = [];
  if (screenshotStore) {
    for (const page of result.smoke.pages) {
      if (!page.screenshot) continue;
      const dataUrl = await readScreenshotAsDataUrl(page.screenshot, screenshotStore, logger);
      if (dataUrl) {
        pageScreenshots.push({ path: page.path, dataUrl });
      }
    }
  }

  // Gather task review screenshots
  const reviewScreenshots: string[] = [];
  if (screenshotStore && result.taskReview) {
    for (const ref of result.taskReview.screenshots) {
      const dataUrl = await readScreenshotAsDataUrl(ref, screenshotStore, logger);
      if (dataUrl) {
        reviewScreenshots.push(dataUrl);
      }
    }
  }

  const statusClass = result.overall === 'pass' ? 'pass' : 'fail';
  const statusLabel = result.overall === 'pass' ? 'PASS' : 'FAIL';

  const smokeImagesHtml = pageScreenshots
    .map(
      (s) =>
        `<div class="screenshot"><p class="caption">Page: ${escapeHtml(s.path)}</p>` +
        `<img src="${s.dataUrl}" alt="Screenshot of ${escapeHtml(s.path)}" /></div>`,
    )
    .join('\n');

  const reviewImagesHtml = reviewScreenshots
    .map(
      (dataUrl, i) =>
        `<div class="screenshot"><p class="caption">Review screenshot ${i + 1}</p>` +
        `<img src="${dataUrl}" alt="Review screenshot ${i + 1}" /></div>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Validation Report — Pod ${escapeHtml(result.podId)}</title>
  <style>
    body { font-family: sans-serif; margin: 2rem; }
    .${statusClass} { color: ${result.overall === 'pass' ? 'green' : 'red'}; }
    .screenshot { margin: 1rem 0; }
    .screenshot img { max-width: 100%; border: 1px solid #ccc; }
    .caption { font-size: 0.85rem; color: #555; margin-bottom: 0.25rem; }
  </style>
</head>
<body>
  <h1>Validation Report</h1>
  <p>Pod: <strong>${escapeHtml(result.podId)}</strong></p>
  <p>Attempt: ${result.attempt}</p>
  <p>Status: <strong class="${statusClass}">${statusLabel}</strong></p>
  <p>Duration: ${result.duration} ms</p>
  ${smokeImagesHtml ? `<h2>Smoke Screenshots</h2>\n${smokeImagesHtml}` : ''}
  ${reviewImagesHtml ? `<h2>Review Screenshots</h2>\n${reviewImagesHtml}` : ''}
</body>
</html>`;
}
