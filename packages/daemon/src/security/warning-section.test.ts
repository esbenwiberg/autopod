import type { ScanFinding } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { buildWarningSection } from './warning-section.js';

function f(overrides: Partial<ScanFinding> = {}): ScanFinding {
  return {
    detector: 'secrets',
    severity: 'high',
    file: 'src/x.ts',
    snippet: '[REDACTED]',
    ...overrides,
  };
}

describe('buildWarningSection', () => {
  it('returns null when there are no findings', () => {
    expect(buildWarningSection([])).toBeNull();
  });

  it('groups findings by detector under three subsections', () => {
    const section = buildWarningSection([
      f({ detector: 'injection', file: 'docs/poison.md', line: 12, confidence: 0.94 }),
      f({ detector: 'pii', file: 'fixtures/users.json' }),
      f({ detector: 'secrets', file: 'src/config.ts', line: 42, ruleId: 'aws-access-key' }),
    ]);
    expect(section?.heading).toBe('Security Notice');
    expect(section?.priority).toBe(5);
    const c = section?.content ?? '';
    expect(c).toContain('### Potential prompt injection');
    expect(c).toContain('### Potential PII');
    expect(c).toContain('### Potential secrets');
    expect(c).toContain('docs/poison.md:12');
    expect(c).toContain('confidence 0.94');
    expect(c).toContain('aws-access-key');
  });

  it('escapes markdown metacharacters in file paths', () => {
    const section = buildWarningSection([f({ file: 'src/[scary]/file_*.ts' })]);
    expect(section?.content).toContain('src/\\[scary\\]/file\\_\\*.ts');
  });

  it('omits subsections that have no findings', () => {
    const section = buildWarningSection([f({ detector: 'secrets' })]);
    const c = section?.content ?? '';
    expect(c).toContain('### Potential secrets');
    expect(c).not.toContain('### Potential PII');
    expect(c).not.toContain('### Potential prompt injection');
  });
});
