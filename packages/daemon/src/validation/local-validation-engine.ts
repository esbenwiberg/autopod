import { spawn } from 'node:child_process';

import type {
  AcCheckResult,
  AcValidationResult,
  DeviationsAssessment,
  PageResult,
  TaskReviewResult,
  ValidationOverride,
  ValidationResult,
} from '@autopod/shared';
import { generateValidationScript, parsePageResults } from '@autopod/validator';
import type { Logger } from 'pino';

import type { ContainerManager } from '../interfaces/container-manager.js';
import type { ValidationEngine, ValidationEngineConfig } from '../interfaces/validation-engine.js';
import type { HostBrowserRunner } from './host-browser-runner.js';
import { runAgenticReview } from './review-agentic-runner.js';
import { type ReviewContext, gatherReviewContext } from './review-context-builder.js';
import { runToolUseReview } from './review-tool-runner.js';

/**
 * Runs the Claude CLI in print mode, piping `input` via stdin.
 *
 * Uses `spawn` instead of `execFile` so that stdin data is written immediately
 * after the process is created. This avoids the Claude CLI's 3-second stdin
 * timeout that `execFile` can miss when its internal setup delays the write.
 */
function runClaudeCli(opts: {
  model: string;
  input: string;
  timeout: number;
  maxBuffer?: number;
}): Promise<{ stdout: string }> {
  const maxBuf = opts.maxBuffer ?? 2 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const child = spawn('claude', ['-p', '--model', opts.model, '--output-format', 'text']);

    // Write stdin immediately so data is queued before the CLI's 3 s timeout.
    child.stdin.write(opts.input);
    child.stdin.end();
    // Suppress EPIPE if the process exits before stdin is fully flushed.
    child.stdin.on('error', () => {});

    let stdout = '';
    let stderr = '';
    let stdoutLen = 0;

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(() => reject(new Error(`Command timed out after ${opts.timeout}ms`)));
    }, opts.timeout);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutLen += chunk.length;
      if (stdoutLen > maxBuf) {
        child.kill('SIGTERM');
        settle(() => reject(new Error(`stdout exceeded maxBuffer (${maxBuf} bytes)`)));
        return;
      }
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        settle(() =>
          reject(
            new Error(
              `Command failed: claude -p --model ${opts.model} --output-format text\n${stderr}`,
            ),
          ),
        );
      } else {
        settle(() => resolve({ stdout }));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      settle(() => reject(err));
    });
  });
}

/**
 * Local validation engine with build, health check, and AI task review.
 *
 * Page validation is intentionally skipped — it requires a browser (Playwright),
 * which is not available in this sandbox environment.
 */
export function createLocalValidationEngine(
  containerManager: ContainerManager,
  logger?: Logger,
  hostBrowserRunner?: HostBrowserRunner,
): ValidationEngine {
  const log = logger?.child({ component: 'local-validation-engine' });

  return {
    async validate(
      config: ValidationEngineConfig,
      onProgress?: (message: string) => void,
    ): Promise<ValidationResult> {
      const startTime = Date.now();

      // ── Phase 1: Build ──────────────────────────────────────────────
      if (config.buildCommand) onProgress?.('Running build…');
      const buildResult = await runBuild(containerManager, config, log);

      // ── Phase 2: Test ───────────────────────────────────────────────
      if (buildResult.status === 'pass' && config.testCommand) onProgress?.('Running tests…');
      const testResult =
        buildResult.status === 'pass'
          ? await runTests(containerManager, config, log)
          : { status: 'skip' as const, duration: 0 };

      // ── Phase 3: Health check ───────────────────────────────────────
      if (buildResult.status === 'pass' && config.startCommand)
        onProgress?.('Running health check…');
      const healthResult =
        buildResult.status === 'pass'
          ? await runHealthCheck(containerManager, config, log)
          : {
              status: 'fail' as const,
              url: config.previewUrl + config.healthPath,
              responseCode: null,
              duration: 0,
            };

      // ── Phase 4: Page validation ─────────────────────────────────────
      if (healthResult.status === 'pass' && config.smokePages.length > 0)
        onProgress?.('Validating pages…');
      const pages: PageResult[] =
        healthResult.status === 'pass' && config.smokePages.length > 0
          ? await runPageValidation(containerManager, config, log, hostBrowserRunner)
          : [];

      // ── Phase 5: AC Validation ────────────────────────────────────────
      if (healthResult.status === 'pass' && config.acceptanceCriteria?.length)
        onProgress?.('Checking acceptance criteria…');
      const acValidation =
        healthResult.status === 'pass'
          ? await runAcValidation(containerManager, config, log, hostBrowserRunner)
          : null;

      // ── Phase 6: AI Task Review ─────────────────────────────────────
      onProgress?.('Running AI task review…');

      // Gather enriched context from the worktree (Tier 0+1)
      let reviewContext: ReviewContext | undefined;
      if (config.worktreePath) {
        try {
          reviewContext = await gatherReviewContext(
            config.worktreePath,
            config.diff,
            config.startCommitSha,
          );
        } catch (err) {
          log?.warn({ err }, 'Failed to gather review context, proceeding without enrichment');
        }
      }

      const { result: taskReview, skipReason: reviewSkipReason } = await runTaskReview(
        config,
        log,
        reviewContext,
      );

      // ── Phase 7: Overall result ─────────────────────────────────────
      const pagesPass = pages.length === 0 || pages.every((p) => p.status === 'pass');
      const smokeStatus =
        buildResult.status === 'pass' && healthResult.status === 'pass' && pagesPass
          ? ('pass' as const)
          : ('fail' as const);

      const testFailed = testResult.status === 'fail';
      const acFailed = acValidation !== null && acValidation.status === 'fail';
      const overall =
        smokeStatus === 'pass' &&
        !testFailed &&
        !acFailed &&
        (taskReview === null || taskReview.status === 'pass')
          ? ('pass' as const)
          : ('fail' as const);

      const duration = Date.now() - startTime;

      return {
        sessionId: config.sessionId,
        attempt: config.attempt,
        timestamp: new Date().toISOString(),
        smoke: {
          status: smokeStatus,
          build: buildResult,
          health: healthResult,
          pages,
        },
        test: testResult,
        acValidation,
        taskReview,
        reviewSkipReason,
        overall,
        duration,
      };
    },
  };
}

