import type { ValidationResult } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { type PrBodyConfig, buildPrBody, buildPrTitle } from './pr-body-builder.js';

describe('buildPrTitle', () => {
  it('prefixes with feat: when no conventional commit prefix', () => {
    expect(buildPrTitle('Add dark mode toggle')).toBe('feat: Add dark mode toggle');
  });

  it('preserves existing conventional commit prefix', () => {
    expect(buildPrTitle('fix: resolve login crash')).toBe('fix: resolve login crash');
    expect(buildPrTitle('chore: update dependencies')).toBe('chore: update dependencies');
    expect(buildPrTitle('refactor(auth): simplify token refresh')).toBe(
      'refactor(auth): simplify token refresh',
    );
  });

  it('truncates at 70 chars', () => {
    const longTask =
      'Add a comprehensive dark mode toggle with persistent user preferences and system theme detection';
    const title = buildPrTitle(longTask);
    expect(title.length).toBeLessThanOrEqual(70);
    expect(title).toMatch(/\.\.\.$/);
  });

  it('strips newlines', () => {
    expect(buildPrTitle('Fix\nthe\nbug')).toBe('feat: Fix the bug');
  });
});

describe('buildPrBody', () => {
  const baseConfig: PrBodyConfig = {
    task: 'Add dark mode toggle to the settings page',
    sessionId: 'abc12345',
    profileName: 'my-app',
    validationResult: null,
    filesChanged: 5,
    linesAdded: 120,
    linesRemoved: 30,
    previewUrl: null,
  };

  it('includes summary section with task', () => {
    const body = buildPrBody(baseConfig);
    expect(body).toContain('## Summary');
    expect(body).toContain('Add dark mode toggle');
  });

  it('includes stats', () => {
    const body = buildPrBody(baseConfig);
    expect(body).toContain('**Files changed:** 5');
    expect(body).toContain('+120 / -30');
  });

  it('includes autopod footer', () => {
    const body = buildPrBody(baseConfig);
    expect(body).toContain('autopod');
    expect(body).toContain('abc12345');
    expect(body).toContain('my-app');
  });

  it('includes preview URL when present', () => {
    const body = buildPrBody({ ...baseConfig, previewUrl: 'https://preview.example.com' });
    expect(body).toContain('## Preview');
    expect(body).toContain('https://preview.example.com');
  });

  it('omits preview section when null', () => {
    const body = buildPrBody(baseConfig);
    expect(body).not.toContain('## Preview');
  });

  it('includes validation results table when present', () => {
    const result: ValidationResult = {
      sessionId: 'abc12345',
      attempt: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      smoke: {
        status: 'pass',
        build: { status: 'pass', output: '', duration: 5000 },
        health: { status: 'pass', url: 'http://localhost:3000', responseCode: 200, duration: 500 },
        pages: [],
      },
      taskReview: {
        status: 'pass',
        reasoning: 'Implementation looks correct.',
        issues: [],
        model: 'sonnet',
        screenshots: [],
        diff: '',
      },
      overall: 'pass',
      duration: 95000,
    };

    const body = buildPrBody({ ...baseConfig, validationResult: result });
    expect(body).toContain('## Validation');
    expect(body).toContain('✅');
    expect(body).toContain('Build');
    expect(body).toContain('Health check');
    expect(body).toContain('AI review');
    expect(body).toContain('Implementation looks correct.');
    expect(body).toContain('1m 35s');
  });

  it('shows failure icons for failed phases', () => {
    const result: ValidationResult = {
      sessionId: 'abc12345',
      attempt: 2,
      timestamp: '2026-01-01T00:00:00.000Z',
      smoke: {
        status: 'fail',
        build: { status: 'fail', output: 'Error: Module not found', duration: 5000 },
        health: { status: 'pass', url: 'http://localhost:3000', responseCode: 200, duration: 500 },
        pages: [],
      },
      taskReview: null,
      overall: 'fail',
      duration: 5500,
    };

    const body = buildPrBody({ ...baseConfig, validationResult: result });
    expect(body).toContain('❌');
    expect(body).toContain('**Overall: ❌ fail**');
  });

  it('includes page validation results', () => {
    const result: ValidationResult = {
      sessionId: 'abc12345',
      attempt: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      smoke: {
        status: 'pass',
        build: { status: 'pass', output: '', duration: 5000 },
        health: { status: 'pass', url: 'http://localhost:3000', responseCode: 200, duration: 500 },
        pages: [
          { path: '/', status: 'pass', assertions: [], consoleErrors: [], screenshotPath: null },
          {
            path: '/about',
            status: 'pass',
            assertions: [],
            consoleErrors: [],
            screenshotPath: null,
          },
          {
            path: '/broken',
            status: 'fail',
            assertions: [],
            consoleErrors: ['TypeError'],
            screenshotPath: null,
          },
        ],
      },
      taskReview: null,
      overall: 'fail',
      duration: 10000,
    };

    const body = buildPrBody({ ...baseConfig, validationResult: result });
    expect(body).toContain('2/3 pages passed');
  });
});
