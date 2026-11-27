import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type Dockerode from 'dockerode';
import { afterEach, describe, expect, it } from 'vitest';
import { createRetainedCleanupDocker } from '../containers/retained-cleanup-docker.js';
import { openTestDiskDatabase } from '../test-utils/disk-database.js';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { fixtureGit } from '../test-utils/retained-cleanup-fixture.js';
import { createRetainedCleanupHost } from '../worktrees/retained-cleanup-host.js';
import { createPodRepository } from './pod-repository.js';
import { createRetainedCleanup } from './retained-cleanup.js';
import { createValidationHeldDockerControl } from './validation-held-docker-control.js';
import { assertValidationMutationSettled } from './validation-recovery-policy.js';

const closes: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
const actor = { type: 'human', userId: 'fixture-human' } as const;
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'held-docker-')));
  closes.push(() => rm(root, { recursive: true, force: true }));
  const db = createTestDb();
  closes.push(() => {
    if (db.open) db.close();
  });
  insertTestProfile(db);
  const pods = createPodRepository(db);
  const podId = 'held-fixture';
  pods.insert({
    id: podId,
    profileName: 'test-profile',
    task: 'fixture',
    status: 'queued',
    branch: podId,
    model: 'fixture',
    runtime: 'codex',
    executionTarget: 'local',
    userId: actor.userId,
    maxValidationAttempts: 1,
    skipValidation: false,
    outputMode: 'pr',
  });
  const seed = path.join(root, 'seed'),
    bare = path.join(root, 'shared.git'),
    worktree = path.join(root, 'worktree');
  await mkdir(seed);
  await fixtureGit(seed, 'init', '-b', 'main');
  await writeFile(path.join(seed, 'README'), 'retained fixture');
  await fixtureGit(seed, 'add', 'README');
  await fixtureGit(seed, 'commit', '-m', 'fixture');
  await fixtureGit(root, 'clone', '--bare', '--no-local', seed, bare);
  await fixtureGit(bare, 'worktree', 'add', '-b', podId, worktree, 'main');
  const id = 'a'.repeat(64),
    net = 'b'.repeat(64),
    engine = 'fixture-engine',
    name = 'fixture-bridge';
  db.prepare(
    `UPDATE pods SET status='review_required',container_id=?,worktree_path=?,last_validation_result=? WHERE id=?`,
  ).run(
    id,
    worktree,
    JSON.stringify({
      overall: 'fail',
      infrastructureFailure: {
        code: 'EXEC_EXIT_UNVERIFIED',
        phase: 'test',
        retryable: false,
        message: 'unknown fixture exit',
        execution: { cleanup: 'unverified' },
      },
    }),
    podId,
  );
  const guest = {
    Id: id,
    Name: '/autopod-' + podId,
    Config: { Env: ['POD_ID=' + podId] },
    HostConfig: { NetworkMode: name, RestartPolicy: { Name: 'no' } },
    State: { Running: true, Paused: false, Restarting: false, Status: 'running' },
    Mounts: [
      { Type: 'bind', Source: worktree, Destination: '/mnt/worktree' },
      { Type: 'bind', Source: bare, Destination: bare },
    ],
    NetworkSettings: { Networks: { [name]: { NetworkID: net } } },
  };
  const bridge = {
    Id: net,
    Name: name,
    Scope: 'local',
    Driver: 'bridge',
    Ingress: false,
    Labels: { 'com.autopod.pod-id': podId, 'com.autopod.pod-network': 'true' },
    Containers: {},
  };
  let present = true,
    networkPresent = true,
    stops = 0,
    removes = 0,
    uncertain = false,
    uncertainRemove = false,
    idle = true;
  const absent = () => {
    throw Object.assign(new Error('fixture absent'), { statusCode: 404 });
  };
  const docker = createRetainedCleanupDocker({
    info: async () => ({ ID: engine }),
    listContainers: async () => (present ? [{ ...guest, Names: [guest.Name] }] : []),
    listNetworks: async () => (networkPresent ? [bridge] : []),
    getContainer: () => ({
      inspect: async () => (present ? guest : absent()),
      stop: async () => {
        stops++;
        if (uncertain) throw new Error('lost fixture reply');
        guest.State.Running = false;
        guest.State.Status = 'exited';
      },
      remove: async () => {
        removes++;
        if (uncertainRemove) throw new Error('lost removal reply');
        present = false;
      },
    }),
    getNetwork: () => ({
      inspect: async () => (networkPresent ? bridge : absent()),
      remove: async () => {
        removes++;
        networkPresent = false;
      },
    }),
  } as unknown as Dockerode);
  const service = (repo = pods) =>
    createValidationHeldDockerControl({
      pods: repo,
      docker,
      isIdle: () => idle,
      isGoal: () => false,
    });
  const cleanup = () =>
    createRetainedCleanup({
      pods,
      docker,
      isIdle: () => idle,
      isGoal: () => false,
      heldSelection: service().cleanupSelection,
      host: createRetainedCleanupHost(async () => [{ point: '/', root: '/', device: 'fixture' }]),
    });
  async function request() {
    const preview = await service().inspect(podId);
    expect(preview.state).toBe('eligible');
    return {
      requestKey: 'fixture-stop',
      expectedGeneration: preview.generation!,
      expectedBinding: preview.binding!,
      mode: 'stop-retain' as const,
      reason: 'Stop execution and retain all local evidence',
    };
  }
  return {
    db,
    pods,
    podId,
    guest,
    bridge,
    service,
    cleanup,
    request,
    worktree,
    stops: () => stops,
    removes: () => removes,
    absent: () => {
      present = false;
    },
    uncertainRemove: () => {
      uncertainRemove = true;
    },
    reopen: async () => {
      const file = path.join(root, 'restart.db');
      await db.backup(file);
      db.close();
      const reopened = openTestDiskDatabase(file);
      closes.push(() => reopened.close());
      return createPodRepository(reopened);
    },
    uncertain: () => {
      uncertain = true;
    },
    idle: (value: boolean) => {
      idle = value;
    },
  };
}
describe('exact validation-held Docker human controls', () => {
  it('stops legacy execution while retaining the validation fence, then separately discards', async () => {
    const f = await fixture(),
      body = await f.request();
    const original = f.pods.getOrThrow(f.podId).lastValidationResult;
    expect(f.stops()).toBe(0);
    expect(await f.service().submit(f.podId, body, actor)).toMatchObject({ state: 'stopped' });
    expect(f.pods.getOrThrow(f.podId)).toMatchObject({
      status: 'review_required',
      lastValidationResult: original,
    });
    expect(() => assertValidationMutationSettled(f.pods, f.podId)).toThrow();
    expect(await f.service().submit(f.podId, body, actor)).toMatchObject({ state: 'stopped' });
    expect(f.stops()).toBe(1);
    expect(f.removes()).toBe(0);
    const preview = await f.cleanup().inspect(f.podId);
    if (preview.state !== 'eligible') throw new Error(JSON.stringify(preview));
    const result = await f.cleanup().submit(
      f.podId,
      {
        id: 'fixture-discard',
        expectedGeneration: preview.plan.generation,
        expectedBinding: preview.plan.binding,
        expectedSessionId: preview.plan.sessionId,
        reason: 'Accept loss of all selected local work',
        acknowledgeDataLoss: true,
      },
      actor,
    );
    expect(result.state).toBe('deleted');
    expect(f.removes()).toBe(2);
    expect(f.db.prepare('SELECT status FROM retained_pods WHERE id=?').get(f.podId)).toEqual({
      status: 'review_required',
    });
    expect(
      f.db.prepare('SELECT COUNT(*) AS n FROM validation_dispatches WHERE pod_id=?').get(f.podId),
    ).toEqual({ n: 0 });
  });
  it('does not replay uncertain Stop after service reconstruction and rejects actor/key conflicts', async () => {
    const f = await fixture(),
      body = await f.request();
    f.uncertain();
    expect(await f.service().submit(f.podId, body, actor)).toMatchObject({ state: 'unknown' });
    const restarted = f.service(await f.reopen());
    expect(await restarted.submit(f.podId, body, actor)).toMatchObject({ state: 'unknown' });
    expect(f.stops()).toBe(1);
    await expect(restarted.submit(f.podId, body, { ...actor, userId: 'other' })).rejects.toThrow();
    await expect(
      restarted.submit(f.podId, { ...body, requestKey: 'other' }, actor),
    ).rejects.toThrow();
    f.guest.State.Running = false;
    f.guest.State.Status = 'exited';
    expect(await restarted.submit(f.podId, body, actor)).toMatchObject({ state: 'stopped' });
    expect(f.stops()).toBe(1);
    expect(f.removes()).toBe(0);
  });
  it('blocks stale selections, non-human callers, foreign identity and active custody', async () => {
    const f = await fixture(),
      body = await f.request();
    await expect(
      f.service().submit(f.podId, { ...body, expectedGeneration: 2 }, actor),
    ).rejects.toThrow();
    await expect(
      f
        .service()
        .submit(f.podId, body, { type: 'agent', userId: 'worker' } as unknown as typeof actor),
    ).rejects.toThrow();
    f.idle(false);
    expect(await f.service().inspect(f.podId)).toMatchObject({
      state: 'blocked',
      blockers: [{ code: 'NOT_SETTLED' }],
    });
    f.idle(true);
    f.bridge.Labels['com.autopod.pod-id'] = 'foreign';
    expect(await f.service().inspect(f.podId)).toMatchObject({
      state: 'blocked',
      blockers: [{ code: 'IDENTITY_CHANGED' }],
    });
    expect(f.stops()).toBe(0);
    expect(f.removes()).toBe(0);
  });
  it('can Stop without destructive tree readiness and keeps the card on blocked Discard', async () => {
    const f = await fixture(),
      request = await f.request();
    await mkdir(path.join(f.worktree, 'nested', '.git'), { recursive: true });
    expect(await f.service().submit(f.podId, request, actor)).toMatchObject({ state: 'stopped' });
    expect(await f.cleanup().inspect(f.podId)).toMatchObject({
      state: 'blocked',
      blockers: [{ code: 'HOST_PROOF_UNAVAILABLE' }],
    });
    expect(f.pods.getOrThrow(f.podId).status).toBe('review_required');
    expect(f.removes()).toBe(0);
  });
  it('keeps partial Discard owned and reconciles positive absence without repeating removal', async () => {
    const f = await fixture();
    await f.service().submit(f.podId, await f.request(), actor);
    const preview = await f.cleanup().inspect(f.podId);
    if (preview.state !== 'eligible') throw new Error(JSON.stringify(preview));
    const request = {
      id: 'discard-once',
      expectedGeneration: preview.plan.generation,
      expectedBinding: preview.plan.binding,
      expectedSessionId: preview.plan.sessionId,
      reason: 'Explicitly discard this local experiment',
      acknowledgeDataLoss: true as const,
    };
    f.uncertainRemove();
    expect(await f.cleanup().submit(f.podId, request, actor)).toMatchObject({ state: 'partial' });
    expect(await f.cleanup().submit(f.podId, request, actor)).toMatchObject({ state: 'partial' });
    expect(f.removes()).toBe(1);
    expect(f.pods.getOrThrow(f.podId).status).toBe('review_required');
    f.absent();
    expect(await f.cleanup().submit(f.podId, request, actor)).toMatchObject({ state: 'deleted' });
    expect(f.removes()).toBe(2);
  });
  it.each([
    'dependent',
    'unresolved-allocation',
    'foreign-claim',
    'engine-dispatch',
  ])('blocks %s historical custody without effects', async (kind) => {
    const f = await fixture();
    if (kind === 'dependent')
      f.db.prepare('UPDATE pods SET depends_on_pod_id=? WHERE id=?').run(f.podId, f.podId);
    if (kind === 'unresolved-allocation')
      f.pods.retainedAllocations!.scope(f.podId)!.begin('container', 'unobserved-create');
    if (kind === 'foreign-claim') {
      f.pods.insert({
        id: 'foreign',
        profileName: 'test-profile',
        task: 'foreign fixture',
        status: 'queued',
        branch: 'foreign',
        model: 'fixture',
        runtime: 'codex',
        executionTarget: 'local',
        userId: 'other',
        maxValidationAttempts: 1,
        skipValidation: false,
        outputMode: 'pr',
      });
      f.db.prepare('UPDATE pods SET container_id=? WHERE id=?').run(f.guest.Id, 'foreign');
    }
    if (kind === 'engine-dispatch') {
      const taskId = f.pods.taskExecutions!.snapshot(f.podId).taskId;
      f.db.prepare('INSERT INTO validation_dispatches VALUES (?,?,?,?,?,?,?,?)').run(
        'historical',
        f.podId,
        taskId,
        1,
        1,
        'historical-admission',
        JSON.stringify({
          podId: f.podId,
          taskId,
          generation: 1,
          executionTarget: 'local',
          containerId: f.guest.Id,
          worktreePath: f.worktree,
          resourceScope: JSON.stringify(['docker', 'foreign-engine', f.guest.Id]),
        }),
        new Date().toISOString(),
      );
    }
    expect((await f.service().inspect(f.podId)).state).toBe('blocked');
    expect(f.stops()).toBe(0);
    expect(f.removes()).toBe(0);
  });
});
