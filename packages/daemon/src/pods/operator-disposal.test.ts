import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type Dockerode from 'dockerode';
import { afterEach, describe, expect, it } from 'vitest';
import { createRetainedCleanupDocker } from '../containers/retained-cleanup-docker.js';
import { openTestDiskDatabase } from '../test-utils/disk-database.js';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { fixtureGit } from '../test-utils/retained-cleanup-fixture.js';
import { createRetainedCleanupHost } from '../worktrees/retained-cleanup-host.js';
import { createOperatorDisposal } from './operator-disposal.js';
import { createPodRepository } from './pod-repository.js';
import { assertSourceAvailable, assertSourceDeliveryAllowed } from './source-custody-guards.js';

const closes: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
const actor = { type: 'human', userId: 'fixture-operator' } as const;
async function fixture(podId = 'ordinary-fixture') {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'operator-disposal-')));
  closes.push(() => rm(root, { recursive: true, force: true }));
  const db = createTestDb();
  closes.push(() => {
    if (db.open) db.close();
  });
  insertTestProfile(db);
  const pods = createPodRepository(db);
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
  await writeFile(path.join(seed, 'README'), 'unpublished fixture');
  await fixtureGit(seed, 'add', 'README');
  await fixtureGit(seed, 'commit', '-m', 'fixture');
  await fixtureGit(root, 'clone', '--bare', '--no-local', seed, bare);
  await fixtureGit(bare, 'worktree', 'add', '-b', podId, worktree, 'main');
  const id = 'a'.repeat(64),
    net = 'b'.repeat(64),
    name = 'fixture-bridge';
  db.prepare("UPDATE pods SET status='running',container_id=?,worktree_path=? WHERE id=?").run(
    id,
    worktree,
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
    network = true,
    stops = 0,
    removes = 0,
    lostStop = false,
    lostRemove = false,
    blockRemove = false;
  const predecessors = new Map<string, typeof guest>();
  const absent = () => {
    throw Object.assign(new Error('fixture absent'), { statusCode: 404 });
  };
  const docker = createRetainedCleanupDocker({
    info: async () => ({ ID: 'fixture-engine' }),
    listContainers: async () =>
      [...(present ? [guest] : []), ...predecessors.values()].map((g) => ({
        ...g,
        Names: [g.Name],
      })),
    listNetworks: async () => (network ? [bridge] : []),
    getContainer: (cid: string) => ({
      inspect: async () => (cid === id && present ? guest : (predecessors.get(cid) ?? absent())),
      stop: async () => {
        stops++;
        if (lostStop) throw new Error('lost stop reply');
        const selected = cid === id ? guest : predecessors.get(cid)!;
        selected.State.Running = false;
        selected.State.Status = 'exited';
      },
      remove: async () => {
        removes++;
        if (blockRemove) throw new Error('removal outcome unknown');
        if (cid === id) present = false;
        else predecessors.delete(cid);
        if (lostRemove) throw new Error('lost remove reply');
      },
    }),
    getNetwork: () => ({
      inspect: async () => (network ? bridge : absent()),
      remove: async () => {
        removes++;
        network = false;
      },
    }),
  } as unknown as Dockerode);
  const service = (repo = pods) =>
    createOperatorDisposal({
      pods: repo,
      docker,
      host: createRetainedCleanupHost(async () => [{ point: '/', root: '/', device: 'fixture' }]),
    });
  const request = (intent: 'kill' | 'delete' = 'kill', key = intent) => ({
    requestKey: key,
    expectedGeneration: 1,
    intent,
    ...(intent === 'delete' ? { acknowledgeDataLoss: true as const } : {}),
  });
  return {
    db,
    pods,
    podId,
    worktree,
    bare,
    guest,
    service,
    request,
    addPredecessor() {
      const prior = structuredClone(guest);
      prior.Id = 'c'.repeat(64);
      prior.Name += '-previous';
      predecessors.set(prior.Id, prior);
      db.prepare(
        'INSERT INTO task_agent_runs(id,pod_id,generation,cycle,binding,started_at,ended_at) VALUES (?,?,1,1,?,?,?)',
      ).run(
        'original-worker',
        podId,
        JSON.stringify({
          runtime: 'codex',
          resource: { executionTarget: 'local', containerId: prior.Id },
        }),
        '2026-01-01',
        '2026-01-02',
      );
    },
    blockRemove: () => {
      blockRemove = true;
    },
    stops: () => stops,
    removes: () => removes,
    loseStop: () => {
      lostStop = true;
    },
    loseRemove: () => {
      lostRemove = true;
    },
  };
}

