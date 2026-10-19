import { describe, expect, it } from 'vitest';
import { createConfigurationStore } from '../configuration/configuration-store.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import { createAdmissionFixture, flushAdmission } from '../test-utils/admission-queries-helpers.js';
describe('resolved launch admission owner', () => {
  it('stores immutable configuration and creation metadata, publishing only after commit and retaining it through SQLite reopen', async () => {
    const f = createAdmissionFixture(true);
    const n = await f.native();
    const admitted = n.admit();
    expect(f.enqueueSession).not.toHaveBeenCalled();
    await flushAdmission();
    const saved = f.podRepo.getOrThrow(admitted.podId);
    expect(saved.creatorEmail).toBe('owner@invalid.example');
    expect(saved.launchConfigDigest).toBe(n.config.digest);
    expect(f.enqueueSession).toHaveBeenCalledExactlyOnceWith(saved.id);
    const flow = n.store.get('workflow', 'flow');
    n.store.write({
      kind: 'workflow',
      id: flow.id,
      name: flow.name,
      expectedRevision: flow.revision,
      payload: { ...flow.payload, branchPrefix: 'edited/' },
    });
    const next = f.reopen();
    expect(next.pods.getOrThrow(saved.id)).toEqual(saved);
    const snapshots = createLaunchSnapshotRepository(f.db, createConfigurationStore(f.db));
    expect(snapshots.get(saved.id)).toEqual(n.config);
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('refuses unavailable native execution and account identity changes without publishing', async () => {
    const f = createAdmissionFixture();
    const n = await f.native();
    f.live.launchConfiguration = undefined;
    expect(() => f.resolved().createResolvedSession(n.config, 'operator')).toThrow(
      'execution is unavailable',
    );
    f.live.launchConfiguration = {
      read: n.snapshots.get,
      executionSettings: () => f.profiles.get('test-profile'),
      assertCurrentCapabilities: async () => {},
    };
    expect(() =>
      f.resolved().createResolvedSession({ ...n.config, agentAccounts: {} }, 'operator'),
    ).toThrow('identity changed');
    expect(f.enqueueSession).not.toHaveBeenCalled();
  });
  it('refuses native deny-all and unadmitted sidecars before insertion', async () => {
    const f = createAdmissionFixture();
    const n = await f.native();
    expect(() =>
      f.resolved().createResolvedSession(
        {
          ...n.config,
          execution: {
            ...n.config.execution,
            networkPolicy: { enabled: true, mode: 'deny-all', allowedHosts: [] },
          },
        },
        'operator',
      ),
    ).toThrow('outbound provider access');
    expect(f.enqueueSession).not.toHaveBeenCalled();
  });
  it('rolls back failed snapshot admission and emits no creation event or queue effect', async () => {
    const f = createAdmissionFixture(true);
    const n = await f.native();
    const before = f.podRepo.list().length;
    expect(() =>
      f.db.transaction(() => {
        n.admit();
        throw new Error('Synthetic outer rollback');
      })(),
    ).toThrow('outer rollback');
    await flushAdmission();
    expect(f.enqueueSession).not.toHaveBeenCalled();
    const next = f.reopen();
    expect(next.pods.list()).toHaveLength(before);
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
});
