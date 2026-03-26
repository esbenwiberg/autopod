import type { Session, ValidationResult } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import type { StoredValidation } from '../sessions/validation-repository.js';
import { generateValidationReport } from './report-generator.js';

function createTestSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-001',
    profileName: 'test-app',
    task: 'Add a settings page',
    status: 'validated',
    model: 'sonnet',
    runtime: 'claude',
    executionTarget: 'docker',
    branch: 'autopod/sess-001',
    containerId: 'container-123',
    worktreePath: '/tmp/worktree/test',
    validationAttempts: 1,
    maxValidationAttempts: 3,
    lastValidationResult: null,
    pendingEscalation: null,
    escalationCount: 0,
    skipValidation: false,
    createdAt: '2026-03-26T10:00:00Z',
    startedAt: '2026-03-26T10:01:00Z',
    completedAt: null,
    updatedAt: '2026-03-26T10:05:00Z',
    userId: 'user-1',
    filesChanged: 5,
    linesAdded: 120,
    linesRemoved: 30,
    previewUrl: null,
    prUrl: 'https://github.com/org/repo/pull/42',
    plan: null,
    progress: null,
    acceptanceCriteria: null,
    claudeSessionId: null,
    ...overrides,
  };
}

function createPassingResult(attempt: number): ValidationResult {
  return {
    sessionId: 'sess-001',
    attempt,
    timestamp: '2026-03-26T10:05:00Z',
    smoke: {
      status: 'pass',
      build: { status: 'pass', output: 'Build succeeded', duration: 5000 },
      health: { status: 'pass', url: 'http://localhost:3000/', responseCode: 200, duration: 500 },
      pages: [
        {
          path: '/',
          status: 'pass',
          screenshotPath: '/tmp/screenshots/home.png',
          screenshotBase64: 'iVBORw0KGgo=',
          consoleErrors: [],
          assertions: [
            {
              selector: 'h1',
              type: 'exists',
              expected: undefined,
              actual: undefined,
              passed: true,
            },
          ],
          loadTime: 320,
        },
      ],
    },
    test: { status: 'pass', duration: 3000, stdout: 'All tests passed' },
    taskReview: {
      status: 'pass',
      reasoning: 'The settings page has been implemented correctly.',
      issues: [],
      model: 'sonnet',
      screenshots: [],
      diff: '--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n+import Settings from "./Settings"',
    },
    overall: 'pass',
    duration: 10000,
  };
}

function createFailingResult(attempt: number): ValidationResult {
  return {
    sessionId: 'sess-001',
    attempt,
    timestamp: '2026-03-26T10:03:00Z',
    smoke: {
      status: 'fail',
      build: { status: 'pass', output: 'Build succeeded', duration: 5000 },
      health: { status: 'pass', url: 'http://localhost:3000/', responseCode: 200, duration: 500 },
      pages: [
        {
          path: '/settings',
          status: 'fail',
          screenshotPath: '/tmp/screenshots/settings.png',
          consoleErrors: ['TypeError: Cannot read property "theme" of undefined'],
          assertions: [
            {
              selector: '.settings-toggle',
              type: 'exists',
              expected: undefined,
              actual: undefined,
              passed: false,
            },
            {
              selector: 'h2',
              type: 'text_contains',
              expected: 'Settings',
              actual: 'Error',
              passed: false,
            },
          ],
          loadTime: 1200,
        },
      ],
    },
    taskReview: {
      status: 'fail',
      reasoning: 'The settings page crashes on load.',
      issues: ['Missing null check for theme context', 'Settings toggle not rendered'],
      model: 'sonnet',
      screenshots: [],
      diff: '--- a/src/Settings.tsx\n+++ b/src/Settings.tsx',
    },
    overall: 'fail',
    duration: 8000,
  };
}

function toStoredValidation(result: ValidationResult): StoredValidation {
  const screenshots: string[] = [];
  for (const page of result.smoke.pages) {
    if (page.screenshotBase64) screenshots.push(page.screenshotBase64);
  }
  return {
    id: `val-${result.attempt}`,
    sessionId: result.sessionId,
    attempt: result.attempt,
    result,
    screenshots,
    createdAt: result.timestamp,
  };
}

