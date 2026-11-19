// One bounded scheduler pass, separate from the test process that owns the workers.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ManagedPodRequest } from '@autopod/shared';
import pino from 'pino';
import { createDatabase } from '../db/connection.js';
import { ArtifactExports } from '../managed/artifact-exports.js';
import { ManagedArtifactPipeline } from '../managed/artifact-pipeline.js';
import { MemoryArtifactStore } from '../managed/artifact-store.js';
import { REQUIRED_ENFORCEMENT } from '../managed/grants.js';
import { ManagedControls } from '../managed/managed-controls.js';
import { ManagedPodService } from '../managed/managed-service.js';
import { managedGit } from '../managed/source-git.js';
import { LocalCheckpointHost } from '../orchestration/local-checkpoints.js';
import { offlineController } from './offline-controller.js';

const [file, root, mode] = process.argv.slice(2);
assert(file && root && (mode === 'mid-wave' || mode === 'before-ack' || mode === 'recover'));
const db = createDatabase(file, pino({ level: 'silent' }), { fileMustExist: true });
const profile: ManagedPodRequest['profileSnapshot'] = JSON.parse(
  readFileSync(path.join(root, 'profile.json'), 'utf8'),
);
const host = new LocalCheckpointHost(db, path.join(root, 'scratch'), (cp, mirror) => {
  const service = new ManagedPodService(
    db,
    {
      profiles: new Map([[profile.snapshotDigest, profile]]),
      enrollmentCeiling: profile.scope,
      identityCeiling: profile.scope,
      backendCeiling: profile.scope,
      enforcement: REQUIRED_ENFORCEMENT,
      targets: ['local'],
    },
    {
      async preflight() {},
      async ensure(id, _spec, checkpoint) {
        assert(mode === 'recover' && process.send);
        const cwd = path.join(root, id);
        await managedGit(root, ['clone', '--no-local', '--no-checkout', mirror, cwd]);
        await managedGit(cwd, ['checkout', '--detach', cp.commit]);
        // One allocation at a time. Owner gets an ID, not an executable or grant.
        const reply = once(process, 'message');
        process.send(id);
        assert.equal((await reply)[0], id);
        checkpoint(id);
        return { runtimeRef: id };
      },
      async observe() {
        throw new Error('unexpected observation');
      },
      async stop() {
        throw new Error('unexpected stop');
      },
    },
    () => 100,
    true,
  );
  new ManagedArtifactPipeline(
    service,
    new ArtifactExports(db, new MemoryArtifactStore()),
    path.join(root, 'staging'),
    new ManagedControls(service),
  );
  return service;
});
if (mode !== 'recover') {
  db.function('kill_writer', () => {
    process.kill(process.pid, 'SIGKILL');
    return 0;
  });
  db.exec(
    mode === 'mid-wave'
      ? `CREATE TEMP TRIGGER crash_wave BEFORE INSERT ON orchestration_continuations WHEN EXISTS (SELECT 1 FROM orchestration_continuations WHERE start_key LIKE 'turn-%') BEGIN SELECT kill_writer(); END`
      : `CREATE TEMP TRIGGER crash_ack BEFORE UPDATE OF acknowledged ON orchestration_result_waits BEGIN SELECT kill_writer(); END`,
  );
}
const { provider } = offlineController((payload) => {
  appendFileSync(
    path.join(root, 'provider-calls.jsonl'),
    JSON.stringify({ pid: process.pid, payload }) + '\n',
  );
  assert.notEqual(mode, 'recover', 'recovery must not re-plan');
  const { results } = JSON.parse(JSON.parse(payload).messages[0].content) as {
    results: { finding: { text: string } }[];
  };
  const children = results.flatMap(({ finding }) => {
    const issue = /^Issue: (.+)$/m.exec(finding.text)?.[1];
    return issue ? [{ recipe: 'inspect', brief: `Investigate ${issue}` }] : [];
  });
  return JSON.stringify({ children, waitFor: 1 });
});
const result = await host.tickController(
  'example',
  {
    findings: 'required-case-report/v1',
    mission: 'Investigate reported issues',
    routeId: 'offline',
    recipes: { inspect: 'worker-0' },
  },
  provider,
);
assert.equal(mode, 'recover', 'writer missed crash boundary');
assert.deepEqual(result, { blocked: [] });
db.close();
process.disconnect?.();
