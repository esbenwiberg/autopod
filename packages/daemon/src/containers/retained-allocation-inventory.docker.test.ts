import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import Dockerode from 'dockerode';
import pino from 'pino';
import { expect, it, vi } from 'vitest';
import { createPodRepository } from '../pods/pod-repository.js';
import { isDockerNativeId } from '../pods/retained-allocation-inventory.js';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { ALLOCATION_LABEL } from './docker-allocation-evidence.js';
import { DockerContainerManager } from './docker-container-manager.js';
import { DockerNetworkManager } from './docker-network-manager.js';

it.runIf(process.env.AUTOPOD_ALLOCATION_NATIVE_FIXTURE === '1')(
  'records native engine/IDs before detachment and never adopts a different bridge at the same name',
  async () => {
    const socket = process.env.AUTOPOD_ALLOCATION_FIXTURE_SOCKET;
    const engine = process.env.AUTOPOD_ALLOCATION_FIXTURE_ENGINE;
    const image = process.env.AUTOPOD_ALLOCATION_FIXTURE_IMAGE;
    if (
      !socket ||
      !path.isAbsolute(socket) ||
      path.basename(socket) !== 'retained-allocation-fixture.sock' ||
      !engine ||
      !image ||
      !/^sha256:[a-f0-9]{64}$/.test(image)
    )
      throw new Error(
        'An explicit isolated fixture Unix socket, engine ID and exact local image ID are required',
      );
    const parent = path.dirname(socket);
    const parentStat = await lstat(parent);
    const socketStat = await lstat(socket);
    if (
      !parentStat.isDirectory() ||
      (parentStat.mode & 0o077) !== 0 ||
      parentStat.uid !== process.getuid?.() ||
      !socketStat.isSocket() ||
      (await realpath(socket)) !== socket
    )
      throw new Error('Fixture socket must be under an owned, private, canonical directory');
    // Never select a context or accept DOCKER_HOST/TLS config from the environment.
    const docker = new Dockerode({ socketPath: socket, timeout: 5000 });
    const info = await docker.info();
    if (
      info.ID !== engine ||
      !info.Labels?.includes('com.autopod.engine=retained-allocation-fixture')
    )
      throw new Error('Wrong engine or no dedicated fixture-engine label');
    if (
      (await docker.listContainers({ all: true })).length > 0 ||
      (await docker.listNetworks()).some((net) => !['bridge', 'host', 'none'].includes(net.Name))
    )
      throw new Error('Not an empty isolated fixture engine');
    expect((await docker.getImage(image).inspect()).Id).toBe(image);
    vi.spyOn(docker, 'pull').mockImplementation(() => {
      throw new Error('Fixture forbids image pulls');
    });

    const podId = `allocation-native-${randomUUID()}`;
    const logger = pino({ level: 'silent' });
    const db = createTestDb();
    const cleanup: (() => Promise<unknown>)[] = [];
    const addCleanup = (id: string, kind: 'container' | 'bridge', label: string) => {
      expect(isDockerNativeId(id)).toBe(true);
      cleanup.unshift(async () => {
        const object = kind === 'container' ? docker.getContainer(id) : docker.getNetwork(id);
        const observed = await object.inspect().catch((err: { statusCode?: number }) => {
          if (err.statusCode === 404) return null;
          throw err;
        });
        if (!observed) return;
        const labels = 'Config' in observed ? observed.Config.Labels : observed.Labels;
        if (
          observed.Id !== id ||
          labels?.[ALLOCATION_LABEL] !== label ||
          (await docker.info()).ID !== engine
        )
          throw new Error('Fixture resource identity changed; refusing cleanup');
        return kind === 'container'
          ? docker.getContainer(id).remove({ force: true })
          : docker.getNetwork(id).remove();
      });
    };
    const errors: unknown[] = [];
    try {
      insertTestProfile(db);
      const repo = createPodRepository(db);
      repo.insert({
        id: podId,
        profileName: 'test-profile',
        task: 'fixture',
        status: 'queued',
        branch: podId,
        model: 'fixture',
        runtime: 'codex',
        executionTarget: 'local',
        userId: 'fixture',
        maxValidationAttempts: 1,
        skipValidation: false,
        outputMode: 'pr',
      });
      const taskId = repo.taskExecutions?.snapshot(podId).taskId;
      const inventory = repo.retainedAllocations;
      const scope = inventory?.scope(podId);
      if (!taskId || !scope || !inventory) throw new Error('Fixture task binding unavailable');
      const networks = new DockerNetworkManager({ docker, logger });
      const containers = new DockerContainerManager({ docker, logger });
      const read = () => inventory.readTask(taskId);
      let networkName: string;
      try {
        networkName = await networks.ensureNetworkForPod(podId, scope);
      } finally {
        for (const a of read().allocations.filter((entry) => entry.role === 'bridge')) {
          if (a.createReply?.engineId === engine) addCleanup(a.createReply.id, 'bridge', a.id);
        }
      }
      let containerId: string;
      try {
        containerId = await containers.spawn({
          podId,
          networkName,
          allocation: scope,
          image,
          env: {},
          exposeHostGateway: false,
        });
      } finally {
        for (const a of read().allocations.filter((entry) => entry.role === 'container')) {
          if (a.createReply?.engineId === engine) addCleanup(a.createReply.id, 'container', a.id);
        }
      }
      const bridge = read().allocations.find((a) => a.role === 'bridge');
      if (bridge?.state !== 'owned') throw new Error('No verified bridge allocation');
      const oldBridge = bridge.evidence.id;
      expect(read().allocations).toContainEqual(
        expect.objectContaining({
          role: 'container',
          state: 'owned',
          evidence: expect.objectContaining({
            engineId: engine,
            id: containerId,
            bridge: { engineId: engine, id: oldBridge },
          }),
        }),
      );
      const exactBridge = docker.getNetwork(oldBridge);
      const assertFixtureBridge = async () => {
        expect((await docker.info()).ID).toBe(engine);
        const current = await exactBridge.inspect();
        expect(current.Id).toBe(oldBridge);
        expect(current.Labels?.[ALLOCATION_LABEL]).toBe(bridge.id);
        return current;
      };
      await assertFixtureBridge();
      await exactBridge.disconnect({ Container: containerId, Force: true });
      expect(Object.keys((await assertFixtureBridge()).Containers ?? {})).toHaveLength(0);
      expect(read().allocations).toContainEqual(bridge);
      await exactBridge.remove();
      const replacementLabel = randomUUID();
      const replacement = await docker.createNetwork({
        Name: networkName,
        Driver: 'bridge',
        Labels: { [ALLOCATION_LABEL]: replacementLabel },
      });
      addCleanup(replacement.id, 'bridge', replacementLabel);
      expect(replacement.id).not.toBe(oldBridge);
      expect(await networks.ensureNetworkForPod(podId, scope)).toBe(networkName);
      expect(read().state).toBe('incomplete');
      expect(read().allocations).toContainEqual(bridge);
      expect(read().allocations).toContainEqual(
        expect.objectContaining({ role: 'bridge', state: 'reused-or-foreign' }),
      );
      expect(read().allocations.some((a) => a.createReply?.id === replacement.id)).toBe(false);
    } catch (err) {
      errors.push(err);
    } finally {
      for (const remove of cleanup) {
        try {
          await remove();
        } catch (err) {
          errors.push(err);
        }
      }
      db.close();
    }
    if (errors.length) throw new AggregateError(errors, 'Fixture or exact-ID teardown incomplete');
  },
  60_000,
);