// ── Build phase ─────────────────────────────────────────────────────────────

async function runBuild(
  containerManager: ContainerManager,
  config: ValidationEngineConfig,
  log?: Logger,
) {
  if (!config.buildCommand) {
    log?.info('no build command configured, skipping build');
    return { status: 'pass' as const, output: '', duration: 0 };
  }

  const buildStart = Date.now();
  log?.info({ buildCommand: config.buildCommand }, 'running build');

  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = await containerManager.execInContainer(
      config.containerId,
      ['sh', '-c', config.buildCommand],
      { cwd: '/workspace', timeout: config.buildTimeout ?? 300_000 },
    );
  } catch (err) {
    const duration = Date.now() - buildStart;
    const partial = (err as { partialOutput?: string })?.partialOutput ?? '';
    const message = err instanceof Error ? err.message : String(err);
    log?.warn({ duration }, `build timed out: ${message}`);
    return {
      status: 'fail' as const,
      output: `${message}\n\n--- partial output (last 5 KB) ---\n${partial}`.slice(0, 50_000),
      duration,
    };
  }

  const duration = Date.now() - buildStart;
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const status = result.exitCode === 0 ? ('pass' as const) : ('fail' as const);

  if (status === 'fail') {
    log?.warn({ exitCode: result.exitCode, duration }, 'build failed');
  } else {
    log?.info({ duration }, 'build passed');
  }

  return {
    status,
    output: output.slice(0, 50_000), // Cap output size
    duration,
  };
}

// ── Test phase ───────────────────────────────────────────────────────────────

async function runTests(
  containerManager: ContainerManager,
  config: ValidationEngineConfig,
  log?: Logger,
) {
  if (!config.testCommand) {
    log?.info('no test command configured, skipping tests');
    return { status: 'skip' as const, duration: 0 };
  }

  const testStart = Date.now();
  log?.info({ testCommand: config.testCommand }, 'running tests');

  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = await containerManager.execInContainer(
      config.containerId,
      ['sh', '-c', config.testCommand],
      { cwd: '/workspace', timeout: config.testTimeout ?? 600_000 },
    );
  } catch (err) {
    const duration = Date.now() - testStart;
    const partial = (err as { partialOutput?: string })?.partialOutput ?? '';
    const message = err instanceof Error ? err.message : String(err);
    log?.warn({ duration }, `tests timed out: ${message}`);
    return {
      status: 'fail' as const,
      duration,
      stdout: `${message}\n\n--- partial output (last 5 KB) ---\n${partial}`.slice(0, 50_000),
      stderr: '',
    };
  }

  const duration = Date.now() - testStart;
  const status = result.exitCode === 0 ? ('pass' as const) : ('fail' as const);

  if (status === 'fail') {
    log?.warn({ exitCode: result.exitCode, duration }, 'tests failed');
  } else {
    log?.info({ duration }, 'tests passed');
  }

  return {
    status,
    duration,
    stdout: result.stdout.slice(0, 50_000),
    stderr: result.stderr.slice(0, 50_000),
  };
}

// ── Health check phase ──────────────────────────────────────────────────────

async function runHealthCheck(
  containerManager: ContainerManager,
  config: ValidationEngineConfig,
  log?: Logger,
) {
  if (!config.startCommand) {
    log?.info('no start command configured, skipping health check');
    return {
      status: 'pass' as const,
      url: config.previewUrl + config.healthPath,
      responseCode: null,
      duration: 0,
    };
  }

  const healthStart = Date.now();
  const url = config.previewUrl + config.healthPath;
  const timeoutMs = config.healthTimeout * 1_000;

  log?.info({ startCommand: config.startCommand, url, timeoutMs }, 'starting app for health check');

  // Start the app in the background, redirecting output to a log file so we can
  // retrieve it for diagnostics if the health check fails.
  const startLogPath = '/tmp/autopod-start.log';
  containerManager
    .execInContainer(
      config.containerId,
      ['sh', '-c', `${config.startCommand} > ${startLogPath} 2>&1 &`],
      { cwd: '/workspace' },
    )
    .catch((err) => {
      log?.warn(
        { err },
        'background start command errored (may be expected for long-running processes)',
      );
    });

  // Poll for health — accept any 2xx response (200, 201, 204, etc.)
  const pollIntervalMs = 2_000;
  let lastResponseCode: number | null = null;

  while (Date.now() - healthStart < timeoutMs) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5_000),
      });
      lastResponseCode = response.status;

      if (response.status >= 200 && response.status < 300) {
        const duration = Date.now() - healthStart;
        log?.info({ url, status: response.status, duration }, 'health check passed');
        return { status: 'pass' as const, url, responseCode: response.status, duration };
      }

      log?.debug({ url, status: response.status }, 'health check got non-2xx, retrying');
    } catch {
      log?.debug({ url }, 'health check fetch failed, retrying');
    }

    // Wait before next poll, but don't overshoot the timeout
    const remaining = timeoutMs - (Date.now() - healthStart);
    if (remaining > 0) {
      await sleep(Math.min(pollIntervalMs, remaining));
    }
  }

  const duration = Date.now() - healthStart;
  log?.warn({ url, lastResponseCode, duration }, 'health check timed out');

  // Collect startup output to help diagnose why the server didn't come up
  const startOutput = await containerManager
    .readFile(config.containerId, startLogPath)
    .catch(() => '');

  if (startOutput) {
    log?.warn(
      { startOutput: startOutput.slice(0, 500) },
      'start command output on health check failure',
    );
  }

  return {
    status: 'fail' as const,
    url,
    responseCode: lastResponseCode,
    duration,
    startOutput: startOutput.slice(0, 5_000) || undefined,
  };
}

