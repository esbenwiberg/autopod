import type { SmokePage } from '@autopod/shared';

export interface PlaywrightScriptConfig {
  baseUrl: string;
  pages: SmokePage[];
  screenshotDir: string;
  navigationTimeout: number;
  maxConsoleErrors: number;
}

const DEFAULT_CONFIG: Partial<PlaywrightScriptConfig> = {
  screenshotDir: '/workspace/.autopod/screenshots',
  navigationTimeout: 60_000,
  maxConsoleErrors: 50,
};

/**
 * Generate a self-contained ESM script that Playwright Chromium can run inside a container.
 * The script:
 * - Launches headless Chromium with --no-sandbox (container)
 * - Navigates to each page, captures screenshots and console errors
 * - Runs CSS selector assertions
 * - Outputs PageResult[] as JSON to stdout
 * - Exits 0 on assertion failures (they're data), 1 only on script crash
 */
export function generateValidationScript(config: PlaywrightScriptConfig): string {
  const merged = { ...DEFAULT_CONFIG, ...config };
  const configJson = JSON.stringify(merged);

  return `
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Use createRequire so CJS resolution picks up NODE_PATH (ESM import ignores it)
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const CONFIG = ${configJson};

async function run() {
  mkdirSync(CONFIG.screenshotDir, { recursive: true });

  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const results = [];

  // DNS failures are expected in network-restricted containers — don't
  // count them as application errors.
  const DNS_NOISE = /net::ERR_NAME_NOT_RESOLVED/;

  // React dev-mode emits informational warnings via console.error with a
  // "Warning: " prefix. These are not runtime failures — filter them out
  // so smoke checks don't fail on pre-existing React housekeeping noise.
  const REACT_DEV_WARNING = /^Warning: /;

  // Errors that indicate the dev server transiently closed connections
  // (commonly: Vite cold-start dep optimization closes inflight sockets
  // when esbuild finishes pre-bundling). Retrying once after a short
  // pause is the documented mitigation — by the second nav the dep
  // graph is cached.
  const TRANSIENT_NET_ERROR = /net::(ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_NETWORK_CHANGED|ERR_ABORTED|ERR_HTTP2_PROTOCOL_ERROR|ERR_EMPTY_RESPONSE)/;

  async function loadPageOnce(pageDef) {
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();

    const consoleErrors = [];
    const failedRequests = [];
    const MAX_ERRORS = CONFIG.maxConsoleErrors;
    let totalErrorBytes = 0;
    const MAX_ERROR_BYTES = 10240;

    page.on('console', (msg) => {
      if (msg.type() === 'error' && consoleErrors.length < MAX_ERRORS && totalErrorBytes < MAX_ERROR_BYTES) {
        const text = msg.text().slice(0, 500);
        if (DNS_NOISE.test(text)) return;
        if (REACT_DEV_WARNING.test(text)) return;
        consoleErrors.push(text);
        totalErrorBytes += text.length;
      }
    });

    page.on('pageerror', (err) => {
      if (consoleErrors.length < MAX_ERRORS && totalErrorBytes < MAX_ERROR_BYTES) {
        const text = String(err).slice(0, 500);
        consoleErrors.push(text);
        totalErrorBytes += text.length;
      }
    });

    // Capture failed network requests with their URL + error reason so we
    // can tell "ERR_CONNECTION_CLOSED on /bundle.js" from "DNS failure on
    // some CDN". The console listener above only gets Chromium's opaque
    // "Failed to load resource" line which doesn't include the URL.
    page.on('requestfailed', (req) => {
      const errorText = req.failure()?.errorText ?? 'unknown';
      if (DNS_NOISE.test(errorText)) return;
      if (failedRequests.length < MAX_ERRORS && totalErrorBytes < MAX_ERROR_BYTES) {
        const line = req.url().slice(0, 400) + ' — ' + errorText.slice(0, 100);
        failedRequests.push({ url: req.url(), errorText });
        consoleErrors.push('Request failed: ' + line);
        totalErrorBytes += line.length;
      }
    });

    const url = CONFIG.baseUrl + pageDef.path;
    const startTime = Date.now();
    let status = 'pass';
    const assertions = [];
    let screenshotPath = '';
    let navError = null;

    try {
      await page.goto(url, { timeout: CONFIG.navigationTimeout, waitUntil: 'domcontentloaded' });

      // Allow JS frameworks to render after DOM is ready. networkidle is too
      // fragile — external resources that fail DNS (e.g. in network-restricted
      // containers) prevent it from ever firing.
      await page.waitForTimeout(2000);
      const loadTime = Date.now() - startTime;

      // Screenshot
      const safeName = pageDef.path.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '') || 'root';
      screenshotPath = resolve(CONFIG.screenshotDir, safeName + '.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });

      // Assertions
      if (pageDef.assertions) {
        for (const assertion of pageDef.assertions) {
          const result = await runAssertion(page, assertion);
          assertions.push(result);
          if (!result.passed) status = 'fail';
        }
      }

      // Console errors make it a failure
      if (consoleErrors.length > 0) {
        status = 'fail';
      }

      await context.close();
      return {
        path: pageDef.path,
        status,
        screenshotPath,
        consoleErrors,
        assertions,
        loadTime,
        failedRequests,
      };
    } catch (err) {
      navError = err;
      await context.close().catch(() => {});
      return {
        path: pageDef.path,
        status: 'fail',
        screenshotPath,
        consoleErrors: [...consoleErrors, 'Navigation failed: ' + String(navError).slice(0, 500)],
        assertions,
        loadTime: Date.now() - startTime,
        failedRequests,
        navError: String(navError).slice(0, 500),
      };
    }
  }

  function hasTransientNetError(result) {
    if (result.navError && TRANSIENT_NET_ERROR.test(result.navError)) return true;
    for (const r of result.failedRequests || []) {
      if (TRANSIENT_NET_ERROR.test(r.errorText)) return true;
    }
    return false;
  }

  for (const pageDef of CONFIG.pages) {
    let result = await loadPageOnce(pageDef);

    // Vite (and similar dev servers) close inflight sockets when esbuild
    // finishes dep pre-bundling mid-page-load. A single retry after a
    // short pause clears it — by then deps are cached.
    if (result.status === 'fail' && hasTransientNetError(result)) {
      const firstFailedCount = (result.failedRequests || []).length;
      const firstNavError = result.navError;
      await new Promise((r) => setTimeout(r, 3000));
      const retry = await loadPageOnce(pageDef);
      // Annotate so we can see in logs that a retry happened, regardless
      // of outcome.
      retry.retried = true;
      retry.firstAttempt = {
        failedRequestCount: firstFailedCount,
        navError: firstNavError,
      };
      result = retry;
    }

    // Drop the internal failedRequests array from the surfaced result —
    // the URLs are already inlined into consoleErrors. Keep the result
    // shape backward-compatible with parsePageResults().
    delete result.failedRequests;
    results.push(result);
  }

  await browser.close();

  // Output marker + JSON so the parser can find it in noisy stdout
  console.log('__AUTOPOD_PAGE_RESULTS_START__');
  console.log(JSON.stringify(results));
  console.log('__AUTOPOD_PAGE_RESULTS_END__');
}

async function runAssertion(page, assertion) {
  const { selector, type, value } = assertion;
  let actual = undefined;
  let passed = false;

  try {
    switch (type) {
      case 'exists': {
        const count = await page.locator(selector).count();
        actual = String(count);
        passed = count > 0;
        break;
      }
      case 'visible': {
        const el = page.locator(selector).first();
        passed = await el.isVisible();
        actual = passed ? 'visible' : 'hidden';
        break;
      }
      case 'text_contains': {
        const el = page.locator(selector).first();
        const text = await el.textContent() ?? '';
        actual = text.slice(0, 200);
        passed = value ? text.includes(value) : text.length > 0;
        break;
      }
      case 'count': {
        const count = await page.locator(selector).count();
        actual = String(count);
        passed = value ? count === Number(value) : count > 0;
        break;
      }
    }
  } catch (err) {
    actual = 'error: ' + String(err).slice(0, 200);
    passed = false;
  }

  return { selector, type, expected: value, actual, passed };
}

run().catch((err) => {
  console.error('Script crashed:', err);
  process.exit(1);
});
`.trim();
}
