import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
/** Local test-only JSON-lines bridge. Never listens on a socket or invokes a provider. */
import { createInterface } from 'node:readline';
import type { ManagedPodRequest } from '@autopod/shared';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { managedArtifactRoutes } from '../api/routes/managed-artifacts.js';
import { managedPodRoutes } from '../api/routes/managed-pods.js';
import { ArtifactExports } from '../managed/artifact-exports.js';
import { ManagedArtifactInputs } from '../managed/artifact-inputs.js';
import { ManagedArtifactPipeline } from '../managed/artifact-pipeline.js';
import { AzureBlobArtifactStore } from '../managed/artifact-store.js';
import { REQUIRED_ENFORCEMENT } from '../managed/grants.js';
import { ManagedControls } from '../managed/managed-controls.js';
import { ManagedPodService, type ManagedRuntimePort } from '../managed/managed-service.js';
import { ManagedSourceDelivery } from '../managed/source-delivery.js';
import { type DraftRecord, ManagedGitBroker } from '../managed/source-git.js';

const [stateRoot, examplesPath, migrations] = process.argv.slice(2);
if (!stateRoot || !examplesPath || !migrations) throw new Error('fixture-paths-required');
await mkdir(stateRoot, { recursive: true });
const sourceConfigPath = path.join(stateRoot, 'source-fixture.json');
const sourceConfig = existsSync(sourceConfigPath)
  ? (JSON.parse(readFileSync(sourceConfigPath, 'utf8')) as {
      request: ManagedPodRequest;
      repo: string;
      remote: string;
    })
  : null;
const example: ManagedPodRequest =
  sourceConfig?.request ?? JSON.parse(readFileSync(examplesPath, 'utf8')).ManagedPodRequest;
const db = new Database(path.join(stateRoot, 'autopod.sqlite3'));
db.exec('CREATE TABLE IF NOT EXISTS fixture_migrations (name TEXT PRIMARY KEY)');
for (const file of readdirSync(migrations)
  .filter((file) => /^(14[2-9]|15[01])_/.test(file))
  .sort()) {
  if (db.prepare('SELECT name FROM fixture_migrations WHERE name=?').get(file)) continue;
  db.transaction(() => {
    db.exec(readFileSync(path.join(migrations, file), 'utf8'));
    db.prepare('INSERT INTO fixture_migrations VALUES (?)').run(file);
  })();
}
db.exec(
  'CREATE TABLE IF NOT EXISTS fixture_runtime (pod_id TEXT PRIMARY KEY, starts INTEGER NOT NULL, stopped INTEGER NOT NULL DEFAULT 0)',
);
const runtime: ManagedRuntimePort = {
  async preflight() {},
  async ensure(podId, _spec, checkpoint) {
    db.prepare('INSERT OR IGNORE INTO fixture_runtime(pod_id,starts) VALUES (?,1)').run(podId);
    checkpoint(podId);
    return { runtimeRef: podId };
  },
  async observe() {
    return { state: 'stopped', consumedTokens: 0 };
  },
  async stop(ref) {
    db.prepare('UPDATE fixture_runtime SET stopped=1 WHERE pod_id=?').run(ref);
  },
  async cleanup() {
    return true;
  },
  async extractOutput(ref, destination) {
    const row = db.prepare('SELECT request_json FROM managed_pods WHERE pod_id=?').get(ref) as {
      request_json: string;
    };
    const spec = JSON.parse(row.request_json) as ManagedPodRequest;
    await mkdir(destination, { recursive: true });
    for (const input of spec.inputArtifacts) {
      const mounted = service.inputs
        ?.mounts(ref)
        .find((mount) => mount.containerPath === input.mountPath);
      const manifest = await store.getManifest(input.backendArtifactId);
      if (
        !mounted ||
        !manifest.files[0] ||
        !(await readFile(path.join(mounted.hostPath, manifest.files[0].path), 'utf8')).startsWith(
          '# Fixture',
        )
      )
        throw new Error('fixture-input-missing');
    }
    for (const file of spec.outputs.artifacts.requiredPaths) {
      await writeFile(
        path.join(destination, file),
        `# Fixture ${spec.task.kind}\nExact local artifact contract.\n`,
      );
    }
  },
};
const policy = {
  profiles: new Map([[example.profileSnapshot.snapshotDigest, example.profileSnapshot]]),
  enrollmentCeiling: example.profileSnapshot.scope,
  identityCeiling: example.profileSnapshot.scope,
  backendCeiling: example.profileSnapshot.scope,
  enforcement: REQUIRED_ENFORCEMENT,
  targets: [example.route.executionTarget],
};
const service = new ManagedPodService(db, policy, runtime, () => 100, true);
const controls = new ManagedControls(service);
if (sourceConfig && example.outputs.source.mode !== 'none') {
  const output = example.outputs.source;
  const baseCommit = example.effectiveGrant.scope.repositories[0]?.baseRevision;
  if (!baseCommit) throw new Error('fixture-source-base-required');
  const broker = new ManagedGitBroker([
    {
      repository: output.repository,
      remote: output.remote,
      remoteUrl: sourceConfig.remote,
      base: output.base,
      baseCommit,
      branchNamespace: 'worker/',
      workspace: () => sourceConfig.repo,
    },
  ]);
  db.exec(
    'CREATE TABLE IF NOT EXISTS fixture_draft (id INTEGER PRIMARY KEY,record_json TEXT NOT NULL)',
  );
  service.source = new ManagedSourceDelivery(
    service,
    broker,
    new Map([['fixture-full-v1', 'dispatcher-verifier']]),
    {
      async inspect() {
        const row = db.prepare('SELECT record_json FROM fixture_draft').get() as
          | { record_json: string }
          | undefined;
        return row ? (JSON.parse(row.record_json) as DraftRecord) : null;
      },
      async create(request) {
        const record: DraftRecord = {
          id: 1,
          repository: request.repository,
          head: request.head,
          base: request.base,
          commit: request.newCommit,
          draft: true,
          bodyDigest: request.bodyDigest,
        };
        db.prepare('INSERT INTO fixture_draft VALUES (1,?)').run(JSON.stringify(record));
        return record;
      },
      async update() {
        throw new Error('fixture-update-not-requested');
      },
    },
  );
}