// ── Page validation phase ───────────────────────────────────────────────────

async function runPageValidation(
  containerManager: ContainerManager,
  config: ValidationEngineConfig,
  log?: Logger,
  hostBrowserRunner?: HostBrowserRunner,
): Promise<PageResult[]> {
  log?.info({ pageCount: config.smokePages.length }, 'running page validation');

  // Try host-side execution first — external resources (CDN, fonts, client APIs)
  // are reachable from the host but may be blocked inside network-restricted containers.
  if (hostBrowserRunner && (await hostBrowserRunner.isAvailable())) {
    const hostResult = await runPageValidationOnHost(hostBrowserRunner, config, log);
    if (hostResult) return hostResult;
    log?.info('host-side page validation returned null, falling back to container');
  }

  return runPageValidationInContainer(containerManager, config, log);
}

async function runPageValidationOnHost(
  hostBrowserRunner: HostBrowserRunner,
  config: ValidationEngineConfig,
  log?: Logger,
): Promise<PageResult[] | null> {
  const screenshotDir = hostBrowserRunner.screenshotDir(config.sessionId);

  const script = generateValidationScript({
    baseUrl: config.previewUrl,
    pages: config.smokePages,
    screenshotDir,
    navigationTimeout: config.navigationTimeout ?? 60_000,
    maxConsoleErrors: 50,
  });

  try {
    const result = await hostBrowserRunner.runScript(script, {
      timeout: config.smokePages.length * 45_000,
      sessionId: config.sessionId,
    });

    const pages = parsePageResults(result.stdout);

    if (pages.length === 0 && result.exitCode !== 0) {
      log?.warn(
        { exitCode: result.exitCode, stderr: result.stderr.slice(0, 1000) },
        'host page validation script crashed',
      );
      return [
        makeSyntheticFailure(
          '/',
          `Host script crashed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`,
        ),
      ];
    }

    log?.info(
      {
        mode: 'host',
        pageCount: pages.length,
        passCount: pages.filter((p) => p.status === 'pass').length,
      },
      'page validation complete (host-side)',
    );
    return pages;
  } catch (err) {
    log?.warn({ err }, 'host-side page validation failed, will fall back to container');
    return null;
  }
}

async function runPageValidationInContainer(
  containerManager: ContainerManager,
  config: ValidationEngineConfig,
  log?: Logger,
): Promise<PageResult[]> {
  const script = generateValidationScript({
    baseUrl: config.containerBaseUrl ?? config.previewUrl,
    pages: config.smokePages,
    screenshotDir: '/workspace/.autopod/screenshots',
    navigationTimeout: config.navigationTimeout ?? 60_000,
    maxConsoleErrors: 50,
  });

  // Write the script to the container
  const scriptPath = '/tmp/autopod-page-validation.mjs';
  try {
    await containerManager.writeFile(config.containerId, scriptPath, script);
  } catch (err) {
    log?.warn({ err }, 'failed to write validation script to container');
    return [makeSyntheticFailure('/', `Failed to write validation script: ${err}`)];
  }

  // Execute the script inside the container
  try {
    const result = await containerManager.execInContainer(
      config.containerId,
      ['sh', '-c', `NODE_PATH=\${NODE_PATH:-$(npm root -g)} node ${scriptPath}`],
      { cwd: '/workspace', timeout: config.smokePages.length * 45_000 },
    );

    const pages = parsePageResults(result.stdout);

    if (pages.length === 0 && result.exitCode !== 0) {
      log?.warn(
        { exitCode: result.exitCode, stderr: result.stderr.slice(0, 1000) },
        'page validation script crashed',
      );
      return [
        makeSyntheticFailure(
          '/',
          `Script crashed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`,
        ),
      ];
    }

    log?.info(
      { pageCount: pages.length, passCount: pages.filter((p) => p.status === 'pass').length },
      'page validation complete',
    );
    return pages;
  } catch (err) {
    log?.warn({ err }, 'page validation exec failed');
    return [makeSyntheticFailure('/', `Exec failed: ${err}`)];
  }
}

function makeSyntheticFailure(path: string, error: string): PageResult {
  return {
    path,
    status: 'fail',
    screenshotPath: '',
    consoleErrors: [error],
    assertions: [],
    loadTime: 0,
  };
}

// ── AC Validation phase ─────────────────────────────────────────────────────

