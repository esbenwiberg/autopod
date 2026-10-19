import { describe, expect, it, vi } from 'vitest';
import { createConfigurationStore } from '../configuration/configuration-store.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import { createWorkspaceFixture } from '../test-utils/workspace-recovery-helpers.js';
describe('workspace manual-fix admission', () => {
  it('requires eligible failed/review/validated worker and carries actor/creator into legacy workspace request', async () => {
    const f = createWorkspaceFixture();
    await expect(
      f.manualFix().fixManually.call(f.calls, 'prepare', 'operator'),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    f.podRepo.update('prepare', { status: 'failed' });
    const create = vi.fn(f.calls.createSession);
    f.calls.createSession = create;
    const creator = { name: 'Fixture', email: 'fixture@invalid.example' };
    await f
      .manualFix()
      .fixManually.call(
        f.calls,
        'prepare',
        { type: 'human', userId: 'operator', displayName: 'Reviewer' },
        creator,
        ' repair ',
      );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        outputMode: 'workspace',
        branch: 'branch',
        linkedPodId: 'prepare',
        task: expect.stringContaining('Instructions: repair'),
      }),
      'operator',
      creator,
    );
  });
  it('uses actual frozen derive/snapshot admission and preserves the native manual workspace through reopen', async () => {
    const f = createWorkspaceFixture(true);
    const native = await f.nativeLaunch();
    const id = native.admitted.podId;
    f.podRepo.update(id, { status: 'failed' });
    const flow = native.store.get('workflow', 'flow');
    native.store.write({
      kind: 'workflow',
      id: flow.id,
      name: flow.name,
      expectedRevision: flow.revision,
      payload: { ...flow.payload, validationPhases: [] },
    });
    const creator = { name: 'Reviewer' };
    const child = await f
      .manualFix()
      .fixManually.call(f.calls, id, { type: 'human', userId: 'reviewer' }, creator, 'repair');
    expect(child).toMatchObject({
      id: 'frozen-manual',
      linkedPodId: id,
      userId: 'reviewer',
      options: { agentMode: 'interactive', output: 'branch', promotable: false },
    });
    expect(f.calls.createResolvedSession).toHaveBeenCalledWith(
      expect.objectContaining({
        derivation: expect.objectContaining({ kind: 'manual-fix', podId: id }),
      }),
      'reviewer',
      creator,
      { type: 'human', userId: 'reviewer' },
    );
    const frozen = native.snapshots.get(child.id);
    expect(frozen?.work.seriesId).toBeUndefined();
    expect(frozen?.work.dependsOnPodIds ?? []).toEqual([]);
    const next = f.reopen();
    expect(next.pods.getOrThrow(child.id)).toEqual(child);
    expect(
      createLaunchSnapshotRepository(f.db, createConfigurationStore(f.db)).get(child.id),
    ).toEqual(frozen);
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
});
