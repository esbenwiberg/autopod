// Opt-in local canary: real Docker lifetime, fixed offline workload. No HTTP listener or provider.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFileSync } from 'node:fs';
import { chmod, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ManagedPodRequest } from '@autopod/shared';
import Database from 'better-sqlite3';
import Docker from 'dockerode';
import { ArtifactExports } from '../managed/artifact-exports.js';
import { ManagedArtifactPipeline } from '../managed/artifact-pipeline.js';
import { MemoryArtifactStore } from '../managed/artifact-store.js';
import { REQUIRED_ENFORCEMENT } from '../managed/grants.js';
import { ManagedControls } from '../managed/managed-controls.js';
import { ManagedPodService, type ManagedRuntimePort } from '../managed/managed-service.js';
import { managedGit } from '../managed/source-git.js';
import { LocalCheckpointHost } from '../orchestration/local-checkpoints.js';
import { offlineController } from './offline-controller.js';

const [database, root, socketPath, image, owner, mode] = process.argv.slice(2);
assert(
  database &&
    root &&
    socketPath &&
    path.isAbsolute(socketPath) &&
    image &&
    /^sha256:[0-9a-f]{64}$/.test(image) &&
    owner &&
    (mode === 'first' || mode === 'recover') &&
    process.send,
);
const db = new Database(database, { fileMustExist: true });
const docker = new Docker({ socketPath, timeout: 15000 });
const label = 'autopod.orchestration.canary';
const run = 'example';
const recipe: ManagedPodRequest = JSON.parse(
  db
    .prepare('SELECT recipes_json FROM orchestration_kickoffs WHERE run_id=?')
    .pluck()
    .get(run) as string,
).inspect;
const profile = recipe.profileSnapshot;
const owned = async (ref: string) => {
  const c = docker.getContainer(ref);
  const info = await c.inspect();
  assert.equal(info.Config.Labels[label], owner);
  return { c, info };
};
const compose = (mirror?: string) => {
  const runtime: ManagedRuntimePort = {
    async preflight() {
      assert.equal((await docker.getImage(image).inspect()).Id, image);
    },
    async ensure(id, spec, checkpoint) {
      assert(mirror && /^managed-[0-9a-f-]+$/.test(id));
      const pin = spec.effectiveGrant.scope.repositories[0]?.baseRevision;
      assert(pin);
      const source = path.join(root, id),
        output = path.join(root, 'output', id);
      await managedGit(root, ['clone', '--no-local', '--no-checkout', mirror, source]);
      await managedGit(source, ['checkout', '--detach', pin]);
      await mkdir(output, { recursive: true });
      await chmod(output, 0o777);
      const c = await docker.createContainer({
        name: `ap-wave-${owner}-${id}`,
        Image: image,
        Labels: { [label]: owner, 'autopod.canary.pod': id },
        User: '65534:65534',
        // Fail-safe lifetime even if the test driver itself is interrupted.
        Entrypoint: ['/bin/busybox', 'timeout', '-s', 'KILL', '120', '/bin/sh'],
        Cmd: [
          '-ec',
          `test "$(cat /src/.git/HEAD)" = "$1"; test "$(cat /src/proof.txt)" = 'unpublished checkpoint'; mkfifo /tmp/finish; read -r result </tmp/finish; test "$result" = finish; printf 'Checked %s\\n' "$1" > /out/report.md`,
          'worker',
          pin,
        ],
        HostConfig: {
          NetworkMode: 'none',
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          PidsLimit: 24,
          Memory: 32 * 1024 * 1024,
          NanoCpus: 250000000,
          Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=1m' },
          Binds: [`${source}:/src:ro`, `${output}:/out:rw`],
        },
      });
      checkpoint(c.id);
      await c.start();
      return { runtimeRef: c.id };
    },
    async observe(ref) {
      const { info } = await owned(ref);
      return {
        state: info.State.Running ? 'running' : 'stopped',
        exitCode: info.State.ExitCode,
        consumedTokens: 0,
      };
    },
    async stop(ref) {
      const { c, info } = await owned(ref);
      if (info.State.Running) await c.kill();
    },
    async extractOutput(ref, staging) {
      const { info } = await owned(ref);
      assert(!info.State.Running && info.State.ExitCode === 0);
      const id = info.Config.Labels['autopod.canary.pod'];
      assert(/^managed-[0-9a-f-]+$/.test(id));
      await cp(path.join(root, 'output', id), staging, { recursive: true });
    },
  };
  const s = new ManagedPodService(
    db,
    {
      profiles: new Map([[profile.snapshotDigest, profile]]),
      enrollmentCeiling: profile.scope,
      identityCeiling: profile.scope,
      backendCeiling: profile.scope,
      enforcement: REQUIRED_ENFORCEMENT,
      targets: ['local'],
    },
    runtime,
    () => 100,
    true,
  );
  new ManagedArtifactPipeline(
    s,
    new ArtifactExports(db, new MemoryArtifactStore()),
    path.join(root, 'staging'),
    new ManagedControls(s),
  );
  return s;
};
const host = new LocalCheckpointHost(db, path.join(root, 'scratch'), (_cp, mirror) =>
  compose(mirror),
);
const { provider } = offlineController((payload) => {
  appendFileSync(path.join(root, 'calls'), `${process.pid}\n`);
  assert.equal(mode, 'first', 'unexpected replan');
  const ctx = JSON.parse(JSON.parse(payload).messages[0].content);
  if (ctx.phase === 'kickoff')
    return JSON.stringify({
      children: Array.from({ length: 6 }, (_, i) => ({ recipe: 'inspect', brief: `Inspect ${i}` })),
      waitFor: 3,
    });
  assert.equal(ctx.results.length, 3);
  assert.equal(ctx.inFlightCount, 3);
  for (const r of ctx.results)
    assert.equal(r.finding.text.trim(), `Checked ${profile.scope.repositories[0]?.baseRevision}`);
  return JSON.stringify({
    children: ctx.results
      .slice(0, 2)
      .map((r: { child: string }) => ({ recipe: 'inspect', brief: `Follow up on ${r.child}` })),
    waitFor: null,
  });
});
const loop = host.watchController(
  run,
  {
    mission: 'Verify canary reports',
    findings: 'report.md',
    routeId: 'offline',
    recipes: { inspect: '@inspect' },
  },
  provider,
);
assert.deepEqual(await loop.settled(), { blocked: [] });
const next = once(process, 'message');
process.send({ type: 'ready', pid: process.pid });
const [action] = await next;
const s = compose();
if (mode === 'first') {
  assert.equal(action, 'collect');
  db.function('crash_before_ack', () => {
    process.kill(process.pid, 'SIGKILL');
    return 0;
  });
  db.exec(
    `CREATE TEMP TRIGGER crash_ack BEFORE UPDATE OF acknowledged ON orchestration_result_waits BEGIN SELECT crash_before_ack(); END`,
  );
  await s.enforceExpiry();
  await s.artifactPipeline?.tick();
  await loop.settled();
  throw new Error('scheduler missed crash boundary');
}
assert.equal(action, 'cancel');
await loop.close();
host.ledger.cancel(run);
await s.enforceExpiry();
await s.enforceExpiry();
db.close();
process.disconnect?.();