async function runAcValidation(
  containerManager: ContainerManager,
  config: ValidationEngineConfig,
  log?: Logger,
  hostBrowserRunner?: HostBrowserRunner,
): Promise<AcValidationResult | null> {
  if (!config.acceptanceCriteria || config.acceptanceCriteria.length === 0) {
    log?.info('no acceptance criteria provided, skipping AC validation');
    return null;
  }

  if (!config.reviewerModel) {
    log?.info('no reviewer model configured, skipping AC validation');
    return null;
  }

  log?.info(
    { acCount: config.acceptanceCriteria.length, model: config.reviewerModel },
    'running AC validation',
  );

  // Step 1: Reviewer generates validation instructions from ACs
  const instructions = await generateAcInstructions(config, log);
  if (!instructions || instructions.length === 0) {
    log?.warn('reviewer generated no validation instructions, skipping AC validation');
    return { status: 'skip', results: [], model: config.reviewerModel };
  }

  // Step 2: Executor translates instructions to Playwright script and executes
  const results = await executeAcChecks(
    containerManager,
    config,
    instructions,
    log,
    hostBrowserRunner,
  );

  const allPassed = results.every((r) => r.passed);

  log?.info(
    {
      acCount: results.length,
      passCount: results.filter((r) => r.passed).length,
      failCount: results.filter((r) => !r.passed).length,
    },
    'AC validation complete',
  );

  return {
    status: allPassed ? 'pass' : 'fail',
    results,
    model: config.reviewerModel,
  };
}

/** Reviewer LLM generates natural language validation instructions from ACs. */
async function generateAcInstructions(
  config: ValidationEngineConfig,
  log?: Logger,
): Promise<Array<{ criterion: string; instruction: string }> | null> {
  const acs = config.acceptanceCriteria ?? [];
  const acList = acs.map((ac, i) => `${i + 1}. ${ac}`).join('\n');

  const prompt = `You are a QA reviewer for a web application. Your job is to generate browser-based validation instructions for each acceptance criterion.

Task: ${config.task}

Acceptance Criteria:
${acList}

Diff of changes made:
${config.diff || '(no diff available)'}

The application is running at: ${config.previewUrl}

For each acceptance criterion, generate a specific validation instruction that can be carried out in a browser. The instruction should describe:
- Which URL to navigate to
- What to look for on the page
- What constitutes a pass vs fail

Respond with a JSON array. Each element must have:
- "criterion": the original acceptance criterion text (copy exactly)
- "instruction": a natural language instruction for a browser automation tool

Example:
[
  {
    "criterion": "Settings page has a dark mode toggle",
    "instruction": "Navigate to /settings. Look for a toggle, switch, or checkbox element related to 'dark mode' or 'theme'. Verify it is visible and interactive. Take a screenshot."
  }
]

Respond ONLY with the JSON array, no markdown fences or extra text.`;

  try {
    const reviewTimeout = config.reviewTimeout ?? 300_000;
    const { stdout } = await runClaudeCli({
      model: config.reviewerModel ?? 'sonnet',
      input: prompt,
      timeout: reviewTimeout,
    });

    return parseAcInstructionsJson(stdout.trim());
  } catch (err) {
    log?.warn({ err }, 'failed to generate AC validation instructions');
    return null;
  }
}

/** Executor LLM generates and runs a Playwright script from instructions. */
async function executeAcChecks(
  containerManager: ContainerManager,
  config: ValidationEngineConfig,
  instructions: Array<{ criterion: string; instruction: string }>,
  log?: Logger,
  hostBrowserRunner?: HostBrowserRunner,
): Promise<AcCheckResult[]> {
  const useHost = hostBrowserRunner && (await hostBrowserRunner.isAvailable());
  const baseUrl = useHost ? config.previewUrl : (config.containerBaseUrl ?? config.previewUrl);
  const screenshotDir = useHost
    ? `${hostBrowserRunner.screenshotDir(config.sessionId)}/ac`
    : '/tmp/autopod-ac-screenshots';

  const instructionList = instructions
    .map((inst, i) => `Check ${i + 1}: "${inst.criterion}"\nInstruction: ${inst.instruction}`)
    .join('\n\n');

  // When running on host, use standard ESM import; in container, use createRequire for NODE_PATH
  const importLine = useHost
    ? `import { chromium } from 'playwright';`
    : `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const { chromium } = require('playwright');`;

  const prompt = `You are a browser automation expert. Generate a Playwright script (ESM, using @playwright/test's chromium) that executes the following validation checks against a running web application.

Base URL: ${baseUrl}
Screenshot directory: ${screenshotDir}

Checks to perform:
${instructionList}

Requirements:
- Use \`${importLine}\` (${useHost ? 'standard ESM import' : 'ESM import ignores NODE_PATH, so use createRequire for CJS resolution'})
- Launch chromium with \`{ headless: true, args: ['--no-sandbox'] }\`
- Create browser context with \`{ locale: 'en-US' }\` to avoid locale issues
- For each check: navigate to the appropriate URL with \`{ waitUntil: 'domcontentloaded' }\`, then \`await page.waitForTimeout(2000)\` for JS rendering, perform the validation, take a screenshot
- Save screenshots as ${screenshotDir}/check-{index}.png (0-indexed)
- After all checks, output a JSON result between markers:
  __AUTOPOD_AC_RESULTS_START__
  [
    { "criterion": "...", "passed": true/false, "reasoning": "what you found" }
  ]
  __AUTOPOD_AC_RESULTS_END__
- Exit code 0 regardless of pass/fail (failures are data, not errors)
- Wrap each check in try/catch — if one fails, continue to the next
- Use a 15 second timeout for each navigation

Respond ONLY with the script code. No markdown fences, no explanation.`;

  try {
    const reviewTimeout = config.reviewTimeout ?? 300_000;
    const { stdout: scriptCode } = await runClaudeCli({
      model: config.reviewerModel ?? 'sonnet',
      input: prompt,
      timeout: reviewTimeout,
    });

    const cleanScript = stripMarkdownFences(scriptCode.trim());
    const execTimeout = instructions.length * 45_000 + 30_000;

    if (useHost) {
      return await executeAcOnHost(
        hostBrowserRunner,
        config,
        cleanScript,
        instructions,
        execTimeout,
        log,
      );
    }

    return await executeAcInContainer(
      containerManager,
      config,
      cleanScript,
      instructions,
      execTimeout,
      log,
    );
  } catch (err) {
    log?.warn({ err }, 'AC check execution failed');
    return instructions.map((inst) => ({
      criterion: inst.criterion,
      passed: false,
      reasoning: `Execution failed: ${err}`,
    }));
  }
}

