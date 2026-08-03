import { describe, expect, it } from 'vitest';
import type { StructuredReviewFinding } from '@autopod/shared';
import { parseSynthesis } from './review-synthesizer.js';

const finding = (id: string, claim = 'missing guard'): StructuredReviewFinding => ({
  id, axis: 'security_authority', severity: 'HIGH', path: 'a.ts', claim,
  evidence: 'route is public', remediation: 'add guard', confidence: 0.8,
});

describe('parseSynthesis', () => {
  it('persists source-backed accepted, rejected, and merged decisions', () => {
    const a = finding('a'); const b = finding('b', 'missing test');
    const result = parseSynthesis(JSON.stringify({ decisions: [
      { action: 'accept', sourceIds: ['a'], finding: a },
      { action: 'reject', sourceIds: ['b'], reason: 'duplicate' },
    ] }), [a, b]);
    expect(result.accepted).toEqual([a]);
    expect(result.rejected[0]?.sourceIds).toEqual(['b']);
  });

  it('rejects invented IDs, altered claims, paths, severities, and malformed output', () => {
    const a = finding('a');
    for (const response of [
      '{bad',
      JSON.stringify({ decisions: [{ action: 'accept', sourceIds: ['invented'], finding: a }] }),
      JSON.stringify({ decisions: [{ action: 'accept', sourceIds: ['a'], finding: { ...a, claim: 'invented' } }] }),
      JSON.stringify({ decisions: [{ action: 'accept', sourceIds: ['a'], finding: { ...a, path: 'x.ts' } }] }),
      JSON.stringify({ decisions: [{ action: 'accept', sourceIds: ['a'], finding: { ...a, severity: 'CRITICAL' } }] }),
    ]) expect(() => parseSynthesis(response, [a])).toThrow();
  });
});
