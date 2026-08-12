import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AutopodError, parseSpecContract } from '@autopod/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type {
  ValidationEngineConfig,
  ValidationPhaseCallbacks,
} from '../interfaces/validation-engine.js';
import { createValidationRepository } from '../pods/validation-repository.js';
import { createProviderAnthropicClient } from '../providers/llm-client.js';
import { runClaudeCli } from '../runtimes/run-claude-cli.js';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { runContainerReviewer } from './container-reviewer-runner.js';
import type { HostBrowserRunner } from './host-browser-runner.js';
import {
  artifactChangeSatisfied,
  buildReviewPrompt,
  createLocalValidationEngine,
  enforceRequirementsStatus,
  initialBroadFindings,
  normalizeReviewIssue,
  parseReviewJson,
  parseWarningCount,
  runHealthCheck,
  startAppStabilityMonitor,
  stripMarkdownFences,
} from './local-validation-engine.js';
import { runAgenticReview } from './review-agentic-runner.js';
import { CodexReviewError, runCodexReview } from './review-codex-runner.js';
import { runToolUseReview } from './review-tool-runner.js';

const containerReviewerDelegate = vi.hoisted(() => ({
  actual: undefined as typeof runContainerReviewer | undefined,
}));

vi.mock('../runtimes/run-claude-cli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtimes/run-claude-cli.js')>();
  return {
    ...actual,
    runClaudeCli: vi.fn(),
  };
});

vi.mock('../providers/llm-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../providers/llm-client.js')>();
  return {
    ...actual,
    createProviderAnthropicClient: vi.fn(),
  };
});

vi.mock('./review-tool-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./review-tool-runner.js')>();
  return {
    ...actual,
    runToolUseReview: vi.fn(),
  };
});

vi.mock('./review-agentic-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./review-agentic-runner.js')>();
  return {
    ...actual,
    runAgenticReview: vi.fn(),
  };
});

vi.mock('./container-reviewer-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./container-reviewer-runner.js')>();
  containerReviewerDelegate.actual = actual.runContainerReviewer;
  return { ...actual, runContainerReviewer: vi.fn() };
});

vi.mock('./review-codex-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./review-codex-runner.js')>();
  return {
    ...actual,
    runCodexReview: vi.fn(),
  };
});

