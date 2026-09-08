import { expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { fixture } from '../test-utils/managed-fixture.js';
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
