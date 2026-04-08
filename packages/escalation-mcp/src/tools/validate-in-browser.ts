import type { SessionBridge } from '../session-bridge.js';

export interface ValidateInBrowserInput {
  url: string;
  checks: string[];
}

export interface BrowserCheckResult {
  check: string;
  passed: boolean;
  screenshot?: string;
  reasoning: string;
}

export interface ValidateInBrowserResult {
  passed: boolean;
  results: BrowserCheckResult[];
}

const LOCALHOST_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i;

const CONTAINER_SCREENSHOT_DIR = '/tmp/autopod-browser-checks';
const CONTAINER_SCRIPT_PATH = '/tmp/autopod-browser-check.mjs';
const START_MARKER = '__AUTOPOD_BROWSER_RESULTS_START__';
const END_MARKER = '__AUTOPOD_BROWSER_RESULTS_END__';

export function isLocalhostUrl(url: string): boolean {
  return LOCALHOST_PATTERN.test(url);
}

export async function validateInBrowser(
  sessionId: string,
  input: ValidateInBrowserInput,
  bridge: SessionBridge,
): Promise<string> {
  if (!isLocalhostUrl(input.url)) {
    throw new Error(
      `URL must be localhost or 127.0.0.1. Got: ${input.url}. The browser tool is restricted to the local application running in your container.`,
    );
  }

  if (input.checks.length === 0) {
    throw new Error('At least one check is required.');
  }

  const timeout = input.checks.length * 45_000 + 30_000;

  // Try host-side execution first — this avoids network isolation issues since
  // the browser runs on the daemon host where external resources (CDN, fonts,
  // client-side APIs) are reachable.
  const hostResult = await tryHostExecution(sessionId, input, bridge, timeout);
  if (hostResult) return hostResult;

  // Fall back to in-container execution
  return runInContainer(sessionId, input, bridge, timeout);
}

// ── Host-side execution ────────────────────────────────────────────────────

async function tryHostExecution(
  sessionId: string,
  input: ValidateInBrowserInput,
  bridge: SessionBridge,
  timeout: number,
): Promise<string | null> {
  const previewUrl = bridge.getPreviewUrl(sessionId);
  const hostScreenshotDir = bridge.getHostScreenshotDir(sessionId);
  if (!previewUrl || !hostScreenshotDir) return null;

  // Rewrite container-local URL to host-accessible URL
  const hostUrl = rewriteUrlToHost(input.url, previewUrl);

  const script = await generateBrowserScript(sessionId, { ...input, url: hostUrl }, bridge, hostScreenshotDir);

  const execResult = await bridge.runBrowserOnHost(sessionId, script, timeout);
  if (!execResult) return null;

  const results = parseResults(execResult.stdout, input.checks);

  // Collect screenshots from host filesystem
  for (let i = 0; i < results.length; i++) {
    try {
      const b64 = await bridge.readHostScreenshot(`${hostScreenshotDir}/check-${i}.png`);
      const entry = results[i];
      if (entry && b64) {
        entry.screenshot = b64;
      }
    } catch {
      // Screenshot may not exist if the check crashed before taking one
    }
  }

  const allPassed = results.every((r) => r.passed);
  const response: ValidateInBrowserResult = { passed: allPassed, results };
  return JSON.stringify(response, null, 2);
}

// ── In-container execution (fallback) ──────────────────────────────────────

async function runInContainer(
  sessionId: string,
  input: ValidateInBrowserInput,
  bridge: SessionBridge,
  timeout: number,
): Promise<string> {
  const script = await generateBrowserScript(sessionId, input, bridge, CONTAINER_SCREENSHOT_DIR);

  await bridge.writeFileInContainer(sessionId, CONTAINER_SCRIPT_PATH, script);
  await bridge.execInContainer(sessionId, ['mkdir', '-p', CONTAINER_SCREENSHOT_DIR], {
    timeout: 5_000,
  });

  const execResult = await bridge.execInContainer(sessionId, ['node', CONTAINER_SCRIPT_PATH], {
    cwd: '/workspace',
    timeout,
  });

  const results = parseResults(execResult.stdout, input.checks);

  // Collect screenshots from container
  for (let i = 0; i < results.length; i++) {
    try {
      const b64 = await bridge.execInContainer(
        sessionId,
        ['sh', '-c', `base64 -w0 ${CONTAINER_SCREENSHOT_DIR}/check-${i}.png 2>/dev/null`],
        { timeout: 10_000 },
      );
      const entry = results[i];
      if (entry && b64.exitCode === 0 && b64.stdout.trim()) {
        entry.screenshot = b64.stdout.trim();
      }
    } catch {
      // Screenshot may not exist if the check crashed before taking one
    }
  }

  const allPassed = results.every((r) => r.passed);
  const response: ValidateInBrowserResult = { passed: allPassed, results };
  return JSON.stringify(response, null, 2);
}