beforeEach(() => {
  vi.mocked(runClaudeCli).mockReset();
  vi.mocked(createProviderAnthropicClient)
    .mockReset()
    .mockResolvedValue({ ok: false, reason: 'no_anthropic_api_key' });
  vi.mocked(runToolUseReview).mockReset();
  vi.mocked(runAgenticReview).mockReset();
  vi.mocked(runContainerReviewer)
    .mockReset()
    .mockImplementation((config) => {
      if (!containerReviewerDelegate.actual) throw new Error('missing reviewer delegate');
      return containerReviewerDelegate.actual(config);
    });
  vi.mocked(runCodexReview).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function getAdvisoryBrowserQaRunner(engine: ReturnType<typeof createLocalValidationEngine>) {
  const runner = engine.runAdvisoryBrowserQa;
  if (!runner) {
    throw new Error('Expected local validation engine to expose advisory browser QA runner');
  }
  return runner;
}

describe('artifactChangeSatisfied', () => {
  const diff = `diff --git a/Client/src/Foo.ts b/Client/src/Foo.ts
index 111..222 100644
--- a/Client/src/Foo.ts
+++ b/Client/src/Foo.ts
@@ -1 +1 @@
-old
+new
diff --git a/Client/tests/page.spec.ts b/Client/tests/page.spec.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/Client/tests/page.spec.ts
@@ -0,0 +1 @@
+test('page', () => {});
`;

  it('treats directory artifacts as changed when any child path changed', () => {
    expect(artifactChangeSatisfied(diff, 'Client/src', 'update')).toBe(true);
  });

  it('requires create artifacts to be newly added', () => {
    expect(artifactChangeSatisfied(diff, 'Client/tests/page.spec.ts', 'create')).toBe(true);
    expect(artifactChangeSatisfied(diff, 'Client/src', 'create')).toBe(false);
  });

  it('treats touch as an existence-only change requirement', () => {
    expect(artifactChangeSatisfied('', 'Client/src', 'touch')).toBe(true);
  });
});

describe('required fact execution', () => {
  async function validateBrowserFact(options: {
    hostBrowserRunner?: HostBrowserRunner;
    command?: string;
    setupWorktree?: (worktreePath: string) => Promise<void>;
  }) {
    const worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), 'autopod-fact-host-'));
    await options.setupWorktree?.(worktreePath);
    const execCommands: string[] = [];
    const containerManager = {
      execInContainer: vi.fn(async (_containerId: string, command: string[]) => {
        const shell = command[2] ?? '';
        execCommands.push(shell);
        if (shell.includes('git reset --hard HEAD')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (shell.includes('test -e')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (shell.includes('sha256sum')) {
          return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        }
        if (shell.includes('.autopod/evidence')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        throw new Error(`unexpected container command: ${shell}`);
      }),
    } as unknown as ContainerManager;
    const command = options.command ?? 'printf host-fact';
    const engine = createLocalValidationEngine(
      containerManager,
      undefined,
      options.hostBrowserRunner,
    );

    try {
      const result = await engine.validate({
        podId: 'pod-facts',
        containerId: 'container-facts',
        previewUrl: 'http://127.0.0.1:3000',
        buildCommand: '',
        startCommand: '',
        healthPath: '/',
        healthTimeout: 1,
        smokePages: [],
        attempt: 1,
        task: 'prove browser fact host execution',
        hasWebUi: false,
        worktreePath,
        skipPhases: ['review'],
        diff: `diff --git a/Client/tests/facts.spec.ts b/Client/tests/facts.spec.ts
new file mode 100644
--- /dev/null
+++ b/Client/tests/facts.spec.ts
@@ -0,0 +1 @@
+test('fact', () => {});
`,
        contract: parseSpecContract(`contract_version: 1
title: Browser facts
depends_on: []
scenarios:
  - id: page
    given: ["state"]
    when: ["open page"]
    then: ["page works"]
required_facts:
  - id: fact-page
    proves: [page]
    kind: browser-test
    artifact:
      path: Client/tests/facts.spec.ts
      change: create
    command: ${JSON.stringify(command)}
human_review: []
`),
      });
      return { result, execCommands };
    } finally {
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
  }

  it('runs browser-test fact commands on the host when a host browser runner is available', async () => {
    const hostBrowserRunner: HostBrowserRunner = {
      getAvailability: vi.fn(async () => ({
        available: true,
        cached: false,
        checkedAt: '2026-05-20T00:00:00.000Z',
        reason: 'ok',
        playwrightPackagePath: '/repo/node_modules/playwright/index.js',
        playwrightCwd: '/repo',
        chromiumExecutablePath: '/chrome',
      })),
      isAvailable: vi.fn(async () => true),
      runScript: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      readScreenshot: vi.fn(async () => ''),
      cleanup: vi.fn(async () => {}),
      screenshotDir: vi.fn(() => '/tmp/autopod/screenshots'),
    };

    const { result, execCommands } = await validateBrowserFact({ hostBrowserRunner });

    expect(result.factValidation?.status).toBe('pass');
    expect(result.factValidation?.results[0]?.stdout).toBe('host-fact');
    expect(hostBrowserRunner.getAvailability).toHaveBeenCalled();
    expect(hostBrowserRunner.isAvailable).not.toHaveBeenCalled();
    expect(execCommands).not.toContain('printf host-fact');
  });

  it('installs missing host package dependencies before browser-test fact commands', async () => {
    const hostBrowserRunner: HostBrowserRunner = {
      getAvailability: vi.fn(async () => ({
        available: true,
        cached: false,
        checkedAt: '2026-05-20T00:00:00.000Z',
        reason: 'ok',
        playwrightPackagePath: '/repo/node_modules/playwright/index.js',
        playwrightCwd: '/repo',
        chromiumExecutablePath: '/chrome',
      })),
      isAvailable: vi.fn(async () => true),
      runScript: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      readScreenshot: vi.fn(async () => ''),
      cleanup: vi.fn(async () => {}),
      screenshotDir: vi.fn(() => '/tmp/autopod/screenshots'),
    };

    const { result } = await validateBrowserFact({
      hostBrowserRunner,
      command: 'npm run --silent fact',
      setupWorktree: async (worktreePath) => {
        await fs.mkdir(path.join(worktreePath, 'dep'), { recursive: true });
        await fs.writeFile(
          path.join(worktreePath, 'dep', 'package.json'),
          JSON.stringify({ name: 'local-fact-dep', version: '1.0.0' }),
        );
        await fs.writeFile(
          path.join(worktreePath, 'package.json'),
          JSON.stringify({
            name: 'fact-host',
            version: '1.0.0',
            scripts: { fact: 'test -d node_modules/local-fact-dep && printf host-fact' },
            dependencies: { 'local-fact-dep': 'file:./dep' },
          }),
        );
      },
    });

    expect(result.factValidation?.status).toBe('pass');
    expect(result.factValidation?.results[0]?.stdout).toBe('host-fact');
  });

  it('installs host dependencies when node_modules exists but is incomplete', async () => {
    const hostBrowserRunner: HostBrowserRunner = {
      getAvailability: vi.fn(async () => ({
        available: true,
        cached: false,
        checkedAt: '2026-05-20T00:00:00.000Z',
        reason: 'ok',
        playwrightPackagePath: '/repo/node_modules/playwright/index.js',
        playwrightCwd: '/repo',
        chromiumExecutablePath: '/chrome',
      })),
      isAvailable: vi.fn(async () => true),
      runScript: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      readScreenshot: vi.fn(async () => ''),
      cleanup: vi.fn(async () => {}),
      screenshotDir: vi.fn(() => '/tmp/autopod/screenshots'),
    };

    const { result } = await validateBrowserFact({
      hostBrowserRunner,
      command: 'npm run --silent fact',
      setupWorktree: async (worktreePath) => {
        await fs.mkdir(path.join(worktreePath, 'dep'), { recursive: true });
        await fs.writeFile(
          path.join(worktreePath, 'dep', 'package.json'),
          JSON.stringify({ name: 'local-fact-dep', version: '1.0.0' }),
        );
        await fs.mkdir(path.join(worktreePath, 'node_modules', 'unrelated'), { recursive: true });
        await fs.writeFile(
          path.join(worktreePath, 'node_modules', 'unrelated', 'package.json'),
          JSON.stringify({ name: 'unrelated', version: '1.0.0' }),
        );
        await fs.writeFile(
          path.join(worktreePath, 'package.json'),
          JSON.stringify({
            name: 'fact-host',
            version: '1.0.0',
            scripts: { fact: 'test -d node_modules/local-fact-dep && printf host-fact' },
            devDependencies: { 'local-fact-dep': 'file:./dep' },
          }),
        );
      },
    });

    expect(result.factValidation?.status).toBe('pass');
    expect(result.factValidation?.results[0]?.stdout).toBe('host-fact');
  });

  it('does not download Playwright browsers during browser-test dependency prep', async () => {
    const hostBrowserRunner: HostBrowserRunner = {
      getAvailability: vi.fn(async () => ({
        available: true,
        cached: false,
        checkedAt: '2026-05-20T00:00:00.000Z',
        reason: 'ok',
        playwrightPackagePath: '/repo/node_modules/playwright/index.js',
        playwrightCwd: '/repo',
        chromiumExecutablePath: '/chrome',
      })),
      isAvailable: vi.fn(async () => true),
      runScript: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      readScreenshot: vi.fn(async () => ''),
      cleanup: vi.fn(async () => {}),
      screenshotDir: vi.fn(() => '/tmp/autopod/screenshots'),
    };

    const { result } = await validateBrowserFact({
      hostBrowserRunner,
      command: 'npm run --silent fact',
      setupWorktree: async (worktreePath) => {
        await fs.writeFile(
          path.join(worktreePath, 'package.json'),
          JSON.stringify({
            name: 'fact-host',
            version: '1.0.0',
            scripts: {
              fact: 'printf host-fact',
              smoke: 'playwright test',
            },
          }),
        );
      },
    });

    expect(result.factValidation?.status).toBe('pass');
    expect(result.factValidation?.results[0]?.stdout).toBe('host-fact');
  });

  it('prewarms the app-local Playwright browser before browser-test fact commands', async () => {
    const hostBrowserRunner: HostBrowserRunner = {
      getAvailability: vi.fn(async () => ({
        available: true,
        cached: false,
        checkedAt: '2026-05-20T00:00:00.000Z',
        reason: 'ok',
        playwrightPackagePath: '/repo/node_modules/playwright/index.js',
        playwrightCwd: '/repo',
        chromiumExecutablePath: '/chrome',
      })),
      isAvailable: vi.fn(async () => true),
      runScript: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      readScreenshot: vi.fn(async () => ''),
      cleanup: vi.fn(async () => {}),
      screenshotDir: vi.fn(() => '/tmp/autopod/screenshots'),
    };

    const { result } = await validateBrowserFact({
      hostBrowserRunner,
      command: 'npm run --silent fact',
      setupWorktree: async (worktreePath) => {
        await fs.mkdir(path.join(worktreePath, 'node_modules', '.bin'), { recursive: true });
        await fs.writeFile(
          path.join(worktreePath, 'node_modules', '.bin', 'playwright'),
          [
            '#!/bin/sh',
            'test "$1" = install',
            'test "$2" = chromium',
            'touch .autopod-playwright-installed',
          ].join('\n'),
          { mode: 0o755 },
        );
        await fs.writeFile(
          path.join(worktreePath, 'package.json'),
          JSON.stringify({
            name: 'fact-host',
            version: '1.0.0',
            scripts: {
              fact: 'test -f .autopod-playwright-installed && printf host-fact',
            },
          }),
        );
      },
    });

    expect(result.factValidation?.status).toBe('pass');
    expect(result.factValidation?.results[0]?.stdout).toBe('host-fact');
  });

  it('blocks browser-test facts as pending_human when app-local Playwright prewarm fails', async () => {
    const hostBrowserRunner: HostBrowserRunner = {
      getAvailability: vi.fn(async () => ({
        available: true,
        cached: false,
        checkedAt: '2026-05-20T00:00:00.000Z',
        reason: 'ok',
        playwrightPackagePath: '/repo/node_modules/playwright/index.js',
        playwrightCwd: '/repo',
        chromiumExecutablePath: '/chrome',
      })),
      isAvailable: vi.fn(async () => true),
      runScript: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      readScreenshot: vi.fn(async () => ''),
      cleanup: vi.fn(async () => {}),
      screenshotDir: vi.fn(() => '/tmp/autopod/screenshots'),
    };

    const { result } = await validateBrowserFact({
      hostBrowserRunner,
      command: 'npm run --silent fact',
      setupWorktree: async (worktreePath) => {
        await fs.mkdir(path.join(worktreePath, 'node_modules', '.bin'), { recursive: true });
        await fs.writeFile(
          path.join(worktreePath, 'node_modules', '.bin', 'playwright'),
          '#!/bin/sh\nprintf "%s" "Download failed: cdn.playwright.dev" >&2\nexit 1\n',
          { mode: 0o755 },
        );
        await fs.writeFile(
          path.join(worktreePath, 'package.json'),
          JSON.stringify({
            name: 'fact-host',
            version: '1.0.0',
            scripts: {
              fact: 'printf should-not-run',
            },
          }),
        );
      },
    });

    expect(result.factValidation?.status).toBe('pending_human');
    expect(result.factValidation?.results[0]).toMatchObject({
      status: 'pending_human',
      exitCode: 1,
    });
    expect(result.factValidation?.results[0]?.stdout).not.toContain('should-not-run');
    expect(result.factValidation?.results[0]?.reasoning).toContain(
      'Playwright browser prewarm failed',
    );
  });

  it('collects browser-test fact attachments written on the host', async () => {
    const hostBrowserRunner: HostBrowserRunner = {
      getAvailability: vi.fn(async () => ({
        available: true,
        cached: false,
        checkedAt: '2026-05-20T00:00:00.000Z',
        reason: 'ok',
        playwrightPackagePath: '/repo/node_modules/playwright/index.js',
        playwrightCwd: '/repo',
        chromiumExecutablePath: '/chrome',
      })),
      isAvailable: vi.fn(async () => true),
      runScript: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      readScreenshot: vi.fn(async () => ''),
      cleanup: vi.fn(async () => {}),
      screenshotDir: vi.fn(() => '/tmp/autopod/screenshots'),
    };

    const { result } = await validateBrowserFact({
      hostBrowserRunner,
      command: 'printf png > "$AUTOPOD_FACT_SCREENSHOT_PATH"; printf host-fact',
    });

    expect(result.factValidation?.status).toBe('pass');
    expect(result.factValidation?.results[0]?.attachments).toContainEqual({
      kind: 'screenshot',
      path: '.autopod/evidence/fact-page/screenshot.png',
    });
  });

  it('blocks browser-test facts as pending_human when host Playwright is unavailable', async () => {
    const hostBrowserRunner: HostBrowserRunner = {
      getAvailability: vi.fn(async () => ({
        available: false,
        cached: false,
        checkedAt: '2026-05-20T00:00:00.000Z',
        reason: 'chromium probe failed',
        playwrightPackagePath: '/repo/node_modules/playwright/index.js',
        playwrightCwd: '/repo',
        chromiumExecutablePath: null,
        exitCode: 1,
        stderr: 'browser missing',
      })),
      isAvailable: vi.fn(async () => false),
      runScript: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      readScreenshot: vi.fn(async () => ''),
      cleanup: vi.fn(async () => {}),
      screenshotDir: vi.fn(() => '/tmp/autopod/screenshots'),
    };

    const { result, execCommands } = await validateBrowserFact({
      hostBrowserRunner,
      command: 'printf should-not-run',
    });

    expect(result.factValidation?.status).toBe('pending_human');
    expect(result.factValidation?.results[0]?.status).toBe('pending_human');
    expect(result.factValidation?.results[0]?.stderr).toContain('chromium probe failed');
    expect(result.factValidation?.results[0]?.stderr).toContain(
      'playwright=/repo/node_modules/playwright/index.js',
    );
    expect(result.factValidation?.results[0]?.stderr).toContain('stderr=browser missing');
    expect(result.factValidation?.results[0]?.reasoning).toContain(
      'browser-test could not run in this validation environment',
    );
    expect(execCommands).not.toContain('printf should-not-run');
  });

  it('blocks browser-test facts as pending_human when Playwright closes the CDP connection', async () => {
    const hostBrowserRunner: HostBrowserRunner = {
      getAvailability: vi.fn(async () => ({
        available: true,
        cached: false,
        checkedAt: '2026-05-20T00:00:00.000Z',
        reason: 'ok',
        playwrightPackagePath: '/repo/node_modules/playwright/index.js',
        playwrightCwd: '/repo',
        chromiumExecutablePath: '/chrome',
      })),
      isAvailable: vi.fn(async () => true),
      runScript: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      readScreenshot: vi.fn(async () => ''),
      cleanup: vi.fn(async () => {}),
      screenshotDir: vi.fn(() => '/tmp/autopod/screenshots'),
    };

    const { result } = await validateBrowserFact({
      hostBrowserRunner,
      command:
        "printf '%s' 'page.goto: net::ERR_CONNECTION_CLOSED at http://127.0.0.1:3000/' >&2; exit 1",
    });

    expect(result.factValidation?.status).toBe('pending_human');
    expect(result.factValidation?.results[0]).toMatchObject({
      status: 'pending_human',
      exitCode: 1,
    });
    expect(result.factValidation?.results[0]?.reasoning).toContain(
      'browser-test could not run in this validation environment',
    );
  });

  it('blocks browser-test facts as pending_human when Playwright expects a missing browser build', async () => {
    const hostBrowserRunner: HostBrowserRunner = {
      getAvailability: vi.fn(async () => ({
        available: true,
        cached: false,
        checkedAt: '2026-05-20T00:00:00.000Z',
        reason: 'ok',
        playwrightPackagePath: '/repo/node_modules/playwright/index.js',
        playwrightCwd: '/repo',
        chromiumExecutablePath: '/chrome',
      })),
      isAvailable: vi.fn(async () => true),
      runScript: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      readScreenshot: vi.fn(async () => ''),
      cleanup: vi.fn(async () => {}),
      screenshotDir: vi.fn(() => '/tmp/autopod/screenshots'),
    };

    const missingBrowser = [
      "browserType.launch: Executable doesn't exist at /opt/pw-browsers/chromium_headless_shell-1223/chrome-linux/headless_shell",
      'Looks like Playwright Test or Playwright was just installed or updated.',
      'Please run the following command to download new browsers:',
      '    npx playwright install',
    ].join('\n');

    const { result } = await validateBrowserFact({
      hostBrowserRunner,
      command: `printf '%s' ${JSON.stringify(missingBrowser)} >&2; exit 1`,
    });

    expect(result.factValidation?.status).toBe('pending_human');
    expect(result.factValidation?.results[0]?.reasoning).toContain(
      'Playwright browser executable is missing or mismatched',
    );
  });

  it('blocks browser-test facts as pending_human when Playwright browser download is blocked', async () => {
    const hostBrowserRunner: HostBrowserRunner = {
      getAvailability: vi.fn(async () => ({
        available: true,
        cached: false,
        checkedAt: '2026-05-20T00:00:00.000Z',
        reason: 'ok',
        playwrightPackagePath: '/repo/node_modules/playwright/index.js',
        playwrightCwd: '/repo',
        chromiumExecutablePath: '/chrome',
      })),
      isAvailable: vi.fn(async () => true),
      runScript: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      readScreenshot: vi.fn(async () => ''),
      cleanup: vi.fn(async () => {}),
      screenshotDir: vi.fn(() => '/tmp/autopod/screenshots'),
    };

    const { result } = await validateBrowserFact({
      hostBrowserRunner,
      command:
        "printf '%s' 'Denied egress: cdn.playwright.dev while running npx playwright install chromium' >&2; exit 1",
    });

    expect(result.factValidation?.status).toBe('pending_human');
    expect(result.factValidation?.results[0]?.reasoning).toContain(
      'Playwright browser download was blocked',
    );
  });

  it('keeps browser-test assertion failures as ordinary failed facts', async () => {
    const hostBrowserRunner: HostBrowserRunner = {
      getAvailability: vi.fn(async () => ({
        available: true,
        cached: false,
        checkedAt: '2026-05-20T00:00:00.000Z',
        reason: 'ok',
        playwrightPackagePath: '/repo/node_modules/playwright/index.js',
        playwrightCwd: '/repo',
        chromiumExecutablePath: '/chrome',
      })),
      isAvailable: vi.fn(async () => true),
      runScript: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      readScreenshot: vi.fn(async () => ''),
      cleanup: vi.fn(async () => {}),
      screenshotDir: vi.fn(() => '/tmp/autopod/screenshots'),
    };

    const { result } = await validateBrowserFact({
      hostBrowserRunner,
      command: "printf '%s' 'Error: expect(locator).toBeVisible() failed' >&2; exit 1",
    });

    expect(result.factValidation?.status).toBe('fail');
    expect(result.factValidation?.results[0]).toMatchObject({
      status: 'fail',
      exitCode: 1,
    });
  });

  it('blocks browser-test facts as pending_human when no host runner is wired', async () => {
    const { result, execCommands } = await validateBrowserFact({
      command: 'printf should-not-run',
    });

    expect(result.factValidation?.status).toBe('pending_human');
    expect(result.factValidation?.results[0]?.status).toBe('pending_human');
    expect(result.factValidation?.results[0]?.stderr).toContain(
      'daemon was not wired with a host browser runner',
    );
    expect(execCommands).not.toContain('printf should-not-run');
  });
});

describe('stripMarkdownFences', () => {
  it('strips ```json fences', () => {
    const input = '```json\n[{"a": 1}]\n```';
    expect(stripMarkdownFences(input)).toBe('[{"a": 1}]');
  });

  it('strips ``` fences without language', () => {
    const input = '```\nconst x = 1;\n```';
    expect(stripMarkdownFences(input)).toBe('const x = 1;');
  });

  it('strips ```javascript fences', () => {
    const input = '```javascript\nconst x = 1;\n```';
    expect(stripMarkdownFences(input)).toBe('const x = 1;');
  });

  it('returns clean text unchanged', () => {
    const input = '[{"a": 1}]';
    expect(stripMarkdownFences(input)).toBe('[{"a": 1}]');
  });
});

describe('enforceRequirementsStatus', () => {
  it('returns null unchanged', () => {
    expect(enforceRequirementsStatus(null)).toBeNull();
  });

  it('leaves pass status unchanged when all requirements are met', () => {
    const parsed = {
      status: 'pass' as const,
      reasoning: 'All good',
      issues: [],
      requirementsCheck: [
        { criterion: 'Scheduler runs on startup', met: true, note: 'Confirmed in diff' },
      ],
    };
    const result = enforceRequirementsStatus(parsed);
    expect(result?.status).toBe('pass');
  });

  it('forces status to fail when any requirementsCheck item is unmet', () => {
    const parsed = {
      status: 'pass' as const,
      reasoning: 'Code quality looks fine',
      issues: [],
      requirementsCheck: [
        { criterion: 'Scheduler runs on startup', met: true },
        {
          criterion: 'ConsecutiveFailureCount increments on failure',
          met: false,
          note: 'Not found in diff',
        },
      ],
    };
    const result = enforceRequirementsStatus(parsed);
    expect(result?.status).toBe('fail');
  });

  it('leaves fail status unchanged even when all requirements are met', () => {
    const parsed = {
      status: 'fail' as const,
      reasoning: 'Code quality issues found',
      issues: ['Missing error handling'],
      requirementsCheck: [{ criterion: 'Scheduler runs on startup', met: true }],
    };
    const result = enforceRequirementsStatus(parsed);
    expect(result?.status).toBe('fail');
  });

  it('leaves pass status unchanged when requirementsCheck is absent', () => {
    const parsed = {
      status: 'pass' as const,
      reasoning: 'Looks good',
      issues: [],
    };
    const result = enforceRequirementsStatus(parsed);
    expect(result?.status).toBe('pass');
  });

  it('preserves all other fields when overriding status', () => {
    const parsed = {
      status: 'pass' as const,
      reasoning: 'Mostly fine',
      issues: ['minor nit'],
      requirementsCheck: [{ criterion: 'Some requirement', met: false, note: 'Not done' }],
    };
    const result = enforceRequirementsStatus(parsed);
    expect(result?.reasoning).toBe('Mostly fine');
    expect(result?.issues).toEqual(['minor nit']);
    expect(result?.requirementsCheck).toHaveLength(1);
  });
});

describe('buildReviewPrompt', () => {
  const baseConfig = {
    podId: 'sess-1',
    containerId: 'c1',
    previewUrl: 'http://localhost:3000',
    buildCommand: 'npm run build',
    startCommand: 'npm start',
    healthPath: '/health',
    healthTimeout: 30_000,
    smokePages: [],
    attempt: 1,
    task: 'Implement a job scheduler',
    diff: '+const x = 1;',
    reviewerModel: 'claude-opus-4-6',
  };

  const contract = parseSpecContract(`contract_version: 1
title: Scheduler
depends_on: []
scenarios:
  - id: startup
    given: ["the daemon starts"]
    when: ["the scheduler initializes"]
    then: ["recurring jobs are registered"]
required_facts:
  - id: fact-startup
    proves: [startup]
    kind: unit-test
    artifact:
      path: packages/daemon/src/scheduled-jobs/scheduler.test.ts
      change: update
    command: npx pnpm --filter @autopod/daemon test -- scheduled-job-manager.test.ts
human_review:
  - id: review-failure-count
    covers: [startup]
    criterion: ConsecutiveFailureCount increments on failure
    reason: Requires judgment over the diff, not a deterministic command
`);

  it('renders diff-verification requirements from contract human review items', () => {
    const prompt = buildReviewPrompt({ ...baseConfig, contract });
    expect(prompt).toContain('REQUIREMENTS — DIFF VERIFICATION REQUIRED');
    expect(prompt).toContain('ConsecutiveFailureCount increments on failure');
    expect(prompt).toContain('YOU ARE THE ONLY CHECK');
  });

  it('omits diff-verification requirements when the contract has no human review items', () => {
    const noHumanReview = { ...contract, humanReview: [] };
    const prompt = buildReviewPrompt({ ...baseConfig, contract: noHumanReview });
    expect(prompt).not.toContain('DIFF VERIFICATION REQUIRED');
  });

  it('includes requirementsCheck only when human review items exist', () => {
    const prompt = buildReviewPrompt({ ...baseConfig, contract });
    expect(prompt).toContain('"requirementsCheck"');

    const noHumanReview = { ...contract, humanReview: [] };
    const promptWithoutHumanReview = buildReviewPrompt({ ...baseConfig, contract: noHumanReview });
    expect(promptWithoutHumanReview).not.toContain('"requirementsCheck"');
  });

  it('instructs reviewer to include only diff-verification requirements in requirementsCheck', () => {
    const prompt = buildReviewPrompt({ ...baseConfig, contract });
    expect(prompt).toContain('Include ONLY the "DIFF VERIFICATION REQUIRED" requirements');
    expect(prompt).toContain('Do NOT include required facts');
  });
});

describe('normalizeReviewIssue', () => {
  it('passes plain strings through trimmed', () => {
    expect(normalizeReviewIssue('  unhandled null in foo()  ')).toBe('unhandled null in foo()');
  });

  it('drops empty strings', () => {
    expect(normalizeReviewIssue('   ')).toBeNull();
    expect(normalizeReviewIssue('')).toBeNull();
  });

  it('formats {severity, message} objects as "[SEVERITY] message"', () => {
    expect(normalizeReviewIssue({ severity: 'high', message: 'Captive dependency' })).toBe(
      '[HIGH] Captive dependency',
    );
  });

  it('falls back to description / issue / text fields when message is missing', () => {
    expect(normalizeReviewIssue({ severity: 'medium', description: 'Missing await' })).toBe(
      '[MEDIUM] Missing await',
    );
    expect(normalizeReviewIssue({ severity: 'critical', issue: 'SQL injection' })).toBe(
      '[CRITICAL] SQL injection',
    );
    expect(normalizeReviewIssue({ severity: 'high', text: 'Unsafe cast' })).toBe(
      '[HIGH] Unsafe cast',
    );
  });

  it('omits severity prefix when no severity field is present', () => {
    expect(normalizeReviewIssue({ message: 'just a note' })).toBe('just a note');
  });

  it('accepts level as a synonym for severity', () => {
    expect(normalizeReviewIssue({ level: 'medium', message: 'foo' })).toBe('[MEDIUM] foo');
  });

  it('returns null for objects with no renderable content', () => {
    expect(normalizeReviewIssue({})).toBeNull();
    expect(normalizeReviewIssue({ severity: 'high' })).toBeNull();
    expect(normalizeReviewIssue({ message: 42 })).toBeNull();
  });

  it('returns null for non-string non-object inputs', () => {
    expect(normalizeReviewIssue(null)).toBeNull();
    expect(normalizeReviewIssue(undefined)).toBeNull();
    expect(normalizeReviewIssue(42)).toBeNull();
    expect(normalizeReviewIssue(true)).toBeNull();
  });

  it('never produces "[object Object]"', () => {
    // The regression we are guarding against: prior code did
    // `parsed.issues.map(String)` which turned every object into the literal
    // string `[object Object]`. normalizeReviewIssue must never do that.
    const result = normalizeReviewIssue({ severity: 'high', message: 'real content' });
    expect(result).not.toContain('[object Object]');
    expect(String({})).toBe('[object Object]'); // sanity-check the JS behaviour we're guarding against
  });
});

describe('parseReviewJson — issues normalization', () => {
  const baseShape = (issues: unknown[]) =>
    JSON.stringify({
      status: 'fail',
      reasoning: 'overall summary',
      issues,
    });

  it('passes plain string issues through unchanged', () => {
    const parsed = parseReviewJson(baseShape(['simple issue', 'second issue']));
    expect(parsed?.issues).toEqual(['simple issue', 'second issue']);
  });

  it('formats object-shaped issues into "[SEVERITY] message" strings', () => {
    const parsed = parseReviewJson(
      baseShape([
        { severity: 'high', message: 'Captive dependency' },
        { severity: 'medium', message: 'Missing test coverage' },
      ]),
    );
    expect(parsed?.issues).toEqual(['[HIGH] Captive dependency', '[MEDIUM] Missing test coverage']);
  });

  it('handles a mixed array of strings and objects', () => {
    const parsed = parseReviewJson(
      baseShape(['a plain string finding', { severity: 'high', message: 'an object finding' }]),
    );
    expect(parsed?.issues).toEqual(['a plain string finding', '[HIGH] an object finding']);
  });

  it('drops un-renderable entries from a mixed array but keeps the parse', () => {
    const parsed = parseReviewJson(
      baseShape(['   ', { irrelevant: true }, { severity: 'high', message: 'real one' }]),
    );
    expect(parsed?.issues).toEqual(['[HIGH] real one']);
  });

  it('rejects the parse when issues are present but every entry is un-renderable', () => {
    // Better to fail loud than to silently report "no issues" when the model
    // clearly tried to flag problems.
    const parsed = parseReviewJson(baseShape([{}, null, 42]));
    expect(parsed).toBeNull();
  });

  it('accepts an empty issues array', () => {
    const parsed = parseReviewJson(baseShape([]));
    expect(parsed?.issues).toEqual([]);
  });

  it('persists an oversized finding set as bounded independently addressable blockers', () => {
    const parsed = parseReviewJson(
      baseShape(Array.from({ length: 4_097 }, (_, index) => `blocker ${index}`)),
    );
    expect(parsed?.status).toBe('fail');
    expect(parsed?.issues).toHaveLength(4_097);
    expect(parsed?.issues).toContain('blocker 4095');
    expect(parsed?.issues.at(-1)).toContain('[REVIEW OVERFLOW]');
  });

  it('counts only renderable findings toward the supported cap', () => {
    const parsed = parseReviewJson(
      baseShape([...Array.from({ length: 4_096 }, () => ({})), 'valid A', 'valid B']),
    );
    expect(parsed?.issues).toEqual(['valid A', 'valid B']);
    expect(parsed?.firstGateOverflow).toBeUndefined();
  });

  it('does not let duplicate first-gate entries consume distinct finding capacity', () => {
    const parsed = parseReviewJson(
      baseShape([...Array.from({ length: 4_096 }, () => 'duplicate A'), 'distinct B']),
    );
    expect(parsed?.issues).toEqual(['duplicate A', 'distinct B']);
    expect(parsed?.firstGateOverflow).toBeUndefined();
  });

  it('fails closed without scanning an unbounded first-gate issue array', () => {
    const parsed = parseReviewJson(
      baseShape([
        ...Array.from({ length: 8_192 }, () => 'duplicate A'),
        'unscanned distinct blocker',
      ]),
    );
    expect(parsed?.status).toBe('fail');
    expect(parsed?.issues).toEqual(['duplicate A', expect.stringContaining('[REVIEW OVERFLOW]')]);
    expect(parsed?.firstGateOverflow).toEqual({
      reportedCount: 4_097,
      retainedFindingCount: 4_096,
    });
  });

  it('preserves distinct canonical IDs when bounded issue text is identical', () => {
    const prefix = `shared semantic prefix ${'🦊'.repeat(8_000)}`;
    const parsed = parseReviewJson(baseShape([`${prefix} A`, `${prefix} B`]));
    expect(parsed?.issues[0]).toBe(parsed?.issues[1]);
    expect(parsed?.firstGateFindings?.map((finding) => finding.id)).toHaveLength(2);
    expect(new Set(parsed?.firstGateFindings?.map((finding) => finding.id)).size).toBe(2);
    expect(initialBroadFindings(parsed as never).map((finding) => finding.id)).toEqual(
      parsed?.firstGateFindings?.map((finding) => finding.id),
    );
  });
});

describe('validate() — hasWebUi gating', () => {
  /** Minimal ContainerManager stub — every method throws unless explicitly invoked. */
  function stubContainerManager(): ContainerManager {
    const fail = (name: string) =>
      vi.fn(() => Promise.reject(new Error(`stub: ${name} unexpectedly called`)));
    // Pre-validation `resetWorktreeToHead` always calls execInContainer with
    // `git reset --hard HEAD && git clean -fd`. Allow that one call through;
    // anything else still fails so phase-gating assertions stay meaningful.
    const execInContainer = vi.fn(
      async (
        _containerId: string,
        command: string[],
        options?: { cwd?: string },
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        if (
          command[0] === 'sh' &&
          command[1] === '-c' &&
          typeof command[2] === 'string' &&
          command[2].includes('git reset --hard HEAD') &&
          command[2].includes('git clean')
        ) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        throw new Error(
          `stub: execInContainer unexpectedly called with command=${JSON.stringify(command)} cwd=${options?.cwd ?? 'unset'}`,
        );
      },
    );
    return {
      spawn: fail('spawn'),
      kill: fail('kill'),
      refreshFirewall: fail('refreshFirewall'),
      stop: fail('stop'),
      start: fail('start'),
      writeFile: fail('writeFile'),
      readFile: fail('readFile'),
      extractDirectoryFromContainer: fail('extractDirectoryFromContainer'),
      getStatus: fail('getStatus'),
      execInContainer,
      execStreaming: fail('execStreaming'),
    } as unknown as ContainerManager;
  }

  /** Minimal config — no build/test/lint/sast/start commands and empty diff so all
   *  command-driven phases (and the AI review) short-circuit without touching the
   *  container or spawning a CLI. Only the in-memory phase logic runs. */
  function baseConfig(overrides: Partial<ValidationEngineConfig> = {}): ValidationEngineConfig {
    return {
      podId: 'pod-test',
      containerId: 'container-test',
      previewUrl: 'http://127.0.0.1:9999',
      buildCommand: '',
      startCommand: 'node server.js',
      healthPath: '/',
      healthTimeout: 1,
      smokePages: [{ path: '/' }],
      attempt: 1,
      task: 'test task',
      diff: '',
      ...overrides,
    };
  }

  const changedDiff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+new
`;

  function mockCouncil() {
    vi.mocked(runContainerReviewer).mockImplementation(async ({ prompt }) => ({
      stdout: prompt.includes('synthesizer') ? '{malformed' : JSON.stringify({ findings: [] }),
      tokenUsage: { inputTokens: 10, outputTokens: 2 },
    }));
  }

  it('provider-compatible council completes five axes and synthesis', async () => {
    vi.mocked(runCodexReview).mockResolvedValue({
      stdout: JSON.stringify({ status: 'pass', reasoning: 'clean', issues: [] }),
      tokenUsage: { inputTokens: 100, outputTokens: 20 },
    });
    vi.mocked(runContainerReviewer).mockImplementation(async ({ prompt, outputContract }) => {
      expect(outputContract).toBeDefined();
      return {
        stdout: prompt.includes('synthesizer')
          ? JSON.stringify({ decisions: [] })
          : JSON.stringify({ findings: [] }),
        tokenUsage: { inputTokens: 10, outputTokens: 2 },
      };
    });

    const progress: NonNullable<ValidationPhaseCallbacks['onReviewProgress']> extends (
      value: infer T,
    ) => void
      ? T[]
      : never = [];
    const result = await createLocalValidationEngine(stubContainerManager()).validate(
      baseConfig({
        reviewerModel: 'gpt-5.6-sol',
        reviewerProvider: 'openai',
        diff: changedDiff,
        validationSuite: 'full',
        reviewDepth: 'deep',
        startCommand: '',
        smokePages: [],
      }),
      undefined,
      undefined,
      { onReviewProgress: (snapshot) => progress.push(snapshot) },
    );

    expect(runContainerReviewer).toHaveBeenCalledTimes(6);
    expect(result.taskReview?.reviewBatch).toMatchObject({
      quality: 'healthy',
      synthesis: 'model',
      axes: expect.arrayContaining([expect.objectContaining({ status: 'completed', attempts: 1 })]),
    });
    expect(result.taskReview?.reviewBatch?.axes).toHaveLength(5);
    expect(result.taskReview?.reviewBatch?.degradationReasons).toBeUndefined();
    expect(result.taskReview?.tokenUsage).toMatchObject({ inputTokens: 160, outputTokens: 32 });
    expect(progress[0]).toMatchObject({ stage: 'axes', attempt: 1, guardrailMs: 300_000 });
    expect(progress[0]?.axes).toHaveLength(5);
    expect(progress.some((snapshot) => snapshot.stage === 'synthesis')).toBe(true);
    expect(progress.at(-1)?.stage).toBe('finalizing');
    expect(progress.at(-1)?.axes.every((axis) => axis.status === 'completed')).toBe(true);
  });

  it('lets a healthy council reject a broad first-gate finding on the frozen head', async () => {
    const issue = 'broad finding not reproduced by any council axis';
    const initialId = initialBroadFindings({ issues: [issue] } as never)[0]?.id;
    if (!initialId) throw new Error('expected initial finding identity');
    vi.mocked(runClaudeCli).mockResolvedValue({
      stdout: JSON.stringify({ status: 'fail', reasoning: 'blocked', issues: [issue] }),
      tokenUsage: { inputTokens: 100, outputTokens: 20 },
    });
    vi.mocked(runContainerReviewer).mockImplementation(async ({ prompt }) => ({
      stdout: prompt.includes('synthesizer')
        ? JSON.stringify({
            decisions: [
              {
                action: 'reject',
                sourceIds: [initialId],
                reason: 'No frozen-head council axis reproduced the claim.',
              },
            ],
          })
        : JSON.stringify({ findings: [] }),
      tokenUsage: { inputTokens: 10, outputTokens: 2 },
    }));
    const result = await createLocalValidationEngine(stubContainerManager()).validate(
      baseConfig({
        reviewerModel: 'claude-sonnet-4-6',
        diff: changedDiff,
        validationSuite: 'full',
        startCommand: '',
        smokePages: [],
        task: `test task ${['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('')}`,
      }),
    );
    expect(result.taskReview?.status).toBe('pass');
    expect(result.taskReview?.issues).toEqual([]);
    expect(result.taskReview?.reviewBatch?.initialFindings).toHaveLength(1);
    expect(result.taskReview?.reviewBatch?.initialFindings[0]).toMatchObject({
      source: 'initial-review',
      issue,
    });
    expect(result.taskReview?.reviewBatch?.initialFindings[0]).not.toHaveProperty('path');
    expect(result.taskReview?.reviewBatch?.initialFindings[0]).not.toHaveProperty('severity');
    expect(runContainerReviewer).toHaveBeenCalledTimes(6);
    expect(
      vi
        .mocked(runContainerReviewer)
        .mock.calls.every(([config]) => !config.prompt.includes('ghp_')),
    ).toBe(true);
    expect(result.taskReview?.reviewBatch).toMatchObject({
      quality: 'healthy',
      rejected: [expect.objectContaining({ sourceIds: [initialId] })],
    });
    expect(result.taskReview?.reviewBatch?.degradationReasons).toBeUndefined();
    expect(result.taskReview?.tokenUsage).toMatchObject({ inputTokens: 160, outputTokens: 32 });
  });

  it('keeps initial semantic IDs stable when aggregate truncation changes stored text', () => {
    const target = `target blocker ${'x'.repeat(200)}`;
    const prefix = [
      ...Array.from({ length: 24 }, (_, index) => `${index}-${'p'.repeat(8_000)}`),
      `tail-${'q'.repeat(7_945)}`,
    ];
    const first = initialBroadFindings({ issues: [target] } as never)[0];
    const truncated = initialBroadFindings({ issues: [...prefix, target] } as never).at(-1);
    expect(truncated?.issue.length).toBeLessThan(first?.issue.length ?? 0);
    expect(truncated?.id).toBe(first?.id);
  });

  it('keeps distinct identities when long findings share bounded display text', () => {
    const prefix = `shared semantic prefix ${'🦊'.repeat(8_000)}`;
    const findings = initialBroadFindings({ issues: [`${prefix} A`, `${prefix} B`] } as never);
    expect(findings[0]?.issue).toBe(findings[1]?.issue);
    expect(findings[0]?.id).not.toBe(findings[1]?.id);
  });

  it('carries distinct long first-gate IDs through the production review ledger', async () => {
    const prefix = `shared semantic prefix ${'🦊'.repeat(8_000)}`;
    vi.mocked(runClaudeCli).mockResolvedValue({
      stdout: JSON.stringify({
        status: 'fail',
        reasoning: 'two blockers',
        issues: [`${prefix} A`, `${prefix} B`],
      }),
    });
    mockCouncil();
    const result = await createLocalValidationEngine(stubContainerManager()).validate(
      baseConfig({
        reviewerModel: 'claude-sonnet-4-6',
        diff: changedDiff,
        validationSuite: 'full',
        startCommand: '',
        smokePages: [],
      }),
    );
    expect(result.taskReview?.firstGateFindings?.[0]?.issue).toBe(
      result.taskReview?.firstGateFindings?.[1]?.issue,
    );
    expect(new Set(result.taskReview?.firstGateFindings?.map((finding) => finding.id)).size).toBe(
      2,
    );
    expect(result.taskReview?.reviewBatch?.ledger).toHaveLength(2);
    expect(result.taskReview?.firstGateFindings?.[0]).not.toHaveProperty('filterIssue');
  }, 15_000);

  it('retains first-gate findings beyond the frozen packet limit in the ledger', async () => {
    vi.mocked(runClaudeCli).mockResolvedValue({
      stdout: JSON.stringify({
        status: 'fail',
        reasoning: 'many blockers',
        issues: Array.from({ length: 1_001 }, (_, index) => `blocker ${index}`),
      }),
    });
    mockCouncil();
    const result = await createLocalValidationEngine(stubContainerManager()).validate(
      baseConfig({
        reviewerModel: 'claude-sonnet-4-6',
        diff: changedDiff,
        validationSuite: 'full',
        startCommand: '',
        smokePages: [],
      }),
    );
    expect(result.taskReview?.reviewBatch?.initialFindings).toHaveLength(100);
    expect(result.taskReview?.reviewBatch?.ledger).toHaveLength(1_001);
    expect(result.taskReview?.reviewBatch?.ledger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ finding: expect.objectContaining({ issue: 'blocker 1000' }) }),
      ]),
    );
    expect(result.taskReview?.issues).toContain('blocker 1000');
  });

  it('structurally redacts arbitrary nested credentials from frozen packet context', async () => {
    vi.mocked(runClaudeCli).mockResolvedValue({
      stdout: JSON.stringify({ status: 'fail', reasoning: 'blocked', issues: ['real blocker'] }),
    });
    mockCouncil();
    await createLocalValidationEngine(stubContainerManager()).validate(
      baseConfig({
        reviewerModel: 'claude-sonnet-4-6',
        diff: changedDiff,
        validationSuite: 'full',
        startCommand: '',
        smokePages: [],
        plan: {
          summary: 'safe plan',
          steps: ['safe step'],
          nested: { token: 'opaque-plan-credential' },
        } as never,
        taskSummary: {
          actualSummary: 'safe summary',
          deviations: [],
          metadata: {
            secret: 'opaque-summary-credential',
            nested: { password: 'opaque-password-credential' },
          },
        } as never,
      }),
    );
    const axisPrompts = vi
      .mocked(runContainerReviewer)
      .mock.calls.map(([config]) => config.prompt)
      .filter((prompt) => !prompt.includes('synthesizer'));
    expect(axisPrompts).toHaveLength(5);
    for (const prompt of axisPrompts) {
      expect(prompt).toContain('safe plan');
      expect(prompt).toContain('safe summary');
      expect(prompt).toContain('[REDACTED]');
      expect(prompt).not.toContain('opaque-plan-credential');
      expect(prompt).not.toContain('opaque-summary-credential');
      expect(prompt).not.toContain('opaque-password-credential');
    }
  });

  it('runs every first full review through the council after the broad discovery gate', async () => {
    vi.mocked(runClaudeCli).mockResolvedValue({
      stdout: JSON.stringify({ status: 'pass', reasoning: 'clean', issues: [] }),
    });
    mockCouncil();
    const engine = createLocalValidationEngine(stubContainerManager());
    const deep = await engine.validate(
      baseConfig({
        reviewerModel: 'claude-sonnet-4-6',
        diff: changedDiff,
        validationSuite: 'full',
        reviewDepth: 'deep',
        startCommand: '',
        smokePages: [],
      }),
    );
    expect(deep.taskReview?.reviewBatch).toBeDefined();
    expect(runContainerReviewer).toHaveBeenCalledTimes(7);

    vi.mocked(runContainerReviewer).mockClear();
    const standard = await engine.validate(
      baseConfig({
        reviewerModel: 'claude-sonnet-4-6',
        diff: changedDiff,
        validationSuite: 'full',
        reviewDepth: 'standard',
        startCommand: '',
        smokePages: [],
      }),
    );
    expect(standard.taskReview?.reviewBatch).toBeDefined();
    expect(runContainerReviewer).toHaveBeenCalledTimes(7);

    vi.mocked(runContainerReviewer).mockClear();
    vi.mocked(runClaudeCli).mockResolvedValue({
      stdout: JSON.stringify({ status: 'fail', reasoning: 'blocked', issues: ['blocker'] }),
    });
    const nonFull = await engine.validate(
      baseConfig({
        reviewerModel: 'claude-sonnet-4-6',
        diff: changedDiff,
        validationSuite: 'deterministic',
        startCommand: '',
        smokePages: [],
      }),
    );
    expect(nonFull.taskReview?.reviewBatch).toBeUndefined();
    expect(nonFull.taskReview).toMatchObject({ status: 'fail', issues: ['blocker'] });
    expect(runContainerReviewer).not.toHaveBeenCalled();
  });

  it('runs the council after a clean gate for prior blockers and fails closed without a delta', async () => {
    vi.mocked(runClaudeCli).mockResolvedValue({
      stdout: JSON.stringify({ status: 'pass', reasoning: 'clean', issues: [] }),
    });
    mockCouncil();
    const priorReviewBatch = {
      id: 'prior',
      diffHash: 'd',
      reviewedHead: 'unavailable',
      promptVersion: 'p',
      schemaVersion: 's',
      model: 'm',
      axes: [],
      candidates: [],
      initialFindings: [],
      accepted: [{ id: 'initial-a', source: 'initial-review' as const, issue: 'A' }],
      rejected: [],
      merged: [],
      synthesis: 'model' as const,
      durationMs: 1,
    };
    const stages: string[] = [];
    const result = await createLocalValidationEngine(stubContainerManager()).validate(
      baseConfig({
        reviewerModel: 'claude-sonnet-4-6',
        diff: changedDiff,
        validationSuite: 'full',
        reviewDepth: 'standard',
        startCommand: '',
        smokePages: [],
        priorReviewBatch,
      }),
      undefined,
      undefined,
      { onReviewProgress: (snapshot) => stages.push(snapshot.stage) },
    );
    expect(runClaudeCli).not.toHaveBeenCalled();
    expect(runContainerReviewer).toHaveBeenCalledTimes(7);
    expect(result.taskReview?.reviewBatch?.repairDelta?.status).toBe('unavailable');
    expect(result.taskReview?.reviewBatch?.closureVerification?.status).toBe('unavailable');
    expect(result.taskReview?.reviewBatch?.ledger?.[0]?.state).toBe('open');
    expect(result.overall).toBe('fail');
    expect(stages).toContain('closure');
    expect(stages.at(-1)).toBe('finalizing');
  });

  it('closes prior findings across verified sibling sandbox checkpoints', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'autopod-review-checkpoints-'));
    const podId = 'sandbox-review-ledger';
    const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repoPath });
    const checkpoint = async (sourceHead: string, sequence: number): Promise<string> => {
      const tree = (await git('rev-parse', `${sourceHead}^{tree}`)).stdout.trim();
      const created = await promisify(execFile)(
        'git',
        ['commit-tree', tree, '-p', sourceHead, '-m', 'autopod sandbox checkpoint'],
        {
          cwd: repoPath,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Autopod',
            GIT_AUTHOR_EMAIL: 'autopod@localhost',
            GIT_COMMITTER_NAME: 'Autopod',
            GIT_COMMITTER_EMAIL: 'autopod@localhost',
          },
        },
      );
      const snapshot = created.stdout.trim();
      await git('update-ref', `refs/autopod-quarantine/${podId}/${sequence}`, snapshot);
      return snapshot;
    };

    try {
      await git('init');
      await git('config', 'user.email', 'test@example.invalid');
      await git('config', 'user.name', 'Autopod Test');
      await fs.writeFile(path.join(repoPath, 'repair.txt'), 'broken\n');
      await git('add', 'repair.txt');
      await git('commit', '-m', 'initial agent work');
      const sourceA = (await git('rev-parse', 'HEAD')).stdout.trim();
      const snapshotA = await checkpoint(sourceA, 1);

      await fs.writeFile(path.join(repoPath, 'repair.txt'), 'fixed marker abcdefghijklmnop\n');
      await git('add', 'repair.txt');
      await git('commit', '-m', 'repair finding');
      const sourceB = (await git('rev-parse', 'HEAD')).stdout.trim();
      const snapshotB = await checkpoint(sourceB, 2);
      await git('reset', '--hard', snapshotB);

      vi.mocked(runContainerReviewer).mockImplementation(async ({ prompt }) => ({
        stdout: prompt.includes('closure verifier')
          ? (() => {
              const records = JSON.parse(
                prompt.match(/Known findings: (.*)\nRepair delta:/s)?.[1] ?? '[]',
              ) as Array<{ semanticId: string }>;
              return JSON.stringify({
                decisions: records.map((record) => ({
                  semanticId: record.semanticId,
                  fixed: true,
                  evidence: '+fixed marker abcdefghijklmnop',
                })),
              });
            })()
          : prompt.includes('synthesizer')
            ? JSON.stringify({ decisions: [] })
            : JSON.stringify({ findings: [] }),
        tokenUsage: { inputTokens: 10, outputTokens: 2 },
      }));

      const priorReviewBatch = {
        id: 'prior-checkpoint-review',
        diffHash: 'prior-diff',
        reviewedHead: snapshotA,
        promptVersion: 'review-council-v1',
        schemaVersion: 'structured-finding-v2',
        model: 'm',
        axes: [],
        candidates: [],
        initialFindings: [],
        accepted: [{ id: 'initial-a', source: 'initial-review' as const, issue: 'A' }],
        rejected: [],
        merged: [],
        synthesis: 'model' as const,
        durationMs: 1,
      };
      const result = await createLocalValidationEngine(stubContainerManager()).validate(
        baseConfig({
          podId,
          reviewerModel: 'claude-sonnet-4-6',
          diff: changedDiff,
          validationSuite: 'full',
          startCommand: '',
          smokePages: [],
          worktreePath: repoPath,
          priorReviewBatch,
          attempt: 2,
        }),
      );

      expect(
        result.taskReview?.reviewBatch?.repairDelta,
        result.taskReview?.reviewBatch?.repairDelta?.reason,
      ).toMatchObject({ status: 'available', fromHead: snapshotA, toHead: snapshotB });
      expect(result.taskReview?.reviewBatch?.closureVerification?.status).toBe('completed');
      expect(result.taskReview?.reviewBatch?.ledger).toEqual([
        expect.objectContaining({
          state: 'fixed',
          finding: expect.objectContaining({ issue: 'A' }),
        }),
      ]);
      expect(result.taskReview?.issues).toEqual([]);
      expect(result.overall).toBe('pass');
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('preserves canonical council retry authority through an A/B repair lifecycle', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'autopod-review-ledger-'));
    const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repoPath });
    await git('init');
    await git('config', 'user.email', 'test@example.invalid');
    await git('config', 'user.name', 'Autopod Test');
    await fs.writeFile(path.join(repoPath, 'repair.txt'), 'base\n');
    await git('add', 'repair.txt');
    await git('commit', '-m', 'base');
    let closureAttempt = 0;
    let synthesisAttempt = 0;
    vi.mocked(runContainerReviewer).mockImplementation(async ({ prompt }) => ({
      stdout: prompt.includes('closure verifier')
        ? (() => {
            closureAttempt++;
            const records = JSON.parse(
              prompt.match(/Known findings: (.*)\nRepair delta:/s)?.[1] ?? '[]',
            ) as Array<{ semanticId: string; source: { issue?: string } }>;
            return JSON.stringify({
              decisions: records.map((record) => ({
                semanticId: record.semanticId,
                fixed: closureAttempt === 1 ? record.source.issue === 'A' : closureAttempt === 2,
                ...(closureAttempt === 1 && record.source.issue === 'A'
                  ? { evidence: '+repair A marker abcdefghijklmnop' }
                  : closureAttempt === 2
                    ? {
                        evidence: `+repair ${record.source.issue} marker abcdefghijklmnop`,
                      }
                    : {}),
              })),
            });
          })()
        : prompt.includes('synthesizer')
          ? ++synthesisAttempt <= 2
            ? '{malformed'
            : JSON.stringify({ decisions: [] })
          : JSON.stringify({ findings: [] }),
      tokenUsage: { inputTokens: prompt.includes('closure verifier') ? 7 : 10, outputTokens: 2 },
    }));
    const attempts = [['A', 'B']];
    vi.mocked(runClaudeCli).mockImplementation(async () => {
      const issues = attempts.shift() ?? [];
      return {
        stdout: JSON.stringify({
          status: issues.length === 0 ? 'pass' : 'fail',
          reasoning: issues.length === 0 ? 'clean standard first gate' : 'blocked',
          issues,
        }),
      };
    });
    const engine = createLocalValidationEngine(stubContainerManager());
    const common = {
      reviewerModel: 'claude-sonnet-4-6',
      diff: changedDiff,
      validationSuite: 'full' as const,
      startCommand: '',
      smokePages: [],
      worktreePath: repoPath,
    };
    const db = createTestDb();
    insertTestProfile(db);
    db.prepare(
      `INSERT INTO pods (id, profile_name, task, model, runtime, branch, user_id)
       VALUES ('ledger-lifecycle', 'test-profile', 'test task', 'model', 'claude', 'main', 'user-1')`,
    ).run();
    const history = createValidationRepository(db);
    const one = await engine.validate(baseConfig(common));
    history.insert('ledger-lifecycle', 1, { ...one, podId: 'ledger-lifecycle' });
    await fs.writeFile(
      path.join(repoPath, 'repair.txt'),
      'base\nrepair A marker abcdefghijklmnop\n',
    );
    await git('add', 'repair.txt');
    await git('commit', '-m', 'repair A');
    const two = await engine.validate(
      baseConfig({
        ...common,
        attempt: 2,
        priorReviewBatch: history.getLatestReviewBatch('ledger-lifecycle'),
      }),
    );
    history.insert('ledger-lifecycle', 2, { ...two, podId: 'ledger-lifecycle' });
    expect(
      two.taskReview?.reviewBatch?.closureVerification?.status,
      two.taskReview?.reviewBatch?.closureVerification?.reason,
    ).toBe('completed');
    await fs.writeFile(
      path.join(repoPath, 'repair.txt'),
      'base\nrepair A marker abcdefghijklmnop\nrepair B marker abcdefghijklmnop\nrepair C marker abcdefghijklmnop\n',
    );
    await git('add', 'repair.txt');
    await git('commit', '-m', 'repair B C');
    const three = await engine.validate(
      baseConfig({
        ...common,
        attempt: 3,
        priorReviewBatch: history.getLatestReviewBatch('ledger-lifecycle'),
      }),
    );
    history.insert('ledger-lifecycle', 3, { ...three, podId: 'ledger-lifecycle' });
    const states = (result: typeof one) =>
      Object.fromEntries(
        result.taskReview?.reviewBatch?.ledger?.map((entry) => [entry.finding.id, entry.state]) ??
          [],
      );
    expect(states(one)).toEqual({
      'initial-ca978112ca1bbdca': 'new',
      'initial-3e23e8160039594a': 'new',
    });
    expect(states(two)).toEqual({
      'initial-ca978112ca1bbdca': 'fixed',
      'initial-3e23e8160039594a': 'open',
    });
    expect(states(three)).toEqual({
      'initial-ca978112ca1bbdca': 'fixed',
      'initial-3e23e8160039594a': 'fixed',
    });
    // The engine's flattened feedback remains active-only while each prior
    // packet retains immutable fixed/regressed history for later attempts.
    expect(two.taskReview?.issues).toEqual(['B']);
    expect(two.taskReview?.issues).not.toContain('A');
    expect(three.taskReview?.issues).toEqual([]);
    expect(states(two)).toEqual({
      'initial-ca978112ca1bbdca': 'fixed',
      'initial-3e23e8160039594a': 'open',
    });
    expect(two.taskReview?.tokenUsage?.inputTokens).toBe(67);

    await fs.appendFile(path.join(repoPath, 'repair.txt'), 'clean gate follow-up\n');
    await git('add', 'repair.txt');
    await git('commit', '-m', 'clean first gate follow-up');
    const four = await engine.validate(
      baseConfig({
        ...common,
        attempt: 4,
        priorReviewBatch: history.getLatestReviewBatch('ledger-lifecycle'),
      }),
    );
    history.insert('ledger-lifecycle', 4, { ...four, podId: 'ledger-lifecycle' });
    expect(closureAttempt).toBe(2);
    expect(four.taskReview?.reviewBatch?.closureVerification).toBeUndefined();
    expect(four.taskReview?.issues).toEqual([]);
    expect(four.taskReview?.status).toBe('pass');
    expect(runClaudeCli).toHaveBeenCalledTimes(1);

    // Persist the production-engine outputs through the real validation-history
    // seam. Each stored attempt must keep its own immutable ledger snapshot.
    const persisted = history.getForSession('ledger-lifecycle');
    expect(persisted).toHaveLength(4);
    const persistedStates = (index: number) =>
      Object.fromEntries(
        persisted[index]?.result.taskReview?.reviewBatch?.ledger?.map((entry) => [
          entry.finding.id,
          entry.state,
        ]) ?? [],
      );
    expect(persistedStates(0)).toEqual(states(one));
    expect(persistedStates(1)).toEqual(states(two));
    expect(persistedStates(2)).toEqual(states(three));
    expect(history.getLatestReviewBatch('ledger-lifecycle')?.id).toBe(
      four.taskReview?.reviewBatch?.id,
    );

    // Exercise backward compatibility through the same production repository
    // seam: an old persisted packet has accepted findings but predates ledger.
    db.prepare(
      `INSERT INTO pods (id, profile_name, task, model, runtime, branch, user_id)
       VALUES ('legacy-ledger-lifecycle', 'test-profile', 'legacy task', 'model', 'claude', 'main', 'user-1')`,
    ).run();
    const legacyBatch = {
      id: 'legacy-no-ledger',
      diffHash: 'legacy-diff',
      reviewedHead: 'unavailable',
      promptVersion: 'legacy-prompt',
      schemaVersion: 'legacy-schema',
      model: 'legacy-model',
      axes: [],
      candidates: [],
      initialFindings: [],
      accepted: [{ id: 'legacy-A', source: 'initial-review' as const, issue: 'legacy A' }],
      rejected: [],
      merged: [],
      synthesis: 'model' as const,
      durationMs: 1,
    };
    if (!one.taskReview) throw new Error('attempt one must produce task review history');
    history.insert('legacy-ledger-lifecycle', 1, {
      ...one,
      podId: 'legacy-ledger-lifecycle',
      taskReview: {
        ...one.taskReview,
        status: 'fail',
        issues: ['legacy A'],
        reviewBatch: legacyBatch,
      },
    });
    const hydratedLegacy = history.getLatestReviewBatch('legacy-ledger-lifecycle');
    expect(hydratedLegacy?.accepted).toEqual(legacyBatch.accepted);
    expect(hydratedLegacy).not.toHaveProperty('ledger');
    const legacySeeded = await engine.validate(
      baseConfig({
        ...common,
        attempt: 2,
        priorReviewBatch: hydratedLegacy,
      }),
    );
    history.insert('legacy-ledger-lifecycle', 2, {
      ...legacySeeded,
      podId: 'legacy-ledger-lifecycle',
    });
    expect(legacySeeded.taskReview?.reviewBatch?.ledger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: 'open',
          finding: expect.objectContaining({ source: 'initial-review', issue: 'legacy A' }),
        }),
      ]),
    );
    expect(legacySeeded.taskReview?.issues).toContain('legacy A');
    expect(legacySeeded.taskReview?.status).toBe('fail');
    expect(
      history.getForSession('legacy-ledger-lifecycle')[1]?.result.taskReview?.reviewBatch?.ledger,
    ).toEqual(legacySeeded.taskReview?.reviewBatch?.ledger);
    await fs.rm(repoPath, { recursive: true, force: true });
  });

  function commandTrackingContainerManager(
    options: {
      setupExitCode?: number;
      buildTimeout?: number;
    } = {},
  ): {
    cm: ContainerManager;
    commands: string[];
    timeouts: Array<number | undefined>;
    envs: Array<Record<string, string> | undefined>;
  } {
    const commands: string[] = [];
    const timeouts: Array<number | undefined> = [];
    const envs: Array<Record<string, string> | undefined> = [];
    const execInContainer = vi.fn(
      async (
        _containerId: string,
        command: string[],
        execOptions?: { timeout?: number; env?: Record<string, string> },
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        const shell = command[2] ?? '';
        if (shell.includes('git reset --hard HEAD') && shell.includes('git clean')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (shell.includes('node_modules/.bin') || shell.includes('chmod +x')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }

        commands.push(shell);
        timeouts.push(execOptions?.timeout);
        envs.push(execOptions?.env);
        if (shell === 'setup-command') {
          return {
            stdout: options.setupExitCode === 1 ? 'setup stdout' : 'setup ok',
            stderr: options.setupExitCode === 1 ? 'setup stderr' : '',
            exitCode: options.setupExitCode ?? 0,
          };
        }
        return { stdout: `${shell} ok`, stderr: '', exitCode: 0 };
      },
    );

    return {
      cm: { ...stubContainerManager(), execInContainer } as unknown as ContainerManager,
      commands,
      timeouts,
      envs,
    };
  }

  it('runs setup before downstream command phases and records setup events/results', async () => {
    const { cm, commands } = commandTrackingContainerManager();
    const engine = createLocalValidationEngine(cm);
    const started: string[] = [];
    const completed: Array<{ phase: string; status: string; result: unknown }> = [];

    const result = await engine.validate(
      baseConfig({
        validationSetupCommand: 'setup-command',
        lintCommand: 'lint-command',
        sastCommand: 'sast-command',
        buildCommand: 'build-command',
        testCommand: 'test-command',
        startCommand: '',
        smokePages: [],
        hasWebUi: false,
        skipPhases: ['facts', 'review'],
      }),
      undefined,
      undefined,
      {
        onPhaseStarted: (phase) => started.push(phase),
        onPhaseCompleted: (phase, status, phaseResult) =>
          completed.push({ phase, status, result: phaseResult }),
      },
    );

    expect(commands).toEqual([
      'setup-command',
      'lint-command',
      'sast-command',
      'build-command',
      'test-command',
    ]);
    expect(started.slice(0, 5)).toEqual(['setup', 'lint', 'sast', 'build', 'test']);
    expect(completed[0]).toMatchObject({
      phase: 'setup',
      status: 'pass',
      result: { status: 'pass', output: 'setup ok' },
    });
    expect(result.setup).toMatchObject({ status: 'pass', output: 'setup ok' });
    expect(result.overall).toBe('pass');
  });

  it('uses buildTimeout for setup command execution', async () => {
    const { cm, commands, timeouts } = commandTrackingContainerManager();
    const engine = createLocalValidationEngine(cm);

    await engine.validate(
      baseConfig({
        validationSetupCommand: 'setup-command',
        buildTimeout: 12_345,
        startCommand: '',
        smokePages: [],
        hasWebUi: false,
        skipPhases: ['facts', 'review'],
      }),
    );

    const setupIndex = commands.indexOf('setup-command');
    expect(setupIndex).toBeGreaterThanOrEqual(0);
    expect(timeouts[setupIndex]).toBe(12_345);
  });

  it('passes validation env through to setup command execution', async () => {
    const { cm, commands, envs } = commandTrackingContainerManager();
    const engine = createLocalValidationEngine(cm);

    await engine.validate(
      baseConfig({
        validationSetupCommand: 'setup-command',
        extraExecEnv: {
          AUTOPOD_VALIDATION_BASE_REF: 'abc123',
          AUTOPOD_PR_BASE_REF: 'origin/main',
        },
        startCommand: '',
        smokePages: [],
        hasWebUi: false,
        skipPhases: ['facts', 'review'],
      }),
    );

    const setupIndex = commands.indexOf('setup-command');
    expect(setupIndex).toBeGreaterThanOrEqual(0);
    expect(envs[setupIndex]).toMatchObject({
      AUTOPOD_VALIDATION_BASE_REF: 'abc123',
      AUTOPOD_PR_BASE_REF: 'origin/main',
    });
  });

  it('treats missing or profile-skipped setup as neutral', async () => {
    const withoutSetup = commandTrackingContainerManager();
    const engineWithoutSetup = createLocalValidationEngine(withoutSetup.cm);

    const missingResult = await engineWithoutSetup.validate(
      baseConfig({
        lintCommand: 'lint-command',
        startCommand: '',
        smokePages: [],
        hasWebUi: false,
        skipPhases: ['facts', 'review'],
      }),
    );

    expect(missingResult.setup?.status).toBe('skip');
    expect(withoutSetup.commands).toContain('lint-command');

    const skippedSetup = commandTrackingContainerManager();
    const engineSkippedSetup = createLocalValidationEngine(skippedSetup.cm);
    const skippedResult = await engineSkippedSetup.validate(
      baseConfig({
        validationSetupCommand: 'setup-command',
        lintCommand: 'lint-command',
        startCommand: '',
        smokePages: [],
        hasWebUi: false,
        skipPhases: ['setup', 'facts', 'review'],
      }),
    );

    expect(skippedResult.setup).toMatchObject({
      status: 'skip',
      output: 'Setup phase skipped by profile configuration',
    });
    expect(skippedSetup.commands).toEqual(['lint-command']);
    expect(skippedResult.overall).toBe('pass');
  });

  it('fails setup and stops downstream validation phases', async () => {
    const { cm, commands } = commandTrackingContainerManager({ setupExitCode: 1 });
    const engine = createLocalValidationEngine(cm);
    const completed: Array<{ phase: string; status: string }> = [];

    const result = await engine.validate(
      baseConfig({
        validationSetupCommand: 'setup-command',
        lintCommand: 'lint-command',
        sastCommand: 'sast-command',
        buildCommand: 'build-command',
        testCommand: 'test-command',
        startCommand: '',
        smokePages: [],
        hasWebUi: false,
        skipPhases: ['facts', 'review'],
      }),
      undefined,
      undefined,
      { onPhaseCompleted: (phase, status) => completed.push({ phase, status }) },
    );

    expect(commands).toEqual(['setup-command']);
    expect(completed).toEqual([{ phase: 'setup', status: 'fail' }]);
    expect(result.overall).toBe('fail');
    expect(result.setup).toMatchObject({
      status: 'fail',
      output: 'setup stdout\nsetup stderr',
    });
    expect(result.lint?.status).toBe('skip');
    expect(result.sast?.status).toBe('skip');
    expect(result.test?.status).toBe('skip');
    expect(result.smoke.health.status).toBe('skip');
    expect(result.factValidation?.status).toBe('skip');
    expect(result.taskReview).toBeNull();
    expect(result.reviewSkipReason).toBe('Skipped — validation setup failed');
  });

  it('skips Health and Pages when hasWebUi is false', async () => {
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const completed: Array<{ phase: string; status: string }> = [];
    const callbacks: ValidationPhaseCallbacks = {
      onPhaseCompleted: (phase, status) => completed.push({ phase, status }),
    };

    const result = await engine.validate(
      baseConfig({ hasWebUi: false }),
      undefined,
      undefined,
      callbacks,
    );

    // Only the pre-validation worktree reset should hit execInContainer —
    // buildCommand is empty (skip), and Health is short-circuited before
    // runHealthCheck would exec the start command. Any non-cleanup call would
    // throw via the stub.
    const execMock = cm.execInContainer as unknown as ReturnType<typeof vi.fn>;
    expect(execMock).toHaveBeenCalledTimes(1);
    const [, cleanupCommand] = execMock.mock.calls[0] as [string, string[]];
    expect(cleanupCommand[2]).toContain('git reset --hard HEAD');
    expect(cleanupCommand[2]).toContain('git clean');

    expect(result.smoke.health.status).toBe('skip');
    expect(result.smoke.health.responseCode).toBeNull();
    expect(result.smoke.pages).toEqual([]);
    expect(result.smoke.status).toBe('pass');

    const healthEvent = completed.find((c) => c.phase === 'health');
    const pagesEvent = completed.find((c) => c.phase === 'pages');
    expect(healthEvent?.status).toBe('skip');
    expect(pagesEvent?.status).toBe('skip');
  });

  it('reports Health as fail when hasWebUi is true and build fails', async () => {
    // Sanity check: existing behaviour (synthetic-fail health when build fails)
    // is preserved when hasWebUi is left at its default. Here build is skipped (no
    // command) so it actually passes, meaning runHealthCheck would be invoked —
    // and would throw via the stub, which is what we want to verify the gate flips.
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    // Use a non-empty buildCommand so runBuild calls execInContainer and our stub
    // rejects → buildResult is 'fail' → health falls to the synthetic-fail branch.
    const result = await engine.validate(
      baseConfig({ hasWebUi: true, buildCommand: 'npm run build' }),
    );

    expect(result.smoke.build.status).toBe('fail');
    expect(result.smoke.health.status).toBe('fail');
    expect(result.smoke.health.url).toBe('http://127.0.0.1:9999/');
  });

  it('reports Pages as skip (not pass) when Health fails with smokePages configured', async () => {
    // Regression: `pages` is an empty array when health doesn't pass, and
    // `[].every(...)` is vacuously true — which previously made pagesStatus
    // = 'pass' and surfaced a bogus "All pages passed" while Health was red.
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const completed: Array<{ phase: string; status: string }> = [];
    const callbacks: ValidationPhaseCallbacks = {
      onPhaseCompleted: (phase, status) => completed.push({ phase, status }),
    };

    const result = await engine.validate(
      baseConfig({
        hasWebUi: true,
        buildCommand: 'npm run build',
        smokePages: [{ path: '/' }, { path: '/dashboard' }],
      }),
      undefined,
      undefined,
      callbacks,
    );

    expect(result.smoke.health.status).toBe('fail');
    expect(result.smoke.pages).toEqual([]);
    const pagesEvent = completed.find((c) => c.phase === 'pages');
    expect(pagesEvent?.status).toBe('skip');
  });

  it('uses container-local health and page probes when webProbeMode is container', async () => {
    const commands: string[] = [];
    const writtenScripts: string[] = [];
    const cm = {
      ...stubContainerManager(),
      writeFile: vi.fn(async (_containerId: string, _path: string, content: string | Buffer) => {
        writtenScripts.push(String(content));
      }),
      execInContainer: vi.fn(
        async (
          _containerId: string,
          command: string[],
        ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
          const shell = command[2] ?? command.join(' ');
          commands.push(shell);
          if (shell.includes('git reset --hard HEAD') && shell.includes('git clean')) {
            return { stdout: '', stderr: '', exitCode: 0 };
          }
          if (shell.includes('export START_COMMAND')) {
            return { stdout: '', stderr: '', exitCode: 0 };
          }
          if (shell.includes('__AUTOPOD_STATUS__')) {
            return {
              stdout: '__AUTOPOD_STATUS__200\n__AUTOPOD_BODY__\nok\n__AUTOPOD_ERROR__\n',
              stderr: '',
              exitCode: 0,
            };
          }
          if (shell.includes('/tmp/autopod-page-validation.mjs')) {
            return {
              stdout: `__AUTOPOD_PAGE_RESULTS_START__
[{"path":"/","status":"pass","screenshotPath":"/workspace/.autopod/screenshots/root.png","consoleErrors":[],"assertions":[],"loadTime":42}]
__AUTOPOD_PAGE_RESULTS_END__`,
              stderr: '',
              exitCode: 0,
            };
          }
          throw new Error(`unexpected exec: ${JSON.stringify(command)}`);
        },
      ),
    } as unknown as ContainerManager;
    const hostBrowserRunner: HostBrowserRunner = {
      getAvailability: vi.fn(async () => ({
        available: true,
        cached: false,
        checkedAt: '2026-06-26T00:00:00.000Z',
        reason: 'ok',
        playwrightPackagePath: '/repo/node_modules/playwright/index.js',
        playwrightCwd: '/repo',
        chromiumExecutablePath: '/chrome',
      })),
      isAvailable: vi.fn(async () => true),
      runScript: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      readScreenshot: vi.fn(async () => ''),
      cleanup: vi.fn(async () => {}),
      screenshotDir: vi.fn(() => '/tmp/autopod/screenshots'),
    };
    const engine = createLocalValidationEngine(cm, undefined, hostBrowserRunner);

    const result = await engine.validate(
      baseConfig({
        previewUrl: 'http://127.0.0.1:32541',
        containerBaseUrl: 'http://127.0.0.1:3000',
        webProbeMode: 'container',
        startCommand: 'pnpm dev',
        healthPath: '/health',
        smokePages: [{ path: '/' }],
        skipPhases: ['facts', 'review'],
      }),
    );

    expect(result.smoke.health.status).toBe('pass');
    expect(result.smoke.health.url).toBe('http://127.0.0.1:3000/health');
    expect(result.smoke.pages).toHaveLength(1);
    expect(result.smoke.pages[0]?.status).toBe('pass');
    expect(hostBrowserRunner.isAvailable).not.toHaveBeenCalled();
    expect(hostBrowserRunner.runScript).not.toHaveBeenCalled();
    expect(writtenScripts[0]).toContain('"baseUrl":"http://127.0.0.1:3000"');
    expect(commands.some((command) => command.includes('http://127.0.0.1:3000/health'))).toBe(true);
  });

  it('blocking validation does not run advisory inline', async () => {
    const cm = stubContainerManager();
    const hostBrowserRunner = {
      getAvailability: vi.fn(),
    } as unknown as HostBrowserRunner;
    const engine = createLocalValidationEngine(cm, undefined, hostBrowserRunner);
    const started: string[] = [];
    const completed: Array<{ phase: string; status: string; result: unknown }> = [];
    const callbacks: ValidationPhaseCallbacks = {
      onPhaseStarted: (phase) => started.push(phase),
      onPhaseCompleted: (phase, status, result) => completed.push({ phase, status, result }),
    };

    const config = baseConfig({
      startCommand: '',
      smokePages: [],
      hasWebUi: true,
      advisoryBrowserQaEnabled: true,
      skipPhases: ['facts'],
      reviewerModel: 'claude-review',
      contract: parseSpecContract(`contract_version: 1
title: Advisory
depends_on: []
scenarios:
  - id: dashboard
    given: ["state"]
    when: ["open dashboard"]
    then: ["summary is visible"]
required_facts:
  - id: browser-proof
    proves: [dashboard]
    kind: browser-test
    artifact:
      path: tests/browser/advisory.spec.ts
      change: update
    command: npx vitest --run tests/browser/advisory.spec.ts --grep dashboard
human_review: []
`),
    });
    const result = await engine.validate(config, undefined, undefined, callbacks);

    expect(result.overall).toBe('pass');
    expect(result.advisoryBrowserQa).toBeNull();
    expect(hostBrowserRunner.getAvailability).not.toHaveBeenCalled();
    expect(started).not.toContain('advisory');
    expect(completed.some((c) => c.phase === 'advisory')).toBe(false);
  });

  it('advisory-concern-nonblocking records concern evidence without affecting overall', async () => {
    vi.mocked(runClaudeCli).mockResolvedValue({
      stdout: JSON.stringify({
        status: 'fail',
        reasoning: 'Visual concern found.',
        observations: [
          {
            id: 'empty-state-overlap',
            targetId: 'scenario:dashboard',
            status: 'fail',
            summary: 'Loaded data is overlapped by the empty state.',
            suggestedFacts: ['Add a browser fact for the loaded dashboard state.'],
          },
        ],
      }),
      tokenUsage: {
        inputTokens: 3456,
        cachedInputTokens: 2000,
        outputTokens: 234,
        costUsd: 0.067,
      },
    });

    const cm = stubContainerManager();
    const hostBrowserRunner: HostBrowserRunner = {
      getAvailability: vi.fn(async () => ({
        available: true,
        cached: false,
        checkedAt: '2026-05-25T00:00:00.000Z',
        reason: 'ok',
        playwrightPackagePath: '/repo/node_modules/playwright/index.js',
        playwrightCwd: '/repo',
        chromiumExecutablePath: '/chrome',
      })),
      isAvailable: vi.fn(async () => true),
      runScript: vi.fn(async () => ({
        stdout: `AUTOPOD_ADVISORY_BROWSER_QA_JSON_START
[{"targetId":"scenario:dashboard","url":"http://127.0.0.1:9999/","title":"Dashboard","notes":["empty state overlap"],"screenshotPath":"/tmp/advisory-0.png"}]
AUTOPOD_ADVISORY_BROWSER_QA_JSON_END`,
        stderr: '',
        exitCode: 0,
      })),
      readScreenshot: vi.fn(async () => Buffer.from('png').toString('base64')),
      cleanup: vi.fn(async () => {}),
      screenshotDir: vi.fn(() => '/tmp'),
    };
    const screenshotStore = {
      write: vi.fn(async (podId: string, source: 'advisory', filename: string) => ({
        podId,
        source,
        filename,
        relativePath: `screenshots/${podId}/${source}/${filename}`,
      })),
    };
    const engine = createLocalValidationEngine(
      cm,
      undefined,
      hostBrowserRunner,
      screenshotStore as never,
    );
    const started: string[] = [];
    const completed: Array<{ phase: string; status: string; result: unknown }> = [];
    const callbacks: ValidationPhaseCallbacks = {
      onPhaseStarted: (phase) => started.push(phase),
      onPhaseCompleted: (phase, status, result) => completed.push({ phase, status, result }),
    };

    const config = baseConfig({
      startCommand: '',
      smokePages: [],
      hasWebUi: true,
      advisoryBrowserQaEnabled: true,
      skipPhases: ['facts'],
      reviewerModel: 'claude-review',
      contract: parseSpecContract(`contract_version: 1
title: Advisory
depends_on: []
scenarios:
  - id: dashboard
    given: ["state"]
    when: ["open dashboard"]
    then: ["summary is visible"]
required_facts:
  - id: browser-proof
    proves: [dashboard]
    kind: browser-test
    artifact:
      path: tests/browser/advisory.spec.ts
      change: update
    command: npx vitest --run tests/browser/advisory.spec.ts --grep dashboard
human_review: []
`),
    });
    const result = await engine.validate(config, undefined, undefined, callbacks);
    const advisory = await getAdvisoryBrowserQaRunner(engine)(
      config,
      result,
      undefined,
      undefined,
      callbacks,
    );

    expect(result.overall).toBe('pass');
    expect(result.advisoryBrowserQa).toBeNull();
    expect(advisory?.status).toBe('fail');
    expect(advisory?.observations[0]).toMatchObject({
      id: 'empty-state-overlap',
      scenarioId: 'dashboard',
      status: 'fail',
      suggestedFacts: ['Add a browser fact for the loaded dashboard state.'],
    });
    expect(advisory?.screenshots[0]?.source).toBe('advisory');
    expect(advisory?.tokenUsage).toEqual({
      inputTokens: 3456,
      cachedInputTokens: 2000,
      outputTokens: 234,
      costUsd: 0.067,
    });
    expect(hostBrowserRunner.runScript).toHaveBeenCalled();
    expect(started).toContain('advisory');
    expect(completed).toContainEqual({
      phase: 'advisory',
      status: 'fail',
      result: advisory,
    });
  });

  it('advisory-error-nonblocking attaches advisory browser QA errors without affecting overall', async () => {
    const cm = stubContainerManager();
    const hostBrowserRunner: HostBrowserRunner = {
      getAvailability: vi.fn(async () => ({
        available: true,
        cached: false,
        checkedAt: '2026-05-25T00:00:00.000Z',
        reason: 'ok',
        playwrightPackagePath: '/repo/node_modules/playwright/index.js',
        playwrightCwd: '/repo',
        chromiumExecutablePath: '/chrome',
      })),
      isAvailable: vi.fn(async () => true),
      runScript: vi.fn(async () => ({
        stdout: `AUTOPOD_ADVISORY_BROWSER_QA_JSON_START
[{"targetId":"scenario:dashboard","url":"http://127.0.0.1:9999/","title":"Dashboard","notes":["visible"],"screenshotPath":"/tmp/advisory-0.png"}]
AUTOPOD_ADVISORY_BROWSER_QA_JSON_END`,
        stderr: '',
        exitCode: 0,
      })),
      readScreenshot: vi.fn(async () => Buffer.from('png').toString('base64')),
      cleanup: vi.fn(async () => {}),
      screenshotDir: vi.fn(() => '/tmp'),
    };
    const screenshotStore = {
      write: vi.fn(async (podId: string, source: 'advisory', filename: string) => ({
        podId,
        source,
        filename,
        relativePath: `screenshots/${podId}/${source}/${filename}`,
      })),
    };
    const engine = createLocalValidationEngine(
      cm,
      undefined,
      hostBrowserRunner,
      screenshotStore as never,
    );

    const config = baseConfig({
      startCommand: '',
      smokePages: [],
      hasWebUi: true,
      advisoryBrowserQaEnabled: true,
      skipPhases: ['facts'],
      reviewerModel: undefined,
      contract: parseSpecContract(`contract_version: 1
title: Advisory
depends_on: []
scenarios:
  - id: dashboard
    given: ["state"]
    when: ["open dashboard"]
    then: ["summary is visible"]
required_facts:
  - id: browser-proof
    proves: [dashboard]
    kind: browser-test
    artifact:
      path: tests/browser/advisory.spec.ts
      change: update
    command: npx vitest --run tests/browser/advisory.spec.ts --grep dashboard
human_review: []
`),
    });
    const result = await engine.validate(config);
    const advisory = await getAdvisoryBrowserQaRunner(engine)(config, result);

    expect(result.overall).toBe('pass');
    expect(result.advisoryBrowserQa).toBeNull();
    expect(advisory?.status).toBe('uncertain');
    expect(advisory?.reasoning).toContain('No reviewer model configured');
    expect(advisory?.screenshots[0]?.source).toBe('advisory');
    expect(hostBrowserRunner.runScript).toHaveBeenCalled();
  });

  it('records no-contract-checklist skip reason for enabled advisory browser QA', async () => {
    const cm = stubContainerManager();
    const hostBrowserRunner = {
      getAvailability: vi.fn(),
    } as unknown as HostBrowserRunner;
    const engine = createLocalValidationEngine(cm, undefined, hostBrowserRunner);
    const completed: Array<{ phase: string; status: string; result: unknown }> = [];
    const callbacks: ValidationPhaseCallbacks = {
      onPhaseCompleted: (phase, status, result) => completed.push({ phase, status, result }),
    };

    const config = baseConfig({
      startCommand: '',
      smokePages: [],
      hasWebUi: true,
      advisoryBrowserQaEnabled: true,
      contract: parseSpecContract(`contract_version: 1
title: Empty
depends_on: []
scenarios: []
required_facts: []
human_review: []
`),
    });
    const result = await engine.validate(config, undefined, undefined, callbacks);
    const advisory = await getAdvisoryBrowserQaRunner(engine)(
      config,
      result,
      undefined,
      undefined,
      callbacks,
    );

    expect(result.overall).toBe('pass');
    expect(result.advisoryBrowserQa).toBeNull();
    expect(advisory).toMatchObject({
      status: 'skip',
      reasoning: 'no-contract-checklist',
    });
    expect(hostBrowserRunner.getAvailability).not.toHaveBeenCalled();
    expect(completed).toContainEqual({
      phase: 'advisory',
      status: 'skip',
      result: advisory,
    });
  });

  it('skips advisory browser QA when the advisory phase is profile-skipped', async () => {
    const cm = stubContainerManager();
    const hostBrowserRunner = {
      getAvailability: vi.fn(),
    } as unknown as HostBrowserRunner;
    const engine = createLocalValidationEngine(cm, undefined, hostBrowserRunner);
    const completed: Array<{ phase: string; status: string; result: unknown }> = [];
    const callbacks: ValidationPhaseCallbacks = {
      onPhaseCompleted: (phase, status, result) => completed.push({ phase, status, result }),
    };

    const config = baseConfig({
      startCommand: '',
      smokePages: [],
      hasWebUi: true,
      advisoryBrowserQaEnabled: true,
      skipPhases: ['advisory'],
      contract: parseSpecContract(`contract_version: 1
title: Advisory
depends_on: []
scenarios:
  - id: dashboard
    given: ["state"]
    when: ["open dashboard"]
    then: ["summary is visible"]
required_facts: []
human_review:
  - id: visual
    covers: [dashboard]
    criterion: "Dashboard layout is visually coherent."
    reason: "Needs a browser."
`),
    });
    const result = await engine.validate(config, undefined, undefined, callbacks);
    const advisory = await getAdvisoryBrowserQaRunner(engine)(
      config,
      result,
      undefined,
      undefined,
      callbacks,
    );

    expect(result.overall).toBe('pass');
    expect(result.advisoryBrowserQa).toBeNull();
    expect(advisory).toMatchObject({
      status: 'skip',
      reasoning: 'profile-skip',
    });
    expect(hostBrowserRunner.getAvailability).not.toHaveBeenCalled();
    expect(completed).toContainEqual({
      phase: 'advisory',
      status: 'skip',
      result: advisory,
    });
  });
});

