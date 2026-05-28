import type { ValidationResult } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { formatFeedback } from './feedback-formatter.js';

function mockValidationResult(
  overrides: {
    buildFailed?: boolean;
    healthFailed?: boolean;
    pageFailed?: boolean;
    taskReviewFailed?: boolean;
    issues?: string[];
  } = {},
): ValidationResult {
  return {
    podId: 'sess-1',
    attempt: 1,
    timestamp: new Date().toISOString(),
    smoke: {
      status:
        overrides.buildFailed || overrides.healthFailed || overrides.pageFailed ? 'fail' : 'pass',
      build: {
        status: overrides.buildFailed ? 'fail' : 'pass',
        output: overrides.buildFailed ? 'Error: Cannot find module ./missing' : '',
        duration: 100,
      },
      health: {
        status: overrides.healthFailed ? 'fail' : 'pass',
        url: 'http://localhost:3000/health',
        responseCode: overrides.healthFailed ? null : 200,
        duration: 50,
      },
      pages: overrides.pageFailed
        ? [
            {
              path: '/about',
              status: 'fail',
              screenshotPath: '/tmp/screenshots/about.png',
              consoleErrors: ['TypeError: Cannot read property "x" of undefined'],
              assertions: [
                {
                  selector: 'h1',
                  type: 'exists' as const,
                  expected: undefined,
                  actual: undefined,
                  passed: false,
                },
              ],
              loadTime: 200,
            },
          ]
        : [],
    },
    taskReview: overrides.taskReviewFailed
      ? {
          status: 'fail',
          reasoning: 'The contact form is missing required fields',
          issues: overrides.issues ?? ['Missing email field', 'Submit button not wired up'],
          model: 'opus',
          screenshots: [],
          diff: '+<form></form>',
        }
      : null,
    overall: 'fail',
    duration: 5000,
  };
}

