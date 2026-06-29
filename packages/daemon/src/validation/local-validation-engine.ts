import { execFile } from 'node:child_process';
import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  AdvisoryBrowserQaResult,
  DeviationsAssessment,
  FactCheckResult,
  FactValidationResult,
  HealthResult,
  PageResult,
  TaskReviewResult,
  ValidationOverride,
  ValidationResult,
} from '@autopod/shared';
import { generateValidationScript, parsePageResults } from '@autopod/validator';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type {
  ValidationEngine,
  ValidationEngineConfig,
  ValidationPhaseCallbacks,
} from '../interfaces/validation-engine.js';
import { buildSupervisorCommand } from '../pods/preview-supervisor.js';
import { wrapValidationExecCommand } from '../pods/registry-injector.js';
import { ClaudeCliError, runClaudeCli } from '../runtimes/run-claude-cli.js';
import { runAdvisoryBrowserQa } from './advisory-browser-qa-runner.js';
import type { HostBrowserRunner } from './host-browser-runner.js';
import { getPreSubmitCacheDecision, hashDiff } from './pre-submit-review.js';
import { runAgenticReview } from './review-agentic-runner.js';
import { CodexReviewError, runCodexReview } from './review-codex-runner.js';
import { type ReviewContext, gatherReviewContext } from './review-context-builder.js';
import { applyDiffFilterToParsed } from './review-finding-filter.js';
import { runToolUseReview } from './review-tool-runner.js';

const execFileAsync = promisify(execFile);

interface PackageJsonManifest {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * Reset the worktree to HEAD on both filesystems validation evaluates against:
 * the container's `/workspace` (build/lint/sast/test/health/pages all run
 * there via `execInContainer`) and the daemon-host worktree at `worktreePath`
 * (Tier-2/3 reviewers run there with `Read`/`read_file` access).
 *
 * Without this, untracked files leak into validation in two distinct ways:
 *   1. Native build tools (`dotnet build`, etc.) discover source files via
 *      filesystem walk, not the git index, so untracked `.cs`/`.ts` files
 *      get compiled and surface as build failures unrelated to the PR.
 *   2. The agentic reviewer can `Read` any path under `worktreePath`, so even
 *      with prompt-level "DO NOT FLAG" carve-outs it routinely cites untracked
 *      files as scope creep when triggered by other signals (e.g. build
 *      output naming the file).
 *
 * `git clean -fd` (NOT `-fdx`) preserves gitignored caches like `node_modules`,
 * `bin/`, `obj/`, `dist/`, `.next/` so subsequent build phases keep their
 * incremental state. Combined with `git reset --hard HEAD` it restores the
 * worktree to "exactly what's committed" — which is the only thing validation
 * should be evaluating.
 *
 * Cleanup is best-effort: failures are logged and swallowed. Losing cleanup is
 * degraded mode, not broken mode.
 */
