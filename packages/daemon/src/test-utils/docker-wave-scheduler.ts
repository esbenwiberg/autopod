// Opt-in local canary: real Docker lifetime, fixed offline workload. No HTTP listener or provider.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import type { ManagedPodRequest } from '@autopod/shared';
import Docker from 'dockerode';
import pino from 'pino';
import { createDatabase } from '../db/connection.js';
import { dockerCanaryService } from '../orchestration/canary-docker-service.js';
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
const db = createDatabase(database, pino({ level: 'silent' }), { fileMustExist: true });
const docker = new Docker({ socketPath, timeout: 15000 });
const run = 'example';
const recipe: ManagedPodRequest = JSON.parse(
  db
    .prepare('SELECT recipes_json FROM orchestration_kickoffs WHERE run_id=?')
    .pluck()
    .get(run) as string,
).inspect;
const profile = recipe.profileSnapshot;
const compose = dockerCanaryService(db, root, docker, image, owner, profile);
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
  for (const r of ctx.results) assert.equal(r.finding.text.trim(), 'Checked pinned fixture');
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