describe('exact operator disposal', () => {
  it('journals before effects, clears attention, fences late callbacks and preserves outcome/files for Kill', async () => {
    const f = await fixture();
    const s = f.service();
    expect(s.submit(f.podId, f.request(), actor).state).toBe('cleanup_pending');
    expect(f.stops()).toBe(0);
    expect(f.pods.list({ archive: 'exclude' })).toHaveLength(0);
    expect((await s.observe(f.podId, 'kill')).state).toBe('stopped');
    expect(f.stops()).toBe(1);
    expect(f.removes()).toBe(0);
    expect(await readFile(path.join(f.worktree, 'README'), 'utf8')).toBe('unpublished fixture');
    expect(f.pods.getOrThrow(f.podId).status).toBe('running');
    expect(() => assertSourceAvailable(f.db, f.podId)).toThrow(/disposal/);
    expect(() => assertSourceDeliveryAllowed(f.db, f.podId)).toThrow(/disposal/);
    expect(() => f.pods.update(f.podId, { status: 'validated' })).toThrow(/disposal/);
  });
  it('supports explicit Delete upgrade, lost removal reply and actual Git worktree removal without branch mutation', async () => {
    const f = await fixture();
    const s = f.service();
    s.submit(f.podId, f.request(), actor);
    await s.observe(f.podId, 'kill');
    f.loseRemove();
    s.submit(f.podId, f.request('delete'), actor);
    const result = await s.observe(f.podId, 'delete');
    expect(result.state, JSON.stringify(result)).toBe('discarded');
    expect(f.removes()).toBe(2);
    await expect(readFile(path.join(f.worktree, 'README'))).rejects.toThrow();
    expect(await fixtureGit(f.bare, 'show-ref', '--verify', 'refs/heads/' + f.podId)).toContain(
      f.podId,
    );
    expect(f.pods.operatorDisposals!.receipt(f.podId, 'kill')?.intent).toBe('kill');
  });
  it.each([
    'queued',
    'running',
    'complete',
    'killed',
    'failed',
    'review_required',
    'validating',
    'merge_pending',
  ])('accepts %s and persists fences after repository restart', async (status) => {
    const f = await fixture();
    f.db.prepare('UPDATE pods SET status=? WHERE id=?').run(status, f.podId);
    const s = f.service();
    s.submit(f.podId, f.request(), actor);
    await s.observe(f.podId, 'kill');
    const restarted = createPodRepository(f.db);
    expect(restarted.operatorDisposals!.receipt(f.podId)?.actor.userId).toBe(actor.userId);
    expect(() => restarted.assertRerunSourceAvailable(f.podId)).toThrow(/disposal/);
    expect(restarted.getOrThrow(f.podId).status).toBe(status);
  });
  it('refuses stale, missing exact subject, missing actor and unacknowledged Delete before journaling', async () => {
    const f = await fixture();
    const s = f.service();
    expect(() => s.submit(f.podId, { ...f.request(), expectedGeneration: 2 }, actor)).toThrow(
      /Stale/,
    );
    expect(() => s.submit('missing', f.request(), actor)).toThrow();
    expect(() => s.submit(f.podId, { ...f.request(), intent: 'delete' }, actor)).toThrow(
      /data loss/,
    );
    expect(() => s.submit(f.podId, f.request(), { type: 'human', userId: '' })).toThrow();
    expect(f.stops()).toBe(0);
    expect(f.pods.operatorDisposals!.receipt(f.podId)).toBeNull();
  });
  it('keeps lost stop pending without replay after restart or duplicate acceptance', async () => {
    const f = await fixture();
    f.loseStop();
    const s = f.service();
    s.submit(f.podId, f.request(), actor);
    expect((await s.observe(f.podId, 'kill')).state).toBe('cleanup_pending');
    const file = path.join(path.dirname(f.worktree), 'restart.db');
    await f.db.backup(file);
    const reopened = openTestDiskDatabase(file);
    closes.push(() => {
      if (reopened.open) reopened.close();
    });
    const restart = f.service(createPodRepository(reopened));
    restart.submit(f.podId, f.request(), actor);
    expect((await restart.observe(f.podId, 'kill')).state).toBe('cleanup_pending');
    expect(f.stops()).toBe(1);
    expect(() => s.submit(f.podId, f.request(), { type: 'human', userId: 'another' })).toThrow(
      /Idempotency/,
    );
  });
  it.each([
    'favourite-salmon',
    'statutory-tortoise',
  ])('accounts for generation-1 %s original worker on earlier Docker ID (#715)', async (podId) => {
    const f = await fixture(podId);
    const result = {
      overall: 'fail',
      infrastructureFailure: {
        code: 'EXEC_EXIT_UNVERIFIED',
        phase: 'test',
        retryable: false,
        message: 'ordinary Docker validation exit unknown',
      },
    };
    f.db
      .prepare("UPDATE pods SET status='review_required',last_validation_result=? WHERE id=?")
      .run(JSON.stringify(result), podId);
    // Validation-only retry stays on the same task/generation and reuses the checkout,
    // but its current worker container differs from the original coding worker below.
    f.db
      .prepare(`INSERT INTO task_retry_attempts(id,task_id,pod_id,execution_id,generation,stage,identity,binding_hash,admitted_at,not_before,started_at,ended_at,outcome)
      SELECT 'validation-only-retry',task_id,pod_id,execution_id,1,'validation','{}','fixture-binding','2026-01-02','2026-01-02','2026-01-02','2026-01-03','unknown' FROM task_executions WHERE pod_id=?`)
      .run(podId);
    f.db
      .prepare(
        'INSERT INTO task_agent_runs(id,pod_id,generation,cycle,binding,started_at,ended_at) VALUES (?,?,1,1,?,?,?)',
      )
      .run(
        'original-worker',
        podId,
        JSON.stringify({
          runtime: 'codex',
          resource: { executionTarget: 'local', containerId: 'c'.repeat(64) },
        }),
        '2026-01-01',
        '2026-01-02',
      );
    expect(
      f.db.prepare('SELECT 1 FROM validation_dispatches WHERE pod_id=?').get(podId),
    ).toBeUndefined();
    const s = f.service();
    s.submit(podId, f.request('delete'), actor);
    expect((await s.observe(podId, 'delete')).state).toBe('cleanup_pending');
    expect(f.pods.list({ archive: 'exclude' })).toHaveLength(0);
    // Independently owned replacement is stopped; predecessor closure is still unknown.
    expect(f.stops()).toBe(1);
    expect(f.removes()).toBe(0);
    expect(f.pods.getOrThrow(podId).lastValidationResult).toEqual(result);
  });
  it('accepts unsupported Sandbox but never reports physical completion', async () => {
    const f = await fixture();
    f.db.prepare("UPDATE pods SET execution_target='sandbox' WHERE id=?").run(f.podId);
    const s = f.service();
    s.submit(f.podId, f.request('delete'), actor);
    expect((await s.observe(f.podId, 'delete')).state).toBe('cleanup_pending');
    expect(f.stops()).toBe(0);
  });
  it('stops exact owned execution without branch/worktree evidence and keeps discard pending', async () => {
    const f = await fixture();
    f.addPredecessor();
    f.db.prepare("UPDATE pods SET worktree_path=NULL,branch='' WHERE id=?").run(f.podId);
    const s = f.service();
    s.submit(f.podId, f.request('delete'), actor);
    const r = await s.observe(f.podId, 'delete');
    expect(r.state).toBe('cleanup_pending');
    expect(f.stops()).toBe(2);
    expect(f.removes()).toBe(0);
    expect(r.resources?.some((t) => t.observedStopped)).toBe(true);
  });
  it('stops owned execution during an unconfirmed publication without replaying or discarding it', async () => {
    const f = await fixture();
    f.addPredecessor();
    f.db
      .prepare(`INSERT INTO source_publication_intents(id,identity,pod_id,task_id,generation,source_identity,admitted_at)
      SELECT 'publication','publication-identity',pod_id,task_id,1,'{}','2026-01-01' FROM task_executions WHERE pod_id=?`)
      .run(f.podId);
    const s = f.service();
    s.submit(f.podId, f.request('delete'), actor);
    const r = await s.observe(f.podId, 'delete');
    expect(r.state).toBe('cleanup_pending');
    expect(f.stops()).toBe(2);
    expect(f.removes()).toBe(0);
    expect(f.db.prepare('SELECT 1 FROM source_publication_receipts').get()).toBeUndefined();
    expect(r.diagnostics.join(' ')).toMatch(/publication/);
  });
  it('never replays an uncertain Kill stop when explicitly upgrading to Delete', async () => {
    const f = await fixture();
    f.loseStop();
    const s = f.service();
    s.submit(f.podId, f.request(), actor);
    await s.observe(f.podId, 'kill');
    s.submit(f.podId, f.request('delete'), actor);
    expect((await s.observe(f.podId, 'delete')).state).toBe('cleanup_pending');
    expect(f.stops()).toBe(1);
    expect(f.removes()).toBe(0);
  });
  it('fences a previously admitted validation retry before its next start', async () => {
    const f = await fixture();
    const admission = f.pods.taskRetries!.admit(
      f.podId,
      1,
      {
        source: 'a'.repeat(64),
        contract: 'b'.repeat(64),
        commands: 'c'.repeat(64),
        environment: null,
        implementation: null,
      },
      'd'.repeat(64),
      [],
    );
    const s = f.service();
    s.submit(f.podId, f.request(), actor);
    await s.observe(f.podId, 'kill');
    expect(() => f.pods.taskRetries!.start(admission.id)).toThrow(/disposal/);
  });
  it('accepts an archived record independently of visibility and keeps both histories', async () => {
    const f = await fixture();
    f.db.prepare("UPDATE pods SET status='failed' WHERE id=?").run(f.podId);
    f.pods.fleetArchives!.archive(f.podId, actor.userId, 'Archived fixture before disposal');
    const s = f.service();
    s.submit(f.podId, f.request(), actor);
    await s.observe(f.podId, 'kill');
    expect(f.pods.getOrThrow(f.podId).fleetArchivedAt).toBeTruthy();
    expect(f.pods.getOrThrow(f.podId).operatorDisposal?.intent).toBe('kill');
    expect(() => f.pods.delete(f.podId)).toThrow(/disposal/);
  });
  it('refuses effects on foreign live identity while retaining intent', async () => {
    const f = await fixture();
    f.guest.Config.Env = ['POD_ID=foreign'];
    const s = f.service();
    s.submit(f.podId, f.request('delete'), actor);
    expect((await s.observe(f.podId, 'delete')).state).toBe('cleanup_pending');
    expect(f.removes()).toBe(0);
    expect(f.stops()).toBe(0);
  });
  it('disposes an owned replacement only after positively accounting for its present predecessor', async () => {
    const f = await fixture();
    f.addPredecessor();
    const s = f.service();
    s.submit(f.podId, f.request('delete'), actor);
    const result = await s.observe(f.podId, 'delete');
    expect(result.state, JSON.stringify(result)).toBe('discarded');
    expect(f.stops()).toBe(2);
    expect(f.removes()).toBe(3);
  });
  it('retains a partial discard and never repeats an uncertain removal', async () => {
    const f = await fixture();
    f.blockRemove();
    const s = f.service();
    s.submit(f.podId, f.request('delete'), actor);
    expect((await s.observe(f.podId, 'delete')).state).toBe('cleanup_pending');
    expect((await f.service().observe(f.podId, 'delete')).state).toBe('cleanup_pending');
    expect(f.removes()).toBe(1);
    expect(await readFile(path.join(f.worktree, 'README'), 'utf8')).toBe('unpublished fixture');
  });
});
