import type { Pod } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import {
  describeAdoptedHistoryRewrite,
  historyRewritePolicyForPod,
} from './fix-history-rewrite-policy.js';

function pods(overrides: Partial<Pod> = {}, parentOverrides: Partial<Pod> = {}) {
  const parent = { id: 'parent', fixPodId: 'fix', ...parentOverrides } as Pod;
  const fix = {
    id: 'fix',
    executionTarget: 'local',
    outputMode: 'pr',
    linkedPodId: 'parent',
    prUrl: 'https://github.com/org/repo/pull/1',
    branch: 'feature',
    baseBranch: 'release',
    ...overrides,
  } as Pod;
  return { fix, parent };
}

describe('historyRewritePolicyForPod', () => {
  it('authorizes the canonical PR fix pod on local Docker', () => {
    const { fix, parent } = pods();
    expect(historyRewritePolicyForPod(fix, parent, 'main')).toEqual({
      kind: 'canonical-pr-fix',
      podId: 'fix',
      parentPodId: 'parent',
      prUrl: 'https://github.com/org/repo/pull/1',
      branch: 'feature',
      baseBranch: 'release',
    });
  });

  it('falls back to the profile default branch, then main', () => {
    const { fix, parent } = pods({ baseBranch: null });
    expect(historyRewritePolicyForPod(fix, parent, 'develop')?.baseBranch).toBe('develop');
    expect(historyRewritePolicyForPod(fix, parent, null)?.baseBranch).toBe('main');
  });

  it.each([
    ['a sandbox pod', { executionTarget: 'sandbox' }, {}],
    ['an unlinked pod', { linkedPodId: null }, {}],
    ['a manual-fix workspace pod', { outputMode: 'workspace' }, {}],
    ['a pod that is not the parent fix child', {}, { fixPodId: 'other' }],
    ['a pod without a PR', { prUrl: null }, {}],
    ['a pod without a branch', { branch: '' }, {}],
  ] as const)('refuses %s', (_label, overrides, parentOverrides) => {
    const { fix, parent } = pods(overrides as Partial<Pod>, parentOverrides as Partial<Pod>);
    expect(historyRewritePolicyForPod(fix, parent, 'main')).toBeNull();
  });

  it('refuses when the parent is missing or a different pod', () => {
    const { fix } = pods();
    expect(historyRewritePolicyForPod(fix, null, 'main')).toBeNull();
    expect(historyRewritePolicyForPod(fix, { id: 'x', fixPodId: 'fix' } as Pod, 'main')).toBeNull();
  });
});

describe('describeAdoptedHistoryRewrite', () => {
  it('records heads, fork points, accounting and the authorizing policy', () => {
    const { fix, parent } = pods();
    const policy = historyRewritePolicyForPod(fix, parent, 'main');
    if (!policy) throw new Error('policy expected');
    const text = describeAdoptedHistoryRewrite({
      policy,
      evidence: {
        predecessor: 'a'.repeat(40),
        candidate: 'b'.repeat(40),
        baseRef: 'refs/remotes/origin/release',
        baseTip: 'c'.repeat(40),
        predecessorFork: 'd'.repeat(40),
        candidateFork: 'e'.repeat(40),
        patchEquivalent: 2,
        fingerprintMatched: 1,
      },
    });
    for (const fragment of [
      `old head ${'a'.repeat(40)} → new head ${'b'.repeat(40)}`,
      `Base refs/remotes/origin/release at ${'c'.repeat(40)}`,
      `fork point ${'d'.repeat(40)} → ${'e'.repeat(40)}`,
      '3 old commit(s) accounted for (2 patch-equivalent, 1 matched by author, date and subject)',
      'policy canonical-pr-fix (fix of parent, https://github.com/org/repo/pull/1)',
      'lease against the recorded PR head',
    ])
      expect(text).toContain(fragment);
  });
});