describe('formatFeedback', () => {
  describe('validation_failure', () => {
    it('formats build failure with build output', () => {
      const result = formatFeedback({
        type: 'validation_failure',
        result: mockValidationResult({ buildFailed: true }),
        task: 'Add a contact page',
        attempt: 1,
        maxAttempts: 3,
      });
      expect(result).toContain('Build Errors');
      expect(result).toContain('Cannot find module ./missing');
      expect(result).toContain('attempt 1/3');
    });

    it('formats health check failure', () => {
      const result = formatFeedback({
        type: 'validation_failure',
        result: mockValidationResult({ healthFailed: true }),
        task: 'Fix the homepage',
        attempt: 2,
        maxAttempts: 3,
      });
      expect(result).toContain('Health Check Failed');
      expect(result).toContain('Response code: none');
    });

    it('formats page failures with console errors and assertions', () => {
      const result = formatFeedback({
        type: 'validation_failure',
        result: mockValidationResult({ pageFailed: true }),
        task: 'Fix about page',
        attempt: 1,
        maxAttempts: 3,
      });
      expect(result).toContain('Page Failures');
      expect(result).toContain('/about');
      expect(result).toContain('TypeError');
      expect(result).toContain('`h1`');
    });

    it('includes task review issues when present', () => {
      const result = formatFeedback({
        type: 'validation_failure',
        result: mockValidationResult({
          taskReviewFailed: true,
          issues: ['Missing footer', 'Wrong font'],
        }),
        task: 'Rebuild the landing page',
        attempt: 1,
        maxAttempts: 3,
      });
      expect(result).toContain('Task Review Issues');
      expect(result).toContain('Missing footer');
      expect(result).toContain('Wrong font');
    });

    it('renders unmet requirementsCheck items as a separate section', () => {
      const result = mockValidationResult({ taskReviewFailed: true });
      result.taskReview = {
        status: 'fail',
        reasoning: 'Some code issues',
        issues: ['Missing tests'],
        model: 'opus',
        screenshots: [],
        diff: '+const x = 1;',
        requirementsCheck: [
          { criterion: 'Scheduler runs on startup', met: true, note: 'Found in DI config' },
          {
            criterion: 'ConsecutiveFailureCount increments on failure',
            met: false,
            note: 'No increment logic in diff',
          },
        ],
      };
      const output = formatFeedback({
        type: 'validation_failure',
        result,
        task: 'Implement scheduler',
        attempt: 1,
        maxAttempts: 3,
      });
      expect(output).toContain('Unmet Human Review Requirements');
      expect(output).toContain('ConsecutiveFailureCount increments on failure');
      expect(output).toContain('No increment logic in diff');
      // Met items should not appear in this section
      expect(output).not.toContain('Scheduler runs on startup');
    });

    it('omits unmet requirementsCheck section when all items are met', () => {
      const result = mockValidationResult({});
      result.taskReview = {
        status: 'pass',
        reasoning: 'All good',
        issues: [],
        model: 'opus',
        screenshots: [],
        diff: '+const x = 1;',
        requirementsCheck: [{ criterion: 'Scheduler runs on startup', met: true }],
      };
      const output = formatFeedback({
        type: 'validation_failure',
        result,
        task: 'Implement scheduler',
        attempt: 1,
        maxAttempts: 3,
      });
      expect(output).not.toContain('Unmet Human Review Requirements');
    });

    it('uses fallback note when requirementsCheck item has no note', () => {
      const result = mockValidationResult({});
      result.taskReview = {
        status: 'fail',
        reasoning: 'Missing implementation',
        issues: [],
        model: 'opus',
        screenshots: [],
        diff: '+const x = 1;',
        requirementsCheck: [{ criterion: 'Job runs exactly once', met: false }],
      };
      const output = formatFeedback({
        type: 'validation_failure',
        result,
        task: 'Implement scheduler',
        attempt: 1,
        maxAttempts: 3,
      });
      expect(output).toContain('Not implemented or evidence absent in the diff');
    });

    it('renders unmet requirementsCheck section before Task Review Issues', () => {
      const result = mockValidationResult({ taskReviewFailed: true });
      result.taskReview = {
        status: 'fail',
        reasoning: 'Code issues plus missing requirement',
        issues: ['Bad error handling'],
        model: 'opus',
        screenshots: [],
        diff: '+const x = 1;',
        requirementsCheck: [{ criterion: 'Job deduplication', met: false, note: 'Not in diff' }],
      };
      const output = formatFeedback({
        type: 'validation_failure',
        result,
        task: 'Implement scheduler',
        attempt: 1,
        maxAttempts: 3,
      });
      const unmetPos = output.indexOf('Unmet Human Review Requirements');
      const reviewPos = output.indexOf('Task Review Issues');
      expect(unmetPos).toBeGreaterThanOrEqual(0);
      expect(reviewPos).toBeGreaterThanOrEqual(0);
      expect(unmetPos).toBeLessThan(reviewPos);
    });

    it('detects native binding errors in health check output and warns agent', () => {
      const result = mockValidationResult({ healthFailed: true });
      result.smoke.health.startOutput =
        'Error: Cannot find module better-sqlite3\nRequire stack:\n- /workspace/node_modules/better-sqlite3';
      const output = formatFeedback({
        type: 'validation_failure',
        result,
        task: 'Add requestDurationMs to /health',
        attempt: 1,
        maxAttempts: 3,
      });
      expect(output).toContain('native module infrastructure error');
      expect(output).toContain('report_blocker');
      expect(output).toContain('Do NOT attempt to fix this yourself');
    });

    it('does not warn about native errors when health output has unrelated errors', () => {
      const result = mockValidationResult({ healthFailed: true });
      result.smoke.health.startOutput = 'Error: EADDRINUSE port 3000';
      const output = formatFeedback({
        type: 'validation_failure',
        result,
        task: 'Fix something',
        attempt: 1,
        maxAttempts: 3,
      });
      expect(output).not.toContain('native module infrastructure error');
    });

    it('always includes the original task', () => {
      const result = formatFeedback({
        type: 'validation_failure',
        result: mockValidationResult({ buildFailed: true }),
        task: 'Add a contact page with email and phone fields',
        attempt: 1,
        maxAttempts: 3,
      });
      expect(result).toContain('### Original Task');
      expect(result).toContain('Add a contact page with email and phone fields');
    });

    it('does not mention upstream-skipped note when Review actually ran', () => {
      const result = formatFeedback({
        type: 'validation_failure',
        result: mockValidationResult({ buildFailed: true, taskReviewFailed: true }),
        task: 'Add a contact page',
        attempt: 1,
        maxAttempts: 3,
      });
      expect(result).not.toContain('skipped because earlier validation phases failed');
    });

    it('surfaces review runner failures when no task review was produced', () => {
      const validation = mockValidationResult({});
      validation.reviewSkipKind = 'review-failed';
      validation.reviewSkipReason =
        'Review failed: codex review failed (exit=2): sh: 1: Syntax error: ";" unexpected';
      const output = formatFeedback({
        type: 'validation_failure',
        result: validation,
        task: 'Mirror memory APIs in desktop client',
        attempt: 1,
        maxAttempts: 3,
      });
      expect(output).toContain('Review Execution Failure');
      expect(output).toContain('Syntax error');
      expect(output).toContain('validation infrastructure failure');
      expect(output).not.toContain('Report this blocker');
      expect(output).not.toContain('report_blocker');
    });

    it('tells the agent to report factDeviations for unavailable fact commands', () => {
      const validation = mockValidationResult({});
      validation.factValidation = {
        status: 'pending_human',
        results: [
          {
            factId: 'fact-swift-only',
            proves: ['swift-helper-readable'],
            kind: 'unit-test',
            artifactPath: 'packages/desktop/Tests/AutopodClientTests/MemoryResponseTests.swift',
            command: 'cd packages/desktop && swift test --filter MemoryResponseTests',
            passed: false,
            status: 'pending_human',
            exitCode: 127,
            reasoning:
              'Fact fact-swift-only needs human decision: required fact command `swift` is unavailable in the validation container.',
            stderr: 'sh: 1: swift: not found',
          },
        ],
      };
      const output = formatFeedback({
        type: 'validation_failure',
        result: validation,
        task: 'Mirror memory APIs in desktop client',
        attempt: 1,
        maxAttempts: 3,
      });

      expect(output).toContain('Required Fact Deviation Requests Needed');
      expect(output).toContain('Do not report these as ordinary plan deviations');
      expect(output).toContain('`report_task_summary`');
      expect(output).toContain('"factId": "fact-swift-only"');
      expect(output).toContain('"action": "waive"');
      expect(output).not.toContain('Required Fact Failures');
    });

    it('surfaces stdout for failed required facts when stderr is empty', () => {
      const validation = mockValidationResult({});
      validation.factValidation = {
        status: 'fail',
        results: [
          {
            factId: 'fact-playwright-assertion',
            proves: ['layout'],
            kind: 'browser-test',
            artifactPath: 'tests/smoke-fixture/layout.spec.ts',
            command: 'npm run smoke -- tests/smoke-fixture/layout.spec.ts',
            passed: false,
            status: 'fail',
            exitCode: 2,
            reasoning: 'Fact fact-playwright-assertion failed: command exited 2.',
            stdout: 'Error: expect(locator).toHaveCSS() failed\nExpected: left\nReceived: right',
            stderr: '',
          },
        ],
      };

      const output = formatFeedback({
        type: 'validation_failure',
        result: validation,
        task: 'Fix layout',
        attempt: 1,
        maxAttempts: 3,
      });

      expect(output).toContain('Required Fact Failures');
      expect(output).toContain('expect(locator).toHaveCSS() failed');
      expect(output).toContain('Received: right');
    });

    it('labels both stderr and stdout for failed required facts', () => {
      const validation = mockValidationResult({});
      validation.factValidation = {
        status: 'fail',
        results: [
          {
            factId: 'fact-playwright-with-npm-warning',
            proves: ['layout'],
            kind: 'browser-test',
            artifactPath: 'tests/smoke-fixture/layout.spec.ts',
            command: 'npm run smoke -- tests/smoke-fixture/layout.spec.ts',
            passed: false,
            status: 'fail',
            exitCode: 2,
            reasoning: 'Fact fact-playwright-with-npm-warning failed: command exited 2.',
            stdout: 'Error: button left edge was 24px but expected 12px',
            stderr: 'npm warn Unknown env config "recursive"',
          },
        ],
      };

      const output = formatFeedback({
        type: 'validation_failure',
        result: validation,
        task: 'Fix layout',
        attempt: 1,
        maxAttempts: 3,
      });

      expect(output).toContain('stderr:\nnpm warn Unknown env config "recursive"');
      expect(output).toContain('stdout:\nError: button left edge was 24px but expected 12px');
    });
  });

  describe('human_rejection', () => {
    it('formats rejection from validated state', () => {
      const result = formatFeedback({
        type: 'human_rejection',
        feedback: 'Button color should be blue, not red',
        task: 'Redesign the CTA button',
        previousStatus: 'validated',
        attempt: 0,
        maxAttempts: 3,
      });
      expect(result).toContain('passed validation but the reviewer wants changes');
      expect(result).toContain('Button color should be blue');
      expect(result).toContain('Redesign the CTA button');
    });

    it('formats rejection from failed state', () => {
      const result = formatFeedback({
        type: 'human_rejection',
        feedback: 'Try a different approach',
        task: 'Fix the build',
        previousStatus: 'failed',
        attempt: 0,
        maxAttempts: 3,
      });
      expect(result).toContain('another chance');
      expect(result).toContain('Try a different approach');
    });

    it('includes attempt budget info', () => {
      const result = formatFeedback({
        type: 'human_rejection',
        feedback: 'Nope',
        task: 'Do the thing',
        previousStatus: 'validated',
        attempt: 0,
        maxAttempts: 5,
      });
      expect(result).toContain('5 validation attempts');
    });
  });

  describe('escalation_response', () => {
    it('formats human escalation response', () => {
      const result = formatFeedback({
        type: 'escalation_response',
        question: 'What color should the header be?',
        response: {
          respondedAt: new Date().toISOString(),
          respondedBy: 'human',
          response: 'Use brand blue (#1a73e8)',
        },
      });
      expect(result).toContain('Response to Your Question');
      expect(result).toContain('What color should the header be?');
      expect(result).toContain('#1a73e8');
      expect(result).toContain('from human');
    });

    it('includes model when AI responded', () => {
      const result = formatFeedback({
        type: 'escalation_response',
        question: 'How should I structure this?',
        response: {
          respondedAt: new Date().toISOString(),
          respondedBy: 'ai',
          response: 'Use a factory pattern',
          model: 'sonnet',
        },
      });
      expect(result).toContain('from ai, sonnet');
    });
  });
});
