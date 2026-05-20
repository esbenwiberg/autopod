import type { Pod, PodStatus } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { byRecency, isActive, isTerminal, needsMe } from './pod-filters.js';

function pod(status: PodStatus, overrides: Partial<Pod> = {}): Pod {
  // Cast: we only exercise the status field; tests don't need a real Pod.
  return { status, ...overrides } as unknown as Pod;
}

const ALL_STATUSES: PodStatus[] = [
  'queued',
  'provisioning',
  'running',
  'awaiting_input',
  'validating',
  'validated',
  'failed',
  'review_required',
  'approved',
  'merging',
  'merge_pending',
  'complete',
  'paused',
  'handoff',
  'killing',
  'killed',
];

describe('isTerminal', () => {
  it('flags exactly complete + killed as terminal', () => {
    const terminal = ALL_STATUSES.filter((s) => isTerminal(pod(s)));
    expect(terminal.sort()).toEqual(['complete', 'killed']);
  });
});

describe('needsMe', () => {
  it('flags awaiting_input + review_required + failed', () => {
    const flagged = ALL_STATUSES.filter((s) => needsMe(pod(s)));
    expect(flagged.sort()).toEqual(['awaiting_input', 'failed', 'review_required']);
  });
});

describe('isActive', () => {
  it('is the complement of isTerminal', () => {
    for (const s of ALL_STATUSES) {
      expect(isActive(pod(s))).toBe(!isTerminal(pod(s)));
    }
  });
});

describe('byRecency', () => {
  it('sorts most-recently-updated first', () => {
    const a = pod('running', { updatedAt: '2026-01-01T00:00:00Z' });
    const b = pod('running', { updatedAt: '2026-01-02T00:00:00Z' });
    const c = pod('running', { updatedAt: '2025-12-31T00:00:00Z' });
    expect([a, b, c].sort(byRecency).map((p) => p.updatedAt)).toEqual([
      '2026-01-02T00:00:00Z',
      '2026-01-01T00:00:00Z',
      '2025-12-31T00:00:00Z',
    ]);
  });

  it('falls back to createdAt when updatedAt is missing', () => {
    const a = pod('running', { createdAt: '2026-01-01T00:00:00Z' });
    const b = pod('running', { createdAt: '2026-01-02T00:00:00Z' });
    expect([a, b].sort(byRecency).map((p) => p.createdAt)).toEqual([
      '2026-01-02T00:00:00Z',
      '2026-01-01T00:00:00Z',
    ]);
  });
});
