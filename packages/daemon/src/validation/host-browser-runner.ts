import { spawn } from 'node:child_process';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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
  runScript(
    script: string,
    opts: { timeout: number; sessionId: string },
  ): Promise<BrowserRunResult>;

  /** Read a screenshot from the host filesystem as base64. */
  readScreenshot(path: string): Promise<string>;

  /** Remove all temp files for a session. */
  cleanup(sessionId: string): Promise<void>;

  /** Get the session-scoped screenshot directory on the host. */
  screenshotDir(sessionId: string): string;
}

export function createHostBrowserRunner(logger: Logger): HostBrowserRunner {
  const log = logger.child({ component: 'host-browser-runner' });
  const baseDir = join(tmpdir(), 'autopod-browser');
  let available: boolean | null = null;

  function sessionDir(sessionId: string): string {
    return join(baseDir, sessionId);
  }

  function screenshotDir(sessionId: string): string {
    return join(sessionDir(sessionId), 'screenshots');
  }

  return {
    async isAvailable(): Promise<boolean> {
      if (available !== null) return available;

      try {
        // Check if playwright chromium is installed by trying to resolve the executable
        const result = await runNode(
          `const pw = require('playwright'); console.log(pw.chromium.executablePath());`,
          { timeout: 10_000 },
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
      opts: { timeout: number; sessionId: string },
    ): Promise<BrowserRunResult> {
      const dir = sessionDir(opts.sessionId);
      const ssDir = screenshotDir(opts.sessionId);
      await mkdir(ssDir, { recursive: true });

      const scriptPath = join(dir, `${randomUUID()}.mjs`);
      await writeFile(scriptPath, script, 'utf-8');

      log.info(
        { sessionId: opts.sessionId, scriptPath, timeout: opts.timeout },
        'Running Playwright script on host',
      );

      const result = await runNode(`await import(${JSON.stringify(scriptPath)})`, {
        timeout: opts.timeout,
        env: {
          ...process.env,
          // Ensure playwright finds its browsers
          PLAYWRIGHT_BROWSERS_PATH:
            process.env.PLAYWRIGHT_BROWSERS_PATH ?? undefined,
        },
      });

      log.info(
        { sessionId: opts.sessionId, exitCode: result.exitCode },
        'Host Playwright script finished',
      );

      return result;
    },

    async readScreenshot(path: string): Promise<string> {
      const buf = await readFile(path);
      return buf.toString('base64');
    },

    async cleanup(sessionId: string): Promise<void> {
      try {
        await rm(sessionDir(sessionId), { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    },

    screenshotDir,
  };
}

/**
 * Run a snippet of JS via `node -e`. Uses `--input-type=module` so top-level
 * await works, but wraps the snippet in a require-friendly CJS preamble via
 * `createRequire` so that `require('playwright')` resolves from the daemon's
 * node_modules.
 */
function runNode(
  code: string,
  opts: { timeout: number; env?: NodeJS.ProcessEnv },
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
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(() =>
        reject(new Error(`Host browser script timed out after ${opts.timeout}ms`)),
      );
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
