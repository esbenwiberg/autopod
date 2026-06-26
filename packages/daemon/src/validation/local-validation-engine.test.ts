import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseSpecContract } from '@autopod/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type {
  ValidationEngineConfig,
  ValidationPhaseCallbacks,
} from '../interfaces/validation-engine.js';
import { runClaudeCli } from '../runtimes/run-claude-cli.js';
import type { HostBrowserRunner } from './host-browser-runner.js';
import {
  artifactChangeSatisfied,
  buildReviewPrompt,
  createLocalValidationEngine,
  enforceRequirementsStatus,
  normalizeReviewIssue,
  parseReviewJson,
  parseWarningCount,
  runHealthCheck,
  startAppStabilityMonitor,
  stripMarkdownFences,
} from './local-validation-engine.js';

vi.mock('../runtimes/run-claude-cli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtimes/run-claude-cli.js')>();
  return {
    ...actual,
    runClaudeCli: vi.fn(),
  };
});

beforeEach(() => {
  vi.mocked(runClaudeCli).mockReset();
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

  function codexReviewContainerManager(options?: {
    reviewStdout?: string;
    reviewLog?: string;
    reviewError?: Error;
    commands?: string[];
    prompts?: string[];
  }): ContainerManager {
    const fail = (name: string) =>
      vi.fn(() => Promise.reject(new Error(`stub: ${name} unexpectedly called`)));
    const execInContainer = vi.fn(
      async (
        _containerId: string,
        command: string[],
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        const shell = command[2] ?? '';
        options?.commands?.push(shell);
        if (
          command[0] === 'sh' &&
          command[1] === '-c' &&
          typeof shell === 'string' &&
          shell.includes('git reset --hard HEAD')
        ) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (typeof shell === 'string' && shell.includes('codex exec')) {
          if (options?.reviewError) throw options.reviewError;
          return {
            stdout:
              options?.reviewStdout ??
              JSON.stringify({
                status: 'pass',
                reasoning: 'Codex reviewer passed',
                issues: [],
              }),
            stderr: '',
            exitCode: 0,
          };
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
      writeFile: vi.fn(async (_containerId: string, _path: string, content: string | Buffer) => {
        options?.prompts?.push(String(content));
      }),
      readFile: vi.fn(async (_containerId: string, path: string) => {
        if (path.includes('/tmp/autopod-codex-review-') && path.endsWith('.log')) {
          return options?.reviewLog ?? '';
        }
        throw new Error(`stub: readFile unexpectedly called: ${path}`);
      }),
      readFileBinary: fail('readFileBinary'),
      extractDirectoryFromContainer: fail('extractDirectoryFromContainer'),
      getStatus: fail('getStatus'),
      execInContainer,
      execStreaming: fail('execStreaming'),
    } as unknown as ContainerManager;
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

  it('skips Facts + Review when tests fail', async () => {
    const cm = stubContainerManager();
    const engine = createLocalValidationEngine(cm);

    const result = await engine.validate(baseConfig({ testCommand: 'vitest' }));

    expect(result.test?.status).toBe('fail');
    expect(result.factValidation?.status).toBe('skip');
    expect(result.reviewSkipKind).toBe('upstream-failed');
    expect(result.overall).toBe('fail');
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

  it('runs Review through Codex for OpenAI reviewer profiles', async () => {
    const commands: string[] = [];
    const prompts: string[] = [];
    const cm = codexReviewContainerManager({
      commands,
      prompts,
      reviewLog: JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 12_345,
              cached_input_tokens: 10_000,
              output_tokens: 678,
            },
          },
        },
      }),
    });
    const engine = createLocalValidationEngine(cm);

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
    );

    expect(result.overall).toBe('pass');
    expect(result.taskReview).toMatchObject({
      status: 'pass',
      model: 'gpt-5',
      reasoning: 'Codex reviewer passed',
    });
    expect(commands.some((cmd) => cmd.includes('codex exec'))).toBe(true);
    expect(commands.some((cmd) => cmd.includes("--model 'gpt-5'"))).toBe(true);
    expect(prompts[0]).toContain('## DIFF');
    expect(result.taskReview?.tokenUsage).toEqual({
      inputTokens: 12_345,
      cachedInputTokens: 10_000,
      outputTokens: 678,
    });
  });

  it('blocks validation when Codex review times out', async () => {
    const cm = codexReviewContainerManager({
      reviewError: new Error('Command timed out after 300000ms'),
    });
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
    expect(result.reviewSkipReason).toMatch(/Review timed out:/);
    expect(result.overall).toBe('fail');
    expect(completed).toContainEqual({ phase: 'review', status: 'fail' });
  });

  it('blocks validation when Codex review fails after deterministic gates pass', async () => {
    const cm = codexReviewContainerManager({
      reviewError: new Error('codex review exited with code 2'),
    });
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
    expect(result.reviewSkipReason).toContain('codex review exited with code 2');
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

  it('blocks validation as pending_human when a required fact command is unavailable', async () => {
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
          return { stdout: '', stderr: 'sh: 1: swift: not found\n', exitCode: 127 };
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
      exitCode: 127,
    });
    expect(result.factValidation?.results[0]?.reasoning).toContain(
      'required fact command `swift` is unavailable',
    );
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
