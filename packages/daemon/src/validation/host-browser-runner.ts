import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';

export interface BrowserRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface HostBrowserAvailability {
  available: boolean;
  cached: boolean;
  checkedAt: string;
  reason: string;
  playwrightPackagePath: string | null;
  playwrightCwd: string | null;
  chromiumExecutablePath: string | null;
  exitCode?: number;
  stderr?: string;
}

export interface HostBrowserRunner {
  /** Check whether Playwright Chromium is usable on the host, with diagnostics. */
  getAvailability(): Promise<HostBrowserAvailability>;

  /** Check whether Playwright Chromium is usable on the host. */
  isAvailable(): Promise<boolean>;

  /** Execute a Playwright script on the host. Returns stdout/stderr/exitCode. */
  runScript(script: string, opts: { timeout: number; podId: string }): Promise<BrowserRunResult>;

  /** Read a screenshot from the host filesystem as base64. */
  readScreenshot(path: string): Promise<string>;

  /** Remove all temp files for a pod. */
  cleanup(podId: string): Promise<void>;

  /** Get the pod-scoped screenshot directory on the host. */
  screenshotDir(podId: string): string;
}

/**
 * Resolve the package directory that contains playwright as a dependency.
 * Child processes spawned with `cwd` set to this directory can
 * `import 'playwright'` since ESM resolution walks up from cwd.
 */
export function resolvePlaywrightCwdFromEntry(pwEntry: string): string | null {
  const marker = '/node_modules/playwright/';
  const markerIndex = pwEntry.lastIndexOf(marker);
  if (markerIndex === -1) return null;
  return pwEntry.slice(0, markerIndex);
}

function resolvePlaywright(): { cwd: string; packagePath: string } | null {
  try {
    const require = createRequire(import.meta.url);
    const pwEntry = require.resolve('playwright');
    // pwEntry can be a pnpm real path like
    // .../node_modules/.pnpm/playwright@x.y.z/node_modules/playwright/index.js.
    // Use the innermost node_modules/playwright parent so bare ESM imports
    // resolve from the child process cwd.
    const cwd = resolvePlaywrightCwdFromEntry(pwEntry);
    return cwd ? { cwd, packagePath: pwEntry } : null;
  } catch {
    return null;
  }
}

interface HostBrowserRunnerOptions {
  probeAvailability?: () => Promise<Omit<HostBrowserAvailability, 'cached' | 'checkedAt'>>;
}