// ── Script generation ──────────────────────────────────────────────────────

async function generateBrowserScript(
  sessionId: string,
  input: ValidateInBrowserInput,
  bridge: SessionBridge,
  screenshotDir: string,
): Promise<string> {
  const checkList = input.checks.map((check, i) => `Check ${i + 1}: ${check}`).join('\n');

  const prompt = `You are a browser automation expert. Generate a Playwright script (ESM) that executes validation checks against a running web application.

Base URL: ${input.url}
Screenshot directory: ${screenshotDir}

Checks to perform:
${checkList}

Requirements:
- Use \`import { chromium } from 'playwright';\`
- Launch with \`{ headless: true, args: ['--no-sandbox'] }\`
- Create browser context with \`{ locale: 'en-US' }\` to avoid container locale issues
- For each check: navigate to the appropriate URL, perform the validation, take a screenshot
- Save screenshots as ${screenshotDir}/check-{index}.png (0-indexed)
- After all checks, output JSON between markers:
  ${START_MARKER}
  [{ "check": "...", "passed": true/false, "reasoning": "what you observed" }]
  ${END_MARKER}
- Always exit with code 0 (failures are data, not errors)
- Wrap each check in try/catch — if one fails, continue to the next
- Use a 15 second timeout for each navigation

Respond ONLY with the script code. No markdown fences, no explanation.`;

  const rawScript = await bridge.callReviewerModel(sessionId, prompt);
  return stripMarkdownFences(rawScript);
}

// ── URL rewriting ──────────────────────────────────────────────────────────

/**
 * Rewrite a container-local URL (e.g. http://localhost:3000/page) to the
 * host-accessible preview URL (e.g. http://127.0.0.1:45678/page).
 */
export function rewriteUrlToHost(containerUrl: string, previewUrl: string): string {
  try {
    const parsed = new URL(containerUrl);
    const preview = new URL(previewUrl);
    parsed.hostname = preview.hostname;
    parsed.port = preview.port;
    parsed.protocol = preview.protocol;
    return parsed.toString();
  } catch {
    // If URL parsing fails, just return the preview URL as-is
    return previewUrl;
  }
}

// ── Result parsing ─────────────────────────────────────────────────────────

/** Parse results from the Playwright script's stdout markers. */
export function parseResults(stdout: string, checks: string[]): BrowserCheckResult[] {
  const startIdx = stdout.indexOf(START_MARKER);
  const endIdx = stdout.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return checks.map((check) => ({
      check,
      passed: false,
      reasoning: 'Script did not produce parseable results',
    }));
  }

  const jsonStr = stdout.slice(startIdx + START_MARKER.length, endIdx).trim();

  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) {
      return checks.map((check) => ({
        check,
        passed: false,
        reasoning: 'Script output was not a JSON array',
      }));
    }

    return checks.map((check, i) => {
      const result = parsed[i];
      if (!result || typeof result !== 'object') {
        return { check, passed: false, reasoning: 'No result returned for this check' };
      }
      return {
        check,
        passed: Boolean(result.passed),
        reasoning:
          typeof result.reasoning === 'string' ? result.reasoning : 'No reasoning provided',
      };
    });
  } catch {
    return checks.map((check) => ({
      check,
      passed: false,
      reasoning: 'Failed to parse script output as JSON',
    }));
  }
}

/** Strip markdown code fences from LLM output. */
export function stripMarkdownFences(text: string): string {
  return text
    .replace(/^```(?:\w+)?\s*\n?/m, '')
    .replace(/\n?\s*```\s*$/m, '')
    .trim();
}
