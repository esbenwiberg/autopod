/** Explicit, disposable Docker qualification of the retained-bridge release protocol
 * (#565); not imported by the daemon or unit suite. Compile with esbuild (ESM,
 * packages external) inside daemon/node_modules/.cache, like
 * retained-docker-custody.native.ts. AUTOPOD_SOURCE_ROOT and
 * AUTOPOD_DOCKER_CUSTODY_IMAGE must name reviewed source and an already-present
 * exact image ID containing the autopod user and sleep. No image pull,
 * production DB, real pod ID, credentials or model call is used.
 *
 * Proves against a real engine that:
 * - a bridge whose held container is RUNNING is refused (no record, no removal);
 * - once that container is stopped, the bridge is recorded and removed while the
 *   container itself (ID, name, image, config, mounts, network mode) is unchanged;
 * - the held container stays unwakeable, and the current identity's bridge is refused.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import Dockerode from 'dockerode';
import pino from 'pino';
import { runMigrations } from '../db/migrate.js';
import { checkpointResourceIdentity } from '../pods/retained-checkpoint-repository.js';
import { DockerContainerManager } from './docker-container-manager.js';
import { planRetainedNetworkReleases, releaseRetainedNetwork } from './retained-network-release.js';

const source = process.env.AUTOPOD_SOURCE_ROOT;
const image = process.env.AUTOPOD_DOCKER_CUSTODY_IMAGE;
assert(
  source && image && /^sha256:[a-f0-9]{64}$/.test(image),
  'Explicit source root and existing exact image ID required',
);
const logger = pino({ level: 'silent' });
// Private in-memory custody with every real migration; disposable rows only.
const db = new Database(':memory:');
runMigrations(db, path.join(source, 'packages/daemon/src/db/migrations'), logger);
db.pragma('foreign_keys = OFF'); // Fixture pod rows have no profile; never a production DB.

const docker = new Dockerode();
const engine = await docker.info();
await docker.getImage(image).inspect(); // Fail rather than pulling or substituting an image.
const fixtureId = `release-fixture-${randomUUID()}`;
const label = 'com.autopod.native-release-fixture';
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
  return { id: network.id, name: `autopod-${identity}` };
}
// Scope network enumeration to this fixture label; unrelated host bridges are
// never observed. All inspections and the release removal are real Docker calls.
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
const deps = { docker: scopedDocker, db, logger };
const comparable = (info: Dockerode.ContainerInspectInfo) => ({
  Id: info.Id,
  Name: info.Name,
  Image: info.Image,
  Created: info.Created,
  Config: info.Config,
  Mounts: info.Mounts,
  NetworkMode: info.HostConfig?.NetworkMode,
});

let successful = false;
try {
  const originalNetwork = await makeNetwork(fixtureId);
  const original = await manager.spawn({
    ...config,
    networkName: originalNetwork.name,
    managedSpecDigest: 'fixture-original',
  });
  // Custody: the original is held by a recovery whose activated generation 2 is current.
  db.prepare(
    `INSERT INTO pods (id,profile_name,task,status,model,branch,user_id,lifecycle_generation)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(fixtureId, 'fixture', 'fixture', 'validating', 'fixture', 'fixture', 'fixture', 2);
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
  const current = checkpointResourceIdentity(fixtureId, 'fixture-recovery', 2);
  const currentNetwork = await makeNetwork(current);
  const replacement = await manager.spawn({
    ...config,
    resourceIdentity: current,
    networkName: currentNetwork.name,
  });
  const records = () =>
    (db.prepare('SELECT COUNT(*) AS n FROM retained_network_releases').get() as { n: number }).n;

  // 1. Running held container: refused, nothing recorded, bridge intact.
  assert.equal((await docker.getContainer(original).inspect()).State.Running, true);
  const runningPlan = await planRetainedNetworkReleases(deps);
  assert.equal(runningPlan.find((c) => c.identity === fixtureId)?.eligible, false);
  const runningRelease = await releaseRetainedNetwork(
    deps,
    { identity: fixtureId, networkId: originalNetwork.id, networkName: originalNetwork.name },
    'operator',
  );
  assert.equal(runningRelease.outcome, 'refused');
  assert.equal(records(), 0);
  await docker.getNetwork(originalNetwork.id).inspect();

  // 2. Stop the original (fixture setup, not a recovery action), then release.
  await docker.getContainer(original).stop({ t: 1 });
  const before = await docker.getContainer(original).inspect();
  assert.equal(before.State.Running, false);
  const plan = await planRetainedNetworkReleases(deps);
  assert.deepEqual(
    plan.filter((c) => c.eligible).map((c) => c.identity),
    [fixtureId],
  );
  assert.match(plan.find((c) => c.identity === current)?.reason ?? '', /current execution/);
  const target = plan.find((c) => c.eligible);
  assert(target);
  const released = await releaseRetainedNetwork(deps, target, 'operator', {
    type: 'human',
    userId: 'fixture',
  });
  assert.equal(released.outcome, 'removed');
  await assert.rejects(docker.getNetwork(originalNetwork.id).inspect(), { statusCode: 404 });
  const after = await docker.getContainer(original).inspect();
  assert.deepEqual(comparable(after), comparable(before));
  assert.equal(after.State.Running, false);
  const record = db
    .prepare(
      `SELECT r.network_id AS networkId,r.spec,r.containers,o.outcome FROM retained_network_releases r
       JOIN retained_network_release_outcomes o ON o.release_id=r.id`,
    )
    .get() as { networkId: string; spec: string; containers: string; outcome: string };
  assert.equal(record.networkId, originalNetwork.id);
  assert.equal(record.outcome, 'removed');
  assert.equal(JSON.parse(record.spec).labels[label], fixtureId);
  assert.deepEqual(
    JSON.parse(record.containers).map((c: { id: string }) => c.id),
    [original],
  );

  // 3. The held original stays unwakeable; the current bridge is refused.
  await assert.rejects(manager.start(original), { code: 'CHECKPOINT_ORIGINAL_RETAINED' });
  const currentRelease = await releaseRetainedNetwork(
    deps,
    { identity: current, networkId: currentNetwork.id, networkName: currentNetwork.name },
    'operator',
  );
  assert.equal(currentRelease.outcome, 'refused');
  assert.equal((await docker.getContainer(replacement).inspect()).State.Running, true);
  await docker.getNetwork(currentNetwork.id).inspect();

  console.log(
    JSON.stringify({
      marker: 'NATIVE_RETAINED_NETWORK_RELEASE_PASSED',
      engineId: engine.ID,
      engineVersion: engine.ServerVersion,
      image,
      fixtureId,
      original,
      replacement,
      releasedNetwork: originalNetwork.id,
      originalUnchanged: true,
      runningRefused: true,
      currentRefused: true,
    }),
  );
  successful = true;
} finally {
  // Only IDs created by THIS fixture are eligible for cleanup.
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
    const info = await network.inspect().catch((error: { statusCode?: number }) => {
      if (error.statusCode === 404) return null; // Released above.
      return Promise.reject(error);
    });
    if (!info) continue;
    assert.equal(info.Labels?.[label], fixtureId);
    await network.remove();
  }
  db.close();
}
assert(successful);
console.log('OWNED_FIXTURE_CLEANUP_PASSED');
