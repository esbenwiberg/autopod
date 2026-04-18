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

export interface HostBrowserRunner {
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
function resolvePlaywrightCwd(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pwEntry = require.resolve('playwright');
    // pwEntry is something like .../packages/daemon/node_modules/playwright/index.js
    // Walk up to the package directory that has playwright in its node_modules
    const parts = pwEntry.split('/node_modules/');
    if (parts.length >= 2) {
      return parts[0];
    }
    return null;
  } catch {
    return null;
  }
}

export function createHostBrowserRunner(logger: Logger): HostBrowserRunner {
  const log = logger.child({ component: 'host-browser-runner' });
  const baseDir = join(tmpdir(), 'autopod-browser');
  let available: boolean | null = null;

  // Resolve the cwd that has playwright in its node_modules at construction
  // time. Child processes spawned with this cwd can `import 'playwright'`.
  const pwCwd = resolvePlaywrightCwd();

  function sessionDir(podId: string): string {
    return join(baseDir, podId);
  }

  function screenshotDir(podId: string): string {
    return join(sessionDir(podId), 'screenshots');
  }

  function childSpawnOpts(): { env: NodeJS.ProcessEnv; cwd?: string } {
    return {
      env: { ...process.env },
      cwd: pwCwd ?? undefined,
    };
  }

  return {
    async isAvailable(): Promise<boolean> {
      if (available !== null) return available;

      if (!pwCwd) {
        available = false;
        log.info('Playwright package not found — browser validation will fall back to container');
        return false;
      }

      try {
        // Verify chromium binary is actually installed
        const result = await runNode(
          `import { chromium } from 'playwright'; console.log(chromium.executablePath());`,
          { timeout: 10_000, ...childSpawnOpts() },
        );
        available = result.exitCode === 0 && result.stdout.trim().length > 0;
      } catch {
        available = false;
      }

      if (available) {
        log.info('Host Playwright available — browser validation will run on host');
      } else {
        log.info('Host Playwright not available — browser validation will fall back to container');
      }

      return available;
    },

    async runScript(
      script: string,
      opts: { timeout: number; podId: string },
    ): Promise<BrowserRunResult> {
      const dir = sessionDir(opts.podId);
      const ssDir = screenshotDir(opts.podId);
      await mkdir(ssDir, { recursive: true });

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
