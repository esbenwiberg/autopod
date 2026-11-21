import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import type Dockerode from 'dockerode';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockerContainerManager } from '../containers/docker-container-manager.js';
import { DockerNetworkManager, networkNameForPod } from '../containers/docker-network-manager.js';
import { registerRetainedPathFunctions } from '../db/retained-path-functions.js';
import {
  createMigratedTestDb,
  createTestDb,
  insertTestProfile,
} from '../test-utils/mock-helpers.js';
import { gitWorktreeIdentity } from '../worktrees/allocation-identity.js';
import { LocalWorktreeManager } from '../worktrees/local-worktree-manager.js';
import { prepareRetainedCheckpointWorkspace } from '../worktrees/retained-checkpoint-workspace.js';
import { createPodRepository } from './pod-repository.js';
import {
  type AllocationScope,
  createRetainedAllocationInventory,
} from './retained-allocation-inventory.js';

const logger = pino({ level: 'silent' });
const exec = promisify(execFile);
const roots: string[] = [];
const databases: Database.Database[] = [];
const podId = 'fixture-pod';
const engineId = 'fixture-engine';
const repository = 'https://example.test/repository.git';
const git = async (cwd: string, ...args: string[]) =>
  (
    await exec(
      'git',
      [
        '-c',
        'user.name=Allocation test',
        '-c',
        'user.email=fixture@example.test',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd },
    )
  ).stdout.trim();

afterEach(async () => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function rootDir() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'autopod-allocation-')));
  roots.push(root);
  return root;
}

async function openFileDb(location: string, template?: Database.Database) {
  if (template) {
    try {
      await template.backup(location);
    } finally {
      template.close();
    }
  }
  const db = new Database(location);
  registerRetainedPathFunctions(db);
  db.pragma('foreign_keys = ON');
  databases.push(db);
  return db;
}

function seed(db: Database.Database) {
  insertTestProfile(db);
  const repo = createPodRepository(db);
  repo.insert({
    id: podId,
    profileName: 'test-profile',
    task: 'fixture',
    status: 'queued',
    branch: 'fixture-branch',
    model: 'fixture',
    runtime: 'codex',
    executionTarget: 'local',
    userId: 'fixture',
    maxValidationAttempts: 1,
    skipValidation: false,
    outputMode: 'pr',
  });
  const taskId = repo.taskExecutions?.snapshot(podId).taskId;
  if (!taskId) throw new Error('Missing fixture task');
  const inventory = createRetainedAllocationInventory(db);
  const scope = (recoveryId?: string) => {
    const result = inventory.scope(podId, recoveryId);
    if (!result) throw new Error('Missing allocation scope');
    return result;
  };
  return { repo, taskId, scope, read: () => inventory.readTask(taskId) };
}

function dockerFixture() {
  let nextId = 0;
  const nativeId = () => (++nextId).toString(16).padStart(64, '0');
  const bridges = new Map<
    string,
    { Id: string; Name: string; Driver: string; Labels?: Record<string, string> }
  >();
  const containers = new Map<string, object>();
  const missing = Object.assign(new Error('missing'), { statusCode: 404 });
  const docker = {
    info: vi.fn(async () => ({ ID: engineId })),
    getImage: vi.fn(() => ({ inspect: async () => ({}) })),
    getNetwork: vi.fn((id: string) => ({
      inspect: async () => {
        const found = bridges.get(id) ?? [...bridges.values()].find((n) => n.Name === id);
        if (!found) throw missing;
        return found;
      },
    })),
    createNetwork: vi.fn(async (opts: Dockerode.NetworkCreateOptions) => {
      const id = nativeId();
      bridges.set(id, {
        Id: id,
        Name: String(opts.Name),
        Driver: String(opts.Driver),
        Labels: opts.Labels,
      });
      return { id };
    }),
    getContainer: vi.fn((id: string) => ({
      inspect: async () => {
        const found = containers.get(id);
        if (!found) throw missing;
        return found;
      },
    })),
    createContainer: vi.fn(async (opts: Dockerode.ContainerCreateOptions) => {
      const id = nativeId();
      const name = opts.HostConfig?.NetworkMode ?? '';
      const attached = [...bridges.values()].find((n) => n.Name === name);
      return {
        id,
        start: async () => {
          containers.set(id, {
            Id: id,
            Config: { Labels: opts.Labels },
            NetworkSettings: { Networks: attached ? { [name]: { NetworkID: attached.Id } } : {} },
          });
        },
      };
    }),
  };
  const client = docker as unknown as Dockerode;
  const net = new DockerNetworkManager({ docker: client, logger });
  const cm = new DockerContainerManager({ docker: client, logger });
  async function spawn(scope: AllocationScope, identity: string, worktreePath?: string) {
    const networkName = await net.ensureNetworkForPod(identity, scope);
    return cm.spawn({
      podId,
      resourceIdentity: identity === podId ? undefined : identity,
      networkName,
      allocation: scope,
      env: {},
      image: 'fixture',
      volumes: worktreePath ? [{ host: worktreePath, container: '/mnt/worktree' }] : [],
    });
  }
  return { docker, net, bridges, spawn };
}

