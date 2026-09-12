import { expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { fixture, resign } from '../test-utils/managed-fixture.js';
import { digest } from './canonical.js';
import { ManagedQuotaFeed } from './quota-feed.js';

it('publishes root-only bound quota snapshots, then stops refreshing after daemon loss', async () => {
  const f = fixture();
  vi.useFakeTimers();
  const exec = vi.fn(async (_ref: string, _argv: string[], _options: object) => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
  }));
  const manager = { execInContainer: exec } as unknown as ContainerManager;
  const service = f.service();
  const feed = new ManagedQuotaFeed(service, manager);
  try {
    const handle = await service.start('installation-one', f.request);
    await feed.attach(
      'installation-one',
      handle.podId,
      handle.podId,
      `/run/dispatcher-${handle.podId}`,
    );
    expect(exec.mock.calls[0]?.[0]).toBe(handle.podId);
    f.db.prepare('UPDATE managed_pods SET revoked=1').run();
    await vi.advanceTimersByTimeAsync(1000);
    const call = exec.mock.calls.at(-1) as unknown as [string, string[], { user: string }];
    expect(call[2]).toEqual({ user: 'root' });
    expect(JSON.parse(call[1][4]!)).toMatchObject({
      revoked: true,
      specDigest: f.request.executionSpecDigest,
    });
    feed.close();
    const count = exec.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(exec).toHaveBeenCalledTimes(count);
  } finally {
    feed.close();
    vi.useRealTimers();
    f.close();
  }
});

it('retries a transient sandbox control rejection instead of abandoning the quota feed', async () => {
  const f = fixture();
  vi.useFakeTimers();
  f.request.route.executionTarget = 'sandbox';
  f.request.profileSnapshot.route = structuredClone(f.request.route);
  f.request.effectiveGrant.route = structuredClone(f.request.route);
  f.request.profileSnapshot.snapshotDigest = digest(
    Object.fromEntries(
      Object.entries(f.request.profileSnapshot).filter(([key]) => key !== 'snapshotDigest'),
    ),
  );
  f.request.effectiveGrant.profileSnapshotDigest = f.request.profileSnapshot.snapshotDigest;
  resign(f.request);
  f.admission.profiles = new Map([
    [f.request.profileSnapshot.snapshotDigest, f.request.profileSnapshot],
  ]);
  f.admission.targets = ['sandbox'];
  const exec = vi.fn<ContainerManager['execInContainer']>();
  const writeFile = vi
    .fn<ContainerManager['writeFile']>()
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error('sandbox-busy'))
    .mockResolvedValue();
  const feed = new ManagedQuotaFeed(f.service(), {
    execInContainer: exec,
    writeFile,
  } as unknown as ContainerManager);
  try {
    const handle = await f.service().start('installation-one', f.request);
    await feed.attach(
      'installation-one',
      handle.podId,
      handle.podId,
      `/run/dispatcher-${handle.podId}`,
    );
    await vi.advanceTimersByTimeAsync(1_500);
    expect(writeFile).toHaveBeenCalledTimes(3);
    expect(writeFile.mock.calls[0]?.slice(0, 2)).toEqual([
      handle.podId,
      `/run/dispatcher-${handle.podId}/quota.json`,
    ]);
    expect(exec).not.toHaveBeenCalled();
  } finally {
    feed.close();
    vi.useRealTimers();
    f.close();
  }
});
