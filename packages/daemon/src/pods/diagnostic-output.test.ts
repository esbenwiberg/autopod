import { describe, expect, it } from 'vitest';
import { createFailingValidationResult } from '../test-utils/mock-helpers.js';
import { boundedDiagnosticOutput } from './diagnostic-output.js';
import { formatFeedback } from './feedback-formatter.js';

describe('actionable bounded diagnostics', () => {
  it('retains the actual capsule failure after thousands of successful checks', () => {
    const output = `npm run lint\n${'✓ successful capsule check\n'.repeat(2000)}\n✗ capsule check failed\n  - non-capsule commits not covered by capsule commit_range: d6bae2a35390fb489c199a639898883a8757563f\n`;
    const result = createFailingValidationResult('pod');
    result.lint = { status: 'fail', output, duration: 1 };
    const feedback = formatFeedback({
      type: 'validation_failure',
      result,
      task: 'Fix export',
      attempt: 1,
      maxAttempts: 3,
    });
    expect(feedback).toContain('npm run lint');
    expect(feedback).toContain('non-capsule commits not covered');
    expect(feedback).toContain('d6bae2a35390fb489c199a639898883a8757563f');
    expect(boundedDiagnosticOutput(output).length).toBeLessThanOrEqual(10_000);
  });
  it.each([0, 1, 20, 100, 1000])(
    'honors small bounds (%s) without slice(-0) returning the whole log',
    (limit) => {
      expect(boundedDiagnosticOutput('x'.repeat(2000), limit).length).toBeLessThanOrEqual(limit);
    },
  );
  it('preserves small output and removes terminal color escapes', () => {
    expect(boundedDiagnosticOutput('\u001b[31mERROR: failure\u001b[0m\r\n')).toBe(
      'ERROR: failure\n',
    );
  });
});