describe('validate() — facts + review gate', () => {
  function stubContainerManager(): ContainerManager {
    const fail = (name: string) =>
      vi.fn(() => Promise.reject(new Error(`stub: ${name} unexpectedly called`)));
    const execInContainer = vi.fn(
      async (
        _containerId: string,
        command: string[],
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        if (
          command[0] === 'sh' &&
          command[1] === '-c' &&
          typeof command[2] === 'string' &&
          command[2].includes('git reset --hard HEAD')
        ) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        throw new Error(`stub: execInContainer unexpectedly called: ${JSON.stringify(command)}`);
      },
    );
    return {
      spawn: fail('spawn'),
      kill: fail('kill'),
      refreshFirewall: fail('refreshFirewall'),
      stop: fail('stop'),
      start: fail('start'),
      writeFile: fail('writeFile'),
      readFile: fail('readFile'),
      extractDirectoryFromContainer: fail('extractDirectoryFromContainer'),
      getStatus: fail('getStatus'),
      execInContainer,
      execStreaming: fail('execStreaming'),
    } as unknown as ContainerManager;
  }

  function baseConfig(overrides: Partial<ValidationEngineConfig> = {}): ValidationEngineConfig {
    return {
      podId: 'pod-test',
      containerId: 'container-test',
      previewUrl: 'http://127.0.0.1:9999',
      buildCommand: '',
      startCommand: 'node server.js',
      healthPath: '/',
      healthTimeout: 1,
      smokePages: [{ path: '/' }],
      attempt: 1,
      task: 'test task',
      diff: '',
      hasWebUi: false,
      ...overrides,
    };
  }

  it('skips Facts + Review with upstream-failed reason when build fails', async () => {
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const completed: Array<{ phase: string; status: string }> = [];
    const result = await engine.validate(
      baseConfig({ buildCommand: 'npm run build' }),
      undefined,
      undefined,
      { onPhaseCompleted: (phase, status) => completed.push({ phase, status }) },
    );

    expect(result.smoke.build.status).toBe('fail');
    expect(result.factValidation).toEqual({ status: 'skip', results: [] });
    expect(result.taskReview).toBeNull();
    expect(result.reviewSkipKind).toBe('upstream-failed');
    expect(result.reviewSkipReason).toMatch(/earlier validation phases failed/i);
    expect(result.overall).toBe('fail');

    const factsEvent = completed.find((c) => c.phase === 'facts');
    const reviewEvent = completed.find((c) => c.phase === 'review');
    expect(factsEvent?.status).toBe('skip');
    expect(reviewEvent?.status).toBe('skip');
  });

  it('skips Facts + Review when lint fails', async () => {
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(baseConfig({ lintCommand: 'eslint .' }));

    expect(result.lint?.status).toBe('fail');
    expect(result.factValidation?.status).toBe('skip');
    expect(result.reviewSkipKind).toBe('upstream-failed');
    expect(result.overall).toBe('fail');
  });

  it('skips Facts + Review when SAST fails', async () => {
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(baseConfig({ sastCommand: 'semgrep' }));

    expect(result.sast?.status).toBe('fail');
    expect(result.factValidation?.status).toBe('skip');
    expect(result.reviewSkipKind).toBe('upstream-failed');
    expect(result.overall).toBe('fail');
  });

  it('ordinary command exits do not become infrastructure', async () => {
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(baseConfig({ testCommand: 'vitest' }));

    expect(result.test?.status).toBe('fail');
    expect(result.infrastructureFailure).toBeUndefined();
    expect(result.factValidation?.status).toBe('skip');
    expect(result.reviewSkipKind).toBe('upstream-failed');
    expect(result.overall).toBe('fail');
  });

  it('classifies an OOM-killed test command as infrastructure instead of agent rework', async () => {
    const base = stubContainerManager();
    const execInContainer = vi.fn(async (_containerId: string, command: string[]) => {
      const shell = command[2] ?? '';
      if (shell.includes('oom-test')) {
        return { stdout: 'many passing suites\nKilled\n', stderr: '', exitCode: 137 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const engine = createLocalValidationEngine({ ...base, execInContainer } as ContainerManager);

    const result = await engine.validate(baseConfig({ testCommand: 'oom-test' }));

    expect(result.test?.status).toBe('skip');
    expect(result.infrastructureFailure).toMatchObject({
      phase: 'test',
      code: 'CONTAINER_OOM',
      retryable: false,
    });
    expect(result.overall).toBe('fail');
    expect(result.reviewSkipReason).toMatch(/validation infrastructure failed/i);
  });

  it('classifies an OOM-killed build command as infrastructure instead of agent rework', async () => {
    const base = stubContainerManager();
    const execInContainer = vi.fn(async (_containerId: string, command: string[]) => {
      const shell = command[2] ?? '';
      if (shell.includes('oom-build')) {
        return { stdout: 'bundling application\nKilled\n', stderr: '', exitCode: 137 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const engine = createLocalValidationEngine({ ...base, execInContainer } as ContainerManager);

    const result = await engine.validate(baseConfig({ buildCommand: 'oom-build' }));

    expect(result.smoke.build.status).toBe('fail');
    expect(result.infrastructureFailure).toMatchObject({
      phase: 'build',
      code: 'CONTAINER_OOM',
      retryable: false,
    });
    expect(result.overall).toBe('fail');
    expect(result.reviewSkipReason).toMatch(/validation infrastructure failed/i);
  });

  const sandboxMemorySignatures = [
    'RangeError: Array buffer allocation failed',
    'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    'memory allocation of 6442450944 bytes failed',
  ];

  const sandboxMemoryPhases = ['setup', 'lint', 'sast', 'build', 'test', 'facts'] as const;

  function sandboxMemoryConfig(
    phase: (typeof sandboxMemoryPhases)[number],
    executionTarget: 'local' | 'sandbox' = 'sandbox',
  ): ValidationEngineConfig {
    const marker = 'sandbox-memory-command';
    const common = baseConfig({ executionTarget });

    if (phase === 'setup') return { ...common, validationSetupCommand: marker };
    if (phase === 'lint') return { ...common, lintCommand: marker };
    if (phase === 'sast') return { ...common, sastCommand: marker };
    if (phase === 'build') return { ...common, buildCommand: marker };
    if (phase === 'test') return { ...common, testCommand: marker };

    return {
      ...common,
      diff: 'diff --git a/src/fact.ts b/src/fact.ts\n--- a/src/fact.ts\n+++ b/src/fact.ts\n+changed',
      contract: parseSpecContract(`contract_version: 1
title: Sandbox memory fact
depends_on: []
scenarios:
  - id: behavior
    given: ["state"]
    when: ["validated"]
    then: ["works"]
required_facts:
  - id: fact-sandbox-memory
    proves: [behavior]
    kind: unit-test
    artifact:
      path: src/fact.ts
      change: update
    command: ${marker}
human_review: []
`),
    };
  }

  function sandboxMemoryContainer(output: string, exitCode = 1): ContainerManager {
    const base = stubContainerManager();
    const execInContainer = vi.fn(async (_containerId: string, command: string[]) => {
      const shell = command[2] ?? '';
      if (shell.includes('sandbox-memory-command')) {
        return { stdout: '', stderr: output, exitCode };
      }
      if (shell.includes('sha256sum')) {
        return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    return { ...base, execInContainer } as ContainerManager;
  }

  it.each(
    sandboxMemoryPhases.flatMap((phase) =>
      sandboxMemorySignatures.map((signature) => ({ phase, signature })),
    ),
  )(
    'classifies $phase fatal sandbox memory output as infrastructure: $signature',
    async ({ phase, signature }) => {
      const engine = createLocalValidationEngine(sandboxMemoryContainer(signature));

      const result = await engine.validate(sandboxMemoryConfig(phase));

      expect(result.infrastructureFailure).toMatchObject({
        phase,
        code: 'SANDBOX_MEMORY_EXHAUSTED',
        retryable: false,
      });
      expect(result.overall).toBe('fail');
      expect(result.reviewSkipReason).toMatch(/validation infrastructure failed/i);
    },
  );

  it.each(sandboxMemorySignatures)(
    'keeps fatal memory output as an ordinary failure for local containers: %s',
    async (signature) => {
      const engine = createLocalValidationEngine(sandboxMemoryContainer(signature));

      const result = await engine.validate(sandboxMemoryConfig('lint', 'local'));

      expect(result.infrastructureFailure).toBeUndefined();
      expect(result.lint?.status).toBe('fail');
    },
  );

  it.each(['ENOMEM', 'tool reported out of memory while testing its error handling'])(
    'does not classify ambiguous sandbox memory wording as infrastructure: %s',
    async (output) => {
      const engine = createLocalValidationEngine(sandboxMemoryContainer(output));

      const result = await engine.validate(sandboxMemoryConfig('lint'));

      expect(result.infrastructureFailure).toBeUndefined();
      expect(result.lint?.status).toBe('fail');
    },
  );

  it('does not classify fatal memory text from a successful sandbox command', async () => {
    const engine = createLocalValidationEngine(
      sandboxMemoryContainer(sandboxMemorySignatures[0] ?? '', 0),
    );

    const result = await engine.validate(sandboxMemoryConfig('lint'));

    expect(result.infrastructureFailure).toBeUndefined();
    expect(result.lint?.status).toBe('pass');
  });

  it('classifies typed sandbox transport failures by validation phase', async () => {
    const cases: Array<{
      phase: 'setup' | 'lint' | 'sast' | 'build' | 'test';
      marker: string;
      config: Partial<ValidationEngineConfig>;
    }> = [
      {
        phase: 'setup',
        marker: 'infra-setup',
        config: { validationSetupCommand: 'infra-setup' },
      },
      { phase: 'lint', marker: 'infra-lint', config: { lintCommand: 'infra-lint' } },
      { phase: 'sast', marker: 'infra-sast', config: { sastCommand: 'infra-sast' } },
      { phase: 'build', marker: 'infra-build', config: { buildCommand: 'infra-build' } },
      { phase: 'test', marker: 'infra-test', config: { testCommand: 'infra-test' } },
    ];

    for (const testCase of cases) {
      const base = stubContainerManager();
      const execInContainer = vi.fn(
        async (
          _containerId: string,
          command: string[],
        ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
          const shell = command[2] ?? '';
          if (shell.includes(testCase.marker)) {
            throw new AutopodError(
              'Azure Sandboxes POST /executeShellCommand failed with 403',
              'AZURE_SANDBOX_HTTP_ERROR',
              403,
            );
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      );
      const cm = { ...base, execInContainer } as ContainerManager;
      const engine = createLocalValidationEngine(cm);

      const result = await engine.validate(baseConfig(testCase.config));

      expect(result.infrastructureFailure).toMatchObject({
        phase: testCase.phase,
        code: 'AZURE_SANDBOX_HTTP_ERROR',
        statusCode: 403,
        retryable: true,
      });
      expect(result.overall).toBe('fail');
      expect(result.reviewSkipReason).toMatch(/validation infrastructure failed/i);
      if (testCase.phase === 'lint') expect(result.lint?.status).toBe('skip');
      if (testCase.phase === 'sast') expect(result.sast?.status).toBe('skip');
      if (testCase.phase === 'test') expect(result.test?.status).toBe('skip');
    }

    const factBase = stubContainerManager();
    const factExec = vi.fn(async (_containerId: string, command: string[]) => {
      const shell = command[2] ?? '';
      if (shell.includes('infra-fact')) {
        throw new AutopodError(
          'Azure Sandboxes POST /executeShellCommand failed with 403',
          'AZURE_SANDBOX_HTTP_ERROR',
          403,
        );
      }
      if (shell.includes('sha256sum')) {
        return { stdout: 'abc123  src/fact.ts\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const factEngine = createLocalValidationEngine({
      ...factBase,
      execInContainer: factExec,
    } as ContainerManager);
    const factResult = await factEngine.validate(
      baseConfig({
        diff: 'diff --git a/src/fact.ts b/src/fact.ts\n--- a/src/fact.ts\n+++ b/src/fact.ts\n+changed',
        contract: parseSpecContract(`contract_version: 1
title: Infrastructure fact
depends_on: []
scenarios:
  - id: behavior
    given: ["state"]
    when: ["validated"]
    then: ["works"]
required_facts:
  - id: fact-infra
    proves: [behavior]
    kind: unit-test
    artifact:
      path: src/fact.ts
      change: update
    command: infra-fact
human_review: []
`),
      }),
    );

    expect(factResult.infrastructureFailure).toMatchObject({ phase: 'facts', retryable: true });
    expect(factResult.factValidation).toEqual({ status: 'skip', results: [] });
    expect(factResult.overall).toBe('fail');

    const healthBase = stubContainerManager();
    const healthExec = vi.fn(async (_containerId: string, command: string[]) => {
      const shell = command[2] ?? '';
      if (shell.includes('__AUTOPOD_STATUS__')) {
        throw new AutopodError(
          'Azure Sandboxes POST /executeShellCommand failed with 403',
          'AZURE_SANDBOX_HTTP_ERROR',
          403,
        );
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const healthEngine = createLocalValidationEngine({
      ...healthBase,
      execInContainer: healthExec,
    } as ContainerManager);
    const healthResult = await healthEngine.validate(
      baseConfig({
        hasWebUi: true,
        startCommand: 'node server.js',
        smokePages: [],
        webProbeMode: 'container',
      }),
    );

    expect(healthResult.infrastructureFailure).toMatchObject({ phase: 'health', retryable: true });
    expect(healthResult.smoke.health.status).toBe('skip');
    expect(healthResult.overall).toBe('fail');

    const pagesBase = stubContainerManager();
    const pagesExec = vi.fn(async (_containerId: string, command: string[]) => {
      const shell = command[2] ?? '';
      if (shell.includes('autopod-page-validation')) {
        throw new AutopodError(
          'Azure Sandboxes POST /executeShellCommand failed with 403',
          'AZURE_SANDBOX_HTTP_ERROR',
          403,
        );
      }
      if (shell.includes('__AUTOPOD_STATUS__')) {
        return { stdout: '__AUTOPOD_STATUS__200', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const pagesEngine = createLocalValidationEngine({
      ...pagesBase,
      execInContainer: pagesExec,
      writeFile: vi.fn().mockResolvedValue(undefined),
    } as ContainerManager);
    const pagesResult = await pagesEngine.validate(
      baseConfig({
        hasWebUi: true,
        startCommand: 'node server.js',
        smokePages: [{ path: '/' }],
        webProbeMode: 'container',
      }),
    );

    expect(pagesResult.infrastructureFailure).toMatchObject({ phase: 'pages', retryable: true });
    expect(pagesResult.smoke.pages).toEqual([]);
    expect(pagesResult.overall).toBe('fail');
  });

  it('does not mark a non-empty deterministic sandbox 403 as retryable', async () => {
    const base = stubContainerManager();
    const execInContainer = vi.fn(async (_containerId: string, command: string[]) => {
      const shell = command[2] ?? '';
      if (shell.includes('infra-lint')) {
        throw new AutopodError(
          'Azure Sandboxes POST /executeShellCommand failed with 403: RBAC denied',
          'AZURE_SANDBOX_HTTP_ERROR',
          403,
        );
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const engine = createLocalValidationEngine({ ...base, execInContainer } as ContainerManager);

    const result = await engine.validate(baseConfig({ lintCommand: 'infra-lint' }));

    expect(result.infrastructureFailure).toMatchObject({ phase: 'lint', retryable: false });
  });

  it('runs Facts + Review when all tier-1 phases pass-or-skip', async () => {
    // hasWebUi=false → health/pages auto-skip. No build/test/lint/sast commands
    // → those skip too. tier1Pass should be true and facts should be invoked.
    // diff='' makes the review short-circuit with 'No code changes detected',
    // which classifies as 'no-changes' (NOT upstream-failed).
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(baseConfig());

    expect(result.factValidation).toEqual({ status: 'skip', results: [] });
    // Review path was taken (no diff → 'no-changes' kind)
    expect(result.taskReview).toBeNull();
    expect(result.reviewSkipKind).toBe('no-changes');
    expect(result.reviewSkipReason).toBe('No code changes detected');
    expect(result.overall).toBe('pass');
  });

  it('runs a review-only second opinion without executing deterministic phases', async () => {
    vi.mocked(runClaudeCli).mockResolvedValueOnce({
      stdout: JSON.stringify({ status: 'pass', reasoning: 'fresh review', issues: [] }),
    });
    const cm = stubContainerManager();
    const started: string[] = [];
    const result = await createLocalValidationEngine(cm).validate(
      baseConfig({
        diff: '+const changed = true;',
        reviewerModel: 'claude-sonnet-4-6',
        reviewOnly: true,
        skipPhases: ['setup', 'lint', 'sast', 'build', 'test', 'health', 'pages', 'facts'],
      }),
      undefined,
      undefined,
      { onPhaseStarted: (phase) => started.push(phase) },
    );

    expect(started).toEqual(['review']);
    expect(cm.execInContainer).not.toHaveBeenCalled();
    expect(result.taskReview?.status).toBe('pass');
  });

  it('retries only Review after reviewer infrastructure failure', async () => {
    const reviewPass = JSON.stringify({
      status: 'pass',
      reasoning: 'retry completed',
      issues: [],
    });
    vi.mocked(runClaudeCli)
      .mockRejectedValueOnce(
        new CodexReviewError({
          kind: 'timeout',
          message: 'review deadline',
          stderr: 'first attempt diagnostic',
        }),
      )
      .mockResolvedValueOnce({
        stdout: reviewPass,
        tokenUsage: { inputTokens: 20, outputTokens: 5 },
      });
    const engine = createLocalValidationEngine(stubContainerManager());
    const completedPhases: string[] = [];
    const config = baseConfig({
      diff: '+const changed = true;',
      reviewerModel: 'claude-sonnet-4-6',
    });

    const recovered = await engine.validate(config, undefined, undefined, {
      onPhaseCompleted: (phase) => completedPhases.push(phase),
    });

    expect(recovered.overall).toBe('pass');
    expect(recovered.taskReview?.status).toBe('pass');
    expect(runClaudeCli).toHaveBeenCalledTimes(2);
    for (const phase of ['setup', 'lint', 'sast', 'build', 'test', 'health', 'pages', 'facts']) {
      expect(completedPhases.filter((completed) => completed === phase)).toHaveLength(1);
    }

    vi.mocked(runClaudeCli).mockReset();
    vi.mocked(runClaudeCli).mockRejectedValue(
      new CodexReviewError({
        kind: 'timeout',
        message: 'review deadline',
        stderr: 'bounded diagnostic',
      }),
    );
    const blockedCompletedPhases: string[] = [];
    const blocked = await engine.validate(config, undefined, undefined, {
      onPhaseCompleted: (phase) => blockedCompletedPhases.push(phase),
    });

    expect(runClaudeCli).toHaveBeenCalledTimes(2);
    expect(blocked).toMatchObject({
      overall: 'fail',
      taskReview: null,
      reviewSkipKind: 'review-timeout',
    });
    for (const phase of ['setup', 'lint', 'sast', 'build', 'test', 'health', 'pages', 'facts']) {
      expect(blockedCompletedPhases.filter((completed) => completed === phase)).toHaveLength(1);
    }
  });

  it('captures Tier 1 Claude review token usage', async () => {
    vi.mocked(runClaudeCli).mockResolvedValue({
      stdout: JSON.stringify({
        status: 'pass',
        reasoning: 'Claude reviewer passed',
        issues: [],
      }),
      tokenUsage: {
        inputTokens: 4321,
        cachedInputTokens: 3000,
        outputTokens: 123,
        costUsd: 0.045,
      },
    });
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(
      baseConfig({
        reviewerModel: 'claude-sonnet-4-6',
        diff: `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old
+new
`,
      }),
    );

    expect(result.taskReview).toMatchObject({
      status: 'pass',
      model: 'claude-sonnet-4-6',
      reasoning: 'Claude reviewer passed',
      tokenUsage: {
        inputTokens: 4321,
        cachedInputTokens: 3000,
        outputTokens: 123,
        costUsd: 0.045,
      },
    });
    expect(vi.mocked(runClaudeCli).mock.calls[0]?.[0]).toMatchObject({
      model: 'claude-sonnet-4-6',
      outputFormat: 'json',
    });
  });

  it('accumulates telemetry across newly executed task-review tiers', async () => {
    const worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), 'autopod-tiered-review-'));
    vi.mocked(runClaudeCli).mockResolvedValueOnce({
      stdout: JSON.stringify({
        status: 'uncertain',
        reasoning: 'Need repository context',
        issues: [],
      }),
      tokenUsage: { inputTokens: 100, outputTokens: 10 },
    });
    vi.mocked(runToolUseReview).mockResolvedValueOnce({
      stdout: JSON.stringify({
        status: 'pass',
        reasoning: 'Repository context resolves the concern',
        issues: [],
      }),
      tokenUsage: { inputTokens: 200, outputTokens: 20 },
    });
    const engine = createLocalValidationEngine(stubContainerManager());

    const result = await engine.validate(
      baseConfig({
        reviewerModel: 'claude-sonnet-4-6',
        reviewDepth: 'deep',
        worktreePath,
        diff: `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old
+new
`,
      }),
    );

    expect(result.taskReview).toMatchObject({
      status: 'pass',
      tokenUsage: {
        inputTokens: 300,
        outputTokens: 30,
      },
    });
    expect(result.taskReview?.tokenUsage?.costUsd).toBeGreaterThan(0);
    expect(runToolUseReview).toHaveBeenCalledTimes(1);
  });

  it('includes agentic telemetry when all three task-review tiers execute', async () => {
    const worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), 'autopod-agentic-review-'));
    vi.mocked(runClaudeCli).mockResolvedValueOnce({
      stdout: JSON.stringify({
        status: 'uncertain',
        reasoning: 'Need tool context',
        issues: [],
      }),
      tokenUsage: { inputTokens: 100, outputTokens: 10 },
    });
    vi.mocked(runToolUseReview).mockResolvedValueOnce({
      stdout: JSON.stringify({
        status: 'uncertain',
        reasoning: 'Need agentic context',
        issues: [],
      }),
      tokenUsage: { inputTokens: 200, outputTokens: 20 },
    });
    vi.mocked(runAgenticReview).mockResolvedValueOnce({
      stdout: JSON.stringify({
        status: 'pass',
        reasoning: 'Agentic review resolved the concern',
        issues: [],
      }),
      tokenUsage: {
        inputTokens: 300,
        cachedInputTokens: 120,
        outputTokens: 30,
        costUsd: 0.012,
      },
    });
    const engine = createLocalValidationEngine(stubContainerManager());

    const result = await engine.validate(
      baseConfig({
        reviewerModel: 'claude-sonnet-4-6',
        reviewDepth: 'deep',
        worktreePath,
        diff: `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old
+new
`,
      }),
    );

    expect(result.taskReview).toMatchObject({
      status: 'pass',
      tokenUsage: {
        inputTokens: 600,
        cachedInputTokens: 120,
        outputTokens: 60,
      },
    });
    expect(result.taskReview?.tokenUsage?.costUsd).toBeGreaterThan(0);
    expect(runAgenticReview).toHaveBeenCalledTimes(1);
  });

  it('retains structured overflow when Tier 3 falls back to Tier 2', async () => {
    const worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), 'autopod-overflow-fallback-'));
    vi.mocked(runClaudeCli).mockResolvedValueOnce({
      stdout: JSON.stringify({ status: 'uncertain', reasoning: 'tier 1', issues: [] }),
    });
    vi.mocked(runToolUseReview).mockResolvedValueOnce({
      stdout: JSON.stringify({
        status: 'uncertain',
        reasoning: 'overflow in tier 2',
        issues: Array.from({ length: 4_097 }, (_, index) => `finding ${index}`),
      }),
    });
    vi.mocked(runAgenticReview).mockResolvedValueOnce({ stdout: 'malformed' });
    const result = await createLocalValidationEngine(stubContainerManager()).validate(
      baseConfig({
        reviewerModel: 'claude-sonnet-4-6',
        reviewDepth: 'deep',
        validationSuite: 'deterministic',
        worktreePath,
        diff: `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+new
`,
      }),
    );
    expect(result.taskReview?.firstGateOverflow).toEqual({
      reportedCount: 4_097,
      retainedFindingCount: 4_096,
    });
    expect(result.taskReview?.status).toBe('fail');
  });

  it('runs Max full-validation Review through the live container Claude reviewer', async () => {
    const reviewerExecEnv = {
      CLAUDE_CODE_OAUTH_TOKEN_FILE: '/run/autopod/claude-code-oauth-token',
      POD_ID: 'pod-test',
    };
    const worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), 'autopod-max-review-'));
    const writeFile = vi.fn(async () => {});
    const getStatus = vi.fn(async () => 'running' as const);
    const execInContainer = vi.fn(
      async (
        _containerId: string,
        command: string[],
        options?: { env?: Record<string, string>; cwd?: string; timeout?: number },
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        const shell = command[2] ?? '';
        if (shell.includes('git reset --hard HEAD')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (shell.includes('/run/autopod/agent-shim.sh') && shell.includes('claude -p')) {
          expect(options?.env).toEqual(reviewerExecEnv);
          return {
            stdout: JSON.stringify({
              status: 'pass',
              reasoning: 'Container reviewer reached a verdict',
              issues: [],
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        throw new Error(`stub: execInContainer unexpectedly called: ${JSON.stringify(command)}`);
      },
    );
    const cm = {
      ...stubContainerManager(),
      writeFile,
      getStatus,
      execInContainer,
      supportsStreamingExec: true,
      execStreaming: vi.fn(async (containerId, command, options) => {
        const result = await execInContainer(containerId, command, options);
        const { PassThrough } = await import('node:stream');
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        stdout.end(result.stdout);
        stderr.end(result.stderr);
        return {
          stdout,
          stderr,
          exitCode: Promise.resolve(result.exitCode),
          kill: vi.fn(async () => {}),
        };
      }),
    } as unknown as ContainerManager;
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(
      baseConfig({
        reviewerProvider: 'max',
        reviewerProviderCredentials: {
          provider: 'max',
          authMode: 'setup-token',
          oauthToken: 'stored-token',
        },
        reviewerExecEnv,
        reviewerModel: 'claude-sonnet-4-6',
        reviewDepth: 'deep',
        worktreePath,
        diff: `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old
+new
`,
      }),
    );

    expect(result.taskReview).toMatchObject({
      status: 'pass',
      model: 'claude-sonnet-4-6',
      reasoning: 'Container reviewer reached a verdict',
    });
    expect(result.overall).toBe('pass');
    expect(vi.mocked(runClaudeCli)).not.toHaveBeenCalled();
    expect(createProviderAnthropicClient).not.toHaveBeenCalled();
    expect(runToolUseReview).not.toHaveBeenCalled();
    expect(getStatus).toHaveBeenCalledWith('container-test');
    expect(writeFile).toHaveBeenCalledWith(
      'container-test',
      expect.stringContaining('/tmp/autopod-claude-review-pod-test-'),
      expect.stringContaining('performing an independent code review'),
    );
    expect(execInContainer).toHaveBeenCalledTimes(3);
    expect(execInContainer.mock.calls[1]?.[0]).toBe('container-test');
    expect(execInContainer.mock.calls[1]?.[1].join(' ')).toContain('/run/autopod/agent-shim.sh');
    expect(execInContainer.mock.calls[1]?.[2]).toMatchObject({
      cwd: '/workspace',
      env: reviewerExecEnv,
    });
    expect(execInContainer.mock.calls[1]?.[2]).not.toHaveProperty('timeout');
  });

  it('fails Max Review clearly when no live container is available', async () => {
    const cm = {
      ...stubContainerManager(),
      getStatus: vi.fn(async () => 'stopped' as const),
    } as unknown as ContainerManager;
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(
      baseConfig({
        reviewerProvider: 'max',
        reviewerProviderCredentials: {
          provider: 'max',
          authMode: 'setup-token',
          oauthToken: 'stored-token',
        },
        reviewerExecEnv: {
          CLAUDE_CODE_OAUTH_TOKEN_FILE: '/run/autopod/claude-code-oauth-token',
        },
        reviewerModel: 'claude-sonnet-4-6',
        diff: `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old
+new
`,
      }),
    );

    expect(result.taskReview).toBeNull();
    expect(result.reviewSkipKind).toBe('review-failed');
    expect(result.reviewSkipReason).toContain(
      'Container reviewer unavailable: container is stopped (not running)',
    );
    expect(result.overall).toBe('fail');
    expect(createProviderAnthropicClient).not.toHaveBeenCalled();
    expect(runToolUseReview).not.toHaveBeenCalled();
  });

  it('keeps Foundry Anthropic validation Review on daemon provider auth', async () => {
    const messagesCreate = vi.fn().mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'pass',
            reasoning: 'Foundry Anthropic reviewer passed',
            issues: [],
          }),
        },
      ],
      usage: {
        input_tokens: 123,
        output_tokens: 45,
        cache_read_input_tokens: 6,
      },
    });
    vi.mocked(createProviderAnthropicClient).mockResolvedValue({
      ok: true,
      client: { messages: { create: messagesCreate } },
      model: 'claude-sonnet-4-6',
    } as Awaited<ReturnType<typeof createProviderAnthropicClient>>);
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(
      baseConfig({
        reviewerProvider: 'foundry',
        reviewerProviderCredentials: {
          provider: 'foundry',
          endpoint: 'https://foundry.example',
          projectId: 'project-test',
          apiKey: 'foundry-api-key',
          apiSurface: 'anthropic',
        },
        reviewerModel: 'claude-sonnet-4-6',
        diff: `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old
+new
`,
      }),
    );

    expect(result.taskReview).toMatchObject({
      status: 'pass',
      model: 'claude-sonnet-4-6',
      reasoning: 'Foundry Anthropic reviewer passed',
      tokenUsage: {
        inputTokens: 123,
        outputTokens: 45,
        cachedInputTokens: 6,
      },
    });
    expect(result.overall).toBe('pass');
    expect(vi.mocked(runClaudeCli)).not.toHaveBeenCalled();
    expect(createProviderAnthropicClient).toHaveBeenCalledWith(
      {
        provider: 'foundry',
        credentials: {
          provider: 'foundry',
          endpoint: 'https://foundry.example',
          projectId: 'project-test',
          apiKey: 'foundry-api-key',
          apiSurface: 'anthropic',
        },
        model: 'claude-sonnet-4-6',
        profileName: 'pod-test',
      },
      expect.anything(),
    );
    expect(messagesCreate).toHaveBeenCalledWith(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        messages: [
          {
            role: 'user',
            content: expect.stringContaining('performing an independent code review'),
          },
        ],
      },
      { timeout: 300_000 },
    );
    expect(vi.mocked(cm.execInContainer)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(cm.execInContainer).mock.calls[0]?.[1].join(' ')).toContain(
      'git reset --hard HEAD',
    );
  });

  it('runs OpenAI Review through Codex in the pod container', async () => {
    const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old
+new
`;
    vi.mocked(runCodexReview).mockResolvedValue({
      stdout: JSON.stringify({
        status: 'pass',
        reasoning: 'OpenAI reviewer passed',
        issues: [],
      }),
      tokenUsage: {
        inputTokens: 12_345,
        cachedInputTokens: 10_000,
        outputTokens: 678,
      },
    });
    const fetchMock = vi.fn(async () => new Response('quota exceeded', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);
    const reviewerExecEnv = {
      CODEX_HOME: '/run/autopod/codex-home',
      OPENAI_API_KEY_FILE: '/run/autopod/openai-api-key',
    };

    const result = await engine.validate(
      baseConfig({
        reviewerProvider: 'openai',
        reviewerProviderCredentials: {
          provider: 'openai',
          authMode: 'chatgpt',
          authJson: JSON.stringify({ tokens: { access_token: 'chatgpt-profile-token' } }),
        },
        reviewerModel: 'gpt-5',
        reviewerExecEnv,
        diff,
      }),
    );

    expect(result.overall).toBe('pass');
    expect(result.taskReview).toMatchObject({
      status: 'pass',
      model: 'gpt-5',
      reasoning: 'OpenAI reviewer passed',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runCodexReview).toHaveBeenCalledWith({
      podId: 'pod-test',
      attempt: 1,
      containerId: 'container-test',
      containerManager: cm,
      model: 'gpt-5',
      prompt: expect.stringContaining('## DIFF'),
      timeout: 300_000,
      env: reviewerExecEnv,
    });
    expect(vi.mocked(cm.execInContainer)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(cm.execInContainer).mock.calls[0]?.[1].join(' ')).toContain(
      'git reset --hard HEAD',
    );
    expect(result.taskReview?.tokenUsage).toEqual({
      inputTokens: 12_345,
      cachedInputTokens: 10_000,
      outputTokens: 678,
    });
  });

  it('blocks validation when OpenAI review times out', async () => {
    vi.mocked(runCodexReview).mockRejectedValue(
      new CodexReviewError({
        kind: 'timeout',
        message: 'codex review timed out after 300000ms',
      }),
    );
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);
    const completed: Array<{ phase: string; status: string }> = [];

    const result = await engine.validate(
      baseConfig({
        reviewerProvider: 'openai',
        reviewerModel: 'gpt-5',
        diff: `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old
+new
`,
      }),
      undefined,
      undefined,
      { onPhaseCompleted: (phase, status) => completed.push({ phase, status }) },
    );

    expect(result.taskReview).toBeNull();
    expect(result.reviewSkipKind).toBe('review-timeout');
    expect(result.reviewSkipReason).toMatch(/Review timed out: codex review timed out/);
    expect(result.overall).toBe('fail');
    expect(completed).toContainEqual({ phase: 'review', status: 'fail' });
  });

  it('blocks validation when OpenAI review fails after deterministic gates pass', async () => {
    vi.mocked(runCodexReview).mockRejectedValue(
      new CodexReviewError({
        kind: 'non-zero-exit',
        message: 'codex review failed (exit=2): reviewer process failed',
        exitCode: 2,
        stderr: 'reviewer process failed',
      }),
    );
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);
    const completed: Array<{ phase: string; status: string }> = [];

    const result = await engine.validate(
      baseConfig({
        reviewerProvider: 'openai',
        reviewerModel: 'gpt-5',
        diff: `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old
+new
`,
      }),
      undefined,
      undefined,
      { onPhaseCompleted: (phase, status) => completed.push({ phase, status }) },
    );

    expect(result.taskReview).toBeNull();
    expect(result.reviewSkipKind).toBe('review-failed');
    expect(result.reviewSkipReason).toContain('codex review failed (exit=2)');
    expect(result.overall).toBe('fail');
    expect(result.smoke.status).toBe('pass');
    expect(result.factValidation?.status).toBe('skip');
    expect(completed).toContainEqual({ phase: 'review', status: 'fail' });
  });

  it('marks profile-skip on Facts when skipPhases includes facts', async () => {
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(baseConfig({ skipPhases: ['facts'] }));

    expect(result.factValidation).toEqual({ status: 'skip', results: [] });
  });

  it('marks profile-skip on Review when skipPhases includes review', async () => {
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(baseConfig({ skipPhases: ['review'] }));

    expect(result.taskReview).toBeNull();
    expect(result.reviewSkipKind).toBe('profile-skip');
  });

  it('skips Pi task review instead of falling back to Claude', async () => {
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(
      baseConfig({
        reviewerProvider: 'pi',
        reviewerProviderCredentials: {
          provider: 'pi',
          providerId: 'anthropic',
          credential: { accessToken: 'pi-token' },
        },
        reviewerModel: 'anthropic/claude-sonnet-4',
        diff: `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-old
+new
`,
      }),
    );

    expect(result.taskReview).toBeNull();
    expect(result.reviewSkipKind).toBe('review-failed');
    expect(result.reviewSkipReason).toContain('provider pi is not supported');
    expect(vi.mocked(runClaudeCli)).not.toHaveBeenCalled();
    expect(vi.mocked(runCodexReview)).not.toHaveBeenCalled();
  });

  it('blocks validation as pending_human when a fact deviation awaits a decision', async () => {
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);
    const completed: Array<{ phase: string; status: string }> = [];

    const result = await engine.validate(
      baseConfig({
        contract: parseSpecContract(`contract_version: 1
title: Swift-only fact
depends_on: []
scenarios:
  - id: swift-helper-readable
    given: ["a Swift helper changed"]
    when: ["required facts run"]
    then: ["the helper remains readable"]
required_facts:
  - id: fact-swift-only
    proves: [swift-helper-readable]
    kind: unit-test
    artifact:
      path: packages/desktop/Tests/AutopodUITests/ThroughputTimeInStatusDisplayTests.swift
      change: update
    command: swift test --filter ThroughputTimeInStatusDisplayTests
human_review: []
`),
        taskSummary: {
          actualSummary: 'Updated the Swift helper.',
          deviations: [],
          factDeviations: [
            {
              factId: 'fact-swift-only',
              action: 'waive',
              reason: 'The artifact changed, but this verifier image has no Swift toolchain.',
              whyImpossible: 'The command exits 127 with "swift: not found".',
            },
          ],
        },
      }),
      undefined,
      undefined,
      { onPhaseCompleted: (phase, status) => completed.push({ phase, status }) },
    );

    expect(result.factValidation?.status).toBe('pending_human');
    expect(result.factValidation?.results[0]).toMatchObject({
      factId: 'fact-swift-only',
      passed: false,
      status: 'pending_human',
    });
    expect(result.reviewSkipReason).toBe('Skipped — required facts pending human decision');
    expect(result.overall).toBe('fail');
    expect(completed).toContainEqual({ phase: 'facts', status: 'pending_human' });
  });

  it('macOS desktop fact is deferred without execution of its Swift command', async () => {
    const execInContainer = vi.fn(
      async (
        _containerId: string,
        command: string[],
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        const shell = command[2] ?? '';
        if (shell.includes('git reset --hard HEAD')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (shell.includes('test -e')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (shell.includes('sha256sum')) {
          return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        }
        if (shell.includes('.autopod/evidence')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (shell.includes('swift test')) {
          throw new Error('macOS desktop fact command must not execute in a Linux pod');
        }
        throw new Error(`stub: execInContainer unexpectedly called: ${JSON.stringify(command)}`);
      },
    );
    const cm = { ...stubContainerManager(), execInContainer } as unknown as ContainerManager;
    const engine = createLocalValidationEngine(cm);
    const completed: Array<{ phase: string; status: string }> = [];

    const result = await engine.validate(
      baseConfig({
        diff: `diff --git a/packages/desktop/Tests/AutopodUITests/ThroughputTimeInStatusDisplayTests.swift b/packages/desktop/Tests/AutopodUITests/ThroughputTimeInStatusDisplayTests.swift
--- a/packages/desktop/Tests/AutopodUITests/ThroughputTimeInStatusDisplayTests.swift
+++ b/packages/desktop/Tests/AutopodUITests/ThroughputTimeInStatusDisplayTests.swift
@@ -1 +1 @@
-old
+new`,
        contract: parseSpecContract(`contract_version: 1
title: Swift-only fact
depends_on: []
scenarios:
  - id: swift-helper-readable
    given: ["a Swift helper changed"]
    when: ["required facts run"]
    then: ["the helper remains readable"]
required_facts:
  - id: fact-swift-only
    proves: [swift-helper-readable]
    kind: unit-test
    artifact:
      path: packages/desktop/Tests/AutopodUITests/ThroughputTimeInStatusDisplayTests.swift
      change: update
    command: swift test --filter ThroughputTimeInStatusDisplayTests
human_review: []
`),
      }),
      undefined,
      undefined,
      { onPhaseCompleted: (phase, status) => completed.push({ phase, status }) },
    );

    expect(result.factValidation?.status).toBe('pending_human');
    expect(result.factValidation?.results[0]).toMatchObject({
      factId: 'fact-swift-only',
      passed: false,
      status: 'pending_human',
    });
    expect(result.factValidation?.results[0]?.exitCode).toBeUndefined();
    expect(result.factValidation?.results[0]?.reasoning).toContain('command was not attempted');
    expect(
      execInContainer.mock.calls.some(([, command]) => command[2]?.includes('swift test')),
    ).toBe(false);
    expect(result.reviewSkipReason).toBe('Skipped — required facts pending human decision');
    expect(result.overall).toBe('fail');
    expect(completed).toContainEqual({ phase: 'facts', status: 'pending_human' });
  });

  it('passes waived fact deviations after human approval', async () => {
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(
      baseConfig({
        contract: parseSpecContract(`contract_version: 1
title: Swift-only fact
depends_on: []
scenarios:
  - id: swift-helper-readable
    given: ["a Swift helper changed"]
    when: ["required facts run"]
    then: ["the helper remains readable"]
required_facts:
  - id: fact-swift-only
    proves: [swift-helper-readable]
    kind: unit-test
    artifact:
      path: packages/desktop/Tests/AutopodUITests/ThroughputTimeInStatusDisplayTests.swift
      change: update
    command: swift test --filter ThroughputTimeInStatusDisplayTests
human_review: []
`),
        taskSummary: {
          actualSummary: 'Updated the Swift helper.',
          deviations: [],
          factDeviations: [
            {
              factId: 'fact-swift-only',
              action: 'waive',
              decision: 'approved_waive',
              reason: 'The artifact changed, but this verifier image has no Swift toolchain.',
              whyImpossible: 'The command exits 127 with "swift: not found".',
            },
          ],
        },
      }),
    );

    expect(result.factValidation?.status).toBe('pass');
    expect(result.factValidation?.results[0]).toMatchObject({
      factId: 'fact-swift-only',
      passed: true,
      status: 'waived',
    });
    expect(result.overall).toBe('pass');
  });
});

// ── Pre-validation worktree reset (regression for `sporting-coral`) ─────────────
// Untracked files were being picked up by the build (filesystem walk, not git
// index) and read by the agentic reviewer (unrestricted Read on worktreePath),
// driving false-positive validation failures. The fix runs
// `git reset --hard HEAD && git clean -fd` against both the container and host
// worktrees at the top of validate(), before phase 1.

describe('validate() — pre-validation worktree reset', () => {
  const execFileAsync = promisify(execFile);

  function recordingContainerManager(): {
    cm: ContainerManager;
    calls: { command: string[]; cwd?: string }[];
  } {
    const calls: { command: string[]; cwd?: string }[] = [];
    const fail = (name: string) =>
      vi.fn(() => Promise.reject(new Error(`stub: ${name} unexpectedly called`)));
    const execInContainer = vi.fn(
      async (
        _containerId: string,
        command: string[],
        options?: { cwd?: string },
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        calls.push({ command, cwd: options?.cwd });
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );
    const cm = {
      spawn: fail('spawn'),
      kill: fail('kill'),
      refreshFirewall: fail('refreshFirewall'),
      stop: fail('stop'),
      start: fail('start'),
      writeFile: fail('writeFile'),
      readFile: fail('readFile'),
      extractDirectoryFromContainer: fail('extractDirectoryFromContainer'),
      getStatus: fail('getStatus'),
      execInContainer,
      execStreaming: fail('execStreaming'),
    } as unknown as ContainerManager;
    return { cm, calls };
  }

  function minimalConfig(overrides: Partial<ValidationEngineConfig> = {}): ValidationEngineConfig {
    return {
      podId: 'pod-test',
      containerId: 'container-test',
      previewUrl: 'http://127.0.0.1:9999',
      buildCommand: '',
      startCommand: '',
      healthPath: '/',
      healthTimeout: 1,
      smokePages: [],
      attempt: 1,
      task: 'test task',
      diff: '',
      hasWebUi: false,
      skipPhases: ['review'],
      ...overrides,
    };
  }

  it('issues git reset + clean inside the container at /workspace before phase 1', async () => {
    const { cm, calls } = recordingContainerManager();
    const engine = createLocalValidationEngine(cm);

    await engine.validate(minimalConfig());

    expect(calls).toHaveLength(1);
    const first = calls[0];
    expect(first).toBeDefined();
    if (!first) throw new Error('expected at least one execInContainer call');
    expect(first.cwd).toBe('/workspace');
    expect(first.command[0]).toBe('sh');
    expect(first.command[1]).toBe('-c');
    expect(first.command[2]).toContain('git reset --hard HEAD');
    expect(first.command[2]).toContain('git clean -fd');
  });

  it('uses /workspace for cleanup even when buildWorkDir is set', async () => {
    // Cleanup is deliberately NOT scoped to buildWorkDir — we want untracked
    // files anywhere in the repo gone, not just under the build subdir.
    const { cm, calls } = recordingContainerManager();
    const engine = createLocalValidationEngine(cm);

    await engine.validate(minimalConfig({ buildWorkDir: 'apps/web' }));

    const cleanup = calls[0];
    expect(cleanup).toBeDefined();
    if (!cleanup) throw new Error('expected at least one execInContainer call');
    expect(cleanup.cwd).toBe('/workspace');
  });

  it('cleans untracked + uncommitted files on the host worktree when worktreePath is set', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopod-reset-'));
    try {
      await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: tmpDir });
      await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
      await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpDir });

      // Committed file → must survive cleanup.
      await fs.writeFile(path.join(tmpDir, 'README.md'), '# committed\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: tmpDir });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

      // Untracked file → must be removed (the `sporting-coral` failure mode).
      await fs.writeFile(path.join(tmpDir, 'AADGroups.cs'), 'using PF.Graph;\n');
      // Uncommitted modification of a tracked file → must be reverted.
      await fs.writeFile(path.join(tmpDir, 'README.md'), '# modified locally\n');

      // Sanity: status is dirty before validation.
      const dirty = await execFileAsync('git', ['status', '--porcelain'], { cwd: tmpDir });
      expect(dirty.stdout).toContain('AADGroups.cs');
      expect(dirty.stdout).toContain('README.md');

      const { cm } = recordingContainerManager();
      const engine = createLocalValidationEngine(cm);

      await engine.validate(minimalConfig({ worktreePath: tmpDir }));

      // After cleanup: no untracked, no modifications.
      const clean = await execFileAsync('git', ['status', '--porcelain'], { cwd: tmpDir });
      expect(clean.stdout.trim()).toBe('');

      // Untracked file is gone, committed file is restored to HEAD content.
      await expect(fs.access(path.join(tmpDir, 'AADGroups.cs'))).rejects.toThrow();
      const readme = await fs.readFile(path.join(tmpDir, 'README.md'), 'utf-8');
      expect(readme).toBe('# committed\n');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('preserves gitignored files (build caches) on the host worktree', async () => {
    // `git clean -fd` (without -x) must not nuke node_modules / dist / etc.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopod-reset-ign-'));
    try {
      await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: tmpDir });
      await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
      await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpDir });

      await fs.writeFile(path.join(tmpDir, '.gitignore'), 'node_modules/\ndist/\n');
      await fs.writeFile(path.join(tmpDir, 'README.md'), '# committed\n');
      await execFileAsync('git', ['add', '.'], { cwd: tmpDir });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

      // Gitignored caches with content.
      await fs.mkdir(path.join(tmpDir, 'node_modules'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg.txt'), 'cached');
      await fs.mkdir(path.join(tmpDir, 'dist'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'dist', 'bundle.js'), 'compiled');

      const { cm } = recordingContainerManager();
      const engine = createLocalValidationEngine(cm);

      await engine.validate(minimalConfig({ worktreePath: tmpDir }));

      await expect(
        fs.access(path.join(tmpDir, 'node_modules', 'pkg.txt')),
      ).resolves.toBeUndefined();
      await expect(fs.access(path.join(tmpDir, 'dist', 'bundle.js'))).resolves.toBeUndefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not throw when host cleanup fails (degraded, not broken)', async () => {
    // Point worktreePath at a non-git directory; the host-side reset will fail.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopod-reset-broken-'));
    try {
      const { cm } = recordingContainerManager();
      const engine = createLocalValidationEngine(cm);

      // Should not throw — failure is logged and validation continues.
      await expect(engine.validate(minimalConfig({ worktreePath: tmpDir }))).resolves.toBeDefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips host-side cleanup silently when worktreePath is omitted', async () => {
    const { cm, calls } = recordingContainerManager();
    const engine = createLocalValidationEngine(cm);

    await engine.validate(minimalConfig()); // no worktreePath

    // Container cleanup still runs.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command[2]).toContain('git reset --hard HEAD');
  });
});

describe('parseWarningCount', () => {
  it('reads MSBuild trailing summary as the authoritative count', () => {
    const output = [
      'Infrastructure net10.0 succeeded with 3 warning(s) (2.4s)',
      '  /repo/Foo.cs(16,46): warning S1075: Refactor your code',
      'Build succeeded with 3 warning(s) in 17.8s',
    ].join('\n');
    expect(parseWarningCount(output)).toBe(3);
  });

  it('falls back to summing per-project lines when no trailing summary is present', () => {
    const output = [
      'ProjectA net10.0 succeeded with 2 warning(s) (1.0s)',
      'ProjectB net10.0 succeeded with 5 warning(s) (1.0s)',
    ].join('\n');
    expect(parseWarningCount(output)).toBe(7);
  });

  it('falls back to per-line "warning CODE:" when no summary is present', () => {
    const output = [
      '/repo/Foo.cs(16,46): warning S1075: Refactor your code',
      '/repo/Bar.cs(56,26): warning S2139: Either log this exception',
      '/repo/Baz.cs(143,26): warning CS1591: Missing XML comment',
    ].join('\n');
    expect(parseWarningCount(output)).toBe(3);
  });

  it('returns 0 for clean output', () => {
    expect(parseWarningCount('Build succeeded.\n  0 Warning(s)\n  0 Error(s)')).toBe(0);
    expect(parseWarningCount('')).toBe(0);
  });

  it('does not match a path that contains the substring "warning"', () => {
    // The fallback regex is anchored on "path(line,col): warning CODE:" — a path
    // segment named "warning" without that structure must not be counted.
    const output = '/repo/warning-test/foo.cs(1,1): error CS001: Something broke';
    expect(parseWarningCount(output)).toBe(0);
  });

  it('prefers trailing summary even when per-project lines disagree (truncated output)', () => {
    // If the per-project lines were truncated mid-build but the trailer made it
    // through, trust the trailer.
    const output = 'Build succeeded with 5 warning(s) in 17.8s';
    expect(parseWarningCount(output)).toBe(5);
  });
});

describe('runBuild — warning policy', () => {
  function baseConfigForBuild(buildCommand: string): ValidationEngineConfig {
    return {
      podId: 'pod-test',
      containerId: 'container-test',
      previewUrl: 'http://127.0.0.1:9999',
      buildCommand,
      startCommand: 'node server.js',
      healthPath: '/',
      healthTimeout: 1,
      smokePages: [{ path: '/' }],
      attempt: 1,
      task: 'test task',
      diff: '',
      hasWebUi: false,
    };
  }

  function containerManagerWithBuildOutput(stdout: string, exitCode: number): ContainerManager {
    return {
      spawn: vi.fn(),
      kill: vi.fn(),
      refreshFirewall: vi.fn(),
      stop: vi.fn(),
      start: vi.fn(),
      writeFile: vi.fn(),
      readFile: vi.fn(),
      extractDirectoryFromContainer: vi.fn(),
      getStatus: vi.fn(),
      execInContainer: vi.fn(async (_id: string, cmd: string[]) => {
        // The pre-build healing exec calls (find for 0-byte stubs, chmod for native bins)
        // run via `sh -c "find ..."` — return empty stdout so the heal paths are skipped.
        const joined = cmd.join(' ');
        if (joined.includes('-empty -print') || joined.includes('chmod +x')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        // The actual buildCommand exec — return our crafted output.
        return { stdout, stderr: '', exitCode };
      }),
      execStreaming: vi.fn(),
    } as unknown as ContainerManager;
  }

  it("keeps status 'pass' when exit 0 but warnings are present", async () => {
    const cm = containerManagerWithBuildOutput(
      'Restore complete (1.0s)\nBuild succeeded with 3 warning(s) in 17.8s',
      0,
    );
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(baseConfigForBuild('dotnet build'));

    expect(result.smoke.build.status).toBe('pass');
    expect(result.smoke.build.warningCount).toBe(3);
    expect(result.smoke.build.output).not.toContain('Build exited 0 but emitted');
    expect(result.smoke.build.output).not.toContain('--- build output ---');
  });

  it('repairs root-owned package binaries as root before building as autopod', async () => {
    let binaryRepaired = false;
    const execInContainer = vi.fn(
      async (
        _containerId: string,
        command: string[],
        options?: { user?: string },
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        const shell = command.join(' ');
        if (shell.includes('-empty -print')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (shell.includes('node_modules/.bin') && shell.includes('chmod')) {
          binaryRepaired = options?.user === 'root' && shell.includes('chmod a+rx');
          return {
            stdout: '',
            stderr: binaryRepaired ? '' : 'Operation not permitted',
            exitCode: binaryRepaired ? 0 : 1,
          };
        }
        if (shell.includes('pnpm build')) {
          return binaryRepaired
            ? { stdout: 'Build succeeded.', stderr: '', exitCode: 0 }
            : {
                stdout: '',
                stderr:
                  "EACCES: permission denied, open '/workspace/packages/pi-worker/node_modules/.bin/tsup'",
                exitCode: 1,
              };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );
    const cm = {
      ...containerManagerWithBuildOutput('', 0),
      execInContainer,
    } as unknown as ContainerManager;
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(baseConfigForBuild('npx pnpm build'));

    expect(result.smoke.build.status).toBe('pass');
    expect(binaryRepaired).toBe(true);
  });

  it("keeps status 'pass' when exit 0 and no warnings", async () => {
    const cm = containerManagerWithBuildOutput('Build succeeded.\n  0 Warning(s)\n  0 Error(s)', 0);
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(baseConfigForBuild('dotnet build'));

    expect(result.smoke.build.status).toBe('pass');
    expect(result.smoke.build.warningCount).toBe(0);
    expect(result.smoke.build.output).not.toContain('exited 0 but emitted');
  });

  it('fails when project warning policy makes the build exit nonzero', async () => {
    const cm = containerManagerWithBuildOutput(
      'Foo.cs(10,5): error CS8618: Non-nullable property must contain a non-null value',
      1,
    );
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(baseConfigForBuild('dotnet build'));

    expect(result.smoke.build.status).toBe('fail');
    expect(result.smoke.build.output).toContain('error CS8618');
    expect(result.smoke.build.output).not.toContain('Build exited 0 but emitted');
  });

  it('reports warningCount on a real failure (exit nonzero) without overriding status reasoning', async () => {
    // A genuine build failure may also emit warnings before erroring out.
    // The warning count is still informative, but the failure stands on its own.
    const cm = containerManagerWithBuildOutput(
      'Foo.cs(10,5): warning S1075: hardcoded URI\nBar.cs(20,5): error CS1002: ;',
      1,
    );
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(baseConfigForBuild('dotnet build'));

    expect(result.smoke.build.status).toBe('fail');
    // The output is the raw build output, since the build legitimately failed
    // via exit code.
    expect(result.smoke.build.output).not.toContain('Build exited 0 but emitted');
  });
});

// ── Preview supervisor integration tests ─────────────────────────────────────

describe('runHealthCheck — supervisor spawn', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeConfig(overrides: Partial<ValidationEngineConfig> = {}): ValidationEngineConfig {
    return {
      podId: 'pod-hc',
      containerId: 'c-hc',
      previewUrl: 'http://127.0.0.1:9001',
      buildCommand: '',
      startCommand: 'pnpm dev',
      healthPath: '/health',
      healthTimeout: 5,
      smokePages: [],
      attempt: 1,
      task: 'test',
      diff: '',
      ...overrides,
    };
  }

  it('invokes buildSupervisorCommand exactly once and does not tear it down', async () => {
    const execCalls: string[] = [];
    const cm = {
      execInContainer: vi.fn(async (_id: string, cmd: string[]) => {
        if (cmd[2]) execCalls.push(cmd[2]);
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    } as unknown as ContainerManager;

    // Health check resolves immediately with 200
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 200, text: () => Promise.resolve('ok') }),
    );

    await runHealthCheck(cm, makeConfig());

    const supervisorCalls = execCalls.filter((c) => c.includes('export START_COMMAND'));
    expect(supervisorCalls).toHaveLength(1);
    // No kill of the supervisor PID at the end of the phase
    const killCalls = execCalls.filter(
      (c) => c.includes('kill -9') && c.includes('autopod-supervisor.pid'),
    );
    expect(killCalls).toHaveLength(0);
  });

  it('passes validation exec env to the supervised start command', async () => {
    const execInContainer = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const cm = { execInContainer } as unknown as ContainerManager;
    const extraExecEnv = {
      VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_SUPABASE_ANON_KEY: 'public-test-key',
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 200, text: () => Promise.resolve('ok') }),
    );

    await runHealthCheck(cm, makeConfig({ extraExecEnv }));

    expect(execInContainer).toHaveBeenCalledWith(
      'c-hc',
      expect.arrayContaining(['sh', '-c']),
      expect.objectContaining({ cwd: '/workspace', env: extraExecEnv }),
    );
  });

  it('probes containerBaseUrl through container exec in container probe mode', async () => {
    const execCalls: string[] = [];
    const cm = {
      execInContainer: vi.fn(async (_id: string, cmd: string[]) => {
        const shell = cmd[2] ?? cmd.join(' ');
        execCalls.push(shell);
        if (shell.includes('export START_COMMAND')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (shell.includes('__AUTOPOD_STATUS__')) {
          return {
            stdout: '__AUTOPOD_STATUS__204\n__AUTOPOD_BODY__\n\n__AUTOPOD_ERROR__\n',
            stderr: '',
            exitCode: 0,
          };
        }
        throw new Error(`unexpected exec: ${JSON.stringify(cmd)}`);
      }),
    } as unknown as ContainerManager;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('host URL should not be used')));

    const result = await runHealthCheck(
      cm,
      makeConfig({
        previewUrl: 'http://127.0.0.1:32541',
        containerBaseUrl: 'http://127.0.0.1:3000',
        webProbeMode: 'container',
      }),
    );

    expect(result).toMatchObject({
      status: 'pass',
      url: 'http://127.0.0.1:3000/health',
      responseCode: 204,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(execCalls.some((call) => call.includes('http://127.0.0.1:3000/health'))).toBe(true);
  });

  it('skips supervisor spawn when no startCommand is configured', async () => {
    const execCalls: string[] = [];
    const cm = {
      execInContainer: vi.fn(async (_id: string, cmd: string[]) => {
        if (cmd[2]) execCalls.push(cmd[2]);
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    } as unknown as ContainerManager;

    // No fetch needed — without startCommand the health check returns pass immediately
    const result = await runHealthCheck(cm, makeConfig({ startCommand: undefined }));

    expect(result.status).toBe('pass');
    const supervisorCalls = execCalls.filter((c) => c.includes('export START_COMMAND'));
    expect(supervisorCalls).toHaveLength(0);
  });
});

describe('startAppStabilityMonitor — regression guard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fires onCrash after 2 consecutive fetch failures', async () => {
    vi.useFakeTimers();
    let fetchCallCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchCallCount++;
        throw new Error('ECONNREFUSED');
      }),
    );

    const onCrash = vi.fn();
    startAppStabilityMonitor('http://127.0.0.1:9003/health', onCrash);

    // Advance past initial delay + 2 poll intervals (5s each)
    await vi.advanceTimersByTimeAsync(5_100); // initial delay
    await vi.advanceTimersByTimeAsync(5_100); // poll 1 failure
    await vi.advanceTimersByTimeAsync(5_100); // poll 2 failure → crash

    expect(onCrash).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('stop function prevents onCrash from firing', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const onCrash = vi.fn();
    const stop = startAppStabilityMonitor('http://127.0.0.1:9004/health', onCrash);
    stop();

    await vi.advanceTimersByTimeAsync(20_000);

    expect(onCrash).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
