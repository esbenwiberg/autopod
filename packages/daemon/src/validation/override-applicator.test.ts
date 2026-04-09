import type { ValidationOverride, ValidationResult } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { findingId } from './finding-fingerprint.js';
import { applyOverrides } from './override-applicator.js';

function makeBaseResult(overrides?: Partial<ValidationResult>): ValidationResult {
  return {
    sessionId: 'test-123',
    attempt: 1,
    timestamp: new Date().toISOString(),
    overall: 'fail',
    duration: 1000,
    smoke: {
      status: 'pass',
      build: { status: 'pass', output: '', duration: 100 },
      health: { status: 'pass', url: 'http://localhost:3000', responseCode: 200, duration: 50 },
      pages: [],
    },
    taskReview: null,
    ...overrides,
  };
}

function makeDismiss(
  source: 'ac_validation' | 'task_review' | 'requirements_check',
  text: string,
): ValidationOverride {
  return {
    findingId: findingId(source, text),
    description: text,
    action: 'dismiss',
    reason: 'False positive',
    createdAt: new Date().toISOString(),
  };
}

// ── applyOverrides ───────────────────────────────────────────────────────────

describe('applyOverrides', () => {
  it('returns result unchanged when no overrides', () => {
    const result = makeBaseResult();
    expect(applyOverrides(result, [])).toEqual(result);
  });

  it('returns result unchanged when only guidance overrides (no dismiss)', () => {
    const result = makeBaseResult({
      taskReview: {
        status: 'fail',
        reasoning: 'Bad',
        issues: ['Missing tests'],
        model: 'sonnet',
        screenshots: [],
        diff: 'd',
      },
    });
    const overrides: ValidationOverride[] = [
      {
        findingId: findingId('task_review', 'Missing tests'),
        description: 'Missing tests',
        action: 'guidance',
        guidance: 'Add unit tests for the auth module',
        createdAt: new Date().toISOString(),
      },
    ];
    expect(applyOverrides(result, overrides)).toEqual(result);
  });

  it('dismisses AC validation findings', () => {
    const result = makeBaseResult({
      acValidation: {
        status: 'fail',
        results: [
          { criterion: 'Button disables on submit', passed: false, reasoning: 'Not found' },
          { criterion: 'Form shows errors', passed: true, reasoning: 'OK' },
        ],
        model: 'sonnet',
      },
    });

    const overrides = [makeDismiss('ac_validation', 'Button disables on submit')];
    const patched = applyOverrides(result, overrides);

    expect(patched.acValidation!.results[0]!.passed).toBe(true);
    expect(patched.acValidation!.results[0]!.reasoning).toContain('[DISMISSED BY HUMAN]');
    expect(patched.acValidation!.status).toBe('pass');
    expect(patched.overall).toBe('pass');
  });

  it('dismisses task review issues', () => {
    const result = makeBaseResult({
      taskReview: {
        status: 'fail',
        reasoning: 'Issues found',
        issues: ['Missing error handling', 'No tests for new function'],
        model: 'sonnet',
        screenshots: [],
        diff: 'd',
      },
    });

    const overrides = [
      makeDismiss('task_review', 'Missing error handling'),
      makeDismiss('task_review', 'No tests for new function'),
    ];
    const patched = applyOverrides(result, overrides);

    expect(patched.taskReview!.issues).toEqual([]);
    expect(patched.taskReview!.status).toBe('pass');
    expect(patched.taskReview!.reasoning).toContain('[OVERRIDES APPLIED]');
    expect(patched.overall).toBe('pass');
  });

  it('partially dismisses task review issues', () => {
    const result = makeBaseResult({
      taskReview: {
        status: 'fail',
        reasoning: 'Issues found',
        issues: ['Missing error handling', 'SQL injection vulnerability'],
        model: 'sonnet',
        screenshots: [],
        diff: 'd',
      },
    });

    const overrides = [makeDismiss('task_review', 'Missing error handling')];
    const patched = applyOverrides(result, overrides);

    expect(patched.taskReview!.issues).toEqual(['SQL injection vulnerability']);
    expect(patched.taskReview!.status).toBe('fail');
    expect(patched.overall).toBe('fail');
  });

  it('dismisses requirements check items', () => {
    const result = makeBaseResult({
      taskReview: {
        status: 'fail',
        reasoning: 'Requirement not met',
        issues: [],
        model: 'sonnet',
        screenshots: [],
        diff: 'd',
        requirementsCheck: [
          { criterion: 'Implements login', met: true },
          { criterion: 'Adds logout button', met: false, note: 'Not found' },
        ],
      },
    });

    const overrides = [makeDismiss('requirements_check', 'Adds logout button')];
    const patched = applyOverrides(result, overrides);

    expect(patched.taskReview!.requirementsCheck![1]!.met).toBe(true);
    expect(patched.taskReview!.requirementsCheck![1]!.note).toContain('[DISMISSED BY HUMAN]');
    expect(patched.taskReview!.status).toBe('pass');
    expect(patched.overall).toBe('pass');
  });

  it('does not override objective failures (build/health/smoke)', () => {
    const result = makeBaseResult({
      smoke: {
        status: 'fail',
        build: { status: 'fail', output: 'compile error', duration: 100 },
        health: { status: 'fail', url: 'http://localhost:3000', responseCode: null, duration: 50 },
        pages: [],
      },
      taskReview: {
        status: 'fail',
        reasoning: 'Issues',
        issues: ['Missing tests'],
        model: 'sonnet',
        screenshots: [],
        diff: 'd',
      },
    });

    // Dismiss the review issue — overall should still fail because of build failure
    const overrides = [makeDismiss('task_review', 'Missing tests')];
    const patched = applyOverrides(result, overrides);

    expect(patched.taskReview!.status).toBe('pass');
    expect(patched.overall).toBe('fail'); // build failure keeps it failed
  });

  it('does not mutate the original result', () => {
    const result = makeBaseResult({
      taskReview: {
        status: 'fail',
        reasoning: 'Issues',
        issues: ['Missing tests'],
        model: 'sonnet',
        screenshots: [],
        diff: 'd',
      },
    });

    const overrides = [makeDismiss('task_review', 'Missing tests')];
    applyOverrides(result, overrides);

    expect(result.taskReview!.issues).toEqual(['Missing tests']);
    expect(result.taskReview!.status).toBe('fail');
    expect(result.overall).toBe('fail');
  });

  it('handles mixed AC + review overrides', () => {
    const result = makeBaseResult({
      acValidation: {
        status: 'fail',
        results: [{ criterion: 'Form validates email', passed: false, reasoning: 'Nope' }],
        model: 'sonnet',
      },
      taskReview: {
        status: 'fail',
        reasoning: 'Issues',
        issues: ['Missing error handling'],
        model: 'sonnet',
        screenshots: [],
        diff: 'd',
      },
    });

    const overrides = [
      makeDismiss('ac_validation', 'Form validates email'),
      makeDismiss('task_review', 'Missing error handling'),
    ];
    const patched = applyOverrides(result, overrides);

    expect(patched.acValidation!.status).toBe('pass');
    expect(patched.taskReview!.status).toBe('pass');
    expect(patched.overall).toBe('pass');
  });
});
