import type { ReviewBatchResult, StructuredReviewFinding } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import {
  activeLedgerEntries,
  activeLedgerFindings,
  parseClosureVerification,
  reconcileReviewLedger,
} from './review-ledger.js';

const finding = (id: string): StructuredReviewFinding => ({
  id,
  axis: 'tests_integration',
  severity: 'HIGH',
  path: 'a.ts',
  claim: id,
  evidence: 'e',
  remediation: 'r',
  confidence: 1,
});
const batch = (accepted: StructuredReviewFinding[]): ReviewBatchResult => ({
  id: 'b',
  diffHash: 'd',
  reviewedHead: 'h',
  promptVersion: 'p',
  schemaVersion: 's',
  model: 'm',
  axes: [],
  candidates: accepted,
  initialFindings: [],
  accepted,
  rejected: [],
  merged: [],
  synthesis: 'model',
  durationMs: 1,
});

describe('reconcileReviewLedger', () => {
  it('preserves fixed history and derives regression deterministically across attempts', () => {
    const one = reconcileReviewLedger(undefined, [finding('A'), finding('B')], undefined);
    expect(one.map((e) => [e.semanticId, e.state])).toEqual([
      ['A', 'new'],
      ['B', 'new'],
    ]);
    const two = reconcileReviewLedger({ ...batch([]), ledger: one }, [finding('B'), finding('C')], {
      status: 'completed',
      decisions: [{ semanticId: 'A', fixed: true, evidence: 'current frozen diff proves repair' }],
    });
    expect(two.map((e) => [e.semanticId, e.state])).toEqual([
      ['A', 'fixed'],
      ['B', 'open'],
      ['C', 'new'],
    ]);
    const three = reconcileReviewLedger({ ...batch([]), ledger: two }, [finding('A')], {
      status: 'completed',
      decisions: [
        { semanticId: 'B', fixed: true, evidence: 'proof' },
        { semanticId: 'C', fixed: true, evidence: 'proof' },
      ],
    });
    expect(three.map((e) => [e.semanticId, e.state])).toEqual([
      ['A', 'regressed'],
      ['B', 'fixed'],
      ['C', 'fixed'],
    ]);
  });
  it('fails closed for absent closure evidence and seeds historical packets open', () => {
    const prior = batch([finding('A')]);
    const reconciled = reconcileReviewLedger(prior, [], undefined);
    expect(reconciled[0]?.state).toBe('open');
    expect(activeLedgerEntries(prior)).toHaveLength(1);
    expect(activeLedgerFindings(reconciled)).toHaveLength(1);
  });

  it('rejects duplicate closure decisions', () => {
    const prior = reconcileReviewLedger(undefined, [finding('A')], undefined);
    expect(
      parseClosureVerification(
        JSON.stringify({
          decisions: [
            { semanticId: 'A', fixed: false },
            { semanticId: 'A', fixed: true, evidence: 'invented duplicate' },
          ],
        }),
        prior,
      ).status,
    ).toBe('invalid');
  });

  it('fails closed for omitted, invented, and malformed closure decisions', () => {
    const prior = reconcileReviewLedger(undefined, [finding('A'), finding('B')], undefined);
    expect(parseClosureVerification('{"decisions":[{"semanticId":"A","fixed":false}]}', prior).status).toBe('invalid');
    expect(parseClosureVerification('{"decisions":[{"semanticId":"A","fixed":false},{"semanticId":"X","fixed":false}]}', prior).status).toBe('invalid');
    expect(parseClosureVerification('{"decisions":"not-an-array"}', prior).status).toBe('invalid');
  });
});