async function resetWorktreeToHead(
  containerManager: ContainerManager,
  config: ValidationEngineConfig,
  log?: Logger,
): Promise<void> {
  const cmd = 'git reset --hard HEAD && git clean -fd';

  // Container side — feeds Lint/SAST/Build/Tests/Health/Pages/Facts.
  // Always run at /workspace (repo root) regardless of buildWorkDir, so
  // untracked files anywhere in the worktree are removed, not just the
  // build subdir.
  try {
    const result = await containerManager.execInContainer(config.containerId, ['sh', '-c', cmd], {
      cwd: '/workspace',
      timeout: 30_000,
    });
    if (result.exitCode !== 0) {
      log?.warn(
        { exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) },
        'pre-validation worktree reset returned non-zero in container — continuing',
      );
    }
  } catch (err) {
    log?.warn({ err }, 'pre-validation worktree reset failed in container — continuing');
  }

  // Host side — feeds Tier-2/3 review (worktreePath is optional; only set
  // for review-eligible runs). Skip silently otherwise.
  if (config.worktreePath) {
    try {
      await execFileAsync('sh', ['-c', cmd], { cwd: config.worktreePath, timeout: 30_000 });
    } catch (err) {
      log?.warn({ err }, 'pre-validation worktree reset failed on host — continuing');
    }
  }
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
  screenshotStore?: import('../pods/screenshot-store.js').ScreenshotStore,
): ValidationEngine {
  const log = logger?.child({ component: 'local-validation-engine' });

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
        const skipPhases = config.skipPhases ?? [];

        // ── Phase 0: Reset worktree to HEAD ─────────────────────────────
        // Untracked / uncommitted files must not influence validation.
        // See `resetWorktreeToHead` for the full failure-mode rationale.
        checkAbort();
        await resetWorktreeToHead(containerManager, config, log);

        // ── Phase 0.5: Setup ───────────────────────────────────────────
        // Optional pre-validation setup command (e.g. seed a DB, start a
        // service) that must pass before any blocking phases run.
        checkAbort();
        let setupResult: import('@autopod/shared').SetupResult;
        if (skipPhases.includes('setup')) {
          setupResult = {
            status: 'skip',
            output: 'Setup phase skipped by profile configuration',
            duration: 0,
          };
          callbacks?.onPhaseCompleted?.('setup', 'skip', setupResult);
        } else if (!config.validationSetupCommand) {
          setupResult = { status: 'skip', output: '', duration: 0 };
          callbacks?.onPhaseCompleted?.('setup', 'skip', setupResult);
        } else {
          callbacks?.onPhaseStarted?.('setup');
          const setupStart = Date.now();
          let setupExecResult: { stdout: string; stderr: string; exitCode: number };
          try {
            setupExecResult = await containerManager.execInContainer(
              config.containerId,
              wrapValidationExecCommand(config.validationSetupCommand, config.extraExecEnv),
              {
                cwd: '/workspace',
                timeout: config.buildTimeout ?? 300_000,
                ...(config.extraExecEnv ? { env: config.extraExecEnv } : {}),
              },
            );
          } catch (err) {
            const duration = Date.now() - setupStart;
            const message = err instanceof Error ? err.message : String(err);
            setupResult = { status: 'fail', output: message, duration };
            callbacks?.onPhaseCompleted?.('setup', 'fail', setupResult);
            return makeSetupFailedResult(config, startTime, setupResult);
          }
          const setupDuration = Date.now() - setupStart;
          if (setupExecResult.exitCode !== 0) {
            setupResult = {
              status: 'fail',
              output: [setupExecResult.stdout, setupExecResult.stderr].filter(Boolean).join('\n'),
              duration: setupDuration,
            };
            callbacks?.onPhaseCompleted?.('setup', 'fail', setupResult);
            return makeSetupFailedResult(config, startTime, setupResult);
          }
          setupResult = {
            status: 'pass',
            output: setupExecResult.stdout,
            duration: setupDuration,
          };
          callbacks?.onPhaseCompleted?.('setup', 'pass', setupResult);
        }

        // ── Phase 1: Lint ──────────────────────────────────────────────
        checkAbort();
        let lintResult: Awaited<ReturnType<typeof runLint>>;
        if (skipPhases.includes('lint')) {
          lintResult = { status: 'skip', output: '', duration: 0 };
        } else {
          callbacks?.onPhaseStarted?.('lint');
          if (config.lintCommand) onProgress?.('Running lint…');
          lintResult = await runLint(containerManager, config, log);
        }
        callbacks?.onPhaseCompleted?.('lint', lintResult.status, lintResult);

        // ── Phase 2: SAST ──────────────────────────────────────────────
        checkAbort();
        let sastResult: Awaited<ReturnType<typeof runSast>>;
        if (skipPhases.includes('sast')) {
          sastResult = { status: 'skip', output: '', duration: 0 };
        } else {
          callbacks?.onPhaseStarted?.('sast');
          if (config.sastCommand) onProgress?.('Running SAST…');
          sastResult = await runSast(containerManager, config, log);
        }
        callbacks?.onPhaseCompleted?.('sast', sastResult.status, sastResult);

        // ── Phase 3: Build ─────────────────────────────────────────────
        checkAbort();
        let buildResult: Awaited<ReturnType<typeof runBuild>>;
        if (skipPhases.includes('build')) {
          buildResult = {
            status: 'pass',
            output: 'Build phase skipped by profile configuration',
            duration: 0,
          };
        } else {
          callbacks?.onPhaseStarted?.('build');
          if (config.buildCommand) onProgress?.('Running build…');
          buildResult = await runBuild(containerManager, config, log);
        }
        callbacks?.onPhaseCompleted?.('build', buildResult.status, buildResult);

        // ── Phase 4: Test ──────────────────────────────────────────────
        checkAbort();
        let testResult: { status: 'pass' | 'fail' | 'skip'; duration: number };
        if (skipPhases.includes('test')) {
          testResult = { status: 'skip', duration: 0 };
        } else {
          callbacks?.onPhaseStarted?.('test');
          if (buildResult.status === 'pass' && config.testCommand) onProgress?.('Running tests…');
          testResult =
            buildResult.status === 'pass'
              ? await runTests(containerManager, config, log)
              : { status: 'skip' as const, duration: 0 };
        }
        callbacks?.onPhaseCompleted?.('test', testResult.status, testResult);

        // ── Phase 5: Health check ──────────────────────────────────────
        // Skipped when the profile has no web UI — there's nothing to start,
        // no endpoint to poll, and downstream Pages validation is
        // inapplicable too.
        checkAbort();
        const skipForNoWebUi = config.hasWebUi === false;
        let healthResult: HealthResult;
        if (skipPhases.includes('health')) {
          healthResult = { status: 'skip', url: '', responseCode: null, duration: 0 };
        } else {
          callbacks?.onPhaseStarted?.('health');
          if (!skipForNoWebUi && buildResult.status === 'pass' && config.startCommand)
            onProgress?.('Running health check…');
          healthResult = skipForNoWebUi
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
                  url: getHealthCheckUrl(config),
                  responseCode: null,
                  duration: 0,
                };
        }
        callbacks?.onPhaseCompleted?.('health', healthResult.status, healthResult);

        // After health passes, watch for post-startup crashes in the background.
        // If the app goes down during smoke/review-adjacent phases, abort validation with a
        // clear "app crashed" message rather than a cryptic ERR_CONNECTION_REFUSED.
        if (healthResult.status === 'pass' && config.startCommand) {
          const healthUrl = getHealthCheckUrl(config);
          stopMonitor = startAppStabilityMonitor(
            async () => {
              const probe = await probeHealthEndpoint(containerManager, config, 3_000);
              return isHealthyStatus(probe.responseCode);
            },
            () => {
              log?.warn(
                { podId: config.podId, url: healthUrl, probeMode: config.webProbeMode ?? 'host' },
                'App became unreachable after health check passed — aborting validation',
              );
              crashController.abort();
            },
          );
        }

        // ── Phase 6: Page validation ───────────────────────────────────
        checkAbort();
        let pages: PageResult[];
        let pagesStatus: 'pass' | 'fail' | 'skip';
        if (skipPhases.includes('pages')) {
          pages = [];
          pagesStatus = 'skip';
        } else {
          callbacks?.onPhaseStarted?.('pages');
          if (healthResult.status === 'pass' && config.smokePages.length > 0)
            onProgress?.('Validating pages…');
          pages =
            healthResult.status === 'pass' && config.smokePages.length > 0
              ? await runPageValidation(containerManager, config, log, hostBrowserRunner)
              : [];
          // Health must actually pass for Pages to mean anything. When health is
          // 'fail' the app never came up, so `pages` is the empty array — and
          // `[].every(...)` is vacuously true, which previously surfaced a
          // bogus "All pages passed" while the failure was attributed to
          // Health. Treat any non-pass health as 'skip' to keep Pages honest;
          // the upstream Health failure already trips the tier-1 gate.
          pagesStatus =
            healthResult.status !== 'pass' || config.smokePages.length === 0
              ? 'skip'
              : pages.every((p) => p.status === 'pass')
                ? 'pass'
                : 'fail';
        }
        callbacks?.onPhaseCompleted?.('pages', pagesStatus, pages);

        // ── Tier-1 gate ────────────────────────────────────────────────
        // Cheap deterministic phases (lint/sast/build/test/health/pages) must
        // all pass-or-skip before we spend money on the AI tiers. If any
        // failed, facts + review are skipped — the agent gets the tier-1 findings
        // first and AI checks only run on code that's actually buildable.
        // 'skip' counts as pass (legit skips: no test command, no smoke pages,
        // no web UI, profile-level skipPhases).
        const tier1Pass =
          lintResult.status !== 'fail' &&
          sastResult.status !== 'fail' &&
          buildResult.status === 'pass' &&
          testResult.status !== 'fail' &&
          healthResult.status !== 'fail' &&
          pagesStatus !== 'fail';

        // ── Phase 7: Required Facts ────────────────────────────────────
        // Contract facts are the post-merge survival layer: concrete artifacts
        // and commands the validator can execute without model interpretation.
        checkAbort();
        let factValidation: FactValidationResult | null;
        let factsStatus: 'pass' | 'fail' | 'skip' | 'pending_human';
        if (skipPhases.includes('facts')) {
          factValidation = { status: 'skip', results: [] };
          factsStatus = 'skip';
        } else {
          callbacks?.onPhaseStarted?.('facts');
          if (tier1Pass && config.contract?.requiredFacts.length)
            onProgress?.('Checking required facts…');
          factValidation = tier1Pass
            ? await runFactValidation(containerManager, config, log, hostBrowserRunner)
            : { status: 'skip', results: [] };
          factsStatus = factValidation.status;
        }
        callbacks?.onPhaseCompleted?.('facts', factsStatus, factValidation);

        // ── Phase 8: AI Task Review ────────────────────────────────────
        checkAbort();
        let taskReview: TaskReviewResult | null;
        let reviewSkipReason: string | undefined;
        let reviewSkipKind: ValidationResult['reviewSkipKind'];
        if (skipPhases.includes('review')) {
          taskReview = null;
          reviewSkipReason = 'Skipped by profile configuration';
          reviewSkipKind = 'profile-skip';
        } else if (!tier1Pass || factsStatus === 'fail' || factsStatus === 'pending_human') {
          // Don't burn AI tokens reviewing code that doesn't build, lint, or
          // pass tests/facts — the agent will rewrite it on the next attempt.
          callbacks?.onPhaseStarted?.('review');
          taskReview = null;
          reviewSkipReason =
            factsStatus === 'pending_human'
              ? 'Skipped — required facts pending human decision'
              : factsStatus === 'fail'
                ? 'Skipped — required facts failed'
                : 'Skipped — earlier validation phases failed';
          reviewSkipKind = 'upstream-failed';
        } else {
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

          const reviewRun = await runTaskReview(containerManager, config, log, reviewContext);
          taskReview = reviewRun.result;
          reviewSkipReason = reviewRun.skipReason;
          if (taskReview === null && reviewRun.skipReason) {
            reviewSkipKind = classifyReviewSkipKind(reviewRun.skipReason);
          }
        }
        // Map 'uncertain' to 'pass' for the chip status — the detail view shows the full result.
        // Missing review output from a timeout/infra failure is a failed Review phase, not a skip.
        const reviewStatus: 'pass' | 'fail' | 'skip' =
          taskReview === null
            ? reviewSkipKind === 'review-failed' || reviewSkipKind === 'review-timeout'
              ? 'fail'
              : 'skip'
            : taskReview.status === 'fail'
              ? 'fail'
              : 'pass';
        callbacks?.onPhaseCompleted?.('review', reviewStatus, taskReview);

        // ── Phase 9: Overall result ──────────────────────────────────
        // Advisory Browser QA runs after the daemon has created/carry-forwarded
        // the PR. Keeping it out of `validate()` makes advisory evidence
        // nonblocking in both result semantics and scheduling.
        const pagesPass = pages.length === 0 || pages.every((p) => p.status === 'pass');
        const healthOk = healthResult.status === 'pass' || healthResult.status === 'skip';
        const smokeStatus =
          buildResult.status === 'pass' && healthOk && pagesPass
            ? ('pass' as const)
            : ('fail' as const);

        const factsFailed =
          factValidation !== null &&
          (factValidation.status === 'fail' || factValidation.status === 'pending_human');
        // Review is a validation gate. Explicit profile skips and no-change
        // short-circuits are non-blocking, but timeout/infra failures are not
        // allowed to merge unchecked.
        const isReviewBlocker =
          reviewSkipKind === 'review-failed' || reviewSkipKind === 'review-timeout';
        const overall =
          tier1Pass &&
          !factsFailed &&
          ((taskReview === null && !isReviewBlocker) || taskReview?.status === 'pass')
            ? ('pass' as const)
            : ('fail' as const);

        const duration = Date.now() - startTime;

        return {
          podId: config.podId,
          attempt: config.attempt,
          timestamp: new Date().toISOString(),
          validationSuite: config.validationSuite,
          setup: setupResult,
          smoke: {
            status: smokeStatus,
            build: buildResult,
            health: healthResult,
            pages,
          },
          test: testResult,
          lint: lintResult,
          sast: sastResult,
          factValidation,
          taskReview,
          advisoryBrowserQa: null,
          reviewSkipReason,
          reviewSkipKind,
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

    async runAdvisoryBrowserQa(
      config: ValidationEngineConfig,
      blockingResult: ValidationResult,
      onProgress?: (message: string) => void,
      signal?: AbortSignal,
      callbacks?: ValidationPhaseCallbacks,
    ): Promise<AdvisoryBrowserQaResult | null> {
      const skipPhases = config.skipPhases ?? [];

      function checkAbort(): void {
        if (signal?.aborted) throw new ValidationInterruptedError('Validation interrupted by user');
      }

      checkAbort();
      if (!config.advisoryBrowserQaEnabled || blockingResult.overall !== 'pass') {
        return null;
      }

      if (skipPhases.includes('advisory')) {
        const advisoryBrowserQa: AdvisoryBrowserQaResult = {
          status: 'skip',
          reasoning: 'profile-skip',
          observations: [],
          screenshots: [],
          durationMs: 0,
        };
        callbacks?.onPhaseCompleted?.('advisory', 'skip', advisoryBrowserQa);
        return advisoryBrowserQa;
      }

      if (shouldRunAdvisoryBrowserQa(config, blockingResult.smoke.health, true)) {
        callbacks?.onPhaseStarted?.('advisory');
        onProgress?.('Running advisory browser QA…');
        const advisoryBrowserQa = await runAdvisoryBrowserQa({
          podId: config.podId,
          task: config.task,
          baseUrl: config.previewUrl,
          contract: config.contract,
          reviewerModel: config.reviewerModel,
          reviewerProvider: config.reviewerProvider,
          reviewerProviderCredentials: config.reviewerProviderCredentials,
          containerManager,
          containerId: config.containerId,
          ...(config.reviewerExecEnv ? { reviewerExecEnv: config.reviewerExecEnv } : {}),
          hostBrowserRunner,
          screenshotStore,
          logger: log,
          onProgress,
        });
        checkAbort();
        callbacks?.onPhaseCompleted?.(
          'advisory',
          advisoryBrowserQa.status === 'fail' ? 'fail' : 'pass',
          advisoryBrowserQa,
        );
        return advisoryBrowserQa;
      }

      if (hasNoContractChecklist(config)) {
        callbacks?.onPhaseStarted?.('advisory');
        const advisoryBrowserQa: AdvisoryBrowserQaResult = {
          status: 'skip',
          reasoning: 'no-contract-checklist',
          observations: [],
          screenshots: [],
          durationMs: 0,
        };
        callbacks?.onPhaseCompleted?.('advisory', 'skip', advisoryBrowserQa);
        return advisoryBrowserQa;
      }

      return null;
    },
  };
}

