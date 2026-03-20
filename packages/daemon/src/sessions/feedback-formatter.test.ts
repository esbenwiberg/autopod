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
    sessionId: 'sess-1',
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
          screenshots: ['/tmp/screenshots/contact.png'],
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
