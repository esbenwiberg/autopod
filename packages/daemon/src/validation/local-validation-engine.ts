import { spawn } from 'node:child_process';

import type {
  AcCheckResult,
  AcDefinition,
  AcType,
  AcValidationResult,
  DeviationsAssessment,
  HealthResult,
  PageResult,
  TaskReviewResult,
  ValidationOverride,
  ValidationResult,
} from '@autopod/shared';
import { generateValidationScript, parsePageResults } from '@autopod/validator';
import type { Logger } from 'pino';
import type { ValidationPhaseCallbacks } from '../interfaces/validation-engine.js';

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
export class ValidationInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationInterruptedError';
  }
}

export function createLocalValidationEngine(
  containerManager: ContainerManager,
  logger?: Logger,
  hostBrowserRunner?: HostBrowserRunner,
): ValidationEngine {
  const log = logger?.child({ component: 'local-validation-engine' });
  // Cache classification results within this engine instance.
  // Key: sorted AC texts joined with '|'. Value: ClassifiedAc[].
  // Prevents non-deterministic re-classification across validation retry attempts.
  const acClassificationCache = new Map<string, ClassifiedAc[]>();

  return {
    async validate(
      config: ValidationEngineConfig,
      onProgress?: (message: string) => void,
      signal?: AbortSignal,
      callbacks?: ValidationPhaseCallbacks,
    ): Promise<ValidationResult> {
      const startTime = Date.now();

      // Secondary abort controller fired when the stability monitor detects a crash.
      const crashController = new AbortController();

      function checkAbort(): void {
        if (signal?.aborted) throw new ValidationInterruptedError('Validation interrupted by user');
        if (crashController.signal.aborted)
          throw new ValidationInterruptedError(
            'App crashed after passing health check — unreachable during validation',
          );
      }

      let stopMonitor: (() => void) | undefined;

      try {
        // ── Phase 1: Lint ──────────────────────────────────────────────
        checkAbort();
        callbacks?.onPhaseStarted?.('lint');
        if (config.lintCommand) onProgress?.('Running lint…');
        const lintResult = await runLint(containerManager, config, log);
        callbacks?.onPhaseCompleted?.('lint', lintResult.status, lintResult);

        // ── Phase 2: SAST ──────────────────────────────────────────────
        checkAbort();
        callbacks?.onPhaseStarted?.('sast');
        if (config.sastCommand) onProgress?.('Running SAST…');
        const sastResult = await runSast(containerManager, config, log);
        callbacks?.onPhaseCompleted?.('sast', sastResult.status, sastResult);

        // ── Phase 3: Build ─────────────────────────────────────────────
        checkAbort();
        callbacks?.onPhaseStarted?.('build');
        if (config.buildCommand) onProgress?.('Running build…');
        const buildResult = await runBuild(containerManager, config, log);
        callbacks?.onPhaseCompleted?.('build', buildResult.status, buildResult);

        // ── Phase 4: Test ──────────────────────────────────────────────
        checkAbort();
        callbacks?.onPhaseStarted?.('test');
        if (buildResult.status === 'pass' && config.testCommand) onProgress?.('Running tests…');
        const testResult =
          buildResult.status === 'pass'
            ? await runTests(containerManager, config, log)
            : { status: 'skip' as const, duration: 0 };
        callbacks?.onPhaseCompleted?.('test', testResult.status, testResult);

        // ── Phase 5: Health check ──────────────────────────────────────
        // Skipped when the profile has no web UI — there's nothing to start,
        // no endpoint to poll, and downstream Pages/AC web-ui phases are
        // inapplicable too.
        checkAbort();
        callbacks?.onPhaseStarted?.('health');
        const skipForNoWebUi = config.hasWebUi === false;
        if (!skipForNoWebUi && buildResult.status === 'pass' && config.startCommand)
          onProgress?.('Running health check…');
        const healthResult: HealthResult = skipForNoWebUi
          ? {
              status: 'skip',
              url: '',
              responseCode: null,
              duration: 0,
            }
          : buildResult.status === 'pass'
            ? await runHealthCheck(containerManager, config, log)
            : {
                status: 'fail',
                url: config.previewUrl + config.healthPath,
                responseCode: null,
                duration: 0,
              };
        callbacks?.onPhaseCompleted?.('health', healthResult.status, healthResult);

        // After health passes, watch for post-startup crashes in the background.
        // If the app goes down during smoke/AC phases, abort validation with a
        // clear "app crashed" message rather than a cryptic ERR_CONNECTION_REFUSED.
        if (healthResult.status === 'pass' && config.startCommand) {
          stopMonitor = startAppStabilityMonitor(config.previewUrl + config.healthPath, () => {
            log?.warn(
              { podId: config.podId, url: config.previewUrl + config.healthPath },
              'App became unreachable after health check passed — aborting validation',
            );
            crashController.abort();
          });
        }

        // ── Phase 6: Page validation ───────────────────────────────────
        checkAbort();
        callbacks?.onPhaseStarted?.('pages');
        if (healthResult.status === 'pass' && config.smokePages.length > 0)
          onProgress?.('Validating pages…');
        const pages: PageResult[] =
          healthResult.status === 'pass' && config.smokePages.length > 0
            ? await runPageValidation(containerManager, config, log, hostBrowserRunner)
            : [];
        const pagesStatus: 'pass' | 'fail' | 'skip' =
          healthResult.status === 'skip' || config.smokePages.length === 0
            ? 'skip'
            : pages.every((p) => p.status === 'pass')
              ? 'pass'
              : 'fail';
        callbacks?.onPhaseCompleted?.('pages', pagesStatus, pages);

        // ── Phase 7: AC Validation ────────────────────────────────────
        // Run when health passed, or when health was skipped because the
        // profile has no web UI — in the latter case web-ui criteria are
        // auto-downgraded to 'none' and routed through the diff reviewer.
        checkAbort();
        callbacks?.onPhaseStarted?.('ac');
        const acGateOk = healthResult.status === 'pass' || healthResult.status === 'skip';
        if (acGateOk && config.acceptanceCriteria?.length)
          onProgress?.('Checking acceptance criteria…');
        const acValidation = acGateOk
          ? await runAcValidation(
              containerManager,
              config,
              log,
              hostBrowserRunner,
              acClassificationCache,
            )
          : null;
        const acStatus: 'pass' | 'fail' | 'skip' = acValidation?.status ?? 'skip';
        callbacks?.onPhaseCompleted?.('ac', acStatus, acValidation);

        // Collect "none"-classified ACs so the AI reviewer can own them
        const noneAcCriteria: string[] =
          acValidation?.results
            .filter((r) => r.validationType === 'none')
            .map((r) => r.criterion) ?? [];

        // ── Phase 8: AI Task Review ────────────────────────────────────
        checkAbort();
        callbacks?.onPhaseStarted?.('review');
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
          noneAcCriteria,
        );
        // Map 'uncertain' to 'pass' for the chip status — the detail view shows the full result.
        const reviewStatus: 'pass' | 'fail' | 'skip' =
          taskReview === null ? 'skip' : taskReview.status === 'fail' ? 'fail' : 'pass';
        callbacks?.onPhaseCompleted?.('review', reviewStatus, taskReview);

        // ── Phase 9: Overall result ────────────────────────────────────
        const pagesPass = pages.length === 0 || pages.every((p) => p.status === 'pass');
        const healthOk = healthResult.status === 'pass' || healthResult.status === 'skip';
        const smokeStatus =
          buildResult.status === 'pass' && healthOk && pagesPass
            ? ('pass' as const)
            : ('fail' as const);

        const testFailed = testResult.status === 'fail';
        const acFailed = acValidation !== null && acValidation.status === 'fail';
        // Timeouts and infra errors during review are not code quality failures.
        // Only treat review as a blocker when it returns an actual opinion (pass/fail).
        const isReviewInfraFailure =
          reviewSkipReason?.startsWith('Review failed:') &&
          (reviewSkipReason.includes('timed out') || reviewSkipReason.includes('timed_out'));
        const isReviewBlocker =
          reviewSkipReason?.startsWith('Review failed:') && !isReviewInfraFailure;
        const lintFailed = lintResult.status === 'fail';
        const sastFailed = sastResult.status === 'fail';
        const overall =
          smokeStatus === 'pass' &&
          !testFailed &&
          !lintFailed &&
          !sastFailed &&
          !acFailed &&
          ((taskReview === null && !isReviewBlocker) || taskReview?.status === 'pass')
            ? ('pass' as const)
            : ('fail' as const);

        const duration = Date.now() - startTime;

        return {
          podId: config.podId,
          attempt: config.attempt,
          timestamp: new Date().toISOString(),
          smoke: {
            status: smokeStatus,
            build: buildResult,
            health: healthResult,
            pages,
          },
          test: testResult,
          lint: lintResult,
          sast: sastResult,
          acValidation,
          taskReview,
          reviewSkipReason,
          overall,
          duration,
        };
      } catch (err) {
        if (err instanceof ValidationInterruptedError) {
          const reason = crashController.signal.aborted ? 'app-crashed' : 'user';
          log?.info({ podId: config.podId, reason }, 'Validation interrupted');
          return makeInterruptedResult(config, startTime, err.message);
        }
        throw err;
      } finally {
        stopMonitor?.();
      }
    },
  };
}

