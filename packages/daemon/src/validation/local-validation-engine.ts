import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { PageResult, TaskReviewResult, ValidationResult } from '@autopod/shared';
import { generateValidationScript, parsePageResults } from '@autopod/validator';
import type { Logger } from 'pino';

import type { ContainerManager } from '../interfaces/container-manager.js';
import type { ValidationEngine, ValidationEngineConfig } from '../interfaces/validation-engine.js';

const execFileAsync = promisify(execFile);

/**
 * Local validation engine with build, health check, and AI task review.
 *
 * Page validation is intentionally skipped — it requires a browser (Playwright),
 * which is not available in this sandbox environment.
 */
export function createLocalValidationEngine(
  containerManager: ContainerManager,
  logger?: Logger,
): ValidationEngine {
  const log = logger?.child({ component: 'local-validation-engine' });

  return {
    async validate(config: ValidationEngineConfig): Promise<ValidationResult> {
      const startTime = Date.now();

      // ── Phase 1: Build ──────────────────────────────────────────────
      const buildResult = await runBuild(containerManager, config, log);

      // ── Phase 2: Test ───────────────────────────────────────────────
      const testResult =
        buildResult.status === 'pass'
          ? await runTests(containerManager, config, log)
          : { status: 'skip' as const, duration: 0 };

      // ── Phase 3: Health check ───────────────────────────────────────
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
      const pages: PageResult[] =
        healthResult.status === 'pass' && config.validationPages.length > 0
          ? await runPageValidation(containerManager, config, log)
          : [];

      // ── Phase 5: AI Task Review ─────────────────────────────────────
      const taskReview = await runTaskReview(config, log);

      // ── Phase 6: Overall result ─────────────────────────────────────
      const pagesPass = pages.length === 0 || pages.every((p) => p.status === 'pass');
      const smokeStatus =
        buildResult.status === 'pass' && healthResult.status === 'pass' && pagesPass
          ? ('pass' as const)
          : ('fail' as const);

      const testFailed = testResult.status === 'fail';
      const overall =
        smokeStatus === 'pass' &&
        !testFailed &&
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
        taskReview,
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

  const result = await containerManager.execInContainer(
    config.containerId,
    ['sh', '-c', config.buildCommand],
    { cwd: '/workspace', timeout: 120_000 },
  );

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
    output: output.slice(0, 10_000), // Cap output size
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

  const result = await containerManager.execInContainer(
    config.containerId,
    ['sh', '-c', config.testCommand],
    { cwd: '/workspace', timeout: 300_000 },
  );

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
    stdout: result.stdout.slice(0, 10_000),
    stderr: result.stderr.slice(0, 10_000),
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

  // Start the app in the background so it doesn't block
  // Fire-and-forget: we don't await the long-running server process
  containerManager
    .execInContainer(config.containerId, ['sh', '-c', `${config.startCommand} &`], {
      cwd: '/workspace',
    })
    .catch((err) => {
      log?.warn(
        { err },
        'background start command errored (may be expected for long-running processes)',
      );
    });

  // Poll for health
  const pollIntervalMs = 2_000;
  let lastResponseCode: number | null = null;

  while (Date.now() - healthStart < timeoutMs) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5_000),
      });
      lastResponseCode = response.status;

      if (response.status === 200) {
        const duration = Date.now() - healthStart;
        log?.info({ url, duration }, 'health check passed');
        return { status: 'pass' as const, url, responseCode: 200, duration };
      }

      log?.debug({ url, status: response.status }, 'health check got non-200, retrying');
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

  return { status: 'fail' as const, url, responseCode: lastResponseCode, duration };
}

// ── Page validation phase ───────────────────────────────────────────────────

async function runPageValidation(
  containerManager: ContainerManager,
  config: ValidationEngineConfig,
  log?: Logger,
): Promise<PageResult[]> {
  log?.info({ pageCount: config.validationPages.length }, 'running page validation');

  const script = generateValidationScript({
    baseUrl: config.previewUrl,
    pages: config.validationPages,
    screenshotDir: '/workspace/.autopod/screenshots',
    navigationTimeout: 30_000,
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
      ['node', scriptPath],
      { cwd: '/workspace', timeout: config.validationPages.length * 45_000 },
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

// ── AI Task Review phase ────────────────────────────────────────────────────

async function runTaskReview(
  config: ValidationEngineConfig,
  log?: Logger,
): Promise<TaskReviewResult | null> {
  if (!config.reviewerModel || !config.diff || !config.task) {
    log?.info('skipping task review (missing reviewerModel, diff, or task)');
    return null;
  }

  log?.info({ model: config.reviewerModel }, 'running AI task review');

  const prompt = `You are reviewing code changes for correctness.

Task: ${config.task}

Diff:
${config.diff}

Review the changes and respond with a JSON object:
{
  "status": "pass" | "fail" | "uncertain",
  "reasoning": "brief explanation",
  "issues": ["list of specific issues found, if any"]
}

Rules:
- Use "pass" only if you can clearly verify the diff fulfills the task.
- Use "fail" if the task is too vague or ambiguous to verify, if the diff clearly does not match the task, or if there are obvious correctness issues.
- Use "uncertain" only if the task is clear but the diff is inconclusive (e.g. the change is plausible but you cannot confirm without runtime context).

Respond ONLY with the JSON object, no markdown fences or extra text.`;

  try {
    const { stdout } = await execFileAsync(
      'claude',
      ['-p', prompt, '--model', config.reviewerModel, '--output-format', 'text'],
      {
        timeout: 120_000,
        maxBuffer: 1024 * 1024, // 1 MB
      },
    );

    const parsed = parseReviewJson(stdout.trim());
    if (!parsed) {
      log?.warn({ rawOutput: stdout.slice(0, 500) }, 'failed to parse task review response');
      return null;
    }

    log?.info({ status: parsed.status, issueCount: parsed.issues.length }, 'task review complete');

    return {
      status: parsed.status,
      reasoning: parsed.reasoning,
      issues: parsed.issues,
      model: config.reviewerModel,
      screenshots: [], // No browser screenshots available
      diff: config.diff,
    };
  } catch (err) {
    log?.warn({ err }, 'task review failed, continuing without review');
    return null;
  }
}

/**
 * Attempts to parse the reviewer's JSON response, tolerating markdown fences
 * and other common LLM output quirks.
 */
function parseReviewJson(
  raw: string,
): { status: 'pass' | 'fail' | 'uncertain'; reasoning: string; issues: string[] } | null {
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

    return {
      status: parsed.status,
      reasoning: parsed.reasoning,
      issues: parsed.issues.map(String),
    };
  } catch {
    return null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