const blobRoot = path.join(stateRoot, 'private-fixture-blob');
const store = new AzureBlobArtifactStore(
  {
    async putIfAbsent(name, bytes) {
      const file = path.join(blobRoot, name);
      await mkdir(path.dirname(file), { recursive: true });
      try {
        await writeFile(file, bytes, { flag: 'wx' });
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
          !(await readFile(file)).equals(bytes)
        )
          throw new Error('fixture-immutable-conflict');
      }
    },
    async get(name) {
      return readFile(path.join(blobRoot, name));
    },
  },
  async (id) => {
    const row = db.prepare('SELECT pod_id FROM artifact_exports WHERE artifact_id=?').get(id) as
      | { pod_id: string }
      | undefined;
    if (!row) throw new Error('fixture-artifact-not-found');
    return `managed-pods/${row.pod_id}/${id}`;
  },
);
service.inputs = new ManagedArtifactInputs(db, store, path.join(stateRoot, 'inputs'));
const exports = new ArtifactExports(db, store, () => 100);
const pipeline = new ManagedArtifactPipeline(
  service,
  exports,
  path.join(stateRoot, 'staging'),
  controls,
);
const app = Fastify({ logger: false });
managedPodRoutes(app, { service, authenticate: async () => 'installation-one' });
managedArtifactRoutes(app, {
  exports,
  store,
  authorize: async (_request, id) => {
    const row = db.prepare('SELECT pod_id FROM artifact_exports WHERE artifact_id=?').get(id) as
      | { pod_id: string }
      | undefined;
    return !!row && !!service.row('installation-one', row.pod_id);
  },
});
await app.ready();
for await (const line of createInterface({ input: process.stdin })) {
  try {
    const request = JSON.parse(line) as { method: 'GET' | 'POST'; path: string; body?: unknown };
    if (request.path === '/fixture/tick') {
      await service.enforceExpiry();
      await pipeline.tick();
      process.stdout.write('{"ok":true}\n');
      continue;
    }
    if (request.path === '/fixture/counts') {
      process.stdout.write(
        `${JSON.stringify({
          pods: (
            db.prepare('SELECT count(*) AS count FROM managed_pods').get() as { count: number }
          ).count,
          starts: (
            db.prepare('SELECT sum(starts) AS count FROM fixture_runtime').get() as {
              count: number;
            }
          ).count,
          sourceEffects: 0,
        })}\n`,
      );
      continue;
    }
    const response = await app.inject({
      method: request.method,
      url: request.path,
      payload: request.body === undefined ? undefined : JSON.stringify(request.body),
      headers: request.body === undefined ? {} : { 'content-type': 'application/json' },
    });
    process.stdout.write(
      `${JSON.stringify({
        status: response.statusCode,
        body: response.headers['content-type']?.startsWith('application/gzip')
          ? { base64: response.rawPayload.toString('base64') }
          : response.json(),
      })}\n`,
    );
  } catch {
    process.stdout.write('{"error":"fixture-request-failed"}\n');
  }
}
await app.close();
db.close();