/** Return a partial interrupted ValidationResult (phase-complete data preserved) */
function makeInterruptedResult(
  config: ValidationEngineConfig,
  startTime: number,
  reason = 'Validation interrupted by user',
): ValidationResult {
  return {
    podId: config.podId,
    attempt: config.attempt,
    timestamp: new Date().toISOString(),
    smoke: {
      status: 'fail',
      build: { status: 'skip', output: '', duration: 0 },
      health: {
        status: 'fail',
        url: config.previewUrl + config.healthPath,
        responseCode: null,
        duration: 0,
      },
      pages: [],
    },
    test: { status: 'skip', duration: 0 },
    acValidation: null,
    taskReview: null,
    reviewSkipReason: reason,
    overall: 'fail',
    duration: Date.now() - startTime,
  };
}

/**
/** Retry polling a URL until it returns 2xx or all attempts are exhausted. */
async function pollUntilReachable(
  url: string,
  opts: { attempts: number; intervalMs: number },
): Promise<boolean> {
  for (let i = 0; i < opts.attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (res.status >= 200 && res.status < 300) return true;
    } catch {
      // connection refused or timeout — keep retrying
    }
    if (i < opts.attempts - 1) await sleep(opts.intervalMs);
  }
  return false;
}

/**
 * Poll the health URL every 5 seconds after the app passes its initial health check.
 * If the app becomes unreachable (2 consecutive failures), fires `onCrash` once.
 * Returns a stop function — call it when validation finishes.
 */
