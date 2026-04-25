import type { ValidationResult } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { type PrBodyConfig, buildPrBody, buildPrTitle, escapeMd } from './pr-body-builder.js';

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
    podId: 'abc12345',
    profileName: 'my-app',
    validationResult: null,
    filesChanged: 5,
    linesAdded: 120,
    linesRemoved: 30,
    previewUrl: null,
  };

  it('includes Why section with task', () => {
    const body = buildPrBody(baseConfig);
    expect(body).toContain('## Why');
    expect(body).toContain('Add dark mode toggle');
  });

  it('does not include What section when no taskSummary', () => {
    const body = buildPrBody(baseConfig);
    expect(body).not.toContain('## What');
  });

  it('includes What and How sections when taskSummary is provided', () => {
    const body = buildPrBody({
      ...baseConfig,
      taskSummary: {
        actualSummary: 'Added a CSS variable-based dark mode with a toggle button in settings.',
        how: 'Used CSS custom properties and a localStorage flag. No JS framework dependency.',
        deviations: [],
      },
    });
    expect(body).toContain('## What');
    expect(body).toContain('CSS variable-based dark mode');
    expect(body).toContain('## How');
    expect(body).toContain('CSS custom properties');
  });

  it('omits How section when taskSummary.how is absent', () => {
    const body = buildPrBody({
      ...baseConfig,
      taskSummary: {
        actualSummary: 'Added dark mode toggle.',
        deviations: [],
      },
    });
    expect(body).toContain('## What');
    expect(body).not.toContain('## How');
  });

  it('includes stats with compact format', () => {
    const body = buildPrBody(baseConfig);
    expect(body).toContain('## Stats');
    expect(body).toContain('`5 files`');
    expect(body).toContain('`+120`');
    expect(body).toContain('`-30`');
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
      podId: 'abc12345',
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
    expect(body).toContain('1m 35s');
  });

  it('wraps AI review reasoning in details block', () => {
    const result: ValidationResult = {
      podId: 'abc12345',
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
      duration: 10000,
    };

    const body = buildPrBody({ ...baseConfig, validationResult: result });
    expect(body).toContain('<details>');
    expect(body).toContain('<summary>AI Review Details</summary>');
    expect(body).toContain('Implementation looks correct.');
  });

  it('shows failure icons for failed phases', () => {
    const result: ValidationResult = {
      podId: 'abc12345',
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
      podId: 'abc12345',
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

  it('surfaces AI issues in Concerns section', () => {
    const result: ValidationResult = {
      podId: 'abc12345',
      attempt: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      smoke: {
        status: 'pass',
        build: { status: 'pass', output: '', duration: 5000 },
        health: { status: 'pass', url: 'http://localhost:3000', responseCode: 200, duration: 500 },
        pages: [],
      },
      taskReview: {
        status: 'fail',
        reasoning: 'Has issues.',
        issues: ['Missing accessibility labels', 'No mobile breakpoint'],
        model: 'sonnet',
        screenshots: [],
        diff: '',
      },
      overall: 'fail',
      duration: 10000,
    };

    const body = buildPrBody({ ...baseConfig, validationResult: result });
    expect(body).toContain('## ⚠️ Concerns');
    expect(body).toContain('Missing accessibility labels');
    expect(body).toContain('No mobile breakpoint');
    // Concerns must appear before Validation
    expect(body.indexOf('## ⚠️ Concerns')).toBeLessThan(body.indexOf('## Validation'));
  });

  it('omits Concerns section when no issues or bad deviations', () => {
    const result: ValidationResult = {
      podId: 'abc12345',
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
        reasoning: 'All good.',
        issues: [],
        model: 'sonnet',
        screenshots: [],
        diff: '',
      },
      overall: 'pass',
      duration: 10000,
    };

    const body = buildPrBody({ ...baseConfig, validationResult: result });
    expect(body).not.toContain('## ⚠️ Concerns');
  });

  it('renders Review Checklist as GitHub checkboxes', () => {
    const result: ValidationResult = {
      podId: 'abc12345',
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
        reasoning: '',
        issues: [],
        model: 'sonnet',
        screenshots: [],
        diff: '',
        requirementsCheck: [
          { criterion: 'Dark mode persists on reload', met: true },
          { criterion: 'Accessible toggle label', met: false, note: 'Missing aria-label' },
        ],
      },
      overall: 'pass',
      duration: 10000,
    };

    const body = buildPrBody({ ...baseConfig, validationResult: result });
    expect(body).toContain('## Review Checklist');
    expect(body).toContain('- [x] ✅ Dark mode persists on reload');
    expect(body).toContain('- [ ] ❌ Accessible toggle label — Missing aria-label');
  });

  it('renders deviations as a table', () => {
    const body = buildPrBody({
      ...baseConfig,
      taskSummary: {
        actualSummary: 'Done.',
        deviations: [
          {
            step: 'Step 2',
            planned: 'Use localStorage',
            actual: 'Used sessionStorage',
            reason: 'Privacy requirement',
          },
        ],
      },
    });
    expect(body).toContain('## Deviations from Plan');
    expect(body).toContain('| Step | Planned | Actual | Reason |');
    expect(body).toContain('Step 2');
    expect(body).toContain('Privacy requirement');
  });

  it('adds Verdict column to deviations table when deviationsAssessment is present', () => {
    const result: ValidationResult = {
      podId: 'abc12345',
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
        reasoning: '',
        issues: [],
        model: 'sonnet',
        screenshots: [],
        diff: '',
        deviationsAssessment: {
          disclosedDeviations: [{ step: 'Step 2', verdict: 'justified', reasoning: 'Good reason' }],
          undisclosedDeviations: [],
        },
      },
      overall: 'pass',
      duration: 10000,
    };

    const body = buildPrBody({
      ...baseConfig,
      validationResult: result,
      taskSummary: {
        actualSummary: 'Done.',
        deviations: [
          {
            step: 'Step 2',
            planned: 'Use localStorage',
            actual: 'Used sessionStorage',
            reason: 'Privacy requirement',
          },
        ],
      },
    });

    expect(body).toContain('| Step | Planned | Actual | Reason | Verdict |');
    expect(body).toContain('✅ justified');
  });

  it('renders screenshots as inline images by default', () => {
    const body = buildPrBody({
      ...baseConfig,
      screenshots: [{ pagePath: '/', imageUrl: 'https://raw.github.com/screenshot.png' }],
    });
    expect(body).toContain('![/](https://raw.github.com/screenshot.png)');
  });

  it('renders screenshots as links when inlineImages is false', () => {
    const body = buildPrBody({
      ...baseConfig,
      inlineImages: false,
      screenshots: [{ pagePath: '/', imageUrl: 'https://raw.github.com/screenshot.png' }],
    });
    expect(body).not.toContain('![');
    expect(body).toContain('[View screenshot](https://raw.github.com/screenshot.png)');
  });

  it('omits the Security Notice section when there are no findings', () => {
    const body = buildPrBody({ ...baseConfig, securityFindings: [] });
    expect(body).not.toContain('Security Notice');
  });

  it('renders the Security Notice section grouped by detector', () => {
    const body = buildPrBody({
      ...baseConfig,
      securityFindings: [
        {
          detector: 'secrets',
          severity: 'critical',
          file: 'src/config.ts',
          line: 42,
          ruleId: '@secretlint/rule-aws',
          snippet: 'AKIA...[REDACTED]',
        },
        {
          detector: 'injection',
          severity: 'high',
          file: 'docs/notes.md',
          line: 12,
          confidence: 0.94,
          snippet: 'ignore previous instructions',
        },
        {
          detector: 'pii',
          severity: 'medium',
          file: 'fixtures/users.json',
          snippet: 'name field detected',
        },
      ],
    });
    expect(body).toContain('## ⚠️ Security Notice');
    expect(body).toContain('### Potential secrets');
    expect(body).toContain('### Potential PII');
    expect(body).toContain('### Potential prompt injection');
    expect(body).toContain('src/config.ts:42');
    expect(body).toContain('@secretlint/rule-aws');
    expect(body).toContain('confidence 0.94');
    // Security Notice appears before Stats so the reviewer sees it before the meta block
    expect(body.indexOf('Security Notice')).toBeLessThan(body.indexOf('## Stats'));
  });
});

