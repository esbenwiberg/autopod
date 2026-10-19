import { describe, expect, it } from 'vitest';
import { deferred } from '../test-utils/workspace-recovery-helpers.js';
import {
  createWorkspaceLeaseState,
  createWorkspaceRecoveryState,
} from './workspace-recovery-state.js';
describe('workspace state and completion coordinator', () => {
  it('creates distinct maps/Set per manager while retaining returned identities', () => {
    const a = createWorkspaceRecoveryState();
    const b = createWorkspaceRecoveryState();
    const lease = createWorkspaceLeaseState();
    expect(a.infrastructureResumeRuns).not.toBe(b.infrastructureResumeRuns);
    expect(a.artifactResumeRuns).not.toBe(b.artifactResumeRuns);
    expect(a.artifactCompletionRuns).not.toBe(b.artifactCompletionRuns);
    const pending = Promise.resolve();
    a.infrastructureResumeRuns.set('pod', pending);
    expect(a.infrastructureResumeRuns.get('pod')).toBe(pending);
    expect(b.infrastructureResumeRuns.size).toBe(0);
    lease.forceWithLeaseAllowances.add('pod');
    expect(createWorkspaceLeaseState().forceWithLeaseAllowances.size).toBe(0);
    a.infrastructureResumeRuns.delete('pod');
    lease.forceWithLeaseAllowances.delete('pod');
  });
  it('coalesces identical requests, rejects conflicting overlap and releases after success or failure', async () => {
    const state = createWorkspaceRecoveryState();
    const gate = deferred<{ pushError?: string }>();
    const pod = { id: 'pod', lifecycleGeneration: 1 };
    const first = state.coordinateInteractiveCompletion(
      pod,
      { promoteTo: 'branch' },
      () => gate.promise,
    );
    const same = state.coordinateInteractiveCompletion(pod, { promoteTo: 'branch' }, async () => ({
      pushError: 'must not execute',
    }));
    expect(same).toBe(first);
    expect(() =>
      state.coordinateInteractiveCompletion(pod, { promoteTo: 'pr' }, async () => ({})),
    ).toThrow('still settling');
    gate.resolve({});
    await first;
    const error = new Error('Synthetic completion');
    await expect(
      state.coordinateInteractiveCompletion(pod, undefined, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    await expect(
      state.coordinateInteractiveCompletion(pod, undefined, async () => ({})),
    ).resolves.toEqual({});
  });
});
