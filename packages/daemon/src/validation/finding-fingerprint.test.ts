import type { ValidationResult } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import {
  detectRecurringFindings,
  extractFindings,
  findingId,
  fingerprintText,
} from './finding-fingerprint.js';

// ── fingerprintText ──────────────────────────────────────────────────────────

describe('fingerprintText', () => {
  it('produces a 12-char hex string', () => {
    const fp = fingerprintText('Missing error handling in auth route');
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is stable across calls', () => {
    const text = 'Missing error handling in auth route';
    expect(fingerprintText(text)).toBe(fingerprintText(text));
  });

  it('ignores punctuation differences', () => {
    expect(fingerprintText('Missing error handling.')).toBe(
      fingerprintText('Missing error handling'),
    );
  });

  it('ignores case differences', () => {
    expect(fingerprintText('Missing Error Handling')).toBe(
      fingerprintText('missing error handling'),
    );
  });

  it('collapses whitespace', () => {
    expect(fingerprintText('missing   error\n  handling')).toBe(
      fingerprintText('missing error handling'),
    );
  });

  it('produces different fingerprints for different text', () => {
    expect(fingerprintText('missing error handling')).not.toBe(
      fingerprintText('unused variable detected'),
    );
  });
});

// ── findingId ────────────────────────────────────────────────────────────────

describe('findingId', () => {
  it('prefixes with review: for task_review', () => {
    expect(findingId('task_review', 'Missing tests')).toMatch(/^review:[0-9a-f]{12}$/);
  });

  it('prefixes with req: for requirements_check', () => {
    expect(findingId('requirements_check', 'Login form validates email')).toMatch(
      /^req:[0-9a-f]{12}$/,
    );
  });

  it('prefixes with fact: for fact_validation', () => {
    expect(findingId('fact_validation', 'fact-login')).toMatch(/^fact:[0-9a-f]{12}$/);
  });
});

// ── extractFindings ──────────────────────────────────────────────────────────

function makeBaseResult(overrides?: Partial<ValidationResult>): ValidationResult {
  return {
    podId: 'test-123',
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

describe('extractFindings', () => {
  it('returns empty array when no AI-driven failures', () => {
    const result = makeBaseResult({ overall: 'pass' });
    expect(extractFindings(result)).toEqual([]);
  });

  it('extracts failed required facts', () => {
    const result = makeBaseResult({
      factValidation: {
        status: 'fail',
        results: [
          {
            factId: 'fact-login',
            proves: ['login'],
            kind: 'unit-test',
            artifactPath: 'packages/app/login.test.ts',
            command: 'npx vitest login.test.ts',
            passed: false,
            reasoning: 'test failed',
          },
        ],
      },
    });

    const findings = extractFindings(result);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.source).toBe('fact_validation');
    expect(findings[0]?.description).toBe('fact-login: npx vitest login.test.ts');
    expect(findings[0]?.reasoning).toBe('test failed');
    expect(findings[0]?.id).toMatch(/^fact:/);
  });

  it('extracts failed task review issues', () => {
    const result = makeBaseResult({
      taskReview: {
        status: 'fail',
        reasoning: 'Issues found',
        issues: ['Missing error handling in API route', 'No tests for new function'],
        model: 'sonnet',
        screenshots: [],
        diff: 'some diff',
      },
    });

    const findings = extractFindings(result);
    expect(findings).toHaveLength(2);
    expect(findings[0]?.source).toBe('task_review');
    expect(findings[0]?.description).toBe('Missing error handling in API route');
    expect(findings[1]?.description).toBe('No tests for new function');
  });

  it('skips task review issues when status is not fail', () => {
    const result = makeBaseResult({
      taskReview: {
        status: 'pass',
        reasoning: 'Looks good',
        issues: [],
        model: 'sonnet',
        screenshots: [],
        diff: 'some diff',
      },
    });

    expect(extractFindings(result)).toHaveLength(0);
  });

  it('extracts unmet requirements check items', () => {
    const result = makeBaseResult({
      taskReview: {
        status: 'fail',
        reasoning: 'Requirements not met',
        issues: [],
        model: 'sonnet',
        screenshots: [],
        diff: 'some diff',
        requirementsCheck: [
          { criterion: 'Implements login', met: true },
          { criterion: 'Adds logout button', met: false, note: 'Not found in diff' },
        ],
      },
    });

    const findings = extractFindings(result);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.source).toBe('requirements_check');
    expect(findings[0]?.description).toBe('Adds logout button');
    expect(findings[0]?.reasoning).toBe('Not found in diff');
  });

  it('extracts from all sources when all have failures', () => {
    const result = makeBaseResult({
      factValidation: {
        status: 'fail',
        results: [
          {
            factId: 'fact-email',
            proves: ['email'],
            artifactPath: 'packages/app/email.test.ts',
            command: 'npx vitest email.test.ts',
            passed: false,
            reasoning: 'Nope',
          },
        ],
      },
      taskReview: {
        status: 'fail',
        reasoning: 'Bad',
        issues: ['Issue1'],
        model: 'sonnet',
        screenshots: [],
        diff: 'd',
        requirementsCheck: [{ criterion: 'Req1', met: false }],
      },
    });

    const findings = extractFindings(result);
    expect(findings).toHaveLength(3);
    expect(findings.map((f) => f.source)).toEqual([
      'fact_validation',
      'task_review',
      'requirements_check',
    ]);
  });
});