export function createHostBrowserRunner(
  logger: Logger,
  options: HostBrowserRunnerOptions = {},
): HostBrowserRunner {
  const log = logger.child({ component: 'host-browser-runner' });
  const baseDir = join(tmpdir(), 'autopod-browser');
  let availableCache: HostBrowserAvailability | null = null;

  // Resolve the cwd that has playwright in its node_modules at construction
  // time. Child processes spawned with this cwd can `import 'playwright'`.
  const playwright = resolvePlaywright();
  const pwCwd = playwright?.cwd ?? null;

  function sessionDir(podId: string): string {
    return join(baseDir, podId);
  }

  function screenshotDir(podId: string): string {
    return join(sessionDir(podId), 'screenshots');
  }

  // The generated Playwright script uses `createRequire(import.meta.url)` to
  // load `playwright`. Module resolution walks up from the file's location, not
  // from cwd — so the script must live somewhere under pwCwd for the walk to
  // reach `<pwCwd>/node_modules/playwright`. node_modules/.cache is the
  // conventional tooling-cache spot and is already gitignored.
  function scriptDir(podId: string): string | null {
    return pwCwd ? join(pwCwd, 'node_modules', '.cache', 'autopod-browser', podId) : null;
  }

  function childSpawnOpts(): { env: NodeJS.ProcessEnv; cwd?: string } {
    return {
      env: { ...process.env },
      cwd: pwCwd ?? undefined,
    };
  }

  async function defaultProbeAvailability(): Promise<
    Omit<HostBrowserAvailability, 'cached' | 'checkedAt'>
  > {
    if (!playwright || !pwCwd) {
      return {
        available: false,
        reason: 'Playwright package not found from the daemon module path',
        playwrightPackagePath: null,
        playwrightCwd: null,
        chromiumExecutablePath: null,
      };
    }

    try {
      // Verify chromium binary is actually installed.
      const result = await runNode(
        `import { chromium } from 'playwright'; console.log(chromium.executablePath());`,
        { timeout: 10_000, ...childSpawnOpts() },
      );
      const executablePath = result.stdout.trim();
      if (result.exitCode === 0 && executablePath.length > 0) {
        return {
          available: true,
          reason: 'Host Playwright Chromium probe succeeded',
          playwrightPackagePath: playwright.packagePath,
          playwrightCwd: pwCwd,
          chromiumExecutablePath: executablePath,
          exitCode: result.exitCode,
          stderr: result.stderr || undefined,
        };
      }
      return {
        available: false,
        reason: 'Host Playwright Chromium probe did not produce an executable path',
        playwrightPackagePath: playwright.packagePath,
        playwrightCwd: pwCwd,
        chromiumExecutablePath: executablePath || null,
        exitCode: result.exitCode,
        stderr: result.stderr || undefined,
      };
    } catch (err) {
      return {
        available: false,
        reason: err instanceof Error ? err.message : String(err),
        playwrightPackagePath: playwright.packagePath,
        playwrightCwd: pwCwd,
        chromiumExecutablePath: null,
      };
    }
  }

  return {
    async getAvailability(): Promise<HostBrowserAvailability> {
      if (availableCache) {
        return { ...availableCache, cached: true };
      }

      const probe = await (options.probeAvailability ?? defaultProbeAvailability)();
      const availability = {
        ...probe,
        cached: false,
        checkedAt: new Date().toISOString(),
      };

      if (availability.available) {
        availableCache = availability;
        log.info(
          {
            playwrightPackagePath: availability.playwrightPackagePath,
            playwrightCwd: availability.playwrightCwd,
            chromiumExecutablePath: availability.chromiumExecutablePath,
          },
          'Host Playwright available — browser validation will run on host',
        );
      } else {
        log.warn(
          {
            reason: availability.reason,
            playwrightPackagePath: availability.playwrightPackagePath,
            playwrightCwd: availability.playwrightCwd,
            exitCode: availability.exitCode,
            stderr: availability.stderr,
          },
          'Host Playwright not available — browser validation cannot run host browser checks',
        );
      }

      return availability;
    },

    async isAvailable(): Promise<boolean> {
      return (await this.getAvailability()).available;
    },

    async runScript(
      script: string,
      opts: { timeout: number; podId: string },
    ): Promise<BrowserRunResult> {
      const dir = scriptDir(opts.podId);
      if (!dir) {
        throw new Error(
          'Host browser runner: cannot resolve Playwright package directory; isAvailable() should have returned false',
        );
      }
      const ssDir = screenshotDir(opts.podId);
      await mkdir(ssDir, { recursive: true });
      await mkdir(dir, { recursive: true });

      const scriptPath = join(dir, `${randomUUID()}.mjs`);
      await writeFile(scriptPath, script, 'utf-8');

      log.info(
        { podId: opts.podId, scriptPath, timeout: opts.timeout },
        'Running Playwright script on host',
      );

      const result = await runNode(`await import(${JSON.stringify(scriptPath)})`, {
        timeout: opts.timeout,
        ...childSpawnOpts(),
      });

      log.info({ podId: opts.podId, exitCode: result.exitCode }, 'Host Playwright script finished');

      return result;
    },

    async readScreenshot(path: string): Promise<string> {
      const buf = await readFile(path);
      return buf.toString('base64');
    },

    async cleanup(podId: string): Promise<void> {
      try {
        await rm(sessionDir(podId), { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
      const sDir = scriptDir(podId);
      if (sDir) {
        try {
          await rm(sDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup
        }
      }
    },

    screenshotDir,
  };
}

/**
 * Run a snippet of JS via `node -e` in ESM mode (top-level await supported).
 * NODE_PATH must be set in env for the child to resolve packages like playwright.
 */
function runNode(
  code: string,
  opts: { timeout: number; env?: NodeJS.ProcessEnv; cwd?: string },
): Promise<BrowserRunResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const child = spawn('node', ['--input-type=module', '-e', code], {
      env: opts.env ?? process.env,
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(() => reject(new Error(`Host browser script timed out after ${opts.timeout}ms`)));
    }, opts.timeout);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      settle(() => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      settle(() => reject(err));
    });
  });
}