async function gitFixture(root: string, scope: AllocationScope) {
  const source = path.join(root, 'seed');
  await mkdir(source);
  await git(source, 'init', '-b', 'main');
  await writeFile(path.join(source, 'README.md'), 'fixture source\n');
  await git(source, 'add', '.');
  await git(source, 'commit', '-m', 'fixture source');
  const manager = new LocalWorktreeManager({
    cacheDir: path.join(root, 'cache'),
    worktreeDir: path.join(root, 'worktrees'),
    logger,
  });
  // Only transport selection is replaced: clone, fetch, add, registration and evidence use real Git and disk.
  vi.spyOn(
    manager as unknown as { getAuthenticatedRemoteForRepo(url: string): Promise<{ url: string }> },
    'getAuthenticatedRemoteForRepo',
  ).mockResolvedValue({ url: source });
  const create = (sessionId = podId) =>
    manager.create({
      repoUrl: repository,
      baseBranch: 'main',
      branch: 'fixture-branch',
      sessionId,
      allocation: scope,
    });
  return { create, upstream: source };
}

describe('forward-only retained allocation inventory', () => {
  it('records real Git checkout roles plus exact producer IDs for original and two replacements, and survives reopen', async () => {
    const root = await rootDir();
    const location = path.join(root, 'inventory.db');
    const db = await openFileDb(location, createTestDb());
    const f = seed(db);
    const d = dockerFixture();
    const gitState = await gitFixture(root, f.scope());
    const original = await gitState.create();
    let worktreePath = original.worktreePath;
    let containerId = await d.spawn(f.scope(), podId, worktreePath);
    f.repo.update(podId, { worktreePath, containerId });
    expect(f.read().reasons).toEqual([]);
    expect(f.read().allocations).toContainEqual(
      expect.objectContaining({
        role: 'original-worktree',
        state: 'owned',
        evidence: expect.objectContaining({
          commonStoreOwnership: 'shared-cache',
          commonStore: expect.objectContaining({ path: original.bareRepoPath }),
        }),
      }),
    );
    for (const generation of [1, 2]) {
      const recoveryId = `prep-${generation}`;
      const resourceKey = JSON.stringify(['docker', engineId, containerId]);
      db.prepare(
        `INSERT INTO retained_checkpoint_recoveries
          (id,pod_id,task_id,generation,container_id,resource_key,worktree_path,request_hash,actor,reason,binding,original_evidence,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
      ).run(
        recoveryId,
        podId,
        f.taskId,
        generation,
        containerId,
        resourceKey,
        worktreePath,
        'fixture hash',
        JSON.stringify({ type: 'human', userId: 'fixture' }),
        'fixture only',
        JSON.stringify({ continuation: {} }),
        '{}',
      );
      expect(f.read().reasons).toContainEqual(
        expect.objectContaining({ code: 'missing-prepared-source', recoveryId }),
      );
      const prepared = await prepareRetainedCheckpointWorkspace({
        source: worktreePath,
        root: path.join(root, recoveryId),
        branch: 'fixture-branch',
        repository,
        head: await git(worktreePath, 'rev-parse', 'HEAD'),
        generation,
        cycle: 1,
        assertCurrent() {},
        allocation: f.scope(recoveryId),
        sourceStoreOwnership: generation === 1 ? 'shared-cache' : 'private-prepared',
      });
      expect(await readFile(path.join(prepared.snapshot, 'README.md'), 'utf8')).toBe(
        'fixture source\n',
      );
      const event =
        db.prepare(`INSERT INTO retained_checkpoint_recovery_events (recovery_id,kind,evidence,created_at)
        VALUES (?,?,?,CURRENT_TIMESTAMP)`);
      event.run(recoveryId, 'prepared', JSON.stringify(prepared));
      const recovery = f.repo.retainedCheckpoints;
      if (!recovery) throw new Error('Missing retained checkpoint fixture');
      await recovery.owned(recoveryId, async () => {
        expect(f.repo.incrementLifecycleGeneration(podId)).toBe(generation + 1);
        worktreePath = prepared.worktree;
        f.repo.update(podId, { containerId: null, worktreePath });
        event.run(recoveryId, 'activated', JSON.stringify({ generation: generation + 1 }));
        const scope = f.scope(recoveryId);
        expect(
          scope.matchesWorktree(
            await gitWorktreeIdentity(prepared.worktree, 'private-prepared', prepared.bare),
          ),
        ).toBe(true);
        containerId = await d.spawn(scope, `${podId}-replacement-${generation}`, worktreePath);
        f.repo.update(podId, { containerId });
        expect(f.read().reasons).toEqual([]);
        // Model settlement only. This test does not qualify checks or continuation admission.
        event.run(recoveryId, 'checked', '{}');
      });
    }
    const inventory = f.read();
    expect(inventory.state).toBe('recorded');
    expect(
      inventory.allocations.filter((a) => a.role === 'container').map((a) => a.generation),
    ).toEqual([1, 2, 3]);
    expect(
      inventory.allocations.filter((a) => a.role === 'prepared-source').map((a) => a.recoveryId),
    ).toEqual(['prep-1', 'prep-2']);
    expect(inventory.allocations).toHaveLength(9);
    db.close();
    const reopened = await openFileDb(location);
    expect(createRetainedAllocationInventory(reopened).readTask(f.taskId)).toEqual(inventory);
    expect(() => reopened.prepare('DELETE FROM retained_allocation_facts').run()).toThrow(
      'immutable',
    );
    expect(await git(gitState.upstream, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  }, 30_000);

  it('keeps a lost create reply plus all later attempts across reopen; a verified bridge alone cannot complete inventory', async () => {
    const location = path.join(await rootDir(), 'inventory.db');
    const db = await openFileDb(location, createTestDb());
    const f = seed(db);
    const d = dockerFixture();
    d.docker.createNetwork.mockImplementationOnce(async () => {
      const observer = await openFileDb(location);
      expect(createRetainedAllocationInventory(observer).readTask(f.taskId).allocations).toEqual([
        expect.objectContaining({ role: 'bridge', state: 'pending' }),
      ]);
      observer.close();
      throw new Error('simulated lost create reply');
    });
    await expect(d.net.ensureNetworkForPod(podId, f.scope())).rejects.toThrow('lost create reply');
    const pending = f.read().allocations[0];
    expect(pending).toMatchObject({ state: 'pending', role: 'bridge', createReply: null });
    db.close();
    const reopened = await openFileDb(location);
    const inventory = createRetainedAllocationInventory(reopened);
    const scope = inventory.scope(podId);
    if (!scope) throw new Error('missing scope after reopen');
    await d.net.ensureNetworkForPod(podId, scope);
    // No cap/pagination, including unknown attempts well beyond operator list defaults.
    for (let i = 0; i < 205; i++) scope.begin('bridge', `uncertain-${i}`);
    const result = inventory.readTask(f.taskId);
    expect(result.allocations).toHaveLength(207);
    expect(result.allocations[0]).toEqual(pending);
    expect(result.state).toBe('incomplete');
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ code: 'missing-bridge-or-container' }),
    );
  });

  it('does not turn a foreign same-name bridge or unavailable engine inspection into ownership', async () => {
    const db = createTestDb();
    databases.push(db);
    const f = seed(db);
    const d = dockerFixture();
    const identity = networkNameForPod(podId);
    const known = await d.net.ensureNetworkForPod(podId, f.scope());
    const recorded = f.read().allocations[0];
    expect(recorded?.state).toBe('owned');
    d.bridges.clear();
    const foreignId = 'f'.repeat(64);
    d.bridges.set(foreignId, { Id: foreignId, Name: identity, Driver: 'bridge' });
    expect(await d.net.ensureNetworkForPod(podId, f.scope())).toBe(known);
    await d.spawn(f.scope(), podId);
    expect(f.read().allocations.at(0)).toEqual(recorded);
    expect(f.read().allocations).toContainEqual(
      expect.objectContaining({ role: 'bridge', state: 'reused-or-foreign' }),
    );
    expect(f.read().allocations).toContainEqual(
      expect.objectContaining({
        role: 'container',
        state: 'unverified',
        createReply: expect.anything(),
      }),
    );
    d.docker.info.mockRejectedValue(new Error('engine unavailable'));
    await d.net.ensureNetworkForPod('next', f.scope());
    expect(f.read().allocations.at(-1)).toMatchObject({
      role: 'bridge',
      state: 'unverified',
      createReply: { engineId: null },
    });
  });

  it('keeps stale worktree path and occupied prepared root from becoming verified evidence', async () => {
    const db = createTestDb();
    databases.push(db);
    const f = seed(db);
    const root = await rootDir();
    const fixture = await gitFixture(root, f.scope());
    const original = await fixture.create();
    expect(f.read().allocations.at(0)?.state).toBe('owned');
    const clean = await gitWorktreeIdentity(
      original.worktreePath,
      'shared-cache',
      original.bareRepoPath,
    );
    expect(f.scope().matchesWorktree(clean)).toBe(true);
    await fixture.create(); // The ordinary custody-checked stale-path handling still runs.
    const replaced = await gitWorktreeIdentity(
      original.worktreePath,
      'shared-cache',
      original.bareRepoPath,
    );
    expect(f.scope().matchesWorktree(replaced)).toBe(false);
    expect(f.read().allocations.at(-1)).toMatchObject({
      role: 'original-worktree',
      state: 'reused-or-foreign',
    });
    const preparedRoot = path.join(root, 'foreign');
    await mkdir(preparedRoot);
    await writeFile(path.join(preparedRoot, 'sentinel'), 'foreign\n');
    await expect(
      prepareRetainedCheckpointWorkspace({
        source: original.worktreePath,
        root: preparedRoot,
        branch: 'fixture-branch',
        repository,
        head: original.startCommitSha,
        generation: 1,
        cycle: 1,
        assertCurrent() {},
        allocation: f.scope('occupied'),
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(f.read().allocations.at(-1)).toMatchObject({
      role: 'prepared-source',
      state: 'reused-or-foreign',
    });
    expect(await readFile(path.join(preparedRoot, 'sentinel'), 'utf8')).toBe('foreign\n');
  });

  it('does not enroll any pre-274 execution when the actual forward migration runs', async () => {
    const location = path.join(await rootDir(), 'legacy.db');
    const db = await openFileDb(location, createMigratedTestDb(272));
    const f = seed(db);
    f.repo.update(podId, { containerId: 'e'.repeat(64), worktreePath: '/old/checkout' });
    db.close();
    const reopened = await openFileDb(location);
    reopened.exec(
      await readFile(
        new URL('../db/migrations/274_retained_allocation_inventory.sql', import.meta.url),
        'utf8',
      ),
    );
    const inventory = createRetainedAllocationInventory(reopened);
    expect(inventory.readTask(f.taskId)).toMatchObject({
      state: 'incomplete',
      allocations: [],
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'legacy-execution', podId }),
      ]),
    });
    const scope = inventory.scope(podId);
    if (!scope) throw new Error('new producer scope unavailable');
    await dockerFixture().net.ensureNetworkForPod(podId, scope);
    expect(inventory.readTask(f.taskId).reasons).toContainEqual(
      expect.objectContaining({ code: 'legacy-execution' }),
    );
  });
});
