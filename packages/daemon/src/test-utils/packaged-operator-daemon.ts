// Isolated HTTP daemon process. Production server, enrollment, watchdog, Codex command,
// channel, custody, Docker manager and SQLite. Only identity/provider services are fixtures.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Docker from 'dockerode';
import pino from 'pino';
import { createServer, type ServerDependencies } from '../api/server.js';
import { DockerContainerManager } from '../containers/docker-container-manager.js';
import { DockerNetworkManager } from '../containers/docker-network-manager.js';
import { createDatabase } from '../db/connection.js';
import { composeManagedCatalog } from '../managed/catalog.js';
import { codexSse } from '../managed/codex-wire.js';
import {
  composeManagedProfileSet,
  parseManagedProfileSetConfig,
} from '../managed/profile-set-config.js';
import {
  composeOperatorEnrollment,
  parseOperatorEnrollment,
} from '../orchestration/operator-enrollment.js';
import { operatorPartition } from '../orchestration/operator-partition.js';
import { offlineController } from './offline-controller.js';

const [root, mode] = process.argv.slice(2);
assert(root && process.send && (mode === 'first' || mode === 'recover'));
const data = JSON.parse(readFileSync(path.join(root, 'operator.json'), 'utf8'));
const { database, socket, cli, token } = data;
const enrollment = parseOperatorEnrollment(JSON.stringify(data.enrollment));
const profiles = parseManagedProfileSetConfig(JSON.stringify(data.profiles));
assert(enrollment && profiles);
const logger = pino({ level: 'silent' }),
  db = createDatabase(database, logger, { fileMustExist: true });
const docker = new Docker({ socketPath: socket, timeout: 20000 }),
  manager = new DockerContainerManager({ docker, logger });
const names = ['MAPLE', 'IRIS', 'CEDAR', 'FIR', 'OAK', 'ELM'];
const record = (event: string) => appendFileSync(path.join(root, 'trace'), event + '\n');
const six = Promise.withResolvers<void>(),
  eight = Promise.withResolvers<void>(),
  stopped = Promise.withResolvers<void>();
