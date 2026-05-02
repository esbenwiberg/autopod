import type { Pod } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { findPreflightConflicts } from './preflight.js';

/**
 * Build a minimal Pod fixture for preflight tests. Only the fields preflight
 * reads are filled in; other fields use safe placeholder values so the type
 * checks pass without leaking unrelated noise into the tests.
 */
function makePod(overrides: Partial<Pod> & { id: string; touches?: string[] | null }): Pod {
  return {
    id: overrides.id,
    profileName: 'test-profile',
    task: overrides.task ?? `task for ${overrides.id}`,
    status: overrides.status ?? 'running',
    model: 'sonnet',
    runtime: 'claude',
    branch: `feat/${overrides.id}`,
    baseBranch: overrides.baseBranch ?? null,
    touches: overrides.touches ?? null,
    doesNotTouch: null,
    ...overrides,
  } as unknown as Pod;
}

describe('findPreflightConflicts', () => {
  it('returns [] when the candidate has no touches', () => {
    const result = findPreflightConflicts({ touches: [], repoUrl: 'r', baseBranch: 'main' }, [
      { pod: makePod({ id: 'p1', touches: ['packages/daemon/**'] }), repoUrl: 'r' },
    ]);
    expect(result).toEqual([]);
  });

  it('returns [] when no existing pod overlaps', () => {
    const result = findPreflightConflicts(
      { touches: ['packages/cli/**'], repoUrl: 'r', baseBranch: 'main' },
      [{ pod: makePod({ id: 'p1', touches: ['packages/daemon/**'] }), repoUrl: 'r' }],
    );
    expect(result).toEqual([]);
  });

  it('flags overlapping pods on the same repo + base', () => {
    const result = findPreflightConflicts(
      { touches: ['packages/daemon/src/pods/**'], repoUrl: 'r', baseBranch: 'main' },
      [
        {
          pod: makePod({
            id: 'p1',
            touches: ['packages/daemon/src/pods/pod-manager.ts'],
            baseBranch: 'main',
          }),
          repoUrl: 'r',
        },
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.conflictingPodId).toBe('p1');
    expect(result[0]?.overlappingGlobs).toHaveLength(1);
  });

  it('skips terminal pods', () => {
    for (const status of ['complete', 'killed'] as const) {
      const result = findPreflightConflicts(
        { touches: ['packages/daemon/**'], repoUrl: 'r', baseBranch: 'main' },
        [
          {
            pod: makePod({
              id: 'p1',
              status,
              touches: ['packages/daemon/src/pods/pod-manager.ts'],
              baseBranch: 'main',
            }),
            repoUrl: 'r',
          },
        ],
      );
      expect(result, `status=${status} should not conflict`).toEqual([]);
    }
  });

  it('flags failed pods (not terminal in autopod — may be retried)', () => {
    const result = findPreflightConflicts(
      { touches: ['packages/daemon/**'], repoUrl: 'r', baseBranch: 'main' },
      [
        {
          pod: makePod({
            id: 'p1',
            status: 'failed',
            touches: ['packages/daemon/src/pods/pod-manager.ts'],
            baseBranch: 'main',
          }),
          repoUrl: 'r',
        },
      ],
    );
    expect(result).toHaveLength(1);
  });

  it('skips pods with no touches', () => {
    const result = findPreflightConflicts(
      { touches: ['packages/daemon/**'], repoUrl: 'r', baseBranch: 'main' },
      [{ pod: makePod({ id: 'p1', touches: null, baseBranch: 'main' }), repoUrl: 'r' }],
    );
    expect(result).toEqual([]);
  });

  it('does not flag pods on a different repo', () => {
    const result = findPreflightConflicts(
      { touches: ['packages/daemon/**'], repoUrl: 'repo-a', baseBranch: 'main' },
      [
        {
          pod: makePod({
            id: 'p1',
            touches: ['packages/daemon/src/pods/pod-manager.ts'],
            baseBranch: 'main',
          }),
          repoUrl: 'repo-b',
        },
      ],
    );
    expect(result).toEqual([]);
  });

  it('does not flag pods on a different base branch', () => {
    const result = findPreflightConflicts(
      { touches: ['packages/daemon/**'], repoUrl: 'r', baseBranch: 'main' },
      [
        {
          pod: makePod({
            id: 'p1',
            touches: ['packages/daemon/src/pods/pod-manager.ts'],
            baseBranch: 'develop',
          }),
          repoUrl: 'r',
        },
      ],
    );
    expect(result).toEqual([]);
  });

  it('treats a null pod.baseBranch as the candidate base (default-branch case)', () => {
    // When pod.baseBranch is null, the pod is on the profile's default branch.
    // The caller passes the candidate's base branch; we treat null as "matches the candidate".
    const result = findPreflightConflicts(
      { touches: ['packages/daemon/**'], repoUrl: 'r', baseBranch: 'main' },
      [
        {
          pod: makePod({
            id: 'p1',
            touches: ['packages/daemon/src/pods/pod-manager.ts'],
            baseBranch: null,
          }),
          repoUrl: 'r',
        },
      ],
    );
    expect(result).toHaveLength(1);
  });

  it('returns multiple conflicts when several pods overlap', () => {
    const result = findPreflightConflicts(
      { touches: ['packages/daemon/**'], repoUrl: 'r', baseBranch: 'main' },
      [
        {
          pod: makePod({ id: 'p1', touches: ['packages/daemon/src/pods/x.ts'] }),
          repoUrl: 'r',
        },
        {
          pod: makePod({ id: 'p2', touches: ['packages/daemon/src/api/y.ts'] }),
          repoUrl: 'r',
        },
        {
          pod: makePod({ id: 'p3', touches: ['packages/cli/**'] }),
          repoUrl: 'r',
        },
      ],
    );
    expect(result.map((c) => c.conflictingPodId).sort()).toEqual(['p1', 'p2']);
  });
});
