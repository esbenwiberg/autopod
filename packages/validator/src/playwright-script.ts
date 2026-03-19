import type { ValidationPage } from '@autopod/shared';

export interface PlaywrightScriptConfig {
  baseUrl: string;
  pages: ValidationPage[];
  screenshotDir: string;
  navigationTimeout: number;
  maxConsoleErrors: number;
}

const DEFAULT_CONFIG: Partial<PlaywrightScriptConfig> = {
  screenshotDir: '/workspace/.autopod/screenshots',
  navigationTimeout: 30_000,
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
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const CONFIG = ${configJson};

async function run() {
  mkdirSync(CONFIG.screenshotDir, { recursive: true });

  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const results = [];

  for (const pageDef of CONFIG.pages) {
    const context = await browser.newContext();
    const page = await context.newPage();

    const consoleErrors = [];
    const MAX_ERRORS = CONFIG.maxConsoleErrors;
    let totalErrorBytes = 0;
    const MAX_ERROR_BYTES = 10240;

    page.on('console', (msg) => {
      if (msg.type() === 'error' && consoleErrors.length < MAX_ERRORS && totalErrorBytes < MAX_ERROR_BYTES) {
        const text = msg.text().slice(0, 500);
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

    const url = CONFIG.baseUrl + pageDef.path;
    const startTime = Date.now();
    let status = 'pass';
    const assertions = [];
    let screenshotPath = '';

    try {
      await page.goto(url, { timeout: CONFIG.navigationTimeout, waitUntil: 'networkidle' });
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

      results.push({
        path: pageDef.path,
        status,
        screenshotPath,
        consoleErrors,
        assertions,
        loadTime,
      });
    } catch (err) {
      results.push({
        path: pageDef.path,
        status: 'fail',
        screenshotPath,
        consoleErrors: [...consoleErrors, 'Navigation failed: ' + String(err).slice(0, 500)],
        assertions,
        loadTime: Date.now() - startTime,
      });
    }

    await context.close();
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