async function executeAcOnHost(
  hostBrowserRunner: HostBrowserRunner,
  config: ValidationEngineConfig,
  script: string,
  instructions: Array<{ criterion: string; instruction: string }>,
  timeout: number,
  log?: Logger,
): Promise<AcCheckResult[]> {
  const screenshotDir = `${hostBrowserRunner.screenshotDir(config.sessionId)}/ac`;

  const result = await hostBrowserRunner.runScript(script, {
    timeout,
    sessionId: config.sessionId,
  });

  const parsed = parseAcResults(result.stdout, instructions);

  for (let i = 0; i < parsed.length; i++) {
    try {
      const b64 = await hostBrowserRunner.readScreenshot(`${screenshotDir}/check-${i}.png`);
      parsed[i].screenshot = b64;
    } catch {
      // Screenshot might not exist
    }
  }

  log?.info({ mode: 'host', checkCount: parsed.length }, 'AC checks executed on host');

  return parsed;
}

async function executeAcInContainer(
  containerManager: ContainerManager,
  config: ValidationEngineConfig,
  script: string,
  instructions: Array<{ criterion: string; instruction: string }>,
  timeout: number,
  log?: Logger,
): Promise<AcCheckResult[]> {
  const scriptPath = '/tmp/autopod-ac-validation.mjs';
  await containerManager.writeFile(config.containerId, scriptPath, script);

  await containerManager.execInContainer(
    config.containerId,
    ['mkdir', '-p', '/tmp/autopod-ac-screenshots'],
    { cwd: '/workspace' },
  );

  const result = await containerManager.execInContainer(
    config.containerId,
    ['sh', '-c', `NODE_PATH=\${NODE_PATH:-$(npm root -g)} node ${scriptPath}`],
    { cwd: '/workspace', timeout },
  );

  const parsed = parseAcResults(result.stdout, instructions);

  for (let i = 0; i < parsed.length; i++) {
    try {
      const b64Result = await containerManager.execInContainer(
        config.containerId,
        ['sh', '-c', `base64 -w0 /tmp/autopod-ac-screenshots/check-${i}.png 2>/dev/null`],
        { timeout: 10_000 },
      );
      if (b64Result.exitCode === 0 && b64Result.stdout.trim()) {
        parsed[i].screenshot = b64Result.stdout.trim();
      }
    } catch {
      // Screenshot might not exist if the check crashed
    }
  }

  log?.info({ mode: 'container', checkCount: parsed.length }, 'AC checks executed in container');

  return parsed;
}

/** @internal Exported for testing. Parse the reviewer's JSON array of AC instructions. */
export function parseAcInstructionsJson(
  raw: string,
): Array<{ criterion: string; instruction: string }> | null {
  const cleaned = stripMarkdownFences(raw);
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return null;

    return parsed
      .filter(
        (item: unknown): item is { criterion: string; instruction: string } =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Record<string, unknown>).criterion === 'string' &&
          typeof (item as Record<string, unknown>).instruction === 'string',
      )
      .map((item) => ({ criterion: item.criterion, instruction: item.instruction }));
  } catch {
    return null;
  }
}

/** @internal Exported for testing. Parse AC results from the Playwright script's stdout markers. */
export function parseAcResults(
  stdout: string,
  instructions: Array<{ criterion: string; instruction: string }>,
): AcCheckResult[] {
  const startMarker = '__AUTOPOD_AC_RESULTS_START__';
  const endMarker = '__AUTOPOD_AC_RESULTS_END__';

  const startIdx = stdout.indexOf(startMarker);
  const endIdx = stdout.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    // Script didn't output proper markers — treat all as failed
    return instructions.map((inst) => ({
      criterion: inst.criterion,
      passed: false,
      reasoning: 'Script did not produce parseable results',
    }));
  }

  const jsonStr = stdout.slice(startIdx + startMarker.length, endIdx).trim();

  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) {
      return instructions.map((inst) => ({
        criterion: inst.criterion,
        passed: false,
        reasoning: 'Script output was not a JSON array',
      }));
    }

    // Map results back to instructions, preserving order
    return instructions.map((inst, i) => {
      const result = parsed[i];
      if (!result || typeof result !== 'object') {
        return {
          criterion: inst.criterion,
          passed: false,
          reasoning: 'No result returned for this check',
        };
      }
      return {
        criterion: inst.criterion,
        passed: Boolean(result.passed),
        reasoning:
          typeof result.reasoning === 'string' ? result.reasoning : 'No reasoning provided',
      };
    });
  } catch {
    return instructions.map((inst) => ({
      criterion: inst.criterion,
      passed: false,
      reasoning: 'Failed to parse script output as JSON',
    }));
  }
}

/** @internal Exported for testing. Strip markdown code fences from LLM output. */
export function stripMarkdownFences(text: string): string {
  return text
    .replace(/^```(?:\w+)?\s*\n?/m, '')
    .replace(/\n?\s*```\s*$/m, '')
    .trim();
}

// ── AI Task Review phase ────────────────────────────────────────────────────

/**
 * Builds the review prompt with all available context.
 * Extracted so it can be reused across tiers.
 */
