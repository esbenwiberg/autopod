import type { StructuredReviewFinding } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { parseSynthesis } from './review-synthesizer.js';

const finding = (id: string, claim = 'missing guard'): StructuredReviewFinding => ({
  id,
  axis: 'security_authority',
  severity: 'HIGH',
  path: 'a.ts',
  claim,
  evidence: 'route is public',
  remediation: 'add guard',
  confidence: 0.8,
});

describe('parseSynthesis', () => {
  it('persists source-backed accepted, rejected, and merged decisions', () => {
    const a = finding('a');
    const b = finding('b');
    const c = finding('c', 'obsolete concern');
    const result = parseSynthesis(
      JSON.stringify({
        decisions: [
          { action: 'accept', sourceIds: ['a'], finding: a },
          { action: 'merge', sourceIds: ['b'], finding: b },
          { action: 'reject', sourceIds: ['c'], reason: 'superseded by inspected evidence' },
        ],
      }),
      [a, b, c],
    );
    expect(result.accepted).toEqual([a, b]);
    expect(result.merged[0]?.sourceIds).toEqual(['b']);
    expect(result.rejected).toEqual([
      { sourceIds: ['c'], reason: 'superseded by inspected evidence' },
    ]);
  });

  it('rejects invented IDs, altered claims, paths, severities, and malformed output', () => {
    const a = finding('a');
    for (const response of [
      '{bad',
      JSON.stringify({ decisions: [{ action: 'accept', sourceIds: ['invented'], finding: a }] }),
      JSON.stringify({
        decisions: [{ action: 'accept', sourceIds: ['a'], finding: { ...a, claim: 'invented' } }],
      }),
      JSON.stringify({
        decisions: [{ action: 'accept', sourceIds: ['a'], finding: { ...a, path: 'x.ts' } }],
      }),
      JSON.stringify({
        decisions: [
          { action: 'accept', sourceIds: ['a'], finding: { ...a, severity: 'CRITICAL' } },
        ],
      }),
    ])
      expect(() => parseSynthesis(response, [a])).toThrow();
  });
});
