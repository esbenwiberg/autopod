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

const SCREENSHOT_DIR = '/tmp/autopod-browser-checks';
const SCRIPT_PATH = '/tmp/autopod-browser-check.mjs';
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

  // Generate Playwright script via LLM
  const script = await generateBrowserScript(sessionId, input, bridge);

  // Write script and set up screenshot dir in container
  await bridge.writeFileInContainer(sessionId, SCRIPT_PATH, script);
  await bridge.execInContainer(sessionId, ['mkdir', '-p', SCREENSHOT_DIR], { timeout: 5_000 });

  // Execute the script
  const timeout = input.checks.length * 45_000 + 30_000;
  const execResult = await bridge.execInContainer(sessionId, ['node', SCRIPT_PATH], {
    cwd: '/workspace',
    timeout,
  });

  // Parse results from stdout
  const results = parseResults(execResult.stdout, input.checks);

  // Collect screenshots
  for (let i = 0; i < results.length; i++) {
    try {
      const b64 = await bridge.execInContainer(
        sessionId,
        ['sh', '-c', `base64 -w0 ${SCREENSHOT_DIR}/check-${i}.png 2>/dev/null`],
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

async function generateBrowserScript(
  sessionId: string,
  input: ValidateInBrowserInput,
  bridge: SessionBridge,
): Promise<string> {
  const checkList = input.checks.map((check, i) => `Check ${i + 1}: ${check}`).join('\n');

  const prompt = `You are a browser automation expert. Generate a Playwright script (ESM) that executes validation checks against a running web application.

Base URL: ${input.url}
Screenshot directory: ${SCREENSHOT_DIR}

Checks to perform:
${checkList}

Requirements:
- Use \`import { chromium } from 'playwright';\`
- Launch with \`{ headless: true, args: ['--no-sandbox'] }\`
- For each check: navigate to the appropriate URL, perform the validation, take a screenshot
- Save screenshots as ${SCREENSHOT_DIR}/check-{index}.png (0-indexed)
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