/** Return a partial interrupted ValidationResult (phase-complete data preserved) */
function makeSetupFailedResult(
  config: ValidationEngineConfig,
  startTime: number,
  setupResult: import('@autopod/shared').SetupResult,
): ValidationResult {
  return {
    podId: config.podId,
    attempt: config.attempt,
    timestamp: new Date().toISOString(),
    validationSuite: config.validationSuite,
    setup: setupResult,
    smoke: {
      status: 'fail',
      build: { status: 'skip', output: '', duration: 0 },
      health: {
        status: 'skip',
        url: getHealthCheckUrl(config),
        responseCode: null,
        duration: 0,
      },
      pages: [],
    },
    test: { status: 'skip', duration: 0 },
    lint: { status: 'skip', output: '', duration: 0 },
    sast: { status: 'skip', output: '', duration: 0 },
    factValidation: { status: 'skip', results: [] },
    taskReview: null,
    reviewSkipReason: 'Skipped — validation setup failed',
    reviewSkipKind: null,
    overall: 'fail',
    duration: Date.now() - startTime,
  };
}

function makeInterruptedResult(
  config: ValidationEngineConfig,
  startTime: number,
  reason = 'Validation interrupted by user',
): ValidationResult {
  return {
    podId: config.podId,
    attempt: config.attempt,
    timestamp: new Date().toISOString(),
    validationSuite: config.validationSuite,
    smoke: {
      status: 'fail',
      build: { status: 'skip', output: '', duration: 0 },
      health: {
        status: 'fail',
        url: getHealthCheckUrl(config),
        responseCode: null,
        duration: 0,
      },
      pages: [],
    },
    test: { status: 'skip', duration: 0 },
    factValidation: { status: 'skip', results: [] },
    taskReview: null,
    reviewSkipReason: reason,
    reviewSkipKind: 'upstream-failed',
    overall: 'fail',
    duration: Date.now() - startTime,
  };
}

function hasNoContractChecklist(config: ValidationEngineConfig): boolean {
  return (
    (config.contract?.scenarios.length ?? 0) === 0 &&
    (config.contract?.humanReview.length ?? 0) === 0
  );
}

function shouldRunAdvisoryBrowserQa(
  config: ValidationEngineConfig,
  healthResult: HealthResult,
  blockingChecksGreen: boolean,
): boolean {
  return (
    config.advisoryBrowserQaEnabled === true &&
    config.hasWebUi !== false &&
    healthResult.status === 'pass' &&
    blockingChecksGreen &&
    !hasNoContractChecklist(config)
  );
}

function getHealthCheckUrl(config: ValidationEngineConfig): string {
  const base =
    config.webProbeMode === 'container'
      ? (config.containerBaseUrl ?? config.previewUrl)
      : config.previewUrl;
  return base + config.healthPath;
}

function isHealthyStatus(responseCode: number | null): boolean {
  return responseCode !== null && responseCode >= 200 && responseCode < 300;
}

/**
 * Poll the health URL every 5 seconds after the app passes its initial health check.
 * If the app becomes unreachable (2 consecutive failures), fires `onCrash` once.
 * Returns a stop function — call it when validation finishes.
 */