function buildReviewPrompt(config: ValidationEngineConfig, reviewContext?: ReviewContext): string {
  const acList =
    config.acceptanceCriteria && config.acceptanceCriteria.length > 0
      ? config.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n')
      : null;

  const planSection = config.plan
    ? `\n## ORIGINAL PLAN\n\nSummary: ${config.plan.summary}\n\nSteps:\n${config.plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`
    : '';

  const taskSummarySection = config.taskSummary
    ? `\n## AGENT TASK SUMMARY\n\nWhat was actually done: ${config.taskSummary.actualSummary}\n${
        config.taskSummary.deviations.length > 0
          ? `\nReported deviations from plan:\n${config.taskSummary.deviations
              .map(
                (d) =>
                  `- **${d.step}**: planned "${d.planned}" → actual "${d.actual}" (reason: ${d.reason})`,
              )
              .join('\n')}`
          : '\nNo deviations from plan reported.'
      }\n`
    : '';

  const repoRulesSection = config.codeReviewSkill
    ? `\n## REPO-SPECIFIC REVIEW RULES (these take precedence over standard rules)\n\n${config.codeReviewSkill}\n`
    : '';

  const acSection = acList ? `\n## ACCEPTANCE CRITERIA\n\n${acList}\n` : '';

  const commitLogSection = config.commitLog
    ? `\n## COMMIT HISTORY\n\nCommits on this branch (most recent first — use to understand progression and intent):\n\n${config.commitLog}\n`
    : '';

  // Build the enriched context section (Tier 0+1)
  const contextSection = reviewContext ? buildContextSection(reviewContext) : '';

  // Human-dismissed findings that must be skipped
  const overridesSection = buildOverridesSection(config.overrides);

  return `You are an expert software engineer performing an independent code review of changes made by an AI agent.

Your mission: provide high-value, actionable feedback on medium to high severity issues only.

Core principles:
- Be helpful, not noisy. Only raise fair, actionable concerns that genuinely improve code.
- Focus exclusively on what changed in this diff. Never comment on pre-existing code.
- Don't flag style preferences. Only flag significant inconsistencies with existing patterns.
- Treat generated code fairly — if it's appropriate and contextually correct, it passes.
- When uncertain, skip rather than create noise.
- Use the CODEBASE CONTEXT section (if present) to verify claims made in the diff. Auto-detected warnings are high-confidence signals — investigate them seriously.
${repoRulesSection}
## TASK

${config.task}
${acSection}${planSection}${taskSummarySection}
${commitLogSection}${contextSection}## DIFF

${config.diff}
${overridesSection}
## INSTRUCTIONS

${
  acList
    ? `### Step 1: Requirements check

For each acceptance criterion above, determine whether the diff addresses it:
- Mark met=true only if the diff clearly and fully implements the criterion
- Mark met=false if the criterion is unaddressed or only partially implemented
- Add a brief note if the criterion is partially met or needs context

`
    : ''
}${
  taskSummarySection
    ? `### ${acList ? 'Step 2' : 'Step 1'}: Deviation assessment

Compare the ORIGINAL PLAN (if provided) with the AGENT TASK SUMMARY and the DIFF:

1. For each deviation the agent reported: assess whether the reasoning is justified given the diff.
   - "justified": the diff confirms the deviation was necessary or beneficial
   - "questionable": the reasoning is unclear or the diff doesn't confirm it
   - "unjustified": the deviation appears to have degraded quality without good reason

2. Look for undisclosed deviations: things in the diff that diverge from the plan but were NOT reported.
   - Only flag meaningful gaps (e.g., a planned step that was entirely skipped, or a wholly different approach taken)
   - Do NOT flag minor implementation details that naturally evolve during development

Transparency is rewarded: a disclosed deviation with sound reasoning should not negatively affect the status.
An undisclosed deviation that the diff reveals IS a negative signal.

`
    : ''
}### ${acList ? (taskSummarySection ? 'Step 3' : 'Step 2') : taskSummarySection ? 'Step 2' : 'Step 1'}: Code review

Review ONLY the changed code across these dimensions. Only raise medium or high severity issues:

**Correctness & Quality**: error handling completeness, resource management, type/null safety, edge case handling

**Security**: input validation and sanitization, access control, hardcoded secrets, dependency vulnerabilities

**Performance & Reliability**: memory leaks, concurrency correctness, N+1 queries, retry logic and timeout handling, data consistency

**Architecture & Maintainability**: component boundaries, interface design, inappropriate coupling, documentation for public APIs

**Consistency**: does new code follow same patterns as existing similar code? Same error handling, naming, logging approaches? Only flag if the inconsistency is significant enough to cause confusion — not style preferences.

**Generated Code**: if code appears generated (repetitive, boilerplate, generic) — verify it's adapted to the specific use case and follows project patterns. Flag if it's illogical or manipulated. Don't penalize if it's correct and contextually appropriate.

**Testing** (treat as critical):
- Coverage: are new functions/methods/branches tested? Edge cases and error scenarios covered? Missing tests for significant functionality? Coverage notably low?
- Quality: do tests verify intended behavior (not just "no crash")? Meaningful assertions? Tests isolated and independent?
- Common issues: over-mocking (testing mock behavior instead of real logic), type "any" abuse bypassing type checking, mocking core business logic instead of testing it, testing implementation details instead of behavior, missing negative/error tests, arbitrary sleeps instead of proper synchronization, tests inconsistent with existing patterns
- Severity: High = missing tests for critical paths, "any" type abuse, mocking core logic / Medium = low coverage, tests not verifying behavior, excessive mocking

### Self-reflection gate

Before including any issue, ask yourself:
- Is this actually in the diff (not pre-existing code)?
- Could this be intentional per the task description or acceptance criteria?
- Does the existing codebase use similar patterns?
- Is this medium/high severity, not just a nit?
- Would I want this feedback if I were the author?

Drop any issue that fails these checks.

## RESPONSE FORMAT

Respond ONLY with a JSON object — no markdown fences, no extra text:

{
  "status": "pass" | "fail" | "uncertain",
  "reasoning": "one or two sentence summary of the overall assessment",
  ${acList ? '"requirementsCheck": [{ "criterion": "...", "met": true|false, "note": "optional" }],\n  ' : ''}${taskSummarySection ? '"deviationsAssessment": {\n    "disclosedDeviations": [{ "step": "...", "reasoning": "...", "verdict": "justified"|"questionable"|"unjustified" }],\n    "undisclosedDeviations": ["description of gap between plan and diff that was not reported"]\n  },\n  ' : ''}"issues": ["specific medium/high severity issues only"]
}

Status rules:
- "pass": requirements met (if any), no significant issues, and no unjustified undisclosed deviations
- "fail": one or more requirements unmet, OR critical/high severity issues, OR undisclosed deviations that compromised scope
- "uncertain": task is clear but diff is inconclusive without runtime context (use sparingly)`;
}

