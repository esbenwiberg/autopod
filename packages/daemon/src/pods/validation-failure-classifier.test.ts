import type { ValidationResult } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { classifyValidationFailure } from './validation-failure-classifier.js';

function failedResult(overrides: Partial<ValidationResult>): ValidationResult {
  return {
    podId: 'pod-1',
    attempt: 1,
    timestamp: '2026-06-17T00:00:00.000Z',
    setup: { status: 'skip', output: '', duration: 0 },
    smoke: {
      status: 'fail',
      build: { status: 'pass', output: '', duration: 0 },
      health: { status: 'skip', url: '', responseCode: null, duration: 0 },
      pages: [],
    },
    test: { status: 'skip', duration: 0 },
    lint: { status: 'skip', output: '', duration: 0 },
    sast: { status: 'skip', output: '', duration: 0 },
    factValidation: { status: 'skip', results: [] },
    taskReview: null,
    overall: 'fail',
    duration: 0,
    ...overrides,
  };
}

describe('classifyValidationFailure', () => {
  it('classifies missing build tools as infrastructure', () => {
    const result = failedResult({
      smoke: {
        status: 'fail',
        build: { status: 'fail', output: 'sh: 1: tsc: not found', duration: 12 },
        health: { status: 'fail', url: '', responseCode: null, duration: 0 },
        pages: [],
      },
    });

    expect(classifyValidationFailure(result)).toMatchObject({
      kind: 'infra',
      phase: 'build',
      signature: 'node-tool-not-found',
    });
  });

  it('classifies missing Playwright test dependency as infrastructure', () => {
    const result = failedResult({
      factValidation: {
        status: 'fail',
        results: [
          {
            factId: 'fact-ui',
            proves: ['ui'],
            artifactPath: 'tests/fact.spec.ts',
            command: 'node facts.js',
            passed: false,
            status: 'fail',
            reasoning: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@playwright/test'",
            stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@playwright/test'",
          },
        ],
      },
    });

    expect(classifyValidationFailure(result)).toMatchObject({
      kind: 'infra',
      phase: 'facts',
      signature: 'playwright-package-missing',
    });
  });

  it('classifies reviewer timeouts as infrastructure', () => {
    const result = failedResult({
      reviewSkipKind: 'review-timeout',
      reviewSkipReason: 'Reviewer subprocess timed out after 300000ms',
    });

    expect(classifyValidationFailure(result)).toMatchObject({
      kind: 'infra',
      phase: 'review',
      signature: 'review-timeout',
    });
  });

  it('does not classify ordinary code errors as infrastructure', () => {
    const result = failedResult({
      smoke: {
        status: 'fail',
        build: {
          status: 'fail',
          output: "src/app.ts(12,8): error TS2307: Cannot find module './missing-widget'",
          duration: 40,
        },
        health: { status: 'fail', url: '', responseCode: null, duration: 0 },
        pages: [],
      },
    });

    expect(classifyValidationFailure(result)).toBeNull();
  });
});