/** @internal Exported for testing. */
export function startAppStabilityMonitor(
  probe: string | (() => Promise<boolean>),
  onCrash: () => void,
): () => void {
  let stopped = false;
  let consecutiveFailures = 0;
  const POLL_INTERVAL_MS = 5_000;
  const FAILURE_THRESHOLD = 2;
  const probeOnce =
    typeof probe === 'string'
      ? async () => {
          const response = await fetch(probe, { signal: AbortSignal.timeout(3_000) });
          return response.status >= 200 && response.status < 300;
        }
      : probe;

  const poll = async () => {
    // Initial delay — give the app a moment to settle after health check
    await sleep(POLL_INTERVAL_MS);

    while (!stopped) {
      try {
        if (await probeOnce()) {
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

/**
 * Parse warning count from build output.
 *
 * Many toolchains (notably `dotnet build` with Roslyn analyzers) report warnings
 * in their output while still exiting 0 when project policy allows them. This
 * helper recognises common "succeeded with N warning(s)" summary patterns so
 * validation can surface the count as diagnostics without second-guessing the
 * build tool's pass/fail policy.
 *
 * Strategy:
 *   1. MSBuild's authoritative "Build succeeded with N warning(s)" trailing line
 *   2. Sum of per-project "succeeded with N warning(s)" lines (when no trailer)
 *   3. Per-line "path(line,col): warning CODE:" fallback for truncated output
 *
 * Returns 0 when nothing matches — the caller treats that as no detectable
 * warnings (not as confirmation that the build was clean).
 */
export function parseWarningCount(output: string): number {
  const buildSummary = output.match(/Build succeeded with (\d+) warning\(s\)/);
  if (buildSummary?.[1]) return Number(buildSummary[1]);

  const perProject = [...output.matchAll(/succeeded with (\d+) warning\(s\)/g)];
  if (perProject.length > 0) {
    return perProject.reduce((acc, m) => acc + Number(m[1] ?? 0), 0);
  }

  // Anchored on "path(line,col): warning CODE:" so a path that happens to
  // contain the substring "warning" doesn't trigger a false positive.
  const lineRegex = /^\s*\S+\([\d,]+\):\s*warning\s+[A-Z]+\d+:/gm;
  return (output.match(lineRegex) || []).length;
}

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
      [
        'sh',
        '-c',
        `find ${buildCwd} -path "*/node_modules/.bin/*" -empty -print 2>/dev/null | head -1`,
      ],
      { timeout: 5_000 },
    )
    .catch(() => null);
  if (stubCheck?.stdout?.trim()) {
    log?.info('0-byte .bin stubs found before build — running npm rebuild');
    await containerManager
      .execInContainer(
        config.containerId,
        [
          'sh',
          '-c',
          "find /workspace -path '*/node_modules/.bin/*' -empty -print 2>/dev/null | awk -F'/node_modules/' '{print $1}' | sort -u | while read -r dir; do [ -f \"$dir/package.json\" ] && (cd \"$dir\" && npm rebuild 2>&1); done",
        ],
        { timeout: 120_000, ...(config.extraExecEnv ? { env: config.extraExecEnv } : {}) },
      )
      .catch((err: unknown) =>
        log?.warn(
          { err },
          'pre-build npm rebuild failed — build may still encounter Permission denied errors',
        ),
      );
  }

  // Fix non-executable binaries (distinct from 0-byte stubs — files that exist but lack +x).
  // The agent may have installed packages during its run; npm doesn't always set execute bits
  // on native platform binaries (e.g. @esbuild/linux-arm64/bin/esbuild) on Docker Desktop for Mac.
  await containerManager
    .execInContainer(
      config.containerId,
      [
        'sh',
        '-c',
        `find ${buildCwd} \\( -path "*/node_modules/.bin/*" -o -path "*/node_modules/*/bin/*" \\) -type f -not -empty -not -perm /111 -exec chmod +x {} + 2>/dev/null || true`,
      ],
      { timeout: 10_000 },
    )
    .catch(() => null);

  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = await containerManager.execInContainer(
      config.containerId,
      wrapValidationExecCommand(config.buildCommand, config.extraExecEnv),
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
  const rawOutput = `${result.stdout}\n${result.stderr}`.trim();
  const status = result.exitCode === 0 ? ('pass' as const) : ('fail' as const);
  const warningCount = parseWarningCount(rawOutput);

  // Exit 137 from an in-container exec is overwhelmingly the kernel OOM killer
  // (SIGKILL). Combined with a bare trailing "Killed" line and no Node stack
  // trace, it's a near-certain memory exhaustion. Surface this clearly so the
  // failure points at memory headroom instead of looking like a generic build
  // bug. Common cause on Docker Desktop: the Linux VM's memory ceiling is
  // smaller than the container's requested limit, so the per-container cgroup
  // limit is fake headroom.
  const looksOomKilled = result.exitCode === 137 || /(^|\n)Killed\s*$/.test(rawOutput.slice(-200));
  let output = rawOutput;
  if (status === 'fail' && looksOomKilled) {
    const hint =
      'Build appears to have been OOM-killed (exit 137 / "Killed"). Raise the Docker Desktop VM memory (Settings → Resources), reduce concurrent pods, or increase profile.containerMemoryGb.';
    output = `${hint}\n\n--- build output ---\n${rawOutput}`;
    log?.warn(
      { exitCode: result.exitCode, duration },
      'build failed — OOM-killed (exit 137 / Killed)',
    );
  } else if (status === 'fail') {
    log?.warn({ exitCode: result.exitCode, duration }, 'build failed');
  } else if (warningCount > 0) {
    // The project owns warning policy (`TreatWarningsAsErrors`, `NoWarn`,
    // `WarningsNotAsErrors`, etc.). If those policies want a warning to fail
    // the build, the build command must exit non-zero; Autopod only records the
    // warning count here so diagnostics remain visible.
    log?.info({ warningCount, duration }, 'build passed with warnings');
  } else {
    log?.info({ duration }, 'build passed');
  }

  return {
    status,
    output: output.slice(0, 50_000), // Cap output size
    duration,
    warningCount,
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
      wrapValidationExecCommand(config.testCommand, config.extraExecEnv),
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

// ── Required facts phase ───────────────────────────────────────────────────

async function runFactValidation(
  containerManager: ContainerManager,
  config: ValidationEngineConfig,
  log?: Logger,
  hostBrowserRunner?: HostBrowserRunner,
): Promise<FactValidationResult> {
  const facts = config.contract?.requiredFacts ?? [];
  const factDeviationMap = new Map(
    (config.taskSummary?.factDeviations ?? []).map((d) => [d.factId, d] as const),
  );
  if (facts.length === 0) {
    log?.info('no required facts configured, skipping fact validation');
    return { status: 'skip', results: [] };
  }

  const cwd = config.buildWorkDir ? `/workspace/${config.buildWorkDir}` : '/workspace';
  const results: FactCheckResult[] = [];
  let hostBrowserFactDependenciesPrepared = false;

  for (const fact of facts) {
    const requestedDeviation = factDeviationMap.get(fact.id);
    if (requestedDeviation) {
      if (requestedDeviation.decision === 'rejected') {
        // Rejected by human: fall through and enforce original fact deterministically.
      } else if (requestedDeviation.decision === 'approved_waive') {
        results.push({
          factId: fact.id,
          proves: fact.proves,
          kind: fact.kind,
          artifactPath: normalizeContractPath(fact.artifact.path),
          command: fact.command,
          passed: true,
          status: 'waived',
          reasoning: `Fact deviation approved by human as waive. Reason: ${requestedDeviation.reason}.`,
        });
        continue;
      } else if (
        requestedDeviation.decision === 'approved_replace' &&
        requestedDeviation.replacement
      ) {
        const replacement = requestedDeviation.replacement;
        const replacementPath = normalizeContractPath(replacement.artifactPath);
        const replacementExists = await artifactExistsInContainer(
          containerManager,
          config,
          replacementPath,
          log,
        );
        const replacementChanged = artifactChangeSatisfied(
          config.diff,
          replacementPath,
          'modified',
        );
        const replacementCmd = await containerManager.execInContainer(
          config.containerId,
          ['sh', '-c', replacement.command],
          { cwd },
        );
        const replacementPass =
          replacementExists && replacementChanged && replacementCmd.exitCode === 0;
        results.push({
          factId: fact.id,
          proves: replacement.proves ?? fact.proves,
          kind: fact.kind,
          artifactPath: replacementPath,
          command: replacement.command,
          passed: replacementPass,
          status: replacementPass ? 'replaced' : 'fail',
          exitCode: replacementCmd.exitCode,
          reasoning: replacementPass
            ? `Fact deviation approved by human as replace. Replacement checks passed for ${replacementPath}.`
            : `Fact deviation approved as replace, but replacement checks failed for ${replacementPath}.`,
          stdout: replacementCmd.stdout.slice(0, 20_000),
          stderr: replacementCmd.stderr.slice(0, 20_000),
        });
        continue;
      }

      const requestedStatus = requestedDeviation.action === 'replace' ? 'replaced' : 'waived';
      const replacementDetail =
        requestedDeviation.action === 'replace' && requestedDeviation.replacement
          ? ` Requested replacement artifact "${requestedDeviation.replacement.artifactPath}" with command "${requestedDeviation.replacement.command}".`
          : '';
      results.push({
        factId: fact.id,
        proves: fact.proves,
        kind: fact.kind,
        artifactPath: normalizeContractPath(fact.artifact.path),
        command: fact.command,
        passed: false,
        status: 'pending_human',
        reasoning: `Fact deviation request is pending human decision. Requested action: ${requestedStatus}. Reason: ${requestedDeviation.reason}. Why impossible: ${requestedDeviation.whyImpossible}.${replacementDetail}`,
      });
      continue;
    }

    const artifactPath = normalizeContractPath(fact.artifact.path);
    const artifactChanged = artifactChangeSatisfied(
      config.diff,
      artifactPath,
      fact.artifact.change,
    );
    const artifactExists = await artifactExistsInContainer(
      containerManager,
      config,
      artifactPath,
      log,
    );
    const artifactHash = artifactExists
      ? await artifactHashInContainer(containerManager, config, artifactPath, log)
      : undefined;

    let commandResult: { stdout: string; stderr: string; exitCode: number } | null = null;
    let commandError: string | undefined;
    const commandStart = Date.now();
    try {
      if (fact.kind === 'browser-test') {
        commandResult = await runBrowserFactOnHost(
          fact.command,
          fact.id,
          config,
          hostBrowserRunner,
          log,
          !hostBrowserFactDependenciesPrepared,
        );
        hostBrowserFactDependenciesPrepared = true;
      } else {
        const factEnv = {
          ...(config.extraExecEnv ?? {}),
          AUTOPOD_FACT_EVIDENCE_DIR: `/workspace/.autopod/evidence/${fact.id}`,
          AUTOPOD_FACT_SCREENSHOT_PATH: `/workspace/.autopod/evidence/${fact.id}/screenshot.png`,
        };
        commandResult = await containerManager.execInContainer(
          config.containerId,
          wrapValidationExecCommand(fact.command, factEnv),
          {
            cwd,
            timeout: config.testTimeout ?? 600_000,
            env: factEnv,
          },
        );
      }
    } catch (err) {
      const partial = (err as { partialOutput?: string })?.partialOutput;
      commandError = err instanceof Error ? err.message : String(err);
      commandResult = {
        stdout: partial ?? '',
        stderr: commandError,
        exitCode: 124,
      };
    }
    const durationMs = Date.now() - commandStart;

    const commandPassed = commandResult.exitCode === 0;
    const attachments =
      fact.kind === 'browser-test' && config.worktreePath
        ? await collectHostFactAttachments(config.worktreePath, fact.id, log)
        : await collectFactAttachments(containerManager, config, fact.id, log);
    const passed = artifactExists && artifactChanged && commandPassed;
    const failedReasons = [
      artifactExists ? null : `artifact ${artifactPath} does not exist`,
      artifactChanged
        ? null
        : `artifact ${artifactPath} does not satisfy ${fact.artifact.change} requirement`,
      commandPassed ? null : `command exited ${commandResult.exitCode}`,
    ].filter((reason): reason is string => reason !== null);
    const unavailableReason = detectUnavailableFactCommand(commandResult);
    const browserInfrastructureReason =
      fact.kind === 'browser-test' ? detectBrowserFactInfrastructureFailure(commandResult) : null;
    const pendingHumanReason = unavailableReason ?? browserInfrastructureReason;
    const factStatus = passed ? 'pass' : pendingHumanReason ? 'pending_human' : 'fail';
    const executionNote =
      !passed && fact.kind === 'browser-test' && config.worktreePath
        ? ` Browser-test fact executed on daemon host worktree (${config.worktreePath}), not inside the agent container.`
        : '';
    const reasoning = passed
      ? `Fact ${fact.id} passed: ${artifactPath} exists, satisfies ${fact.artifact.change}, and command exited 0.`
      : pendingHumanReason
        ? `Fact ${fact.id} needs human decision: ${pendingHumanReason}`
        : `Fact ${fact.id} failed: ${failedReasons.join('; ')}.${executionNote}${commandError ? ` ${commandError}` : ''}`;

    results.push({
      factId: fact.id,
      proves: fact.proves,
      kind: fact.kind,
      artifactPath,
      command: fact.command,
      passed,
      status: factStatus,
      exitCode: commandResult.exitCode,
      durationMs,
      artifact: {
        path: artifactPath,
        change: fact.artifact.change,
        exists: artifactExists,
        changed: artifactChanged,
        ...(artifactHash ? { hash: artifactHash } : {}),
      },
      attachments,
      reasoning,
      stdout: commandResult.stdout.slice(0, 20_000),
      stderr: commandResult.stderr.slice(0, 20_000),
    });
  }

  const status = results.some((r) => r.status === 'pending_human')
    ? ('pending_human' as const)
    : results.every((r) => r.passed)
      ? ('pass' as const)
      : ('fail' as const);
  log?.info(
    { status, passed: results.filter((r) => r.passed).length, total: results.length },
    'fact validation complete',
  );
  return { status, results };
}

function detectUnavailableFactCommand(result: {
  stdout: string;
  stderr: string;
  exitCode: number;
}): string | null {
  if (result.exitCode !== 127) return null;

  const combined = `${result.stderr}\n${result.stdout}`;
  const shMatch = combined.match(/(?:^|\n)sh:\s*\d+:\s*([^\s:]+):\s*not found\b/i);
  const bashMatch = combined.match(
    /(?:^|\n)(?:bash|zsh):(?:\s*line\s*\d+:)?\s*([^\s:]+):\s*command not found\b/i,
  );
  const genericMatch = combined.match(/(?:^|\n)([A-Za-z0-9_.+/-]+):\s+(?:command\s+)?not found\b/i);
  const missingCommand = shMatch?.[1] ?? bashMatch?.[1] ?? genericMatch?.[1];

  if (!missingCommand) return null;

  return [
    `required fact command \`${missingCommand}\` is unavailable in the validation container`,
    '(exit 127). This is an environment/spec issue, not a code failure;',
    'install the toolchain, change the profile/template, or approve a waive/replace decision.',
  ].join(' ');
}

function detectBrowserFactInfrastructureFailure(result: {
  stdout: string;
  stderr: string;
  exitCode: number;
}): string | null {
  if (result.exitCode === 0) return null;

  const combined = `${result.stderr}\n${result.stdout}`;
  const normalized = combined.replace(/\s+/g, ' ').trim();
  const detail = normalized.length > 0 ? ` Diagnostic: ${normalized.slice(0, 700)}` : '';

  if (
    /Host Playwright is not available for browser-test fact execution/i.test(combined) ||
    /daemon was not wired with a host browser runner/i.test(combined)
  ) {
    return [
      'browser-test could not run in this validation environment because host Playwright is unavailable.',
      'This is an Autopod/browser infrastructure issue, not evidence that the app behavior failed.',
      'Refresh the validation browser environment or approve a waive/replace decision.',
      detail,
    ].join(' ');
  }

  if (/Host browser-test Playwright browser install failed/i.test(combined)) {
    return [
      'browser-test could not run in this validation environment because Playwright browser prewarm failed.',
      'This is an Autopod/browser-cache issue, not evidence that the app behavior failed.',
      'Refresh the validation browser cache or approve a waive/replace decision.',
      detail,
    ].join(' ');
  }

  if (
    /Executable doesn't exist at .*?(chromium|chrome|headless_shell)/i.test(combined) ||
    /chromium_headless_shell-\d+/i.test(combined) ||
    /Looks like Playwright(?: Test)? or Playwright was just installed or updated/i.test(combined) ||
    /Please run .*playwright install/i.test(combined) ||
    /browser (?:revision|build).*?(?:not found|missing|mismatch)/i.test(combined) ||
    /browser version mismatch/i.test(combined) ||
    /needs browser \d+.*only (?:have|has) \d+ installed/i.test(combined)
  ) {
    return [
      'browser-test could not run in this validation environment: Playwright browser executable is missing or mismatched.',
      'This usually means the project Playwright package expects a different cached browser build than Autopod has installed.',
      'Refresh the validation image/browser cache or approve a waive/replace decision.',
      detail,
    ].join(' ');
  }

  if (
    /Denied egress: .*?(cdn\.playwright\.dev|playwright\.download\.prss\.microsoft\.com)/i.test(
      combined,
    ) ||
    /firewall_denied/i.test(combined) ||
    /Download failed:.*?(cdn\.playwright\.dev|playwright\.download\.prss\.microsoft\.com)/i.test(
      combined,
    ) ||
    /playwright install.*?(cdn\.playwright\.dev|playwright\.download\.prss\.microsoft\.com)/i.test(
      combined,
    ) ||
    /Network access for downloads is restricted/i.test(combined)
  ) {
    return [
      'browser-test could not run in this validation environment because Playwright browser download was blocked.',
      'This is an Autopod egress/browser-cache issue, not evidence that the app behavior failed.',
      'Prewarm the required browser build in the validation image or approve a waive/replace decision.',
      detail,
    ].join(' ');
  }

  if (
    /ERR_CONNECTION_CLOSED/i.test(combined) &&
    /\b(page\.goto|browserType\.launch|chromium|playwright|CDP|DevTools protocol|Target page|browser has been closed)\b/i.test(
      combined,
    )
  ) {
    return [
      'browser-test could not run in this validation environment because the Playwright browser connection closed before assertions completed.',
      'This often indicates browser/CDP drift in the validation environment rather than an app assertion failure.',
      'Refresh the validation browser environment or approve a waive/replace decision.',
      detail,
    ].join(' ');
  }

  return null;
}

async function runBrowserFactOnHost(
  command: string,
  factId: string,
  config: ValidationEngineConfig,
  hostBrowserRunner: HostBrowserRunner | undefined,
  log?: Logger,
  prepareDependencies = true,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (!hostBrowserRunner) {
    throw new Error(
      'Host Playwright is not available for browser-test fact execution: daemon was not wired with a host browser runner',
    );
  }
  const availability = await hostBrowserRunner.getAvailability();
  if (!availability.available) {
    const details = [
      availability.reason,
      availability.playwrightPackagePath
        ? `playwright=${availability.playwrightPackagePath}`
        : 'playwright=<not resolved>',
      availability.playwrightCwd ? `cwd=${availability.playwrightCwd}` : 'cwd=<not resolved>',
      availability.exitCode !== undefined ? `exit=${availability.exitCode}` : null,
      availability.stderr ? `stderr=${availability.stderr.slice(0, 500)}` : null,
      availability.cached ? 'cached=true' : 'cached=false',
    ].filter((detail): detail is string => detail !== null);
    throw new Error(
      `Host Playwright is not available for browser-test fact execution: ${details.join('; ')}`,
    );
  }
  if (!config.worktreePath) {
    throw new Error('Host worktree path is required for browser-test fact execution');
  }

  const evidenceDir = path.join(config.worktreePath, '.autopod', 'evidence', factId);
  await mkdir(evidenceDir, { recursive: true });

  const env = {
    ...process.env,
    ...(config.extraExecEnv ?? {}),
    AUTOPOD_PREVIEW_URL: config.previewUrl,
    AUTOPOD_CONTAINER_BASE_URL: config.containerBaseUrl ?? config.previewUrl,
    AUTOPOD_FACT_EVIDENCE_DIR: evidenceDir,
    AUTOPOD_FACT_SCREENSHOT_PATH: path.join(evidenceDir, 'screenshot.png'),
  };
  log?.info({ command, worktreePath: config.worktreePath }, 'running browser-test fact on host');
  try {
    if (prepareDependencies) {
      await ensureHostBrowserFactDependencies(
        config.worktreePath,
        command,
        config.testTimeout ?? 600_000,
        log,
      );
      await prewarmHostBrowserFactBrowsers(config.worktreePath, config.testTimeout ?? 600_000, log);
    }
    const result = await execFileAsync('sh', ['-c', command], {
      cwd: config.worktreePath,
      env,
      timeout: config.testTimeout ?? 600_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return {
      stdout: String(result.stdout),
      stderr: String(result.stderr),
      exitCode: 0,
    };
  } catch (err) {
    const execErr = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
    };
    const exitCode = typeof execErr.code === 'number' ? execErr.code : execErr.killed ? 124 : 1;
    return {
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? (err instanceof Error ? err.message : String(err)),
      exitCode,
    };
  }
}

async function prewarmHostBrowserFactBrowsers(
  worktreePath: string,
  timeout: number,
  log?: Logger,
): Promise<void> {
  const playwrightBin = path.join(worktreePath, 'node_modules', '.bin', 'playwright');
  if (!(await pathExists(playwrightBin))) return;

  const fullCommand = `${shellQuote(playwrightBin)} install chromium`;
  log?.info(
    { worktreePath, command: fullCommand },
    'prewarming host browser-test Playwright browser cache',
  );

  try {
    await execFileAsync('sh', ['-c', fullCommand], {
      cwd: worktreePath,
      env: process.env,
      timeout,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (err) {
    const execErr = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const stdout = execErr.stdout ?? '';
    const stderr = execErr.stderr ?? '';
    const exitCode = typeof execErr.code === 'number' ? execErr.code : 1;
    const detail = formatCommandDiagnostic(stdout, stderr, 4_000);
    const enhanced = new Error(
      [
        `Host browser-test Playwright browser install failed (exit ${exitCode}) before running required fact command.`,
        `Install command: ${fullCommand}`,
        detail ? `\n${detail}` : null,
      ]
        .filter((part): part is string => part !== null)
        .join('\n'),
    ) as Error & { stdout?: string; stderr?: string; code?: number };
    enhanced.stdout = stdout;
    enhanced.stderr = [enhanced.message, stderr].filter(Boolean).join('\n\n');
    enhanced.code = exitCode;
    throw enhanced;
  }
}

async function ensureHostBrowserFactDependencies(
  worktreePath: string,
  command: string,
  timeout: number,
  log?: Logger,
): Promise<void> {
  if (!looksLikePackageManagedBrowserFact(command)) return;

  const packageJsonPath = path.join(worktreePath, 'package.json');
  const packageJson = await readPackageJsonManifest(packageJsonPath);
  if (!packageJson) return;

  const nodeModulesPath = path.join(worktreePath, 'node_modules');
  if (await pathExists(nodeModulesPath)) {
    const missingPackages = await missingDeclaredHostPackages(worktreePath, packageJson);
    if (missingPackages.length === 0) return;
    log?.info(
      { worktreePath, missingPackages: missingPackages.slice(0, 20) },
      'host browser-test dependencies are incomplete',
    );
  }

  const fullCommand = await resolveHostDependencyInstallCommand(worktreePath);

  log?.info(
    { worktreePath, command: fullCommand },
    'installing host dependencies before browser-test fact execution',
  );

  try {
    await execFileAsync('sh', ['-c', fullCommand], {
      cwd: worktreePath,
      env: process.env,
      timeout,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (err) {
    const execErr = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const stdout = execErr.stdout ?? '';
    const stderr = execErr.stderr ?? '';
    const exitCode = typeof execErr.code === 'number' ? execErr.code : 1;
    const detail = formatCommandDiagnostic(stdout, stderr, 4_000);
    const enhanced = new Error(
      [
        `Host browser-test dependency install failed (exit ${exitCode}) before running required fact command.`,
        `Install command: ${fullCommand}`,
        detail ? `\n${detail}` : null,
      ]
        .filter((part): part is string => part !== null)
        .join('\n'),
    ) as Error & { stdout?: string; stderr?: string; code?: number };
    enhanced.stdout = stdout;
    enhanced.stderr = stderr || enhanced.message;
    enhanced.code = exitCode;
    throw enhanced;
  }
}

function looksLikePackageManagedBrowserFact(command: string): boolean {
  return /\b(npm|npx|pnpm|yarn|playwright)\b/.test(command);
}

async function resolveHostDependencyInstallCommand(worktreePath: string): Promise<string> {
  if (
    (await pathExists(path.join(worktreePath, 'package-lock.json'))) ||
    (await pathExists(path.join(worktreePath, 'npm-shrinkwrap.json')))
  ) {
    return 'npm ci --include=dev';
  }
  if (await pathExists(path.join(worktreePath, 'pnpm-lock.yaml'))) {
    return 'npx pnpm install --frozen-lockfile --prod=false';
  }
  if (await pathExists(path.join(worktreePath, 'yarn.lock'))) {
    return 'corepack yarn install --immutable';
  }
  return 'npm install --include=dev --package-lock=false';
}

async function readPackageJsonManifest(
  packageJsonPath: string,
): Promise<PackageJsonManifest | null> {
  try {
    const text = await readFile(packageJsonPath, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return {};
    return {
      scripts: readStringRecordField(parsed, 'scripts'),
      dependencies: readStringRecordField(parsed, 'dependencies'),
      devDependencies: readStringRecordField(parsed, 'devDependencies'),
    };
  } catch {
    return null;
  }
}

function readStringRecordField(
  record: Record<string, unknown>,
  field: string,
): Record<string, string> | undefined {
  const value = record[field];
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => {
    const [, version] = entry;
    return typeof version === 'string';
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function missingDeclaredHostPackages(
  worktreePath: string,
  packageJson: PackageJsonManifest,
): Promise<string[]> {
  const packageNames = new Set([
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ]);
  const missing: string[] = [];
  for (const packageName of packageNames) {
    if (!(await hostPackageExists(worktreePath, packageName))) {
      missing.push(packageName);
    }
  }
  return missing;
}

async function hostPackageExists(worktreePath: string, packageName: string): Promise<boolean> {
  const packagePath = packageNameToNodeModulesPath(packageName);
  if (!packagePath) return false;
  return pathExists(path.join(worktreePath, 'node_modules', ...packagePath, 'package.json'));
}

function packageNameToNodeModulesPath(packageName: string): string[] | null {
  if (/^@[a-z0-9._~-]+\/[a-z0-9._~-]+$/i.test(packageName)) {
    return packageName.split('/');
  }
  if (/^[a-z0-9._~-]+$/i.test(packageName)) {
    return [packageName];
  }
  return null;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatCommandDiagnostic(stdout: string, stderr: string, limit: number): string {
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();
  if (trimmedStdout && trimmedStderr) {
    return [`stderr:\n${trimmedStderr}`, `stdout:\n${trimmedStdout}`].join('\n\n').slice(0, limit);
  }
  return (trimmedStderr || trimmedStdout).slice(0, limit);
}

async function artifactExistsInContainer(
  containerManager: ContainerManager,
  config: ValidationEngineConfig,
  artifactPath: string,
  log?: Logger,
): Promise<boolean> {
  try {
    const result = await containerManager.execInContainer(
      config.containerId,
      ['sh', '-c', `test -e ${shellQuote(`/workspace/${artifactPath}`)}`],
      { cwd: '/workspace', timeout: 10_000 },
    );
    return result.exitCode === 0;
  } catch (err) {
    log?.warn({ err, artifactPath }, 'required fact artifact existence check failed');
    return false;
  }
}

async function collectFactAttachments(
  containerManager: ContainerManager,
  config: ValidationEngineConfig,
  factId: string,
  log?: Logger,
): Promise<FactCheckResult['attachments']> {
  try {
    const evidenceDir = `.autopod/evidence/${factId}`;
    const result = await containerManager.execInContainer(
      config.containerId,
      [
        'sh',
        '-c',
        `if [ -d ${shellQuote(`/workspace/${evidenceDir}`)} ]; then find ${shellQuote(`/workspace/${evidenceDir}`)} -type f | sed 's#^/workspace/##' | head -100; fi`,
      ],
      { cwd: '/workspace', timeout: 10_000 },
    );
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((path) => ({ kind: attachmentKindForPath(path), path }));
  } catch (err) {
    log?.warn({ err, factId }, 'required fact attachment collection failed');
    return [];
  }
}

async function collectHostFactAttachments(
  worktreePath: string,
  factId: string,
  log?: Logger,
): Promise<FactCheckResult['attachments']> {
  const evidenceDir = path.join(worktreePath, '.autopod', 'evidence', factId);
  const root = path.resolve(worktreePath);
  const attachments: NonNullable<FactCheckResult['attachments']> = [];

  async function walk(dir: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const rel = path.relative(root, fullPath);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      attachments.push({ kind: attachmentKindForPath(rel), path: rel });
      if (attachments.length >= 100) return;
    }
  }

  try {
    await walk(evidenceDir);
  } catch (err) {
    log?.warn({ err, factId }, 'required fact host attachment collection failed');
  }

  return attachments;
}

function attachmentKindForPath(
  path: string,
): NonNullable<FactCheckResult['attachments']>[number]['kind'] {
  const lower = path.toLowerCase();
  if (
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.webp')
  ) {
    return 'screenshot';
  }
  if (lower.endsWith('.zip')) return 'trace';
  if (lower.endsWith('.webm') || lower.endsWith('.mp4')) return 'video';
  if (lower.endsWith('.xml') || lower.endsWith('.json') || lower.endsWith('.html')) return 'report';
  if (lower.endsWith('.log') || lower.endsWith('.txt')) return 'log';
  return 'artifact';
}

async function artifactHashInContainer(
  containerManager: ContainerManager,
  config: ValidationEngineConfig,
  artifactPath: string,
  log?: Logger,
): Promise<string | undefined> {
  try {
    const quoted = shellQuote(`/workspace/${artifactPath}`);
    const result = await containerManager.execInContainer(
      config.containerId,
      [
        'sh',
        '-c',
        `if command -v sha256sum >/dev/null 2>&1; then sha256sum ${quoted} | awk '{print $1}'; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 ${quoted} | awk '{print $1}'; fi`,
      ],
      { cwd: '/workspace', timeout: 10_000 },
    );
    const hash = result.stdout.trim().split(/\s+/)[0];
    return result.exitCode === 0 && hash ? hash : undefined;
  } catch (err) {
    log?.warn({ err, artifactPath }, 'required fact artifact hash check failed');
    return undefined;
  }
}

function normalizeContractPath(path: string): string {
  return path.replace(/^\/+/, '').replace(/^\.\//, '');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function artifactChangeSatisfied(
  diff: string,
  path: string,
  change: 'create' | 'update' | 'touch',
): boolean {
  if (change === 'touch') return true;
  const normalized = normalizeContractPath(path);
  const entries = parseDiffEntries(diff).filter(
    (entry) => entry.path === normalized || entry.path.startsWith(`${normalized}/`),
  );
  if (change === 'create') return entries.some((entry) => entry.created);
  return entries.length > 0;
}

function parseDiffEntries(diff: string): Array<{ path: string; created: boolean }> {
  const entries: Array<{ path: string; created: boolean }> = [];
  let current: { path: string; created: boolean } | null = null;
  for (const line of diff.split('\n')) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (match) {
      current = { path: normalizeContractPath(match[2] ?? match[1] ?? ''), created: false };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    if (line === 'new file mode' || line.startsWith('new file mode ') || line === '--- /dev/null') {
      current.created = true;
    }
  }
  return entries;
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
      wrapValidationExecCommand(config.lintCommand, config.extraExecEnv),
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
      wrapValidationExecCommand(config.sastCommand, config.extraExecEnv),
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

interface HealthProbeResult {
  responseCode: number | null;
  responseBody?: string;
  error?: string;
}

async function probeHealthEndpoint(
  containerManager: ContainerManager,
  config: ValidationEngineConfig,
  timeoutMs: number,
): Promise<HealthProbeResult> {
  const url = getHealthCheckUrl(config);
  if (config.webProbeMode === 'container') {
    return probeHealthEndpointInContainer(containerManager, config.containerId, url, timeoutMs);
  }

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const rawBody = isHealthyStatus(response.status) ? await response.text().catch(() => '') : '';
    return {
      responseCode: response.status,
      responseBody: rawBody.slice(0, 2_000) || undefined,
    };
  } catch (err) {
    return { responseCode: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function probeHealthEndpointInContainer(
  containerManager: ContainerManager,
  containerId: string,
  url: string,
  timeoutMs: number,
): Promise<HealthProbeResult> {
  const curlTimeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  const bodyPath = `/tmp/autopod-health-body-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const statusPath = `${bodyPath}.status`;
  const errorPath = `${bodyPath}.error`;
  const script = [
    `body=${shellQuote(bodyPath)}`,
    `status=${shellQuote(statusPath)}`,
    `err=${shellQuote(errorPath)}`,
    `curl -sS -L -m ${curlTimeoutSeconds} -o "$body" -w '%{http_code}' ${shellQuote(
      url,
    )} > "$status" 2> "$err"`,
    'rc=$?',
    "printf '__AUTOPOD_STATUS__'",
    'cat "$status" 2>/dev/null || printf 000',
    "printf '\\n__AUTOPOD_BODY__\\n'",
    'head -c 2000 "$body" 2>/dev/null || true',
    "printf '\\n__AUTOPOD_ERROR__\\n'",
    'head -c 1000 "$err" 2>/dev/null || true',
    'rm -f "$body" "$status" "$err"',
    'exit "$rc"',
  ].join('\n');

  try {
    const result = await containerManager.execInContainer(containerId, ['sh', '-c', script], {
      cwd: '/workspace',
      timeout: timeoutMs + 2_000,
    });
    const statusMatch = result.stdout.match(/__AUTOPOD_STATUS__(\d{3})/);
    const rawStatus = statusMatch?.[1] ?? null;
    const responseCode = rawStatus && rawStatus !== '000' ? Number(rawStatus) : null;
    const responseBody = extractMarkerSection(
      result.stdout,
      '__AUTOPOD_BODY__',
      '__AUTOPOD_ERROR__',
    );
    const curlError = extractMarkerSection(result.stdout, '__AUTOPOD_ERROR__');
    const error = [curlError, result.stderr].filter(Boolean).join('\n').trim() || undefined;

    return {
      responseCode,
      responseBody: isHealthyStatus(responseCode)
        ? responseBody.slice(0, 2_000) || undefined
        : undefined,
      error: result.exitCode === 0 ? undefined : error,
    };
  } catch (err) {
    return { responseCode: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function extractMarkerSection(stdout: string, startMarker: string, endMarker?: string): string {
  const start = stdout.indexOf(startMarker);
  if (start === -1) return '';
  const contentStart = start + startMarker.length;
  const end = endMarker ? stdout.indexOf(endMarker, contentStart) : -1;
  return stdout.slice(contentStart, end === -1 ? undefined : end).trim();
}

/** @internal Exported for testing. */
export async function runHealthCheck(
  containerManager: ContainerManager,
  config: ValidationEngineConfig,
  log?: Logger,
) {
  if (!config.startCommand) {
    log?.info('no start command configured, skipping health check');
    return {
      status: 'pass' as const,
      url: getHealthCheckUrl(config),
      responseCode: null,
      duration: 0,
    };
  }

  const healthStart = Date.now();
  const url = getHealthCheckUrl(config);
  const timeoutMs = config.healthTimeout * 1_000;

  log?.info(
    { startCommand: config.startCommand, url, timeoutMs, probeMode: config.webProbeMode ?? 'host' },
    'starting app for health check',
  );

  // Start the app under the supervisor (never-give-up restarter) so crashes
  // during the health-poll window and later browser checks are recovered
  // automatically. The supervisor writes to /tmp/autopod-start.log (same path
  // the old fire-and-forget used), so all existing log-tailing code is unaffected.
  const startLogPath = '/tmp/autopod-start.log';
  const startCwd = config.buildWorkDir ? `/workspace/${config.buildWorkDir}` : '/workspace';
  containerManager
    .execInContainer(
      config.containerId,
      ['sh', '-c', buildSupervisorCommand(config.startCommand)],
      { cwd: startCwd },
    )
    .catch((err) => {
      log?.warn(
        { err },
        'supervisor start command errored (may be expected for long-running processes)',
      );
    });

  // Poll for health — accept any 2xx response (200, 201, 204, etc.)
  const pollIntervalMs = 2_000;
  let lastResponseCode: number | null = null;

  while (Date.now() - healthStart < timeoutMs) {
    const probe = await probeHealthEndpoint(containerManager, config, 5_000);
    lastResponseCode = probe.responseCode;

    if (isHealthyStatus(probe.responseCode)) {
      const duration = Date.now() - healthStart;
      log?.info({ url, status: probe.responseCode, duration }, 'health check passed');
      return {
        status: 'pass' as const,
        url,
        responseCode: probe.responseCode,
        duration,
        responseBody: probe.responseBody,
      };
    }

    if (probe.responseCode !== null) {
      log?.debug({ url, status: probe.responseCode }, 'health check got non-2xx, retrying');
    } else {
      log?.debug({ url, error: probe.error }, 'health check probe failed, retrying');
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
  if (
    config.webProbeMode !== 'container' &&
    hostBrowserRunner &&
    (await hostBrowserRunner.isAvailable())
  ) {
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
): string {
  const contract = config.contract;
  const diffReviewCriteria =
    contract?.humanReview.map(
      (item) =>
        `[human_review:${item.id}] covers ${item.covers.join(', ')} — ${item.criterion} Reason: ${item.reason}`,
    ) ?? [];
  const hasRequirements = diffReviewCriteria.length > 0;

  const noneSection =
    diffReviewCriteria.length > 0
      ? `\n## REQUIREMENTS — DIFF VERIFICATION REQUIRED\nThe following requirements cannot be reduced to the deterministic fact commands alone. YOU ARE THE ONLY CHECK. Examine the diff carefully and assess each one:\n${diffReviewCriteria.map((criterion, i) => `${i + 1}. ${criterion}`).join('\n')}\n\nFor each requirement above include it in "requirementsCheck" with:\n- met=true  — diff clearly implements this\n- met=false — implementation is absent or clearly wrong\n\nBenefit of the doubt: if the diff is ambiguous or you can't confirm, default to met=true. Only fail when you have clear evidence of absence or incorrectness.\n`
      : '';

  const contractSection = contract
    ? `\n## EXECUTABLE CONTRACT\n\nTitle: ${contract.title}\n\nScenarios:\n${contract.scenarios
        .map(
          (scenario) =>
            `- ${scenario.id}\n  Given: ${scenario.given.join(' / ')}\n  When: ${scenario.when.join(' / ')}\n  Then: ${scenario.then.join(' / ')}`,
        )
        .join('\n')}\n\nRequired facts already executed by the validator:\n${
        contract.requiredFacts
          .map(
            (fact) =>
              `- ${fact.id} proves ${fact.proves.join(', ')} via ${fact.artifact.change} ${fact.artifact.path}: \`${fact.command}\``,
          )
          .join('\n') || '- none'
      }\n\nHuman review items:\n${
        contract.humanReview
          .map((item) => `- ${item.id} covers ${item.covers.join(', ')}: ${item.criterion}`)
          .join('\n') || '- none'
      }\n`
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
      }\n${
        config.taskSummary.factEvidence?.length
          ? `\nAgent-reported fact evidence:\n${config.taskSummary.factEvidence
              .map(
                (evidence) =>
                  `- ${evidence.factId}: ${evidence.result} via \`${evidence.command}\` (${evidence.artifactPath})${evidence.notes ? ` — ${evidence.notes}` : ''}`,
              )
              .join('\n')}\n`
          : ''
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
- Untracked files (\`??\` in git status) are NOT part of this PR. They are leftover worktree state from build artifacts, tooling, or prior pod runs. Evaluate ONLY the changes shown in the DIFF section — do not flag, cite, or read untracked files unless investigating a \`.gitignore\` violation explicitly listed under Warnings.
- HARD RULE — every issue you raise MUST cite a file path that appears as a header in the DIFF section above (\`+++ b/<path>\` or \`--- a/<path>\`). If a file is not in the DIFF, you may Read it for CONTEXT only — never to flag a new issue in it. Findings citing only paths outside the diff are automatically discarded by the harness; including them wastes the cycle.
- Use the CODEBASE CONTEXT section (if present) to verify claims made in the diff. Auto-detected warnings are high-confidence signals — investigate them seriously.
${repoRulesSection}
## TASK

${config.task}
${contractSection}${noneSection}${planSection}${taskSummarySection}${briefScopeSection}
${commitLogSection}${contextSection}## DIFF

${config.diff}
${overridesSection}
## INSTRUCTIONS

${
  diffReviewCriteria.length > 0
    ? `### Step 1: Requirements check

For each item in the "REQUIREMENTS — DIFF VERIFICATION REQUIRED" section above, examine the diff carefully and assess whether it is implemented. These are YOUR responsibility because they require judgement beyond deterministic command execution.

- met=true  — diff clearly implements this criterion
- met=false — implementation is absent or clearly wrong
- Benefit of the doubt: if the diff is ambiguous or you can't tell, default to met=true. Only fail when you have clear evidence of absence or incorrectness.
- Add a brief note explaining your assessment.

Do NOT include required fact commands in requirementsCheck.

`
    : ''
}${
  taskSummarySection
    ? `### ${hasRequirements ? 'Step 2' : 'Step 1'}: Deviation assessment

Compare the ORIGINAL PLAN (if provided) with the AGENT TASK SUMMARY and the DIFF:

1. For each deviation the agent reported: assess whether the reasoning is justified given the diff.
   - "justified": the diff confirms the deviation was necessary or beneficial
   - "questionable": the reasoning is unclear or the diff doesn't confirm it
   - "unjustified": the deviation appears to have degraded quality without good reason
   - If a deviation describes a hard external constraint (missing env/tooling/access), treat it as justified unless the diff clearly contradicts that claim.

2. Look for undisclosed deviations: things in the diff that diverge from the plan but were NOT reported.
   - Only flag meaningful gaps (e.g., a planned step that was entirely skipped, or a wholly different approach taken)
   - Do NOT flag minor implementation details that naturally evolve during development
   - Do NOT duplicate disclosed deviations as "undisclosed" just because wording differs.

Transparency is rewarded: a disclosed deviation with sound reasoning should not negatively affect the status.
Use deviations to calibrate trust and follow-up questions, not to punish honest reporting.
An undisclosed deviation that the diff reveals IS a negative signal.

`
    : ''
}### ${hasRequirements ? (taskSummarySection ? 'Step 3' : 'Step 2') : taskSummarySection ? 'Step 2' : 'Step 1'}: Code review

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
- Could this be intentional per the task description or contract?
- Does the existing codebase use similar patterns?
- Is this medium/high severity, not just a nit?
- Would I want this feedback if I were the author?

Drop any issue that fails these checks.

## RESPONSE FORMAT

Respond ONLY with a JSON object — no markdown fences, no extra text:

{
  "status": "pass" | "fail" | "uncertain",
  "reasoning": "one or two sentence summary of the overall assessment",
  ${diffReviewCriteria.length > 0 ? '"requirementsCheck": [\n    // Include ONLY the "DIFF VERIFICATION REQUIRED" requirements. Do NOT include required facts.\n    { "criterion": "...", "met": true|false, "note": "optional" }\n  ],\n  ' : ''}${taskSummarySection ? '"deviationsAssessment": {\n    "disclosedDeviations": [{ "step": "...", "reasoning": "...", "verdict": "justified"|"questionable"|"unjustified" }],\n    "undisclosedDeviations": ["description of gap between plan and diff that was not reported"]\n  },\n  ' : ''}"issues": ["[SEVERITY] short description — each entry MUST be a plain string, not an object. Format: \\"[HIGH] Missing null check in foo()\\". Allowed severities: MEDIUM, HIGH, CRITICAL. Omit anything below medium."]
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

  const status = ctx.gitStatusSummary;
  if (status.clean) {
    parts.push('### Repository Status\n');
    parts.push('Working tree clean (all changes committed).');
    parts.push('');
  } else if (status.inPr.length > 0 || status.untrackedNotInPr.length > 0) {
    parts.push('### Repository Status\n');

    if (status.inPr.length > 0) {
      parts.push(`#### Files in this PR (uncommitted, ${status.inPr.length} file(s))\n`);
      const cappedInPr = status.inPr.slice(0, 50);
      for (const line of cappedInPr) {
        parts.push(`  ${line}`);
      }
      if (status.inPr.length > 50) {
        parts.push(`  ... and ${status.inPr.length - 50} more`);
      }
      parts.push('');
    }

    if (status.untrackedNotInPr.length > 0) {
      parts.push(
        `#### Files in the worktree that are NOT part of this PR — DO NOT FLAG (${status.untrackedNotInPr.length} file(s))\n`,
      );
      parts.push(
        'These untracked files are leftover worktree state from build artifacts, tooling, or prior pod runs. ' +
          'They are NOT part of the submission. Do NOT cite them, read them, or flag them as undisclosed scope creep. ' +
          'The only legitimate reason to investigate one is if it is explicitly listed under Warnings as a `.gitignore` violation.',
      );
      parts.push('');
      const cappedUntracked = status.untrackedNotInPr.slice(0, 20);
      for (const line of cappedUntracked) {
        parts.push(`  ${line}`);
      }
      if (status.untrackedNotInPr.length > 20) {
        parts.push(`  ... and ${status.untrackedNotInPr.length - 20} more`);
      }
      parts.push('');
    }
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
  containerManager: ContainerManager,
  config: ValidationEngineConfig,
  log?: Logger,
  reviewContext?: ReviewContext,
): Promise<{
  result: TaskReviewResult | null;
  skipReason?: string;
  tokenUsage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
}> {
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
  const prompt = buildReviewPrompt(config, reviewContext);
  const reviewTimeout = config.reviewTimeout ?? 300_000;
  const reviewDepth = config.reviewDepth ?? 'auto';
  const reviewRunner = resolveReviewRunner(config);
  if (reviewRunner === 'unsupported') {
    return {
      result: null,
      skipReason: `Review failed: provider ${config.reviewerProvider} is not supported by the validation reviewer`,
    };
  }

  // Tier 1 (single-shot) is useless when the diff is truncated — the model
  // can't see all changed files and will either fabricate findings or skip.
  // Skip straight to Tier 2 (tool-use) where it can read files on demand.
  if (reviewRunner === 'claude' && diffIsTruncated && !config.worktreePath) {
    return {
      result: null,
      skipReason: 'Diff is truncated and no worktree available for tool-use review',
    };
  }

  try {
    let tier1Parsed: ReturnType<typeof parseReviewJson> = null;
    let tier1TokenUsage:
      | { inputTokens: number; outputTokens: number; cachedInputTokens?: number }
      | undefined;

    if (!diffIsTruncated || reviewRunner === 'codex') {
      // Reuse the agent's pre-submit verdict when it applies to the same diff
      // bytes and was a clean pass. Saves ~30s–5min of Tier 1 work on diffs
      // the reviewer model already opined on.
      const cached = pickCachedPreSubmit(config);
      if (cached) {
        tier1Parsed = cached;
        log?.info(
          { issueCount: cached.issues.length },
          'Tier 1 task review: reusing cached pre-submit verdict (diff unchanged)',
        );
      } else {
        // ── Tier 1: Single-shot review with enriched context ──────────────
        let stdout: string;
        if (reviewRunner === 'codex') {
          const codexReview = await runCodexReview({
            podId: config.podId,
            attempt: config.attempt,
            containerId: config.containerId,
            containerManager,
            model: config.reviewerModel,
            prompt,
            timeout: reviewTimeout,
            ...(config.reviewerExecEnv ? { env: config.reviewerExecEnv } : {}),
          });
          stdout = codexReview.stdout;
          tier1TokenUsage = codexReview.tokenUsage;
        } else {
          const claudeReview = await runClaudeCli({
            model: config.reviewerModel,
            input: prompt,
            timeout: reviewTimeout,
            outputFormat: 'json',
          });
          stdout = claudeReview.stdout;
          tier1TokenUsage = claudeReview.tokenUsage;
        }

        tier1Parsed = applyDiffFilterToParsed(
          enforceRequirementsStatus(parseReviewJson(stdout.trim())),
          config.diff,
          log,
          1,
        );
        if (!tier1Parsed) {
          log?.warn({ rawOutput: stdout.slice(0, 500) }, 'failed to parse task review response');
          return { result: null, skipReason: 'Failed to parse Tier 1 review response' };
        }
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
      reviewRunner === 'claude' &&
      (diffIsTruncated ||
        (reviewDepth === 'deep' && !!config.worktreePath) ||
        (tier1Parsed?.status === 'uncertain' &&
          reviewDepth !== 'standard' &&
          !!config.worktreePath));

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
          tokenUsage: tier1TokenUsage,
        },
        tokenUsage: tier1TokenUsage,
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
            tokenUsage: tier1TokenUsage,
          },
          tokenUsage: tier1TokenUsage,
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

      const tier2Parsed = applyDiffFilterToParsed(
        enforceRequirementsStatus(parseReviewJson(tier2Result.stdout.trim())),
        config.diff,
        log,
        2,
      );
      const tier2TokenUsage = tier2Result.tokenUsage;
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
            tokenUsage: tier2TokenUsage,
          },
          tokenUsage: tier2TokenUsage,
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

          const tier3Parsed = applyDiffFilterToParsed(
            enforceRequirementsStatus(parseReviewJson(tier3Result.stdout.trim())),
            config.diff,
            log,
            3,
          );
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
          tokenUsage: tier2TokenUsage,
        },
        tokenUsage: tier2TokenUsage,
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
          tokenUsage: tier1TokenUsage,
        },
        tokenUsage: tier1TokenUsage,
      };
    }
  } catch (err) {
    if (err instanceof ClaudeCliError || err instanceof CodexReviewError) {
      log?.warn(
        {
          kind: err.kind,
          exitCode: err.exitCode,
          signal: err instanceof ClaudeCliError ? err.signal : null,
          durationMs: err instanceof ClaudeCliError ? err.durationMs : null,
          stderrPreview: err.stderr.slice(0, 500),
        },
        'task review failed, continuing without review',
      );
      if (err.kind === 'timeout') {
        return { result: null, skipReason: `Review timed out: ${err.message}` };
      }
      return { result: null, skipReason: `Review failed: ${err.message}` };
    }
    const message = err instanceof Error ? err.message : String(err);
    log?.warn({ err }, 'task review failed, continuing without review');
    return { result: null, skipReason: `Review failed: ${message}` };
  }
}

function classifyReviewSkipKind(reason: string): ValidationResult['reviewSkipKind'] {
  if (reason.startsWith('No code changes detected')) return 'no-changes';
  if (reason.startsWith('Review timed out')) return 'review-timeout';
  return 'review-failed';
}

function resolveReviewRunner(config: ValidationEngineConfig): 'claude' | 'codex' | 'unsupported' {
  if (config.reviewerProvider === 'openai') return 'codex';
  if (
    config.reviewerProvider === 'foundry' &&
    config.reviewerProviderCredentials?.provider === 'foundry' &&
    (config.reviewerProviderCredentials.apiSurface ?? 'anthropic') === 'openai'
  ) {
    return 'codex';
  }
  if (config.reviewerProvider === 'copilot') return 'unsupported';
  return 'claude';
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
/**
 * Returns the cached pre-submit verdict in Tier-1 shape when it can be reused.
 * Only `status: 'pass'` cache entries are reused — fail/uncertain/skipped get
 * a fresh Tier 1 pass to avoid stale negatives.
 */
export function pickCachedPreSubmit(
  config: ValidationEngineConfig,
): { status: 'pass'; reasoning: string; issues: string[] } | null {
  const cache = config.preSubmitReview;
  const scope = summarizeUnifiedDiff(config.diff);
  const decision = getPreSubmitCacheDecision(cache, {
    diffHash: hashDiff(config.diff),
    filesReviewed: scope.filesReviewed,
    linesAdded: scope.linesAdded,
    linesRemoved: scope.linesRemoved,
    startCommitSha: config.startCommitSha ?? null,
  });
  if (!decision.reusable || !cache) return null;
  return {
    status: 'pass',
    reasoning: cache.reasoning,
    issues: cache.issues,
  };
}

function summarizeUnifiedDiff(diff: string): {
  filesReviewed: number;
  linesAdded: number;
  linesRemoved: number;
} {
  if (!diff.trim()) return { filesReviewed: 0, linesAdded: 0, linesRemoved: 0 };
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) linesAdded++;
    else if (line.startsWith('-')) linesRemoved++;
  }
  return {
    filesReviewed: (diff.match(/^diff --git /gm) ?? []).length,
    linesAdded,
    linesRemoved,
  };
}

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