describe('escapeMd', () => {
  it('neutralises @mentions with a zero-width space', () => {
    expect(escapeMd('@security-team URGENT')).toContain('@​security');
    expect(escapeMd('@security-team URGENT')).not.toContain('@security-team');
  });

  it('escapes HTML angle brackets', () => {
    expect(escapeMd('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes markdown link syntax', () => {
    const result = escapeMd('[click me](http://evil.com)');
    expect(result).toContain('\\[click me\\]');
    expect(result).not.toMatch(/\[click me\]\(http/);
  });

  it('escapes pipe characters that would break tables', () => {
    expect(escapeMd('foo | bar')).toBe('foo \\| bar');
  });

  it('escapes backticks', () => {
    expect(escapeMd('`rm -rf /`')).toBe('\\`rm -rf /\\`');
  });

  it('leaves normal prose untouched', () => {
    const text = 'Implemented the login flow using OAuth 2.0.';
    expect(escapeMd(text)).toBe(text);
  });

  it('agent-supplied task summary is escaped in PR body', () => {
    const body = buildPrBody({
      task: 'build a thing',
      podId: 'abc123',
      profileName: 'test',
      validationResult: null,
      filesChanged: 1,
      linesAdded: 10,
      linesRemoved: 0,
      previewUrl: null,
      taskSummary: {
        actualSummary: '@security-team URGENT: [click me](http://evil.com)',
        deviations: [],
      },
    });
    // @mention neutralised
    expect(body).not.toMatch(/@security-team/);
    // link syntax escaped
    expect(body).toContain('\\[click me\\]');
  });

  it('deviation table cells are escaped', () => {
    const body = buildPrBody({
      task: 'build a thing',
      podId: 'abc123',
      profileName: 'test',
      validationResult: null,
      filesChanged: 1,
      linesAdded: 10,
      linesRemoved: 0,
      previewUrl: null,
      taskSummary: {
        actualSummary: 'done',
        deviations: [
          {
            step: 'Step | 1',
            planned: 'planned | task',
            actual: 'actual`thing`',
            reason: '<injected>',
          },
        ],
      },
    });
    expect(body).toContain('Step \\| 1');
    expect(body).toContain('planned \\| task');
    expect(body).toContain('actual\\`thing\\`');
    expect(body).toContain('&lt;injected&gt;');
  });
});