// ── detectRecurringFindings ──────────────────────────────────────────────────

describe('detectRecurringFindings', () => {
  it('returns empty when no overlap', () => {
    const current = [{ id: 'review:aaa', source: 'task_review' as const, description: 'A' }];
    const previous = [{ id: 'review:bbb', source: 'task_review' as const, description: 'B' }];
    expect(detectRecurringFindings(current, previous)).toEqual([]);
  });

  it('returns findings present in both', () => {
    const current = [
      { id: 'review:aaa', source: 'task_review' as const, description: 'A' },
      { id: 'review:bbb', source: 'task_review' as const, description: 'B' },
    ];
    const previous = [
      { id: 'review:aaa', source: 'task_review' as const, description: 'A old' },
      { id: 'review:ccc', source: 'task_review' as const, description: 'C' },
    ];
    const recurring = detectRecurringFindings(current, previous);
    expect(recurring).toHaveLength(1);
    expect(recurring[0]?.id).toBe('review:aaa');
    // Should return the current version's data
    expect(recurring[0]?.description).toBe('A');
  });

  it('handles cross-source matches (same text, different prefix)', () => {
    // These should NOT match because IDs have different prefixes
    const current = [
      { id: 'req:aaa', source: 'requirements_check' as const, description: 'Same text' },
    ];
    const previous = [
      { id: 'review:aaa', source: 'task_review' as const, description: 'Same text' },
    ];
    expect(detectRecurringFindings(current, previous)).toEqual([]);
  });

  it('detects recurring with real fingerprints via extractFindings', () => {
    const result1 = makeBaseResult({
      taskReview: {
        status: 'fail',
        reasoning: 'Issues',
        issues: ['Missing error handling in auth route', 'No tests'],
        model: 'sonnet',
        screenshots: [],
        diff: 'd1',
      },
    });
    const result2 = makeBaseResult({
      taskReview: {
        status: 'fail',
        reasoning: 'Still issues',
        issues: ['Missing error handling in auth route', 'New unrelated issue'],
        model: 'sonnet',
        screenshots: [],
        diff: 'd2',
      },
    });

    const prev = extractFindings(result1);
    const curr = extractFindings(result2);
    const recurring = detectRecurringFindings(curr, prev);

    expect(recurring).toHaveLength(1);
    expect(recurring[0]?.description).toBe('Missing error handling in auth route');
  });
});
