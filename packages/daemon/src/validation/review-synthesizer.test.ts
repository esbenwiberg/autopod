import type { InitialReviewFinding, StructuredReviewFinding } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { structuredFindingSourceId } from './finding-fingerprint.js';
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
    expect(result.accepted).toEqual([a, { ...b, id: structuredFindingSourceId(b) }]);
    expect(result.merged[0]?.sourceIds).toEqual(['b']);
    expect(result.merged[0]?.finding.id).toBe(structuredFindingSourceId(b));
    expect(result.rejected).toEqual([
      { sourceIds: ['c'], reason: 'superseded by inspected evidence' },
    ]);
  });

  it('derives merged IDs instead of accepting a model-supplied collision', () => {
    const a = finding('a');
    const unrelated = finding('unrelated', 'unrelated concern');
    const result = parseSynthesis(
      JSON.stringify({
        decisions: [
          { action: 'merge', sourceIds: ['a'], finding: { ...a, id: unrelated.id } },
          { action: 'reject', sourceIds: ['unrelated'], reason: 'not applicable' },
        ],
      }),
      [a, unrelated],
    );
    expect(result.accepted[0]?.id).toBe(structuredFindingSourceId(a));
    expect(result.accepted[0]?.id).not.toBe(unrelated.id);
  });

  it('accepts a source-identical finding regardless of JSON field order', () => {
    const a = finding('a');
    const reordered = {
      confidence: a.confidence,
      remediation: a.remediation,
      evidence: a.evidence,
      claim: a.claim,
      path: a.path,
      severity: a.severity,
      axis: a.axis,
      id: a.id,
    };
    const result = parseSynthesis(
      JSON.stringify({ decisions: [{ action: 'accept', sourceIds: ['a'], finding: reordered }] }),
      [a],
    );
    expect(result.accepted).toEqual([a]);
  });

  it('permits initial provenance only through a structured canonical merge', () => {
    const structured = finding('structured');
    const initial: InitialReviewFinding = {
      id: 'initial',
      source: 'initial-review',
      issue: 'broad description of the same missing guard',
    };
    const result = parseSynthesis(
      JSON.stringify({
        decisions: [{ action: 'merge', sourceIds: ['initial', 'structured'], finding: structured }],
      }),
      [initial, structured],
    );
    expect(result.accepted).toEqual([{ ...structured, id: structuredFindingSourceId(structured) }]);
    expect(result.merged[0]?.sourceIds).toEqual(['initial', 'structured']);
  });

  it('rejects invented IDs, altered claims, paths, severities, and malformed output', () => {
    const a = finding('a');
    for (const response of [
      '{bad',
      JSON.stringify({ decisions: [{ action: 'accept', sourceIds: ['invented'], finding: a }] }),
      JSON.stringify({ decisions: [{ action: 'accept', sourceIds: ['a', 'a'], finding: a }] }),
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