describe('generateValidationReport', () => {
  it('generates valid HTML with session header', () => {
    const session = createTestSession();
    const html = generateValidationReport(session, []);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('sess-001');
    expect(html).toContain('Add a settings page');
    expect(html).toContain('test-app');
    expect(html).toContain('validated');
    expect(html).toContain('https://github.com/org/repo/pull/42');
  });

  it('shows "no validations" message when empty', () => {
    const html = generateValidationReport(createTestSession(), []);
    expect(html).toContain('No validation attempts yet');
  });

  it('renders a single passing attempt', () => {
    const result = createPassingResult(1);
    const stored = toStoredValidation(result);
    const html = generateValidationReport(createTestSession(), [stored]);

    expect(html).toContain('Attempt 1');
    expect(html).toContain('Build');
    expect(html).toContain('Build succeeded');
    expect(html).toContain('Health Check');
    expect(html).toContain('200');
    expect(html).toContain('Smoke Pages (1)');
    expect(html).toContain('data:image/png;base64,iVBORw0KGgo=');
    expect(html).toContain('AI Task Review');
    expect(html).toContain('settings page has been implemented');
    expect(html).toContain('Tests');
    expect(html).toContain('All tests passed');
  });

  it('renders a failing attempt with issues and console errors', () => {
    const result = createFailingResult(1);
    const stored = toStoredValidation(result);
    const html = generateValidationReport(createTestSession(), [stored]);

    expect(html).toContain('Console errors');
    expect(html).toContain('TypeError: Cannot read property');
    expect(html).toContain('Missing null check');
    expect(html).toContain('Settings toggle not rendered');
    expect(html).toContain('.settings-toggle');
  });

  it('renders multiple attempts with timeline tabs', () => {
    const v1 = toStoredValidation(createFailingResult(1));
    const v2 = toStoredValidation(createPassingResult(2));
    const html = generateValidationReport(createTestSession({ validationAttempts: 2 }), [v1, v2]);

    expect(html).toContain('tab-1');
    expect(html).toContain('tab-2');
    expect(html).toContain('Attempt 1');
    expect(html).toContain('Attempt 2');
    // Should auto-show the latest attempt
    expect(html).toContain('showTab(2)');
  });

  it('handles partial data — no task review', () => {
    const result = createPassingResult(1);
    result.taskReview = null;
    const stored = toStoredValidation(result);
    const html = generateValidationReport(createTestSession(), [stored]);

    expect(html).not.toContain('AI Task Review');
    expect(html).toContain('Build');
  });

  it('handles partial data — no test results', () => {
    const result = createPassingResult(1);
    result.test = undefined;
    const stored = toStoredValidation(result);
    const html = generateValidationReport(createTestSession(), [stored]);

    expect(html).not.toContain('>Tests<');
    expect(html).toContain('Build');
  });

  it('handles partial data — no screenshots', () => {
    const result = createPassingResult(1);
    result.smoke.pages[0].screenshotBase64 = undefined;
    const stored = toStoredValidation(result);
    const html = generateValidationReport(createTestSession(), [stored]);

    expect(html).not.toContain('data:image/png;base64');
    expect(html).toContain('Smoke Pages');
  });

  it('handles partial data — no pages', () => {
    const result = createPassingResult(1);
    result.smoke.pages = [];
    const stored = toStoredValidation(result);
    const html = generateValidationReport(createTestSession(), [stored]);

    // No smoke pages section when pages is empty
    expect(html).not.toContain('Smoke Pages');
  });

  it('handles partial data — no PR URL', () => {
    const session = createTestSession({ prUrl: null });
    const html = generateValidationReport(session, []);

    expect(html).not.toContain('Pull Request');
  });

  it('escapes HTML in user-provided content', () => {
    const session = createTestSession({ task: '<script>alert("xss")</script>' });
    const html = generateValidationReport(session, []);

    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert');
  });

  it('includes Tailwind CDN', () => {
    const html = generateValidationReport(createTestSession(), []);
    expect(html).toContain('cdn.tailwindcss.com');
  });

  it('renders AC validation section when present', () => {
    const result = createPassingResult(1);
    result.acValidation = {
      status: 'fail',
      results: [
        {
          criterion: 'Settings page has dark mode toggle',
          passed: true,
          reasoning: 'Toggle found',
        },
        {
          criterion: 'Dark mode changes background',
          passed: false,
          reasoning: 'Background stayed white',
        },
      ],
      model: 'sonnet',
    };
    const stored = toStoredValidation(result);
    const html = generateValidationReport(createTestSession(), [stored]);

    expect(html).toContain('AC Validation (2)');
    expect(html).toContain('Settings page has dark mode toggle');
    expect(html).toContain('Toggle found');
    expect(html).toContain('Dark mode changes background');
    expect(html).toContain('Background stayed white');
    expect(html).toContain('Model: sonnet');
    expect(html).toContain('1/2 passed');
  });

  it('omits AC section when no AC validation', () => {
    const result = createPassingResult(1);
    const stored = toStoredValidation(result);
    const html = generateValidationReport(createTestSession(), [stored]);

    expect(html).not.toContain('AC Validation');
  });

  it('omits AC section when AC validation was skipped', () => {
    const result = createPassingResult(1);
    result.acValidation = { status: 'skip', results: [], model: 'sonnet' };
    const stored = toStoredValidation(result);
    const html = generateValidationReport(createTestSession(), [stored]);

    expect(html).not.toContain('AC Validation');
  });

  it('renders diff in task review', () => {
    const result = createPassingResult(1);
    const stored = toStoredValidation(result);
    const html = generateValidationReport(createTestSession(), [stored]);

    expect(html).toContain('Diff');
    expect(html).toContain('import Settings');
  });
});