db.function('bound_child', (n: number) => {
  if (n === 6) six.resolve();
  if (n === 8) eight.resolve();
  return n;
});
db.exec(
  `CREATE TEMP TRIGGER count_children AFTER UPDATE OF pod_id ON orchestration_continuations BEGIN SELECT bound_child((SELECT count(pod_id) FROM orchestration_continuations)); END`,
);
db.function('observed_stop', (n: number) => {
  if (n === 8) stopped.resolve();
  return n;
});
db.exec(
  `CREATE TEMP TRIGGER count_exits AFTER UPDATE OF observed_exit ON managed_pods WHEN NEW.observed_exit=1 BEGIN SELECT observed_stop((SELECT sum(observed_exit) FROM managed_pods)); END`,
);
// An explicit barrier before the worker provider gateway: never hold an in-flight paid
// request across SIGKILL. The packaged process remains running in its original container.
const exec = manager.execInContainer.bind(manager);
manager.execInContainer = async (ref, cmd, opts) => {
  if (
    cmd[4] === 'channel-' &&
    cmd[2]?.includes('request.json') &&
    cmd[2]?.includes('print(p.read_text())')
  ) {
    const objective = db
      .prepare(
        "SELECT json_extract(request_json,'$.task.objective') FROM managed_pods WHERE runtime_ref=?",
      )
      .pluck()
      .get(ref);
    if (
      typeof objective === 'string' &&
      /Inspect (FIR|OAK|ELM)|Verify (MAPLE|IRIS)/.test(objective)
    )
      await stopped.promise;
  }
  return exec(ref, cmd, opts);
};
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), 'https://chatgpt.com/backend-api/codex/responses');
  await six.promise;
  const body = JSON.parse(String(init?.body));
  const name = names.find((n) => JSON.stringify(body.input).includes('Inspect ' + n));
  assert(name && names.indexOf(name) < 3);
  record('worker ' + name);
  const text = {
    MAPLE: 'MAPLE counted ticket 12 twice.',
    IRIS: 'IRIS omitted the final archive row.',
    CEDAR: 'CEDAR formatting is correct.',
  }[name];
  assert(text);
  return new Response(
    codexSse({
      model: body.model,
      status: 'completed',
      usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
};
const providerAccounts = {
  get: () => ({
    provider: 'openai',
    credentials: {
      provider: 'openai',
      authMode: 'chatgpt',
      authJson: JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: 'not-a-credential', account_id: 'fixture' },
      }),
    },
  }),
};
const networkManager = new DockerNetworkManager({ docker, logger });
const ensureNetwork = networkManager.ensureNetworkForPod.bind(networkManager);
networkManager.ensureNetworkForPod = async (pod) => {
  const n = db.prepare('SELECT rowid FROM managed_pods WHERE pod_id=?').pluck().get(pod);
  assert(typeof n === 'number' && n >= 1 && n <= 8);
  await docker.createNetwork({
    Name: 'autopod-' + pod,
    Driver: 'bridge',
    Labels: { 'com.autopod.pod-id': pod, 'com.autopod.pod-network': 'true' },
    IPAM: { Config: [{ Subnet: data.subnet + '.' + (n - 1) * 16 + '/28' }] },
  });
  return ensureNetwork(pod);
};
const sandboxProfiles = structuredClone(profiles);
sandboxProfiles.catalogArtifacts = true;
for (const p of sandboxProfiles.profiles) p.profileSnapshot.route.executionTarget = 'sandbox';
const partition = operatorPartition(enrollment, cli, sandboxProfiles, profiles)!;
const sandboxDeps = {
  db,
  databasePath: database,
  manager: {} as never,
  providerAccounts: providerAccounts as never,
  githubAuth: {} as never,
  ownsInstallation: partition.ordinary,
};
const legacy = composeManagedProfileSet(sandboxProfiles, cli, sandboxDeps);
const ordinary = composeManagedCatalog(sandboxProfiles, legacy, {
  ...sandboxDeps,
  catalog: {} as never,
  worktrees: {} as never,
});
await ordinary.resume();
const runtime = composeManagedProfileSet(profiles, cli, {
  ownsInstallation: partition.operator,
  db,
  databasePath: database,
  manager,
  networkManager,
  providerAccounts: providerAccounts as never,
  githubAuth: {} as never,
});
const { provider } = offlineController((raw) => {
  assert.equal(mode, 'first');
  const ctx = JSON.parse(JSON.parse(raw).messages[0].content);
  record('controller ' + ctx.phase);
  const child = (brief: string) => ({ recipe: 'inspect', brief });
  if (ctx.phase === 'kickoff')
    return JSON.stringify({ children: names.map((n) => child('Inspect ' + n)), waitFor: 3 });
  assert.equal(ctx.inFlightCount, 3);
  assert.equal(ctx.results.length, 3);
  const results = ctx.results.filter((r: { finding: { text: string } }) =>
    /counted ticket|omitted the final/.test(r.finding.text),
  );
  assert.equal(results.length, 2);
  return JSON.stringify({
    children: results.map((r: { finding: { text: string }; child: string }) =>
      child('Verify ' + r.finding.text.split(' ')[0] + ' from ' + r.child),
    ),
    waitFor: null,
  });
});
const config = composeOperatorEnrollment(enrollment, {
  db,
  databasePath: database,
  profiles,
  isolatedArtifacts: true,
  cli,
  runtime,
  bind: () => provider,
});
if (mode === 'first') {
  db.function('crash_before_ack', () => {
    record('kill');
    process.kill(process.pid, 'SIGKILL');
    return 0;
  });
  db.exec(
    `CREATE TEMP TRIGGER crash_ack BEFORE UPDATE OF acknowledged ON orchestration_result_waits WHEN NEW.wait_key<>'@kickoff' BEGIN SELECT crash_before_ack(); END`,
  );
}
// Fail fast rather than waiting for a barrier that a refused allocation cannot reach.
const originalStart = runtime.components.service.start.bind(runtime.components.service);
runtime.components.service.start = async (...args) => {
  try {
    return await originalStart(...args);
  } catch (e) {
    record('start failed ' + String(e).slice(0, 300));
    setImmediate(() => process.exit(3));
    throw e;
  }
};
const operator = cli.bindings[0];
const authModule = {
  validateToken: async (t: string) => {
    if (t !== token) throw new Error('unauthorized');
    return {
      iss: operator.issuer,
      aud: operator.audience,
      oid: operator.objectId,
      exp: Date.now() / 1000 + 500,
      iat: 0,
      roles: [],
      name: 'operator',
      preferred_username: 'operator',
    };
  },
};
const app = await createServer({
  authModule,
  db,
  managed: ordinary,
  operatorRuns: {
    ...config,
    watchdog: {
      service: runtime.components.service,
      finishOutputs: () => runtime.components.pipeline.tick(),
    },
  },
  logLevel: 'silent',
  prettyLog: false,
  podManager: {},
  eventBus: {},
  eventRepo: {},
  profileStore: {},
  podBridge: {},
  pendingRequestsByPod: new Map(),
} as unknown as ServerDependencies);
const url = await app.listen({ host: '127.0.0.1', port: 0 });
if (mode === 'recover') await eight.promise;
process.send({ type: 'ready', pid: process.pid, url });
if (mode === 'recover') {
  const finish = once(process, 'message');
  await stopped.promise;
  appendFileSync(path.join(root, 'exits-observed'), '8');
  await finish;
  await app.close();
  ordinary.close();
  runtime.close();
  db.close();
  process.disconnect?.();
}
