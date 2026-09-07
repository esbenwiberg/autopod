import { describe, expect, it } from 'vitest';
import { normalizeNpmAudit } from './npm-lock-audit.js';

const clean = {
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
};
describe('npm audit deterministic response contract', () => {
  it('accepts complete empty coverage and preserves stable advisory identity', () => {
    expect(normalizeNpmAudit(JSON.stringify(clean), 'npm@fixture').findings).toEqual([]);
    const vulnerable = {
      ...clean,
      vulnerabilities: { example: { severity: 'high', via: [{ source: 1234 }] } },
      metadata: { vulnerabilities: { ...clean.metadata.vulnerabilities, high: 1, total: 1 } },
    };
    const result = normalizeNpmAudit(JSON.stringify(vulnerable), 'npm@fixture');
    expect(result.findings).toMatchObject([
      { identity: '["example","1234"]', ruleId: 'npm:1234', severity: 'high' },
    ]);
    expect(result.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([
    {},
    { ...clean, error: { code: 'ENOTFOUND' } },
    { ...clean, auditReportVersion: 1 },
    { ...clean, metadata: { vulnerabilities: { total: 0 } } },
    { ...clean, metadata: { vulnerabilities: { ...clean.metadata.vulnerabilities, total: 1 } } },
    { ...clean, metadata: { vulnerabilities: { ...clean.metadata.vulnerabilities, high: 1 } } },
    { ...clean, vulnerabilities: { example: {} } },
  ])('rejects partial or contradictory scanner output instead of reporting clean', (input) => {
    expect(() => normalizeNpmAudit(JSON.stringify(input), 'npm@fixture')).toThrow();
  });
});