/**
 * Builds the OVERRIDDEN FINDINGS section from human-dismissed overrides.
 * When present, instructs the reviewer to skip these findings entirely.
 */
function buildOverridesSection(overrides?: ValidationOverride[]): string {
  if (!overrides || overrides.length === 0) return '';

  const dismissed = overrides.filter((o) => o.action === 'dismiss');
  if (dismissed.length === 0) return '';

  const lines: string[] = [
    '\n## OVERRIDDEN FINDINGS (DO NOT FLAG)',
    '',
    'The following findings have been reviewed and dismissed by the project owner.',
    'These are FINAL decisions. You MUST NOT raise these as issues. Skip them entirely:',
    '',
  ];

  for (const o of dismissed) {
    const reason = o.reason ? ` — Reason: ${o.reason}` : '';
    lines.push(`- "${o.description}"${reason}`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Builds the CODEBASE CONTEXT section from gathered review context.
 */
function buildContextSection(ctx: ReviewContext): string {
  const parts: string[] = ['## CODEBASE CONTEXT\n'];

  if (ctx.annotations.length > 0) {
    parts.push('### Warnings (auto-detected)\n');
    for (const a of ctx.annotations) {
      parts.push(a);
    }
    parts.push('');
  }

  if (ctx.gitStatusSummary) {
    parts.push('### Repository Status\n');
    parts.push(ctx.gitStatusSummary);
    parts.push('');
  }

  if (ctx.fileTreeSummary) {
    parts.push('### File Tree\n');
    parts.push(ctx.fileTreeSummary);
    parts.push('');
  }

  if (ctx.supplementaryFiles.length > 0) {
    parts.push('### Supplementary Files\n');
    for (const f of ctx.supplementaryFiles) {
      parts.push(`#### \`${f.path}\` (${f.reason})\n`);
      parts.push('```');
      parts.push(f.content);
      parts.push('```\n');
    }
  }

  return parts.join('\n');
}

async function runTaskReview(
  config: ValidationEngineConfig,
  log?: Logger,
  reviewContext?: ReviewContext,
): Promise<{ result: TaskReviewResult | null; skipReason?: string }> {
  if (!config.reviewerModel || !config.diff || !config.task) {
    const reason = !config.diff
      ? 'No code changes detected'
      : !config.task
        ? 'No task description available'
        : 'No reviewer model configured';
    log?.info({ reason }, 'skipping task review');
    return { result: null, skipReason: reason };
  }

  log?.info({ model: config.reviewerModel }, 'running AI task review');

  const prompt = buildReviewPrompt(config, reviewContext);
  const reviewTimeout = config.reviewTimeout ?? 300_000;
  const reviewDepth = config.reviewDepth ?? 'auto';

  try {
    // ── Tier 1: Single-shot review with enriched context ──────────────
    const { stdout } = await runClaudeCli({
      model: config.reviewerModel,
      input: prompt,
      timeout: reviewTimeout,
    });

    const tier1Parsed = parseReviewJson(stdout.trim());
    if (!tier1Parsed) {
      log?.warn({ rawOutput: stdout.slice(0, 500) }, 'failed to parse task review response');
      return { result: null, skipReason: 'Failed to parse Tier 1 review response' };
    }

    log?.info(
      {
        status: tier1Parsed.status,
        issueCount: tier1Parsed.issues.length,
        tier: 1,
      },
      'Tier 1 task review complete',
    );

    // If Tier 1 is conclusive or depth is standard-only, we're done.
    // 'deep' forces Tier 2+ regardless of Tier 1 status (e.g. for auto-hoist on recurring findings).
    const shouldEscalate =
      (reviewDepth === 'deep' && !!config.worktreePath) ||
      (tier1Parsed.status === 'uncertain' && reviewDepth !== 'standard' && !!config.worktreePath);

    if (!shouldEscalate) {
      return {
        result: {
          status: tier1Parsed.status,
          reasoning: tier1Parsed.reasoning,
          issues: tier1Parsed.issues,
          model: config.reviewerModel,
          screenshots: [],
          diff: config.diff,
          requirementsCheck: tier1Parsed.requirementsCheck,
          deviationsAssessment: tier1Parsed.deviationsAssessment,
        },
      };
    }

    // At this point, shouldEscalate guarantees worktreePath is defined
    const worktreePath = config.worktreePath as string;

    // ── Tier 2: Tool-use review (on uncertain) ───────────────────────
    log?.info('Tier 1 returned uncertain, escalating to Tier 2 tool-use review');

    try {
      const tier2Result = await runToolUseReview({
        model: config.reviewerModel,
        prompt,
        worktreePath,
        timeout: reviewTimeout,
      });

      const tier2Parsed = parseReviewJson(tier2Result.stdout.trim());
      if (tier2Parsed && tier2Parsed.status !== 'uncertain') {
        log?.info({ status: tier2Parsed.status, tier: 2 }, 'Tier 2 tool-use review resolved');
        return {
          result: {
            status: tier2Parsed.status,
            reasoning: `[Tier 2 tool-use review] ${tier2Parsed.reasoning}`,
            issues: tier2Parsed.issues,
            model: config.reviewerModel,
            screenshots: [],
            diff: config.diff,
            requirementsCheck: tier2Parsed.requirementsCheck,
            deviationsAssessment: tier2Parsed.deviationsAssessment,
          },
        };
      }

      // ── Tier 3: Agentic review (still uncertain) ────────────────────
      if (tier2Parsed?.status === 'uncertain') {
        log?.info('Tier 2 returned uncertain, escalating to Tier 3 agentic review');

        try {
          const tier3Result = await runAgenticReview({
            model: config.reviewerModel,
            prompt,
            worktreePath,
            timeout: reviewTimeout,
          });

          const tier3Parsed = parseReviewJson(tier3Result.stdout.trim());
          if (tier3Parsed) {
            log?.info({ status: tier3Parsed.status, tier: 3 }, 'Tier 3 agentic review complete');
            return {
              result: {
                status: tier3Parsed.status,
                reasoning: `[Tier 3 agentic review] ${tier3Parsed.reasoning}`,
                issues: tier3Parsed.issues,
                model: config.reviewerModel,
                screenshots: [],
                diff: config.diff,
                requirementsCheck: tier3Parsed.requirementsCheck,
                deviationsAssessment: tier3Parsed.deviationsAssessment,
              },
            };
          }
        } catch (err) {
          log?.warn({ err }, 'Tier 3 agentic review failed, falling back to Tier 2 result');
        }
      }

      // Fall back to best available result
      const bestParsed = tier2Parsed ?? tier1Parsed;
      return {
        result: {
          status: bestParsed.status,
          reasoning: bestParsed.reasoning,
          issues: bestParsed.issues,
          model: config.reviewerModel,
          screenshots: [],
          diff: config.diff,
          requirementsCheck: bestParsed.requirementsCheck,
          deviationsAssessment: bestParsed.deviationsAssessment,
        },
      };
    } catch (err) {
      log?.warn({ err }, 'Tier 2 tool-use review failed, using Tier 1 result');
      // Fall back to Tier 1 result
      return {
        result: {
          status: tier1Parsed.status,
          reasoning: tier1Parsed.reasoning,
          issues: tier1Parsed.issues,
          model: config.reviewerModel,
          screenshots: [],
          diff: config.diff,
          requirementsCheck: tier1Parsed.requirementsCheck,
          deviationsAssessment: tier1Parsed.deviationsAssessment,
        },
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log?.warn({ err }, 'task review failed, continuing without review');
    return { result: null, skipReason: `Review failed: ${message}` };
  }
}

/**
 * Attempts to parse the reviewer's JSON response, tolerating markdown fences
 * and other common LLM output quirks.
 */
function parseReviewJson(raw: string): {
  status: 'pass' | 'fail' | 'uncertain';
  reasoning: string;
  issues: string[];
  requirementsCheck?: Array<{ criterion: string; met: boolean; note?: string }>;
  deviationsAssessment?: DeviationsAssessment;
} | null {
  // Strip markdown code fences if present
  let cleaned = raw
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```$/m, '')
    .trim();

  // Try to extract a JSON object if there's extra text around it
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }

  try {
    const parsed = JSON.parse(cleaned);

    // Validate shape
    if (!parsed || typeof parsed !== 'object') return null;
    if (!['pass', 'fail', 'uncertain'].includes(parsed.status)) return null;
    if (typeof parsed.reasoning !== 'string') return null;
    if (!Array.isArray(parsed.issues)) return null;

    const requirementsCheck = Array.isArray(parsed.requirementsCheck)
      ? parsed.requirementsCheck
          .filter(
            (item: unknown): item is Record<string, unknown> =>
              typeof item === 'object' &&
              item !== null &&
              typeof (item as Record<string, unknown>).criterion === 'string' &&
              typeof (item as Record<string, unknown>).met === 'boolean',
          )
          .map((item) => ({
            criterion: item.criterion as string,
            met: item.met as boolean,
            note: typeof item.note === 'string' ? item.note : undefined,
          }))
      : undefined;

    const deviationsAssessment = parseDeviationsAssessment(parsed.deviationsAssessment);

    return {
      status: parsed.status,
      reasoning: parsed.reasoning,
      issues: parsed.issues.map(String),
      requirementsCheck,
      deviationsAssessment,
    };
  } catch {
    return null;
  }
}

function parseDeviationsAssessment(raw: unknown): DeviationsAssessment | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;

  const disclosedDeviations = Array.isArray(obj.disclosedDeviations)
    ? obj.disclosedDeviations
        .filter(
          (item: unknown): item is Record<string, unknown> =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as Record<string, unknown>).step === 'string' &&
            typeof (item as Record<string, unknown>).reasoning === 'string' &&
            ['justified', 'questionable', 'unjustified'].includes(
              (item as Record<string, unknown>).verdict as string,
            ),
        )
        .map((item) => ({
          step: item.step as string,
          reasoning: item.reasoning as string,
          verdict: item.verdict as 'justified' | 'questionable' | 'unjustified',
        }))
    : [];

  const undisclosedDeviations = Array.isArray(obj.undisclosedDeviations)
    ? obj.undisclosedDeviations.filter((s): s is string => typeof s === 'string')
    : [];

  return { disclosedDeviations, undisclosedDeviations };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
