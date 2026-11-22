import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type Dockerode from 'dockerode';
import { afterEach, describe, expect, it } from 'vitest';
import { ALLOCATION_LABEL } from '../containers/docker-allocation-evidence.js';
import { networkNameForPod } from '../containers/docker-network-manager.js';
import { createRetainedCleanupDocker } from '../containers/retained-cleanup-docker.js';
import { retainedNetworkReleaseScope } from '../containers/retained-network-release.js';
import { registerRetainedPathFunctions } from '../db/retained-path-functions.js';
import { createTestContext, createTestDb } from '../test-utils/mock-helpers.js';
import { fixtureGit, retainedCleanupFixture } from '../test-utils/retained-cleanup-fixture.js';
import { createRetainedCleanupHost } from '../worktrees/retained-cleanup-host.js';
import { createPodManager } from './pod-manager.js';
import { createPodRepository } from './pod-repository.js';
import type { AllocationScope } from './retained-allocation-inventory.js';
import { createRetainedCleanup } from './retained-cleanup.js';
import {
  assertRetainedCleanupPathAvailable,
  withCleanupAllocationFence,
} from './retained-cleanup-repository.js';

const actor = { type: 'human', userId: 'fixture-human' } as const;
const onClose: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of onClose.splice(0).reverse()) await close();
});
const missing = Object.assign(new Error('fixture absent'), { statusCode: 404 });
async function fixture() {
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'retained-cleanup-')));
  onClose.push(() => rm(tmp, { force: true, recursive: true }));
  const config = path.join(tmp, 'db.sqlite');
  const seed = createTestDb();
  await seed.backup(config);
  seed.close();
  function reopen() {
    const db = new Database(config);
    registerRetainedPathFunctions(db);
    db.pragma('foreign_keys=ON');
    onClose.push(() => {
      if (db.open) db.close();
    });
    return db;
  }
  const db = reopen();
  const engine = 'cleanup-fixture-engine';
  let sequence = 0;
  function id() {
    return (++sequence).toString(16).padStart(64, '0');
  }
  const bridges = new Map<string, Dockerode.NetworkInspectInfo>();
  const guests = new Map<string, Dockerode.ContainerInspectInfo>();
  const removed: string[] = [];
  let removeHook: ((id: string) => Promise<void>) | undefined;
  const docker = {
    info: async () => ({ ID: engine }),
    listContainers: async () => [...guests.values()].map((c) => ({ ...c, Names: [c.Name] })),
    listNetworks: async () => [...bridges.values()],
    getContainer: (native: string) => ({
      inspect: async () => {
        if (!guests.has(native)) throw missing;
        return guests.get(native);
      },
      remove: async (opts: unknown) => {
        expect(opts).toEqual({ force: false, v: false });
        removed.push(native);
        if (removeHook) await removeHook(native);
        guests.delete(native);
        for (const bridge of bridges.values()) delete bridge.Containers?.[native];
      },
    }),
    getNetwork: (native: string) => ({
      inspect: async () => {
        if (!bridges.has(native)) throw missing;
        return bridges.get(native);
      },
      remove: async () => {
        expect(guests.size).toBe(0);
        removed.push(native);
        if (removeHook) await removeHook(native);
        bridges.delete(native);
      },
    }),
  } as unknown as Dockerode;
  async function spawn(s: AllocationScope, identity: string, sourceMount: string, common: string) {
    const Name = networkNameForPod(identity);
    const bridge = s.begin('bridge', Name);
    const native = id();
    const receipt = { id: native, engineId: engine };
    bridge.createReply(receipt);
    bridges.set(native, {
      Id: native,
      Name,
      Scope: 'local',
      Driver: 'bridge',
      Ingress: false,
      Containers: {},
      Labels: { [ALLOCATION_LABEL]: bridge.id },
    } as Dockerode.NetworkInspectInfo);
    bridge.owned(receipt);
    const c = s.begin('container', identity);
    const Id = id();
    c.createReply({ engineId: engine, id: Id });
    guests.set(Id, {
      Id,
      Name: '/' + identity,
      Config: { Labels: { [ALLOCATION_LABEL]: c.id } },
      HostConfig: { NetworkMode: Name, RestartPolicy: { Name: 'no' } },
      State: { Status: 'exited', Running: false, Paused: false, Restarting: false },
      NetworkSettings: { Networks: { [Name]: { NetworkID: native } } },
      Mounts: [
        { Type: 'bind', Source: sourceMount, Destination: '/mnt/worktree' },
        { Type: 'bind', Source: common, Destination: common },
      ],
    } as unknown as Dockerode.ContainerInspectInfo);
    c.owned({ engineId: engine, id: Id, bridge: receipt, sourceMount });
    return Id;
  }
  const f = await retainedCleanupFixture({
    db,
    root: tmp,
    podId: 'cleanup-fixture',
    engine,
    spawn,
  });
  const idle = { value: true };
  function service(conn = db) {
    return createRetainedCleanup({
      pods: createPodRepository(conn),
      docker: createRetainedCleanupDocker(docker),
      host: createRetainedCleanupHost(async () => [
        { point: '/', root: '/', device: 'fixture-device' },
      ]),
      isIdle: () => idle.value,
      isGoal: () => false,
    });
  }
  async function request() {
    const p = await service().inspect(f.podId);
    if (p.state !== 'eligible') throw new Error(JSON.stringify(p));
    return {
      id: 'human-request',
      expectedGeneration: p.plan.generation,
      expectedBinding: p.plan.binding,
      expectedSessionId: p.plan.sessionId,
      reason: 'Discard the task and its unpublished retained work',
      acknowledgeDataLoss: true as const,
    };
  }
  function stop(finalize: boolean) {
    const ledger = f.repo.retainedFinalizations!;
    const p = f.repo.getOrThrow(f.podId);
    ledger.admit(
      {
        fingerprint: 'a'.repeat(64),
        generation: 2,
        containerId: f.replacement,
        target: 'local',
        worktreePath: p.worktreePath,
        taskId: f.taskId,
        resources: [f.originalId, f.replacement],
        resourceKey: JSON.stringify(['docker', engine, f.replacement]),
        owners: [{ kind: 'continuation', id: f.recoveryId }],
        sourceLocations: [f.original, f.preparedRoot],
      },
      {
        podId: f.podId,
        request: {
          requestKey: 'stop-exact',
          expectedGeneration: 2,
          expectedBinding: 'a'.repeat(64),
          mode: 'stop-retain',
          reason: 'Preserve evidence while ending active work',
        },
        actor,
        state: 'pending',
        createdAt: new Date().toISOString(),
        finalizedAt: null,
        message: 'retaining',
        resourcesRetained: true,
      },
      'hash',
      null,
    );
    if (finalize)
      f.repo.atomically!(() =>
        ledger.terminal(f.podId, () => {
          f.repo.update(f.podId, { status: 'killing' });
          f.repo.update(f.podId, { status: 'killed' });
          ledger.finish(f.podId, null);
        }),
      );
  }
  return {
    ...f,
    db,
    service,
    request,
    removed,
    bridges,
    guests,
    stop,
    reopen,
    idle,
    hook: (fn?: typeof removeHook) => {
      removeHook = fn;
    },
  };
}
describe('retained cleanup on SQLite and disposable Git', () => {
  it.each([
    'failed',
    'review_required',
    'killed',
  ])('deletes only selected stopped allocations from %s and preserves History', async (status) => {
    const f = await fixture();
    if (status === 'killed') f.stop(true);
    else f.db.prepare('UPDATE pods SET status=? WHERE id=?').run(status, f.podId);
    const api = f.service();
    const body = await f.request();
    const native = [...f.guests.keys(), ...f.bridges.keys()];
    expect(f.removed).toEqual([]);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM retained_cleanup_requests').get()).toEqual({
      n: 0,
    });
    f.db.prepare('UPDATE pods SET cost_usd=5.75 WHERE id=?').run(f.podId);
    f.db.prepare('UPDATE pod_active_time SET elapsed_ms=77 WHERE pod_id=?').run(f.podId);
    // The cost meter is independent of the live row; existing immutable evidence is not touched.
    f.db
      .prepare("INSERT INTO sandbox_compute_cost VALUES ('historical-meter','prior-key',?,'{}',1)")
      .run(f.podId);
    const final = await api.submit(f.podId, body, actor);
    expect(final).toMatchObject({
      state: 'deleted',
      resources: native
        .concat([f.original, f.prepared.worktree, f.preparedRoot])
        .map((id) => expect.objectContaining({ id, state: 'confirmed_absent' })),
    });
    expect(f.removed).toEqual(native);
    expect(() => f.repo.getOrThrow(f.podId)).toThrow();
    expect(
      f.db
        .prepare('SELECT status,input_tokens,cost_usd FROM retained_pods WHERE id=?')
        .get(f.podId),
    ).toEqual({ status, input_tokens: 123, cost_usd: 5.75 });
    expect(
      f.db
        .prepare(
          "SELECT json_extract(evidence,'$.activeTime.elapsed_ms') AS elapsed FROM retained_cleanup_history_metrics WHERE request_id=?",
        )
        .get(body.id),
    ).toEqual({ elapsed: 77 });
    expect(
      f.db.prepare('SELECT evidence,settled FROM sandbox_compute_cost WHERE pod_id=?').get(f.podId),
    ).toEqual({ evidence: '{}', settled: 1 });
    expect(
      f.db
        .prepare(
          'SELECT COUNT(*) AS n FROM retained_checkpoint_recovery_events WHERE recovery_id=?',
        )
        .get(f.recoveryId),
    ).toEqual({ n: 3 });
    expect(await readFile(path.join(f.unrelated, 'README'), 'utf8')).toContain(
      'preserve unrelated',
    );
    expect(await fixtureGit(f.bare, 'show-ref', '--verify', 'refs/heads/' + f.podId)).toContain(
      'refs/heads/',
    );
    expect(api.receipt(f.podId, body.id)).toEqual(final);
    expect(await api.submit(f.podId, body, actor)).toEqual(final);
    expect(f.removed).toEqual(native);
    if (status === 'killed')
      expect(f.repo.retainedFinalizations!.get(f.podId)?.receipt.state).toBe('finalized');
  }, 30_000);
  it('does not dispatch twice after uncertainty, keeps claims across reopen and reconciles absence only', async () => {
    const f = await fixture();
    const body = await f.request();
    const first = f.service();
    let unlock!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    f.hook(async () => {
      entered();
      await wait;
      throw new Error('unknown fixture outcome');
    });
    const run = first.submit(f.podId, body, actor);
    await started;
    try {
      const observer = f.service(f.reopen());
      expect(observer.receipt(f.podId, body.id).resources[0]?.state).toBe('removal_unconfirmed');
      expect(await observer.inspect(f.podId)).toMatchObject({
        state: 'requested',
        requestId: body.id,
      });
      expect(f.removed).toEqual([f.originalId]);
      const ctx = createTestContext();
      onClose.push(() => ctx.db.close());
      const competing = createPodManager({ ...ctx.deps, podRepo: f.repo });
      await expect(competing.killSession(f.podId)).rejects.toMatchObject({
        code: 'RETAINED_CLEANUP_CONFLICT',
      });
      await expect(competing.deleteSession(f.podId)).rejects.toMatchObject({
        code: 'RETAINED_CLEANUP_CONFLICT',
      });
      await expect(
        competing.continueRetained(
          f.podId,
          {
            id: 'competing-recovery',
            reason: 'Try another retained continuation',
            checkpointHead: 'b'.repeat(40),
            expectedGeneration: 2,
            expectedResultHash: 'a'.repeat(64),
          },
          actor,
        ),
      ).rejects.toMatchObject({ code: 'RETAINED_CLEANUP_CONFLICT' });
      expect(ctx.containerManager.kill).not.toHaveBeenCalled();
      expect(ctx.worktreeManager.cleanup).not.toHaveBeenCalled();
      expect(() => f.repo.delete(f.podId)).toThrow('Delete & free resources owns');
      expect(() => f.repo.deletionOwnership!.acquire(f.podId, 'legacy')).toThrow(
        'Delete & free resources owns',
      );
      expect(() => f.repo.retainedCheckpoints!.assertAvailable(f.podId)).toThrow(
        'Delete & free resources owns',
      );
      expect(() => f.repo.retainedAllocations!.scope(f.podId)!.begin('bridge', 'stale')).toThrow(
        'owns this allocation',
      );
      expect(() => f.repo.update(f.podId, { containerId: null })).toThrow(
        'Delete & free resources owns',
      );
      expect(() => assertRetainedCleanupPathAvailable(f.db, f.original)).toThrow(
        'owns this host path',
      );
      expect(retainedNetworkReleaseScope(f.db).excludedPods.has(f.podId)).toBe(true);
      expect(await observer.submit(f.podId, body, actor)).toMatchObject({
        state: 'partial',
        blockers: [{ code: 'REMOVAL_UNCONFIRMED' }],
      });
      await expect(
        observer.submit(f.podId, { ...body, id: 'different-key' }, actor),
      ).rejects.toThrow('already owns');
      await expect(
        observer.submit(f.podId, body, { ...actor, userId: 'another-user' }),
      ).rejects.toThrow('different binding');
    } finally {
      unlock();
    }
    expect(await run).toMatchObject({ state: 'partial' });
    f.db.close();
    const observer = f.service(f.reopen());
    f.guests.delete(f.originalId); // Independent, positively observable effect, not a successful reply.
    f.hook();
    expect(await observer.submit(f.podId, body, actor)).toMatchObject({ state: 'deleted' });
    expect(f.removed.filter((id) => id === f.originalId)).toHaveLength(1);
  }, 30_000);
  it('rejects stale binding, foreign attachments, running predecessors and path aliases without claim', async () => {
    const f = await fixture();
    const api = f.service();
    const body = await f.request();
    await expect(
      api.submit(f.podId, { ...body, expectedSessionId: 'different' }, actor),
    ).rejects.toThrow('stale');
    const original = f.guests.get(f.originalId)!;
    original.State.Running = true;
    expect(await api.inspect(f.podId)).toMatchObject({
      state: 'blocked',
      blockers: [{ code: 'EXECUTION_NOT_STOPPED', resourceId: f.originalId }],
    });
    original.State.Running = false;
    const bridge = f.bridges.values().next().value!;
    bridge.Containers = { ['f'.repeat(64)]: {} } as never;
    expect(await api.inspect(f.podId)).toMatchObject({
      state: 'blocked',
      blockers: [{ code: 'FOREIGN_ATTACHMENT' }],
    });
    bridge.Containers = {};
    await rename(f.original, f.original + '-old');
    await symlink(f.unrelated, f.original);
    expect(await api.submit(f.podId, body, actor)).toMatchObject({
      state: 'blocked',
      blockers: [{ code: 'HOST_PROOF_UNAVAILABLE' }],
    });
    expect(f.removed).toEqual([]);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM retained_cleanup_requests').get()).toEqual({
      n: 0,
    });
  }, 20_000);
  it('refuses common-store drift and a not-yet-observable foreign allocation', async () => {
    const f = await fixture(),
      api = f.service();
    const body = await f.request();
    await withCleanupAllocationFence(f.db, 'foreign', { sources: [f.preparedRoot] }, async () => {
      expect(await api.submit(f.podId, body, actor)).toMatchObject({
        state: 'blocked',
        blockers: [{ code: 'OWNERSHIP_CONFLICT' }],
      });
    });
    const hidden = path.join(f.prepared.worktree, 'nested');
    await mkdir(hidden);
    await mkdir(path.join(hidden, '.git'));
    expect(await api.submit(f.podId, body, actor)).toMatchObject({
      state: 'blocked',
      blockers: [{ code: 'HOST_PROOF_UNAVAILABLE' }],
    });
    expect(f.removed).toEqual([]);
    expect(f.repo.retainedCleanup!.forPod(f.podId)).toBeUndefined();
  }, 20_000);

  it('rolls back the History copy and completion if fleet deletion fails, then reconciles absence', async () => {
    const f = await fixture(),
      api = f.service();
    const body = await f.request();
    f.db.exec(
      "CREATE TRIGGER fixture_deny_remove BEFORE DELETE ON pods BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
    );
    const partial = await api.submit(f.podId, body, actor);
    expect(partial.state).toBe('partial');
    expect(
      api.receipt(f.podId, body.id).resources.every((r) => r.state === 'confirmed_absent'),
    ).toBe(true);
    expect(
      f.db.prepare('SELECT 1 FROM task_history_deletions WHERE pod_id=?').get(f.podId),
    ).toBeUndefined();
    expect(f.repo.getOrThrow(f.podId).status).toBe('failed');
    expect(f.repo.retainedCleanup!.completed(body.id)).toBeUndefined();
    f.db.exec('DROP TRIGGER fixture_deny_remove');
    expect((await api.submit(f.podId, body, actor)).state).toBe('deleted');
    expect(f.removed).toHaveLength(4);
  }, 30_000);

  it('does not advertise a pending Stop or a live invocation', async () => {
    const f = await fixture();
    const api = f.service();
    f.idle.value = false;
    expect(await api.inspect(f.podId)).toMatchObject({
      state: 'blocked',
      blockers: [{ code: 'NOT_SETTLED' }],
    });
    f.idle.value = true;
    f.stop(false);
    expect(await api.inspect(f.podId)).toMatchObject({
      state: 'blocked',
      blockers: [{ code: 'PENDING_STOP' }],
    });
    expect(f.removed).toEqual([]);
  });
});