function startAppStabilityMonitor(url: string, onCrash: () => void): () => void {
  let stopped = false;
  let consecutiveFailures = 0;
  const POLL_INTERVAL_MS = 5_000;
  const FAILURE_THRESHOLD = 2;

  const poll = async () => {
    // Initial delay — give the app a moment to settle after health check
    await sleep(POLL_INTERVAL_MS);

    while (!stopped) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
        if (response.status >= 200 && response.status < 300) {
          consecutiveFailures = 0;
        } else {
          consecutiveFailures++;
        }
      } catch {
        consecutiveFailures++;
      }

      if (consecutiveFailures >= FAILURE_THRESHOLD) {
        if (!stopped) onCrash();
        break;
      }

      await sleep(POLL_INTERVAL_MS);
    }
  };

  // Fire-and-forget — errors are intentionally swallowed (onCrash handles them)
  poll().catch(() => {});

  return () => {
    stopped = true;
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

  const buildCwd = config.buildWorkDir ? `/workspace/${config.buildWorkDir}` : '/workspace';

  // Heal 0-byte .bin stubs before the build — the agent may have run
  // `npm install --ignore-scripts` which leaves empty, non-executable stubs.
  const stubCheck = await containerManager
    .execInContainer(
      config.containerId,
      ['sh', '-c', `find ${buildCwd} -path "*/node_modules/.bin/*" -empty -print 2>/dev/null | head -1`],
      { timeout: 5_000 },
    )
    .catch(() => null);
  if (stubCheck?.stdout?.trim()) {
    log?.info('0-byte .bin stubs found before build — running npm rebuild');
    await containerManager
      .execInContainer(config.containerId, ['sh', '-c', `cd ${buildCwd} && npm rebuild 2>&1`], {
        timeout: 120_000,
        ...(config.extraExecEnv ? { env: config.extraExecEnv } : {}),
      })
      .catch((err: unknown) =>
        log?.warn({ err }, 'pre-build npm rebuild failed — build may still encounter Permission denied errors'),
      );
  }

  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = await containerManager.execInContainer(
      config.containerId,
      ['sh', '-c', config.buildCommand],
      {
        cwd: buildCwd,
        timeout: config.buildTimeout ?? 300_000,
        ...(config.extraExecEnv ? { env: config.extraExecEnv } : {}),
      },
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

  const testCwd = config.buildWorkDir ? `/workspace/${config.buildWorkDir}` : '/workspace';
  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = await containerManager.execInContainer(
      config.containerId,
      ['sh', '-c', config.testCommand],
      {
        cwd: testCwd,
        timeout: config.testTimeout ?? 600_000,
        ...(config.extraExecEnv ? { env: config.extraExecEnv } : {}),
      },
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

// ── Lint phase ──────────────────────────────────────────────────────────────

async function runLint(
  containerManager: ContainerManager,
  config: ValidationEngineConfig,
  log?: Logger,
) {
  if (!config.lintCommand) {
    log?.info('no lint command configured, skipping lint');
    return { status: 'skip' as const, output: '', duration: 0 };
  }

  const lintStart = Date.now();
  log?.info({ lintCommand: config.lintCommand }, 'running lint');

  const cwd = config.buildWorkDir ? `/workspace/${config.buildWorkDir}` : '/workspace';
  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = await containerManager.execInContainer(
      config.containerId,
      ['sh', '-c', config.lintCommand],
      {
        cwd,
        timeout: config.lintTimeout ?? 120_000,
        ...(config.extraExecEnv ? { env: config.extraExecEnv } : {}),
      },
    );
  } catch (err) {
    const duration = Date.now() - lintStart;
    const partial = (err as { partialOutput?: string })?.partialOutput ?? '';
    const message = err instanceof Error ? err.message : String(err);
    log?.warn({ duration }, `lint timed out: ${message}`);
    return {
      status: 'fail' as const,
      output: `${message}\n\n--- partial output (last 5 KB) ---\n${partial}`.slice(0, 50_000),
      duration,
    };
  }

  const duration = Date.now() - lintStart;
  const status = result.exitCode === 0 ? ('pass' as const) : ('fail' as const);

  if (status === 'fail') {
    log?.warn({ exitCode: result.exitCode, duration }, 'lint failed');
  } else {
    log?.info({ duration }, 'lint passed');
  }

  const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
  return { status, output: combined.slice(0, 50_000), duration };
}

// ── SAST phase ──────────────────────────────────────────────────────────────

async function runSast(
  containerManager: ContainerManager,
  config: ValidationEngineConfig,
  log?: Logger,
) {
  if (!config.sastCommand) {
    log?.info('no SAST command configured, skipping SAST');
    return { status: 'skip' as const, output: '', duration: 0 };
  }

  const sastStart = Date.now();
  log?.info({ sastCommand: config.sastCommand }, 'running SAST');

  const cwd = config.buildWorkDir ? `/workspace/${config.buildWorkDir}` : '/workspace';
  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = await containerManager.execInContainer(
      config.containerId,
      ['sh', '-c', config.sastCommand],
      {
        cwd,
        timeout: config.sastTimeout ?? 300_000,
        ...(config.extraExecEnv ? { env: config.extraExecEnv } : {}),
      },
    );
  } catch (err) {
    const duration = Date.now() - sastStart;
    const partial = (err as { partialOutput?: string })?.partialOutput ?? '';
    const message = err instanceof Error ? err.message : String(err);
    log?.warn({ duration }, `SAST timed out: ${message}`);
    return {
      status: 'fail' as const,
      output: `${message}\n\n--- partial output (last 5 KB) ---\n${partial}`.slice(0, 50_000),
      duration,
    };
  }

  const duration = Date.now() - sastStart;
  const status = result.exitCode === 0 ? ('pass' as const) : ('fail' as const);

  if (status === 'fail') {
    log?.warn({ exitCode: result.exitCode, duration }, 'SAST failed');
  } else {
    log?.info({ duration }, 'SAST passed');
  }

  const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
  return { status, output: combined.slice(0, 50_000), duration };
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
  const startCwd = config.buildWorkDir ? `/workspace/${config.buildWorkDir}` : '/workspace';
  containerManager
    .execInContainer(
      config.containerId,
      ['sh', '-c', `${config.startCommand} > ${startLogPath} 2>&1 &`],
      { cwd: startCwd },
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
        const rawBody = await response.text().catch(() => '');
        const responseBody = rawBody.slice(0, 2_000) || undefined;
        return {
          status: 'pass' as const,
          url,
          responseCode: response.status,
          duration,
          responseBody,
        };
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
  const screenshotDir = hostBrowserRunner.screenshotDir(config.podId);

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
      podId: config.podId,
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

export type AcValidationType = 'web-ui' | 'api' | 'none';

export interface ClassifiedAc {
  criterion: string;
  validationType: AcValidationType;
  reason: string;
  /** Author-declared pass condition from the brief frontmatter, if present. */
  pass?: string;
  /** Author-declared fail condition from the brief frontmatter, if present. */
  fail?: string;
}

/** Map brief-declared `AcType` to the engine's internal `AcValidationType`. */
function mapBriefType(t: AcType): AcValidationType {
  return t === 'web' ? 'web-ui' : t;
}

const COMMAND_LIKE_AC_PATTERNS: RegExp[] = [
  /^run\s+`/i, // run `some command`
  /^execute\s+`/i, // execute `some command`
  /^`[^`]+`$/, // entire criterion is a backtick-quoted command
  /^dotnet\s/i, // dotnet build / test / run
  /^npm\s/i, // npm run / test / build
  /^npx\s/i, // npx ...
  /^pnpm\s/i, // pnpm ...
  /^yarn\s/i, // yarn ...
  /^cargo\s/i, // cargo build / test
  /^make\s/i, // make <target>
  /^\.\/\S/, // ./script.sh
  /^\/[a-z]/i, // /simplify, /review, /fix etc. (slash commands)
];

/**
 * Returns true when an AC text describes a shell command or slash-command step
 * rather than a testable behavioural outcome. These are always classified 'none'.
 */
export function isCommandLikeAc(text: string): boolean {
  const t = text.trim();
  return COMMAND_LIKE_AC_PATTERNS.some((re) => re.test(t));
}

/**
 * Assign a validation type to each AC. Brief-declared types are authoritative —
 * the LLM classifier is only invoked for legacy paths where `type` is absent.
 *
 * Command-like ACs (shell commands, slash commands) are always forced to 'none'
 * regardless of any declared type, since they describe procedural steps rather
 * than testable behavioural outcomes.
 */
export async function classifyAcTypes(
  config: ValidationEngineConfig,
  log?: Logger,
): Promise<ClassifiedAc[] | null> {
  const allAcs = config.acceptanceCriteria ?? [];
  if (allAcs.length === 0) return [];

  const hasWebUi = config.hasWebUi ?? true;

  // Pre-pass: force command-like ACs to 'none' regardless of any declared type.
  const commandResults: ClassifiedAc[] = [];
  const acs = allAcs.filter((ac) => {
    if (isCommandLikeAc(ac.test)) {
      log?.info({ criterion: ac.test }, 'AC is command-like — forcing to none');
      commandResults.push({
        criterion: ac.test,
        validationType: 'none',
        reason: 'Command-like criterion — evaluated by diff reviewer',
        pass: ac.pass,
        fail: ac.fail,
      });
      return false;
    }
    return true;
  });

  if (acs.length === 0) {
    const byText = new Map(commandResults.map((r) => [r.criterion, r]));
    return allAcs.map(
      (ac) =>
        byText.get(ac.test) ?? {
          criterion: ac.test,
          validationType: 'none' as const,
          reason: 'Command-like criterion — evaluated by diff reviewer',
        },
    );
  }

  // Brief frontmatter and the pod repository both produce `AcDefinition` with a
  // declared `type` — trust it and skip the LLM classification entirely.
  const allDeclared = acs.every(
    (ac) => ac.type === 'none' || ac.type === 'api' || ac.type === 'web',
  );

  let classifiedRemaining: ClassifiedAc[];
  if (allDeclared) {
    log?.info({ acCount: acs.length }, 'using brief-declared AC types, skipping LLM classifier');
    classifiedRemaining = acs.map((ac) => {
      let validationType = mapBriefType(ac.type);
      // Respect `hasWebUi: false` — downgrade to 'none' rather than run a
      // browser phase against a project that has no frontend.
      if (validationType === 'web-ui' && !hasWebUi) validationType = 'none';
      return {
        criterion: ac.test,
        validationType,
        reason: 'declared in brief frontmatter',
        pass: ac.pass,
        fail: ac.fail,
      };
    });
  } else {
    // Fallback: ask the LLM when types weren't declared (reserved for future
    // ingestion paths that produce `AcDefinition`s without a type).
    const acList = acs.map((ac, i) => `${i + 1}. ${ac.test}`).join('\n');
    const webUiRestriction = hasWebUi
      ? ''
      : '\nIMPORTANT: This project has NO web frontend. Do not classify any criterion as "web-ui". Use "api" or "none" only.\n';

    const prompt = `You are a QA automation planner. For each acceptance criterion, decide how it should be validated automatically by a test harness that can only make synchronous HTTP requests to a running server.

## Validation types

### "api" — only use this when ALL of the following are true:
1. The check is a single synchronous HTTP request (or a short sequence: create → then read/delete).
2. The expected behaviour is observable in the HTTP response immediately — no waiting for background workers, timers, cron jobs, schedulers, or queued tasks to execute.
3. The check does NOT require a specific authenticated user role or credential that the test harness won't have.
4. The endpoint and expected response shape are deterministic from the criterion text alone.

### "web-ui" — verify by navigating a real browser and checking DOM elements. Only for criteria that require a human-visible frontend.${webUiRestriction}

### "none" — use for EVERYTHING else:
- TypeScript type exports, internal code structure, SQL migrations
- Any criterion whose observable state depends on a background process, scheduler, cron job, timer, or async worker having already executed (e.g. "Status is set to Succeeded after job runs", "ConsecutiveFailureCount increments", "IsEnabled is set to false after N failures")
- Auth/RBAC behaviour that requires a specific role credential the harness won't possess (e.g. "a non-Administrator user receives 403")
- Criteria that mention "after a run completes", "on each tick", "on startup", "after N consecutive failures" — these require the scheduler to have fired, which a synchronous HTTP check cannot trigger or wait for
- Desktop/native app changes, CLI output formats, anything only verifiable by reading the diff or running unit tests

## Decision rule (use it literally)
Ask yourself: "Can I write a single curl command (or a create-then-read chain) that, RIGHT NOW against the live server, observes the required state without waiting for any background process?" If NO → use "none".

Task context: ${config.task}

Acceptance Criteria:
${acList}

Diff of changes (for context):
${config.diff ? config.diff.slice(0, 4000) : '(no diff available)'}

Respond with a JSON array. Each element must have:
- "criterion": exact original text (copy verbatim)
- "validationType": "web-ui" | "api" | "none"
- "reason": one short sentence explaining your classification

Respond ONLY with the JSON array, no markdown fences or extra text.`;

    try {
      const reviewTimeout = config.reviewTimeout ?? 300_000;
      const { stdout } = await runClaudeCli({
        model: config.reviewerModel ?? 'sonnet',
        input: prompt,
        timeout: reviewTimeout,
      });

      const llmResult = parseClassificationJson(stdout.trim(), acs);
      if (llmResult === null) return null;
      classifiedRemaining = llmResult;
    } catch (err) {
      log?.warn({ err }, 'failed to classify AC types, falling back to none');
      return null;
    }
  }

  // Merge command-forced results with the classified remainder, restoring original order.
  const byText = new Map<string, ClassifiedAc>();
  for (const r of commandResults) byText.set(r.criterion, r);
  for (const r of classifiedRemaining) byText.set(r.criterion, r);
  return allAcs.map(
    (ac) =>
      byText.get(ac.test) ?? {
        criterion: ac.test,
        validationType: 'none' as const,
        reason: 'Classification unavailable — falling back to diff reviewer',
      },
  );
}

/** Parse and validate the classification JSON response from the LLM. */
export function parseClassificationJson(
  raw: string,
  originalAcs: AcDefinition[],
): ClassifiedAc[] | null {
  const cleaned = stripMarkdownFences(raw);
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return null;

    const validTypes = new Set<string>(['web-ui', 'api', 'none']);
    const results = parsed.filter(
      (item: unknown): item is ClassifiedAc =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).criterion === 'string' &&
        validTypes.has((item as Record<string, unknown>).validationType as string) &&
        typeof (item as Record<string, unknown>).reason === 'string',
    );

    // Enrich LLM results with author-declared pass/fail hints (matched by test text).
    const hintsByText = new Map(originalAcs.map((ac) => [ac.test, ac]));
    for (const r of results) {
      const hint = hintsByText.get(r.criterion);
      if (hint) {
        r.pass = hint.pass;
        r.fail = hint.fail;
      }
    }

    // If we got fewer results than ACs, fall back any missing ones to 'none'.
    if (results.length < originalAcs.length) {
      const covered = new Set(results.map((r) => r.criterion));
      for (const ac of originalAcs) {
        if (!covered.has(ac.test)) {
          results.push({
            criterion: ac.test,
            validationType: 'none',
            reason: 'Not classified by LLM',
            pass: ac.pass,
            fail: ac.fail,
          });
        }
      }
    }

    return results;
  } catch {
    return null;
  }
}

/**
 * Deduplicates acceptance criteria that differ only by an appended parenthetical
 * testability-guidance suffix.  For example:
 *   "POST /jobs returns 201"
 *   "POST /jobs returns 201 (HTTP status code verifiable via a POST request)"
 * are treated as the same criterion; we keep the longer (more informative) form
 * and expose an `expandResult` function to fan results back out to ALL originals.
 *
 * @internal Exported for testing.
 */
export function deduplicateAcsByBaseText(criteria: AcDefinition[]): {
  deduped: AcDefinition[];
  expandResult: (results: AcCheckResult[]) => AcCheckResult[];
} {
  // Normalise: strip trailing " (...)" parenthetical that /prep adds for testability context.
  function baseText(ac: string): string {
    return ac.replace(/\s+\([^)]*\)\s*$/, '').trim();
  }

  // Map from base text → longest original AC (by test-text length) that shares it.
  const canonical = new Map<string, AcDefinition>();
  for (const ac of criteria) {
    const base = baseText(ac.test);
    const existing = canonical.get(base);
    if (!existing || ac.test.length > existing.test.length) {
      canonical.set(base, ac);
    }
  }

  const deduped = [...canonical.values()];

  // For each original criterion, find which canonical test-text it maps to.
  const originalToCanonical = new Map<AcDefinition, string>();
  for (const ac of criteria) {
    const canon = canonical.get(baseText(ac.test));
    if (canon) originalToCanonical.set(ac, canon.test);
  }

  function expandResult(results: AcCheckResult[]): AcCheckResult[] {
    const byCanonical = new Map(results.map((r) => [r.criterion, r]));
    const expanded: AcCheckResult[] = [];
    for (const ac of criteria) {
      const canonText = originalToCanonical.get(ac);
      const result = canonText ? byCanonical.get(canonText) : undefined;
      if (result) {
        // Re-emit the result under the original criterion text so the feedback
        // message shows the text the user actually wrote.
        expanded.push({ ...result, criterion: ac.test });
      } else {
        // Fallback: shouldn't happen, but don't silently drop a criterion
        expanded.push({
          criterion: ac.test,
          passed: false,
          validationType: 'none' as const,
          reasoning: 'No result available for this criterion',
        });
      }
    }
    return expanded;
  }

  return { deduped, expandResult };
}

async function runAcValidation(
  containerManager: ContainerManager,
  config: ValidationEngineConfig,
  log?: Logger,
  hostBrowserRunner?: HostBrowserRunner,
  acClassificationCache?: Map<string, ClassifiedAc[]>,
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

  // Step 1: Deduplicate ACs before classification.
  // Near-duplicates arise when a spec file contains both a short form and a long form with
  // appended parenthetical testability guidance, e.g.:
  //   "POST /jobs returns 201"
  //   "POST /jobs returns 201 (HTTP status code is directly verifiable via a POST request)"
  // Both forms are semantically the same criterion.  We normalise by keeping the longest
  // form for each base text and map results back to ALL matching originals.
  const { deduped: dedupedCriteria, expandResult } = deduplicateAcsByBaseText(
    config.acceptanceCriteria,
  );
  const dedupedConfig =
    dedupedCriteria.length < config.acceptanceCriteria.length
      ? { ...config, acceptanceCriteria: dedupedCriteria }
      : config;

  // Step 2: Classify each AC by validation type (cached to prevent non-deterministic re-classification)
  const cacheKey = dedupedCriteria
    .map((ac) => ac.test)
    .sort()
    .join('|');
  const cachedClassification = acClassificationCache?.get(cacheKey) ?? null;
  const classified = cachedClassification ?? (await classifyAcTypes(dedupedConfig, log));
  if (classified && classified.length > 0 && !cachedClassification) {
    acClassificationCache?.set(cacheKey, classified);
  }
  if (!classified || classified.length === 0) {
    log?.warn('AC classification failed, marking all as diff-reviewed');
    const fallbackResults: AcCheckResult[] = (config.acceptanceCriteria ?? []).map((ac) => ({
      criterion: ac.test,
      passed: true,
      validationType: 'none' as const,
      reasoning: 'Classification failed — evaluated by diff reviewer',
    }));
    return { status: 'pass', results: fallbackResults, model: config.reviewerModel };
  }

  log?.info(
    {
      webUi: classified.filter((c) => c.validationType === 'web-ui').length,
      api: classified.filter((c) => c.validationType === 'api').length,
      none: classified.filter((c) => c.validationType === 'none').length,
      deduped: config.acceptanceCriteria.length - dedupedCriteria.length,
    },
    'AC classification complete',
  );

  // Step 3: Split by type
  const webUiAcs = classified.filter((c) => c.validationType === 'web-ui');
  const apiAcs = classified.filter((c) => c.validationType === 'api');
  const noneAcs = classified.filter((c) => c.validationType === 'none');

  // Step 4: Execute each bucket (using dedupedConfig so the LLM sees clean, non-duplicate ACs)
  const noneResults: AcCheckResult[] = noneAcs.map((c) => ({
    criterion: c.criterion,
    passed: true,
    validationType: 'none' as const,
    reasoning: `Automated check not applicable (${c.reason}) — evaluated by diff reviewer`,
  }));

  const apiResults = apiAcs.length > 0 ? await executeApiChecks(dedupedConfig, apiAcs, log) : [];

  let browserResults: AcCheckResult[] = [];
  if (webUiAcs.length > 0) {
    const webUiInstructions = await generateAcInstructions(dedupedConfig, webUiAcs, log);
    if (webUiInstructions && webUiInstructions.length > 0) {
      browserResults = await executeAcChecks(
        containerManager,
        dedupedConfig,
        webUiInstructions,
        log,
        hostBrowserRunner,
      );
    } else {
      browserResults = webUiAcs.map((c) => ({
        criterion: c.criterion,
        passed: false,
        validationType: 'web-ui' as const,
        reasoning: 'Failed to generate browser validation instructions',
      }));
    }
  }

  // Step 5: Expand deduplicated results back to original criteria.
  // When two original ACs mapped to the same canonical form (e.g., one has a
  // parenthetical suffix), both get the same result so neither shows as "missing".
  const compactResults: AcCheckResult[] = [...browserResults, ...apiResults, ...noneResults];
  const results: AcCheckResult[] = expandResult(compactResults);

  // Only count automated checks (web-ui and api) for pass/fail determination
  const automatedResults = results.filter((r) => r.validationType !== 'none');
  const allPassed = automatedResults.length === 0 || automatedResults.every((r) => r.passed);

  log?.info(
    {
      acCount: results.length,
      automated: automatedResults.length,
      passCount: automatedResults.filter((r) => r.passed).length,
      failCount: automatedResults.filter((r) => !r.passed).length,
      diffReviewed: noneResults.length,
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
  webUiAcs: ClassifiedAc[],
  log?: Logger,
): Promise<Array<{ criterion: string; instruction: string }> | null> {
  const acList = webUiAcs
    .map((ac, i) => {
      const hints =
        ac.pass || ac.fail
          ? `\n   Pass: ${ac.pass ?? '(no explicit pass condition)'}\n   Fail: ${ac.fail ?? '(no explicit fail condition)'}`
          : '';
      return `${i + 1}. ${ac.criterion}${hints}`;
    })
    .join('\n');

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

interface ApiCheckSpec {
  criterion: string;
  method: string;
  path: string;
  expectedStatus: number;
  bodyContains?: string;
  requestBody?: unknown;
  /**
   * Variable name to capture from this response (e.g. "jobId").
   * Used when a POST creates a resource whose ID is needed by later checks.
   */
  captureAs?: string;
  /**
   * Dot-separated JSON field path to extract from the response body (e.g. "id" or "data.id").
   * Required when captureAs is set.
   */
  captureField?: string;
  /**
   * Criterion text of the spec this one depends on.
   * The dependent spec runs AFTER its dependency and may use {variableName} in path.
   */
  dependsOn?: string;
}

/** Execute HTTP-based AC checks for api-type criteria. */
async function executeApiChecks(
  config: ValidationEngineConfig,
  apiAcs: ClassifiedAc[],
  log?: Logger,
): Promise<AcCheckResult[]> {
  const acList = apiAcs
    .map((c, i) => {
      const hints =
        c.pass || c.fail
          ? `\n   Pass: ${c.pass ?? '(no explicit pass condition)'}\n   Fail: ${c.fail ?? '(no explicit fail condition)'}`
          : '';
      return `${i + 1}. ${c.criterion} (${c.reason})${hints}`;
    })
    .join('\n');

  const prompt = `You are a QA automation engineer. Generate HTTP request specs to validate each acceptance criterion against a running server.

Server base URL: ${config.previewUrl}

## Criteria to validate (YOUR OUTPUT MUST HAVE ONE SPEC PER CRITERION)
${acList}

## Output format — one JSON object per criterion above

Fields:
- "criterion": COPY the criterion text VERBATIM from the numbered list above. Do NOT paraphrase, shorten, or alter it.
- "method": HTTP method (GET, POST, PUT, DELETE, PATCH)
- "path": URL path — use {varName} placeholders for dynamic IDs (explained below)
- "expectedStatus": HTTP status code as a NUMBER (e.g. 200, 201, 400, 404)
- "bodyContains": optional string that must appear in the JSON response body
- "requestBody": optional JSON object for POST/PUT/PATCH

## Chained requests (for endpoints that need a resource to exist first)

REST APIs typically use server-generated UUIDs, not integer IDs like 1, 2, 3.
Never hardcode integer IDs in paths — use the chaining mechanism below instead.

To create a resource and then use its ID in later specs:
- On the CREATE spec: add "captureAs": "someVar" and "captureField": "id"
- On the DEPENDENT spec: add "dependsOn": "<verbatim criterion of the create spec>"
  and use {someVar} in the path

## Example (uses a FICTIONAL blog API — do NOT copy these criterion texts into your output)

[
  {
    "criterion": "POST /api/articles creates an article and returns 201",
    "method": "POST", "path": "/api/articles", "expectedStatus": 201,
    "requestBody": {"title": "Test", "body": "Hello"},
    "captureAs": "articleId", "captureField": "id"
  },
  {
    "criterion": "DELETE /api/articles/{id} returns 204",
    "method": "DELETE", "path": "/api/articles/{articleId}", "expectedStatus": 204,
    "dependsOn": "POST /api/articles creates an article and returns 201"
  }
]

## Rules
1. Output MUST contain exactly one spec for EVERY criterion in the numbered list — no omissions.
2. The "criterion" value MUST be copied character-for-character from the numbered list.
3. Use {varName} placeholders instead of hardcoded integer IDs.
4. Keep requestBody minimal — just enough to pass validation.

Respond ONLY with a JSON array, no markdown fences or extra text.`;

  let specs: ApiCheckSpec[] = [];
  const reviewTimeout = config.reviewTimeout ?? 300_000;
  let parseAttempt = 0;
  while (parseAttempt < 2) {
    try {
      const { stdout } = await runClaudeCli({
        model: config.reviewerModel ?? 'sonnet',
        input: prompt,
        timeout: reviewTimeout,
      });
      const rawOutput = stdout.trim();
      const parsed = parseApiCheckSpecs(rawOutput, log);
      if (parsed !== null) {
        specs = parsed;
        break;
      }
      parseAttempt++;
      if (parseAttempt < 2) {
        log?.warn(
          { rawPreview: rawOutput.slice(0, 500) },
          'parseApiCheckSpecs returned null — retrying LLM call',
        );
      } else {
        log?.warn(
          { rawPreview: rawOutput.slice(0, 500) },
          'parseApiCheckSpecs returned null after retry — gap-filling all API ACs',
        );
      }
    } catch (err) {
      log?.warn({ err }, 'failed to generate API check specs');
      return apiAcs.map((c) => ({
        criterion: c.criterion,
        passed: false,
        validationType: 'api' as const,
        reasoning: 'Failed to generate API check specification (LLM call error)',
      }));
    }
  }

  const specsWereGenerated = specs.length > 0;
  const results: AcCheckResult[] = [];

  // Execute specs in dependency order so captured variables are available.
  // Build a lookup by criterion for fast dependency resolution.
  const specsByCriterion = new Map(specs.map((s) => [s.criterion, s]));
  const captured = new Map<string, string>(); // varName → captured value

  // Topological sort: specs with no dependsOn go first; dependent specs follow.
  const independent = specs.filter((s) => !s.dependsOn);
  const dependent = specs.filter((s) => !!s.dependsOn);
  const orderedSpecs = [...independent, ...dependent];

  for (const spec of orderedSpecs) {
    // If this spec depends on another, skip it if its dependency failed (no variable captured).
    if (spec.dependsOn && spec.captureAs === undefined) {
      const dep = specsByCriterion.get(spec.dependsOn);
      if (dep?.captureAs && !captured.has(dep.captureAs)) {
        results.push({
          criterion: spec.criterion,
          passed: false,
          validationType: 'api',
          reasoning: `Skipped: dependency "${spec.dependsOn}" did not capture a variable (setup failed)`,
        });
        continue;
      }
    }

    // Interpolate {varName} placeholders in the path using captured values.
    const resolvedPath = spec.path.replace(
      /\{(\w+)\}/g,
      (_, name) => captured.get(name) ?? `{${name}}`,
    );

    try {
      const url = `${config.previewUrl.replace(/\/$/, '')}${resolvedPath}`;
      const options: RequestInit = {
        method: spec.method,
        headers: { 'Content-Type': 'application/json' },
      };
      if (spec.requestBody && ['POST', 'PUT', 'PATCH'].includes(spec.method.toUpperCase())) {
        options.body = JSON.stringify(spec.requestBody);
      }

      const response = await fetch(url, options);
      const statusOk = response.status === spec.expectedStatus;

      // Always read the body — we need it for capture and for diagnostic info on failure.
      const responseBody = await response.text();

      // Capture a value from the response if requested.
      if (spec.captureAs && spec.captureField && response.status >= 200 && response.status < 300) {
        try {
          const json = JSON.parse(responseBody) as Record<string, unknown>;
          const value = spec.captureField
            .split('.')
            .reduce<unknown>((obj, key) => (obj as Record<string, unknown>)?.[key], json);
          if (typeof value === 'string' || typeof value === 'number') {
            captured.set(spec.captureAs, String(value));
            log?.debug({ varName: spec.captureAs, value }, 'captured variable from API response');
          }
        } catch {
          log?.warn(
            { captureField: spec.captureField },
            'failed to extract capture field from response',
          );
        }
      }

      let bodyOk = true;
      let bodyNote = '';
      if (spec.bodyContains) {
        bodyOk = responseBody.includes(spec.bodyContains);
        bodyNote = bodyOk
          ? ` Response body contains "${spec.bodyContains}".`
          : ` Response body does NOT contain "${spec.bodyContains}".`;
      }

      // For failing checks, include the first 300 chars of the response body so the agent
      // can understand WHY the request was rejected (e.g. validation error details on 400s).
      const failureBodyHint =
        !statusOk && responseBody
          ? ` Response: ${responseBody.slice(0, 300)}${responseBody.length > 300 ? '…' : ''}`
          : '';

      const passed = statusOk && bodyOk;
      results.push({
        criterion: spec.criterion,
        passed,
        validationType: 'api',
        reasoning: passed
          ? `${spec.method} ${resolvedPath} → ${response.status} (expected ${spec.expectedStatus}).${bodyNote}`
          : `${spec.method} ${resolvedPath} → ${response.status} (expected ${spec.expectedStatus}).${bodyNote}${failureBodyHint}`,
      });
    } catch (err) {
      results.push({
        criterion: spec.criterion,
        passed: false,
        validationType: 'api',
        reasoning: `HTTP check failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Ensure every API AC has a result, even if spec generation missed it.
  // Use fuzzy matching: normalise both sides to lower-case trimmed text so minor
  // whitespace or capitalisation differences from the LLM don't cause a false miss.
  // Also treat a result as covering an AC when one is a leading substring of the other
  // (handles cases where the LLM slightly truncates or extends the criterion text).
  function normCriterion(s: string): string {
    return s.toLowerCase().replace(/\s+/g, ' ').trim();
  }
  const coveredNorm = new Set(results.map((r) => normCriterion(r.criterion)));

  function isCovered(ac: string): boolean {
    const n = normCriterion(ac);
    if (coveredNorm.has(n)) return true;
    // Check prefix match: result is a prefix of AC (LLM truncated) or AC is a prefix of result
    for (const c of coveredNorm) {
      if (n.startsWith(c) || c.startsWith(n)) return true;
    }
    return false;
  }

  for (const ac of apiAcs) {
    if (!isCovered(ac.criterion)) {
      results.push({
        criterion: ac.criterion,
        passed: false,
        validationType: 'api',
        reasoning: specsWereGenerated
          ? 'No HTTP check spec was generated for this criterion (criterion missing from LLM response)'
          : 'No HTTP check spec was generated for this criterion (JSON parse failure after retry)',
      });
    }
  }

  return results;
}

/** @internal Exported for testing. */
export function parseApiCheckSpecs(raw: string, log?: Logger): ApiCheckSpec[] | null {
  const cleaned = stripMarkdownFences(raw);
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return null;

    const results: ApiCheckSpec[] = [];
    for (const item of parsed as unknown[]) {
      if (typeof item !== 'object' || item === null) {
        log?.warn({ item }, 'parseApiCheckSpecs: dropping non-object spec entry');
        continue;
      }
      const rec = item as Record<string, unknown>;

      // LLM frequently returns "200" (string) — coerce it to a number
      if (typeof rec.expectedStatus === 'string' && /^\d+$/.test(rec.expectedStatus)) {
        rec.expectedStatus = Number.parseInt(rec.expectedStatus, 10);
      }

      const missingFields: string[] = [];
      if (typeof rec.criterion !== 'string') missingFields.push('criterion');
      if (typeof rec.method !== 'string') missingFields.push('method');
      if (typeof rec.path !== 'string') missingFields.push('path');
      if (typeof rec.expectedStatus !== 'number') missingFields.push('expectedStatus');

      if (missingFields.length > 0) {
        log?.warn(
          { criterion: rec.criterion, missingFields },
          'parseApiCheckSpecs: dropping spec — failed type guard',
        );
        continue;
      }

      // Pass through optional fields without validating — they are used at execution time
      results.push(rec as unknown as ApiCheckSpec);
    }
    return results;
  } catch {
    return null;
  }
}

function buildAcScriptPrompt(
  instructions: Array<{ criterion: string; instruction: string }>,
  baseUrl: string,
  screenshotDir: string,
  mode: 'host' | 'container',
): string {
  const instructionList = instructions
    .map((inst, i) => `Check ${i + 1}: "${inst.criterion}"\nInstruction: ${inst.instruction}`)
    .join('\n\n');

  const importLine =
    mode === 'host'
      ? `import { chromium } from 'playwright';`
      : `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const { chromium } = require('playwright');`;

  return `You are a browser automation expert. Generate a Playwright script (ESM, using @playwright/test's chromium) that executes the following validation checks against a running web application.

Base URL: ${baseUrl}
Screenshot directory: ${screenshotDir}

Checks to perform:
${instructionList}

Requirements:
- Use \`${importLine}\` (${mode === 'host' ? 'standard ESM import' : 'ESM import ignores NODE_PATH, so use createRequire for CJS resolution'})
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
  const reviewTimeout = config.reviewTimeout ?? 300_000;
  const execTimeout = instructions.length * 45_000 + 30_000;

  // Guard against the race between health-check pass and Playwright execution.
  // Dev servers sometimes respond to the health poll once and then crash during
  // startup; a brief retry window catches momentary jitter without masking real failures.
  if (useHost && config.startCommand) {
    const reachable = await pollUntilReachable(config.previewUrl, {
      attempts: 4,
      intervalMs: 1_500,
    });
    if (!reachable) {
      return instructions.map((inst) => ({
        criterion: inst.criterion,
        passed: false,
        reasoning: `App not reachable at ${config.previewUrl} — ensure the start command keeps the server running`,
      }));
    }
  }

  async function generateScript(mode: 'host' | 'container'): Promise<string> {
    const baseUrl =
      mode === 'host' ? config.previewUrl : (config.containerBaseUrl ?? config.previewUrl);
    const screenshotDir =
      mode === 'host'
        ? `${hostBrowserRunner?.screenshotDir(config.podId)}/ac`
        : '/tmp/autopod-ac-screenshots';
    const prompt = buildAcScriptPrompt(instructions, baseUrl, screenshotDir, mode);
    const { stdout } = await runClaudeCli({
      model: config.reviewerModel ?? 'sonnet',
      input: prompt,
      timeout: reviewTimeout,
    });
    return stripMarkdownFences(stdout.trim());
  }

  try {
    if (useHost) {
      const hostScript = await generateScript('host');
      const hostResult = await executeAcOnHost(
        hostBrowserRunner,
        config,
        hostScript,
        instructions,
        execTimeout,
        log,
      );
      if (hostResult !== null) return hostResult;
      // Host Playwright produced no markers — fall back to container with a freshly generated script
      log?.warn({ podId: config.podId }, 'Host AC checks failed — falling back to container');
      const containerScript = await generateScript('container');
      return await executeAcInContainer(
        containerManager,
        config,
        containerScript,
        instructions,
        execTimeout,
        log,
      );
    }

    const containerScript = await generateScript('container');
    return await executeAcInContainer(
      containerManager,
      config,
      containerScript,
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
): Promise<AcCheckResult[] | null> {
  const screenshotDir = `${hostBrowserRunner.screenshotDir(config.podId)}/ac`;

  const result = await hostBrowserRunner.runScript(script, {
    timeout,
    podId: config.podId,
  });

  // If the script crashed before writing markers (e.g. Chromium couldn't reach the host port),
  // return null so the caller can fall back to container execution.
  const hasMarkers =
    result.stdout.includes('__AUTOPOD_AC_RESULTS_START__') &&
    result.stdout.includes('__AUTOPOD_AC_RESULTS_END__');
  if (!hasMarkers) {
    log?.warn(
      { podId: config.podId, stderr: result.stderr.slice(0, 500) },
      'Host AC browser script produced no result markers — falling back to container',
    );
    return null;
  }

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

  const parsed = parseAcResults(result.stdout, instructions, result.stderr);

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

/** @internal Exported for testing. Parse AC results from the Playwright script's stdout markers.
 *  `rawOutput` (stderr or combined output) is included in the fallback reasoning when the script
 *  crashes before emitting markers, so the agent knows why validation failed.
 */
export function parseAcResults(
  stdout: string,
  instructions: Array<{ criterion: string; instruction: string }>,
  rawOutput?: string,
): AcCheckResult[] {
  const startMarker = '__AUTOPOD_AC_RESULTS_START__';
  const endMarker = '__AUTOPOD_AC_RESULTS_END__';

  const startIdx = stdout.indexOf(startMarker);
  const endIdx = stdout.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    // Script crashed before writing result markers — include raw output so the
    // agent can diagnose whether the app was unreachable, Playwright failed, etc.
    const detail = rawOutput?.trim().slice(0, 400);
    const reasoning = detail
      ? `Script produced no result markers. Output: ${detail}`
      : 'Script did not produce parseable results';
    return instructions.map((inst) => ({
      criterion: inst.criterion,
      passed: false,
      reasoning,
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
export function buildReviewPrompt(
  config: ValidationEngineConfig,
  reviewContext?: ReviewContext,
  noneAcCriteria: string[] = [],
): string {
  const allAcs = config.acceptanceCriteria ?? [];

  // ACs already verified by the automated harness (api + web-ui)
  const autoVerifiedAcs = allAcs.filter((ac) => !noneAcCriteria.includes(ac.test));

  // For backward-compat: we still need acList as a boolean signal for step numbering
  const acList = allAcs.length > 0 ? true : null;

  const autoSection =
    autoVerifiedAcs.length > 0
      ? `\n## ACCEPTANCE CRITERIA — AUTO-VERIFIED\nThe following were already checked by the automated test harness (HTTP calls / browser). You do not need to re-verify these unless you spot a code defect that would cause them to fail at runtime:\n${autoVerifiedAcs.map((ac, i) => `${i + 1}. ${ac.test}`).join('\n')}\n`
      : '';

  const noneSection =
    noneAcCriteria.length > 0
      ? `\n## ACCEPTANCE CRITERIA — DIFF VERIFICATION REQUIRED\nThe following criteria cannot be tested via HTTP or browser. YOU ARE THE ONLY CHECK. Examine the diff carefully and assess each one:\n${noneAcCriteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n')}\n\nFor each criterion above include it in "requirementsCheck" with:\n- met=true  — diff clearly implements this\n- met=false — implementation is absent or clearly wrong\n\nBenefit of the doubt: if the diff is ambiguous or you can't confirm, default to met=true. Only fail when you have clear evidence of absence or incorrectness.\n`
      : '';

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

  const commitLogSection = config.commitLog
    ? `\n## COMMIT HISTORY\n\nCommits on this branch (most recent first — use to understand progression and intent):\n\n${config.commitLog}\n`
    : '';

  // Brief scope hints are advisory — flag deviations as discussion items in
  // your notes, never as failures. The agent is allowed to expand scope when
  // the work clearly requires it; the human (or AI reviewer) adjudicates.
  const touches = config.briefTouches ?? [];
  const doesNotTouch = config.briefDoesNotTouch ?? [];
  const briefScopeSection =
    touches.length > 0 || doesNotTouch.length > 0
      ? `\n## BRIEF SCOPE (ADVISORY)\n\nThe brief authored these scope hints. They are GUIDANCE, not enforcement. If the diff modifies files outside the "expected to modify" list or touches files in the "avoid" list, treat it as a DISCUSSION ITEM in your notes — never as a failure on its own. The agent is allowed to expand scope when the work requires it; the human reviewer decides whether the deviation is acceptable.\n${
          touches.length > 0
            ? `\nFiles this brief expected to modify (paths ending in \`/\` mean "anything under this directory"):\n${touches.map((p) => `- ${p}`).join('\n')}\n`
            : ''
        }${
          doesNotTouch.length > 0
            ? `\nFiles this brief was asked to avoid:\n${doesNotTouch.map((p) => `- ${p}`).join('\n')}\n`
            : ''
        }`
      : '';

  // Build the enriched context section (Tier 0+1)
  const contextSection = reviewContext ? buildContextSection(reviewContext) : '';

  // Human-dismissed findings that must be skipped
  const overridesSection = buildOverridesSection(config.overrides);

  return `You are an expert software engineer performing an independent code review of changes made by an AI agent.

Your mission: provide high-value, actionable feedback on medium and above severity issues. Low severity findings should be skipped entirely — if they don't meet the medium bar, don't report them.

Core principles:
- Be helpful, not noisy. Only raise fair, actionable concerns that genuinely improve code.
- Focus exclusively on what changed in this diff. Never comment on pre-existing code.
- Don't flag style preferences. Only flag significant inconsistencies with existing patterns.
- Treat generated code fairly — if it's appropriate and contextually correct, it passes.
- When uncertain, skip rather than create noise.
- Auto-formatter changes (whitespace, punctuation, quote normalization applied by pre-commit hooks like Prettier or ESLint --fix) are expected commit side-effects. Never flag them as scope creep or unrelated changes.
- Files at paths matching \`specs/*/handovers/*.md\` are required Series Handover Protocol artifacts — agents in a series are explicitly instructed to write them. Their presence in the diff is mandatory and must NOT be flagged as scope violation or undisclosed deviation.
- Use the CODEBASE CONTEXT section (if present) to verify claims made in the diff. Auto-detected warnings are high-confidence signals — investigate them seriously.
${repoRulesSection}
## TASK

${config.task}
${autoSection}${noneSection}${planSection}${taskSummarySection}${briefScopeSection}
${commitLogSection}${contextSection}## DIFF

${config.diff}
${overridesSection}
## INSTRUCTIONS

${
  noneAcCriteria.length > 0
    ? `### Step 1: Requirements check

For each criterion in the "ACCEPTANCE CRITERIA — DIFF VERIFICATION REQUIRED" section above, examine the diff carefully and assess whether it is implemented. These are YOUR responsibility — they cannot be tested any other way.

- met=true  — diff clearly implements this criterion
- met=false — implementation is absent or clearly wrong
- Benefit of the doubt: if the diff is ambiguous or you can't tell, default to met=true. Only fail when you have clear evidence of absence or incorrectness.
- Add a brief note explaining your assessment.

Do NOT include auto-verified criteria in requirementsCheck.

`
    : acList
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

Review ONLY the changed code across these dimensions. Only raise medium, high, or critical severity issues — skip anything below that bar:

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
  ${noneAcCriteria.length > 0 ? '"requirementsCheck": [\n    // Include ONLY the "DIFF VERIFICATION REQUIRED" criteria. Do NOT include auto-verified ones.\n    { "criterion": "...", "met": true|false, "note": "optional" }\n  ],\n  ' : acList ? '"requirementsCheck": [{ "criterion": "...", "met": true|false, "note": "optional" }],\n  ' : ''}${taskSummarySection ? '"deviationsAssessment": {\n    "disclosedDeviations": [{ "step": "...", "reasoning": "...", "verdict": "justified"|"questionable"|"unjustified" }],\n    "undisclosedDeviations": ["description of gap between plan and diff that was not reported"]\n  },\n  ' : ''}"issues": ["[SEVERITY] short description — each entry MUST be a plain string, not an object. Format: \\"[HIGH] Missing null check in foo()\\". Allowed severities: MEDIUM, HIGH, CRITICAL. Omit anything below medium."]
}

Status rules:
- "pass": requirements met (if any), no medium/high/critical severity issues found, and no unjustified undisclosed deviations. If you set "pass" but have minor observations below the medium bar, include them in reasoning and explain why they didn't reach the threshold.
- "fail": one or more requirements unmet, OR any medium/high/critical severity issue found, OR undisclosed deviations that compromised scope
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

/**
 * Forces status to 'fail' if any requirementsCheck item is unmet.
 * The reviewer may set status='pass' holistically while still marking individual items as unmet.
 */
export function enforceRequirementsStatus(
  parsed: ReturnType<typeof parseReviewJson>,
): ReturnType<typeof parseReviewJson> {
  if (!parsed) return parsed;
  const anyUnmet = parsed.requirementsCheck?.some((r) => !r.met) ?? false;
  if (anyUnmet && parsed.status === 'pass') {
    return { ...parsed, status: 'fail' };
  }
  return parsed;
}

async function runTaskReview(
  config: ValidationEngineConfig,
  log?: Logger,
  reviewContext?: ReviewContext,
  noneAcCriteria: string[] = [],
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

  const diffIsTruncated = config.diff?.includes('⚠ DIFF TRUNCATED:') ?? false;
  const prompt = buildReviewPrompt(config, reviewContext, noneAcCriteria);
  const reviewTimeout = config.reviewTimeout ?? 300_000;
  const reviewDepth = config.reviewDepth ?? 'auto';

  // Tier 1 (single-shot) is useless when the diff is truncated — the model
  // can't see all changed files and will either fabricate findings or skip.
  // Skip straight to Tier 2 (tool-use) where it can read files on demand.
  if (diffIsTruncated && !config.worktreePath) {
    return {
      result: null,
      skipReason: 'Diff is truncated and no worktree available for tool-use review',
    };
  }

  try {
    let tier1Parsed: ReturnType<typeof parseReviewJson> = null;

    if (!diffIsTruncated) {
      // ── Tier 1: Single-shot review with enriched context ──────────────
      const { stdout } = await runClaudeCli({
        model: config.reviewerModel,
        input: prompt,
        timeout: reviewTimeout,
      });

      tier1Parsed = enforceRequirementsStatus(parseReviewJson(stdout.trim()));
      if (!tier1Parsed) {
        log?.warn({ rawOutput: stdout.slice(0, 500) }, 'failed to parse task review response');
        return { result: null, skipReason: 'Failed to parse Tier 1 review response' };
      }
    } else {
      log?.info(
        'diff is truncated — skipping Tier 1 single-shot review, routing to Tier 2 tool-use',
      );
    }

    if (tier1Parsed) {
      log?.info(
        { status: tier1Parsed.status, issueCount: tier1Parsed.issues.length, tier: 1 },
        'Tier 1 task review complete',
      );
    }

    // If Tier 1 is conclusive and depth is standard-only, we're done.
    // Truncated diffs always escalate (tier1Parsed is null) so this branch is unreachable for them.
    // 'deep' forces Tier 2+ regardless of Tier 1 status.
    const shouldEscalate =
      diffIsTruncated ||
      (reviewDepth === 'deep' && !!config.worktreePath) ||
      (tier1Parsed?.status === 'uncertain' && reviewDepth !== 'standard' && !!config.worktreePath);

    if (!shouldEscalate && tier1Parsed) {
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

    if (!config.worktreePath) {
      // Escalation wanted but no worktree — return Tier 1 result if we have one
      if (tier1Parsed) {
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
      return {
        result: null,
        skipReason: 'Diff is truncated and no worktree available for tool-use review',
      };
    }

    // At this point, worktreePath is defined
    const worktreePath = config.worktreePath;

    // ── Tier 2: Tool-use review ───────────────────────────────────────
    const tier2Reason = diffIsTruncated
      ? 'diff is truncated — routing directly to Tier 2 tool-use review'
      : 'Tier 1 returned uncertain, escalating to Tier 2 tool-use review';
    log?.info(tier2Reason);

    try {
      const tier2Result = await runToolUseReview({
        model: config.reviewerModel,
        prompt,
        worktreePath,
        timeout: reviewTimeout,
        apiKey: config.reviewerApiKey,
      });

      const tier2Parsed = enforceRequirementsStatus(parseReviewJson(tier2Result.stdout.trim()));
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

          const tier3Parsed = enforceRequirementsStatus(parseReviewJson(tier3Result.stdout.trim()));
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

      // Fall back to best available result (Tier 2 if parsed, else Tier 1 if available)
      const bestParsed = tier2Parsed ?? tier1Parsed;
      if (!bestParsed) {
        return { result: null, skipReason: 'All review tiers failed to produce a result' };
      }
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
      log?.warn({ err }, 'Tier 2 tool-use review failed');
      if (!tier1Parsed) {
        // Truncated diff path: no Tier 1 result to fall back to
        const message = err instanceof Error ? err.message : String(err);
        return {
          result: null,
          skipReason: `Tier 2 tool-use review failed (diff was truncated): ${message}`,
        };
      }
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
 * Coerces a single review issue (which the model may emit as a plain string OR a
 * structured object like `{ severity, message }`) into a human-readable string.
 * Returns null for entries that have no renderable content. Without this, an
 * object would slip through `String(obj)` as the literal `"[object Object]"`.
 */
export function normalizeReviewIssue(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    const severityRaw =
      (typeof r.severity === 'string' && r.severity) ||
      (typeof r.level === 'string' && r.level) ||
      null;
    const severity = severityRaw ? severityRaw.trim().toUpperCase() : null;
    const messageRaw =
      (typeof r.message === 'string' && r.message) ||
      (typeof r.description === 'string' && r.description) ||
      (typeof r.issue === 'string' && r.issue) ||
      (typeof r.text === 'string' && r.text) ||
      null;
    const message = messageRaw ? messageRaw.trim() : null;
    if (!message) return null;
    return severity ? `[${severity}] ${message}` : message;
  }
  return null;
}

/**
 * Attempts to parse the reviewer's JSON response, tolerating markdown fences
 * and other common LLM output quirks.
 */
export function parseReviewJson(raw: string): {
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

    const normalizedIssues = (parsed.issues as unknown[])
      .map(normalizeReviewIssue)
      .filter((s): s is string => s !== null);
    // If the model returned issues but every one was un-renderable, treat the
    // response as malformed instead of silently dropping all flagged problems.
    if (parsed.issues.length > 0 && normalizedIssues.length === 0) return null;

    return {
      status: parsed.status,
      reasoning: parsed.reasoning,
      issues: normalizedIssues,
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
