import { expect, it } from 'vitest';
import { fixture, resign } from '../test-utils/managed-fixture.js';
import { ManagedPodService } from './managed-service.js';
import { ManagedQuotaBroker } from './quota-broker.js';

it.each([
  'before-reservation',
  'after-reservation',
  'after-pod-row',
  'after-runtime-identity',
  'after-agent-start',
  'before-response',
  'after-response',
])('one reservation and worker across %s replay', async (fault) => {
  const f = fixture();
  try {
    if (fault === 'after-response') await f.service().start('installation-one', f.request);
    else await expect(f.service().start('installation-one', f.request, fault)).rejects.toThrow();
    f.restart();
    const s = f.service();
    const handle =
      (await s.reconcileStart('installation-one', f.request)) ??
      (await s.start('installation-one', f.request));
    expect(await s.start('installation-one', f.request)).toEqual(handle);
    expect(f.db.prepare('SELECT count(*) AS count FROM managed_pods').get()).toEqual({ count: 1 });
    expect(f.launches()).toBe(1);
  } finally {
    f.close();
  }
});
it('concurrent equal requests converge and conflicting requests reserve only one pod', async () => {
  const f = fixture();
  try {
    const s = f.service();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => s.start('installation-one', f.request)),
    );
    expect(new Set(results.map((result) => result.podId)).size).toBe(1);
    expect(f.launches()).toBe(1);
    const changed = resign({
      ...structuredClone(f.request),
      task: { ...f.request.task, objective: 'changed' },
    });
    const race = await Promise.allSettled([
      s.start('installation-one', f.request),
      s.start('installation-one', changed),
    ]);
    expect(race.map((value) => value.status)).toEqual(['fulfilled', 'rejected']);
    expect(f.launches()).toBe(1);
  } finally {
    f.close();
  }
});
it('expiry survives service restart and is enforced without Dispatcher', async () => {
  const f = fixture();
  try {
    f.request.effectiveGrant.budget.expiresAt = 110;
    resign(f.request);
    const handle = await f.service().start('installation-one', f.request);
    f.advance(111);
    const restarted = f.service();
    await restarted.enforceExpiry();
    expect(restarted.row('installation-one', handle.podId).revoked).toBe(1);
    expect((await f.runtime.observe(handle.podId)).state).toBe('stopped');
    const expired = resign({
      ...structuredClone(f.request),
      startKey: 'new',
      dispatcherAttemptId: 'new',
      effectiveGrant: { ...f.request.effectiveGrant, dispatcherAttemptId: 'new' },
    });
    await expect(restarted.start('installation-one', expired)).rejects.toThrow('expired');
    expect(f.launches()).toBe(1);
  } finally {
    f.close();
  }
});
it('expiry closes a reservation that failed before runtime allocation', async () => {
  const f = fixture();
  try {
    f.request.effectiveGrant.budget.expiresAt = 110;
    resign(f.request);
    await expect(
      f.service().start('installation-one', f.request, 'after-reservation'),
    ).rejects.toThrow('injected-after-reservation');
    expect(f.launches()).toBe(0);
    f.advance(111);
    const restarted = f.service();
    await restarted.enforceExpiry();
    const row = restarted.lookup('installation-one', f.request.startKey);
    expect(row).toMatchObject({
      state: 'killed',
      runtime_ref: null,
      revoked: 1,
      stop_requested: 1,
      observed_exit: 1,
    });
    const recovered = await restarted.reconcileStart('installation-one', f.request);
    expect(recovered?.podId).toBe(row?.pod_id);
    expect(f.launches()).toBe(0);
  } finally {
    f.close();
  }
});
it.each(['agent-request-limit-reached', 'agent-auto-compaction-unsupported'] as const)(
  'persists allowlisted runtime limitation %s before later cleanup',
  async (limitation) => {
    const f = fixture();
    try {
      const service = f.service();
      const handle = await service.start('installation-one', f.request);
      f.runtime.observe = async () => ({
        state: 'stopped',
        consumedTokens: 42,
        exitCode: 1,
        limitation,
      });
      await service.enforceExpiry();
      expect(
        f.db
          .prepare('SELECT limitations_json FROM managed_results WHERE pod_id=?')
          .get(handle.podId),
      ).toEqual({ limitations_json: JSON.stringify([limitation]) });
    } finally {
      f.close();
    }
  },
);
it('dark mode and unenforceable scope cause no effects', async () => {
  const f = fixture();
  try {
    await expect(
      new ManagedPodService(f.db, f.admission, f.runtime).start('installation-one', f.request),
    ).rejects.toThrow('lane-disabled');
    await expect(
      new ManagedPodService(
        f.db,
        { ...f.admission, enforcement: [] },
        f.runtime,
        () => 100,
        true,
      ).start('installation-one', f.request),
    ).rejects.toThrow('unenforceable');
    expect(f.launches()).toBe(0);
  } finally {
    f.close();
  }
});

it('quota reservations survive restart, pin route and do not repeat uncertain calls', async () => {
  const f = fixture();
  try {
    const handle = await f.service().start('installation-one', f.request);
    let calls = 0;
    const quota = new ManagedQuotaBroker(f.service());
    await expect(
      quota.invoke('installation-one', handle.podId, 'one', 20000, async (route) => {
        expect(route).toEqual(f.request.route);
        calls++;
        throw new Error('lost-response');
      }),
    ).rejects.toThrow('lost-response');
    f.restart();
    const restarted = new ManagedQuotaBroker(f.service());
    expect(
      await restarted.invoke('installation-one', handle.podId, 'one', 20000, async () => {
        calls++;
        return { value: 'unexpected', consumedTokens: 1 };
      }),
    ).toEqual({ state: 'reserved' });
    await expect(
      restarted.invoke('installation-one', handle.podId, 'two', 40000, async () => {
        calls++;
        return { value: 'unexpected', consumedTokens: 1 };
      }),
    ).rejects.toThrow('budget-exhausted');
    expect(calls).toBe(1);
    expect(restarted.snapshot('installation-one', handle.podId).consumedTokens).toBe(20000);
  } finally {
    f.close();
  }
});
it('conflicting initial requests racing through separate services reserve one pod', async () => {
  const f = fixture();
  try {
    const other = resign({
      ...structuredClone(f.request),
      task: { ...f.request.task, objective: 'other' },
    });
    const results = await Promise.allSettled([
      f.service().start('installation-one', f.request),
      f.service().start('installation-one', other),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(f.db.prepare('SELECT count(*) AS count FROM managed_pods').get()).toEqual({ count: 1 });
    expect(f.launches()).toBe(1);
  } finally {
    f.close();
  }
});

it.each(['managed-git-operation-failed', 'Bearer reusable-secret'])(
  'persists only safe launch failure categories for %s',
  async (message) => {
    const f = fixture();
    try {
      f.runtime.ensure = async () => {
        throw new Error(message);
      };
      const service = f.service();
      await expect(service.start('installation-one', f.request)).rejects.toThrow();
      const row = service.lookup('installation-one', f.request.startKey);
      const result = f.db
        .prepare('SELECT limitations_json FROM managed_results WHERE pod_id=?')
        .get(row?.pod_id) as { limitations_json: string };
      expect(JSON.parse(result.limitations_json)).toEqual([
        message === 'managed-git-operation-failed' ? message : 'managed-launch-unconfirmed',
      ]);
      expect(result.limitations_json).not.toContain('reusable-secret');
    } finally {
      f.close();
    }
  },
);
