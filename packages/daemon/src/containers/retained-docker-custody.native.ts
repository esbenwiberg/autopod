/** Explicit, disposable Docker qualification; not imported by the daemon or unit suite.
 * Compile with esbuild (ESM, packages external) inside daemon/node_modules/.cache.
 * AUTOPOD_SOURCE_ROOT and AUTOPOD_DOCKER_CUSTODY_IMAGE must name reviewed source
 * and an already-present exact image ID containing the autopod user and sleep.
 * No image pull, production DB, real pod ID, credentials or model call is used.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import Dockerode from 'dockerode';
import pino from 'pino';
import { checkpointResourceIdentity } from '../pods/retained-checkpoint-repository.js';
import { DockerContainerManager } from './docker-container-manager.js';
import { DockerNetworkManager } from './docker-network-manager.js';

const source = process.env.AUTOPOD_SOURCE_ROOT;
const image = process.env.AUTOPOD_DOCKER_CUSTODY_IMAGE;
assert(
  source && image && /^sha256:[a-f0-9]{64}$/.test(image),
  'Explicit source root and existing exact image ID required',
);
const docker = new Dockerode();
const engine = await docker.info();
await docker.getImage(image).inspect(); // Fail rather than pulling or substituting an image.
const fixtureId = `custody-fixture-${randomUUID()}`;
const label = 'com.autopod.native-custody-fixture';
const db = new Database(':memory:');
db.exec(
  readFileSync(
    path.join(source, 'packages/daemon/src/db/migrations/227_retained_checkpoint_recovery.sql'),
    'utf8',
  ),
);
const logger = pino({ level: 'silent' });
const manager = new DockerContainerManager({ docker, logger, managedDatabase: db });
const containers: string[] = [];
const networks: string[] = [];
const config = {
  image,
  podId: fixtureId,
  env: { POD_ID: fixtureId },
  memoryBytes: 256 * 1024 * 1024,
  nanoCpus: 1e9,
  onCreated: (id: string) => {
    containers.push(id);
  },
};
async function makeNetwork(identity: string) {
  const network = await docker.createNetwork({
    Name: `autopod-${identity}`,
    Driver: 'bridge',
    Internal: true,
    Labels: {
      [label]: fixtureId,
      'com.autopod.pod-network': 'true',
      'com.autopod.pod-id': identity,
    },
  });
  networks.push(network.id);
  return `autopod-${identity}`;
}
// Scope only enumeration to this fixture label. All Docker mutations/inspections
// are real; orphan reconciliation must never enumerate unrelated user networks.
const scopedDocker = Object.create(docker) as Dockerode;
scopedDocker.listNetworks = (async (options: Dockerode.NetworkListOptions = {}) => {
  const filters =
    typeof options.filters === 'string' ? JSON.parse(options.filters) : (options.filters ?? {});
  return docker.listNetworks({
    ...options,
    filters: JSON.stringify({
      ...filters,
      label: [...(filters.label ?? []), `${label}=${fixtureId}`],
    }),
  });
}) as Dockerode['listNetworks'];
const networkManager = new DockerNetworkManager({
  docker: scopedDocker,
  logger,
  managedDatabase: db,
});
let successful = false;
try {
  const originalNetwork = await makeNetwork(fixtureId);
  const original = await manager.spawn({
    ...config,
    networkName: originalNetwork,
    managedSpecDigest: 'fixture-original',
  });
  await docker.getContainer(original).stop({ t: 1 }); // Before custody: fixture setup, not a recovery action.
  const before = await docker.getContainer(original).inspect();
  assert.equal(before.State.Running, false);
  db.prepare('INSERT INTO retained_checkpoint_recoveries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'fixture-recovery',
    fixtureId,
    'fixture-task',
    1,
    original,
    'fixture-resource',
    '/fixture',
    'fixture-hash',
    JSON.stringify({ type: 'human', userId: 'fixture' }),
    'Retain disposable fixture original',
    JSON.stringify({ continuation: { prepareOnly: true } }),
    JSON.stringify({ result: {} }),
    'now',
  );
  db.prepare(
    'INSERT INTO retained_checkpoint_recovery_events(recovery_id,kind,evidence,created_at) VALUES(?,?,?,?)',
  ).run('fixture-recovery', 'activated', '{"generation":2}', 'now');
  await assert.rejects(manager.spawn({ ...config, networkName: originalNetwork }), {
    code: 'CHECKPOINT_ORIGINAL_RETAINED',
  });
  await assert.rejects(
    manager.ensureManagedContainer({
      ...config,
      networkName: originalNetwork,
      managedSpecDigest: 'fixture-original',
      firewallScript: ':',
    }),
    { code: 'CHECKPOINT_ORIGINAL_RETAINED' },
  );
  const resourceIdentity = checkpointResourceIdentity(fixtureId, 'fixture-recovery', 2);
  const replacementNetwork = await makeNetwork(resourceIdentity);
  const replacement = await manager.spawn({
    ...config,
    resourceIdentity,
    networkName: replacementNetwork,
  });
  assert.notEqual(replacement, original);
  await assert.rejects(
    manager.spawn({ ...config, resourceIdentity, networkName: replacementNetwork }),
    { statusCode: 409 },
  );
  assert.equal((await docker.getContainer(replacement).inspect()).State.Running, true);
  const after = await docker.getContainer(original).inspect();
  assert.equal(after.Id, before.Id);
  assert.equal(after.Name, before.Name);
  assert.equal(after.State.Running, false);
  assert.equal(
    (await docker.getContainer(replacement).inspect()).Name,
    `/autopod-${resourceIdentity}`,
  );
  for (const identity of [fixtureId, resourceIdentity]) {
    await assert.rejects(networkManager.destroyNetworkForPod(identity), {
      code: 'CHECKPOINT_NETWORK_RETAINED',
    });
    await assert.rejects(networkManager.removeNetworkForPod(identity), {
      code: 'CHECKPOINT_NETWORK_RETAINED',
    });
  }
  assert.equal(await networkManager.reconcileOrphanNetworks(new Set()), 0);
  for (const id of networks)
    assert.equal((await docker.getNetwork(id).inspect()).Labels?.[label], fixtureId);
  console.log(
    JSON.stringify({
      marker: 'NATIVE_RETAINED_DOCKER_CUSTODY_PASSED',
      engineId: engine.ID,
      engineVersion: engine.ServerVersion,
      image,
      fixtureId,
      original,
      replacement,
      resourceIdentity,
      originalRemainsStoppedAndUnchanged: true,
      retainedNetworks: networks,
    }),
  );
  successful = true;
} finally {
  // Only IDs returned by THIS fixture's create callbacks are eligible for cleanup.
  // These are synthetic originals in a private in-memory DB, never live pod resources.
  for (const id of containers.reverse()) {
    const container = docker.getContainer(id);
    const info = await container.inspect();
    assert(
      info.Name.startsWith(`/autopod-${fixtureId}`) &&
        info.Config.Env?.includes(`POD_ID=${fixtureId}`),
    );
    await container.remove({ force: true });
  }
  for (const id of networks.reverse()) {
    const network = docker.getNetwork(id);
    assert.equal((await network.inspect()).Labels?.[label], fixtureId);
    await network.remove();
  }
  db.close();
}
assert(successful);
console.log('OWNED_FIXTURE_CLEANUP_PASSED');
