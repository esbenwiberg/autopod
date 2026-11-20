import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import pino from 'pino';
import { expect, it, onTestFinished, vi } from 'vitest';
import { mcpHandler } from '../api/mcp-handler.js';
import { authPlugin } from '../api/plugins/auth.js';
import { resolveLaunchAgentRoute } from '../configuration/agent-route-resolution.js';
import { createConfigurationStore } from '../configuration/configuration-store.js';
import { admitLaunch } from '../configuration/launch-admission.js';
import { resolveLaunchExecutionSettings } from '../configuration/launch-execution-settings.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import { createPodTokenIssuer } from '../crypto/pod-tokens.js';
import { ArtifactExports } from '../managed/artifact-exports.js';
import { MemoryArtifactStore } from '../managed/artifact-store.js';
import { ManagedPodService } from '../managed/managed-service.js';
import {
  PARENT_DELEGATE_BIN,
  PARENT_DELEGATE_DESCRIPTOR,
} from '../pods/parent-delegate-materials.js';
import { createSessionBridge } from '../pods/pod-bridge-impl.js';
import type { PodManagerDependencies } from '../pods/pod-manager.js';
import { createPodRepository } from '../pods/pod-repository.js';
import { runDelegate } from '../pods/runtime/ap-delegate.mjs';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { setupOrchestrationRun } from '../test-utils/orchestration-run-fixture.js';
import { createProvisioningFixture } from '../test-utils/provisioning-helpers.js';
import { LocalCheckpointHost } from './local-checkpoints.js';
import { type OperatorRunsConfig, operatorRunId, registerOperatorRuns } from './operator-runs.js';
import { ParentManagedLaunch } from './parent-managed-launch.js';

const logger = pino({ level: 'silent' });
const operator = {
  issuer: 'https://issuer.example/',
  audience: 'api://autopod',
  objectId: 'operator',
  installationId: 'team',
};
const auth = {
  validateToken: async (token: string) => {
    if (!['operator', 'other'].includes(token)) throw new Error('invalid');
    return {
      iss: operator.issuer,
      aud: operator.audience,
      oid: token,
      exp: Date.now() / 1000 + 3600,
      iat: 0,
      roles: [],
      name: 'fixture',
      preferred_username: 'fixture',
    };
  },
};

async function fixture(
  requests = 2,
  active = 1,
  workers = 2,
  runtimeRequest = false,
  loseAllocation = false,
  restartBeforeProvision = false,
) {
  // Real SQLite migrations, admission, source custody and parent provisioning; external execution is fake.
  const source = await setupOrchestrationRun(
    requests,
    active,
    operatorRunId(operator, 'parent-fixture'),
  );
  const p = createProvisioningFixture(true, false);
  onTestFinished(() => p.close());
  const original = { id: 'prepare' };
  const { store, services } = createTestConfiguration(p.db);
  services.resolveAgentRoute = async (route) => resolveLaunchAgentRoute(route, p.accounts);
  const snapshots = createLaunchSnapshotRepository(p.db, store);
  const requestId = randomUUID();
  // Resolve first, so operator enrollment selects the exact launch preview before admission.
  const { resolveLaunch } = await import('../configuration/launch-resolver.js');
  const launchRequest = {
    repositoryId: 'repo-a',
    task: 'Commission a confined report worker',
    requestId,
    overrides: {
      execution: { networkPolicy: { enabled: true, mode: 'restricted', allowedHosts: [] } },
    },
  };
  const preview = await resolveLaunch(launchRequest, services, 'operator');
  let boundaryCalls = 0;
  const stages: string[] = [];
  const host = () =>
    new LocalCheckpointHost(p.db, path.join(p.directory, 'scratch'), () => {
      const service = new ManagedPodService(
        p.db,
        source.f.admission,
        {
          ...source.f.runtime,
          ensure: async (...args) => {
            boundaryCalls++;
            if (loseAllocation) throw new Error('synthetic-external-allocation-reply-lost');
            return source.f.runtime.ensure(...args);
          },
        },
        () => 100,
        true,
      );
      service.onTransition = () => {
        const view = owner.family(original.id);
        stages.push((view.children[0] as { status: string }).status);
      };
      return service;
    });
  host().ledger.open(
    source.cp.run,
    source.cp.repository,
    source.cp.policyDigest,
    source.cp.predecessor,
    requests,
    active,
  );
  await host().retain(source.subject, source.bytes, source.verify);
  const key = path.join(p.directory, 'test-signing-key');
  await writeFile(key, 'synthetic-offline-signing-material');
  const issuer = createPodTokenIssuer(key);
  const config = (): OperatorRunsConfig => ({
    db: p.db,
    host: host(),
    slots: [
      {
        slot: 'parent-fixture',
        operator,
        checkpoint: source.cp,
        catalog: { inspect: source.request },
        parent: { requestId, launchDigest: preview.digest },
        policy: {
          mission: 'Fixture',
          routeId: 'unused',
          recipes: { inspect: '@inspect' },
          limits: { workers, turns: 1, outputTokens: 64 },
        },
      },
    ],
  });
  let owner = new ParentManagedLaunch(config(), issuer, (id) =>
    createPodRepository(p.db).getOrThrow(id),
  );
  Object.assign(p.deps, {
    launchConfiguration: {
      read: snapshots.get,
      assertCurrentCapabilities: async () => {},
      prepareEnvironment: async () => 'fixture-image',
      executionSettings: (launch: import('@autopod/shared').EffectiveLaunchConfig) =>
        resolveLaunchExecutionSettings(launch, { image: 'fixture-image' }),
    },
  });
  const principal = { oid: operator.objectId, iss: operator.issuer, aud: operator.audience };
  for (const invalid of [
    undefined,
    { ...principal, oid: 'another-operator' },
    { ...principal, iss: 'https://wrong-issuer.example/' },
    { ...principal, aud: 'api://wrong-audience' },
  ]) {
    expect(() => owner.authorizeLaunch(requestId, invalid)).toThrow(
      'Enrolled parent operator required',
    );
  }
  const admitted = await admitLaunch({
    request: { ...launchRequest, expectedDigest: preview.digest, requireParentEnrollment: true },
    actorId: 'operator',
    authorize: (id) => owner.authorizeLaunch(id, principal),
    services,
    snapshots,
    createPod: (launch) => {
      const parent = p.manager().createResolvedSession(launch, 'operator');
      original.id = parent.id;
      p.selectPod(parent.id);
      return original.id;
    },
  });
  expect(admitted.config.digest).toBe(preview.digest);
  const live: PodManagerDependencies = p.deps;
  live.sessionTokenIssuer = issuer;
  live.provisionParentSession = (id) => owner.provision(id);
  // Full production workspace → container → session → agent material pipeline.
  Object.assign(p.deps, {
    launchConfiguration: {
      read: snapshots.get,
      assertCurrentCapabilities: async () => {},
      prepareEnvironment: async () => 'fixture-image',
      executionSettings: (launch: import('@autopod/shared').EffectiveLaunchConfig) =>
        resolveLaunchExecutionSettings(launch, { image: 'fixture-image' }),
    },
  });
  let token = '';
  expect(source.f.launches()).toBe(0);
  let scheduler: ReturnType<typeof registerOperatorRuns>;
  let app = build();
  function build() {
    const app = Fastify();
    app.addHook('onRequest', async (req, reply) => {
      req.raw.setTimeout = () => req.raw;
      reply.raw.setTimeout = () => reply.raw;
    });
    authPlugin(app, auth, issuer);
    scheduler = registerOperatorRuns(
      app,
      { ...config(), lifetimeOwner: { owns: () => true } },
      auth,
    );
    const bridge = createSessionBridge({
      podManager: p.manager(),
      podRepo: p.deps.podRepo,
      eventBus: p.deps.eventBus,
      escalationRepo: p.deps.escalationRepo,
      nudgeRepo: p.deps.nudgeRepo,
      profileStore: p.deps.profileStore,
      containerManagerFactory: p.deps.containerManagerFactory,
      pendingRequestsByPod: new Map(),
      logger,
      scopedTools: (id) => owner.tools(id),
    });
    mcpHandler(app, bridge, new Map(), logger, issuer, undefined, (id, credential, run) =>
      owner.withIngress(id, credential, run),
    );
    owner.registerFamily(app, auth);
    return app;
  }
  onTestFinished(async () => app.close());
  const call = async (
    args: Record<string, unknown>,
    credential = token,
    podId = original.id,
    name = 'managed_child_request',
  ) => {
    const response = await app.inject({
      method: 'POST',
      url: `/mcp/${podId}`,
      headers: {
        authorization: `Bearer ${credential}`,
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    });
    if (response.statusCode === 500) throw new Error(response.body);
    await scheduler.settled(source.cp.run);
    if (response.statusCode !== 200)
      return { rejected: true, status: response.statusCode, body: response.body };
    const data = response.body.split('\n').find((line) => line.startsWith('data: '));
    const envelope = JSON.parse(data ? data.slice(6) : response.body);
    return {
      rejected: Boolean(envelope.error || envelope.result?.isError),
      result: envelope.result,
    };
  };
  const delegate = async (args: string[], replacementToken?: string) => {
    const writes = vi.mocked(p.cm.writeFile).mock.calls;
    const descriptor = writes.findLast((entry) => entry[1] === PARENT_DELEGATE_DESCRIPTOR);
    expect(descriptor?.[3]).toMatchObject({ mode: 0o600, preserveParentModes: true });
    expect(writes.findLast((entry) => entry[1] === `${PARENT_DELEGATE_BIN}/ap`)?.[3]).toMatchObject(
      {
        mode: 0o500,
      },
    );
    const config = JSON.parse(String(descriptor?.[2]));
    if (replacementToken) config.authorization = `Bearer ${replacementToken}`;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = await runDelegate(['delegate', ...args], {
      config,
      stdout: { write: (s: string) => stdout.push(s) },
      stderr: { write: (s: string) => stderr.push(s) },
      transport: async (url: string, init: RequestInit) => {
        const headers = Object.fromEntries(new Headers(init.headers));
        const result = await app.inject({
          url: new URL(url).pathname,
          method: 'POST',
          headers,
          payload: String(init.body),
        });
        await scheduler.settled(source.cp.run);
        return new Response(result.body, {
          status: result.statusCode,
          headers: { 'content-type': String(result.headers['content-type']) },
        });
      },
    });
    return { exit, stdout: stdout.length ? JSON.parse(stdout.join('')) : null, stderr };
  };
  const family = (credential = 'operator', podId = original.id) =>
    app.inject({
      method: 'GET',
      url: `/orchestration/parents/${podId}/family`,
      headers: { authorization: `Bearer ${credential}` },
    });
  const restart = async () => {
    await app.close();
    p.reopen();
    live.launchConfiguration!.read = createLaunchSnapshotRepository(
      p.db,
      createConfigurationStore(p.db),
    ).get;
    owner = new ParentManagedLaunch(config(), issuer, (id) =>
      createPodRepository(p.db).getOrThrow(id),
    );
    app = build();
    await app.ready();
    await scheduler.settled(source.cp.run);
  };
  const runtimeToken = (servers: import('@autopod/shared').McpServerConfig[]) => {
    const mcp = servers.find((s) => s.name === 'escalation');
    if (!mcp || mcp.type === 'stdio' || !mcp.headers?.Authorization)
      throw new Error('Missing provisioned ingress');
    return mcp.headers.Authorization.slice(7);
  };
  if (restartBeforeProvision) {
    expect(p.db.prepare('SELECT pod_id, current_attempt FROM parent_managed_runs').get()).toEqual({
      pod_id: original.id,
      current_attempt: null,
    });
    expect(p.db.prepare('SELECT count(*) FROM parent_managed_sessions').pluck().get()).toBe(0);
    await restart();
    expect((await family()).json()).toMatchObject({ parent: original.id, children: [] });
    expect(source.f.launches()).toBe(0);
  }
  if (runtimeRequest) {
    // Fake model/runtime adapter, called by production processPod. It learns authority ONLY
    // from its real SpawnConfig and sends a model-selected recipe/brief over its scoped ingress.
    vi.mocked(p.ctx.runtime.spawn).mockImplementation(async function* (spawn) {
      token = runtimeToken(spawn.mcpServers ?? []);
      expect(issuer.verifyAttempt(token)?.podId).toBe(spawn.podId);
      const commissioned = await delegate([
        'start',
        '--key',
        'model-turn-one',
        '--recipe',
        'inspect',
        '--brief',
        'Read the pinned source',
      ]);
      expect(commissioned).toMatchObject({
        exit: 0,
        stdout: { ok: true, result: { requestKey: 'model-turn-one' } },
        stderr: [],
      });
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        fatal: true,
        message: 'Synthetic parent stops after proving commissioning; no delivery requested',
      };
    });
    await p.manager().processPod(original.id);
    if (!vi.mocked(p.ctx.runtime.spawn).mock.calls.length)
      throw new Error(JSON.stringify(p.pod().failureReason));
    expect(p.ctx.runtime.spawn).toHaveBeenCalledTimes(1);
  } else {
    p.podRepo.update(original.id, {
      profileSnapshot: resolveLaunchExecutionSettings(admitted.config, { image: 'fixture-image' }),
    });
    token = runtimeToken((await p.agent()).mcpServers);
  }
  return {
    parentId: original.id,
    p,
    source,
    call,
    delegate,
    family,
    operatorStart: () =>
      app.inject({
        method: 'POST',
        url: '/orchestration/runs/parent-fixture/start',
        headers: { authorization: 'Bearer operator' },
        payload: {},
      }),
    token,
    issuer,
    restart,
    host,
    stages,
    boundaryCalls: () => boundaryCalls,
    owner: () => owner,
    setPolicy: (enabled: boolean) => {
      owner = new ParentManagedLaunch(
        { ...config(), ...(enabled ? {} : { slots: [] }) },
        issuer,
        (id) => createPodRepository(p.db).getOrThrow(id),
      );
    },
    remaining: () =>
      p.db
        .prepare('SELECT remaining FROM orchestration_request_balances WHERE id=?')
        .pluck()
        .get(source.cp.run),
    reservations: () =>
      p.db.prepare('SELECT count(*) FROM orchestration_continuations').pluck().get(),
  };
}

it.each([
  false,
  true,
])('production processPod provisions a parent and its runtime commissions a child (restart before provision: %s)', async (restartBeforeProvision) => {
  const f = await fixture(2, 1, 1, true, false, restartBeforeProvision);
  expect(f.source.f.launches()).toBe(1);
  expect(f.stages).toEqual(['reserved', 'started']);
  expect(f.p.pod().status).toBe('failed'); // fake parent runtime has exited; no display-only process
  expect(f.remaining()).toBe(0);
  expect(f.reservations()).toBe(1);
  expect((await f.family()).json().children[0]).toMatchObject({
    requestKey: 'model-turn-one',
    status: 'started',
    parentAttempt: f.issuer.verifyAttempt!(f.token)?.attempt,
  });
  const history = (await f.family()).json();
  await f.restart();
  expect((await f.family()).json()).toEqual(history);
});

it('a real launched parent commissions through provisioned MCP ingress; lost replies and restart retain one debit and actual managed identity', async () => {
  const f = await fixture();
  const request = {
    requestKey: 'first',
    recipe: 'inspect',
    brief: 'Read the pinned synthetic source',
  };
  // Only this parent-side tool invocation starts the child. Ignore its first reply.
  expect(await f.call(request)).toMatchObject({ rejected: false });
  const before = (await f.family()).json();
  expect(before).toMatchObject({ parent: f.parentId, children: [{ status: 'started' }] });
  expect(before.children[0].child).toMatch(/^managed-/);
  expect(f.remaining()).toBe(0);
  expect(f.source.f.launches()).toBe(1);
  expect(f.p.db.prepare('SELECT count(*) FROM pods').pluck().get()).toBe(1);
  expect(f.p.db.prepare('SELECT pod_id FROM orchestration_continuations').pluck().get()).toBe(
    before.children[0].child,
  );
  await f.restart();
  expect(await f.call(request)).toMatchObject({ rejected: false });
  expect((await f.family()).json()).toEqual(before);
  expect(f.remaining()).toBe(0);
  expect(f.reservations()).toBe(1);
  expect(f.source.f.launches()).toBe(1);
  // Durable unknown and observed exit projections are independent of ordinary pod rows.
  const service = new ManagedPodService(
    f.p.db,
    f.source.f.admission,
    {
      ...f.source.f.runtime,
      observe: async () => ({ state: 'unknown', consumedTokens: 0 }),
    },
    () => 100,
    true,
  );
  await service.enforceExpiry();
  expect((await f.family()).json().children[0].status).toBe('unknown');
  f.source.f.advance(401);
  await new ManagedPodService(
    f.p.db,
    f.source.f.admission,
    f.source.f.runtime,
    () => 401,
    true,
  ).enforceExpiry();
  const pods = createPodRepository(f.p.db);
  pods.update(f.parentId, { status: 'validating' });
  expect((await f.family()).json().children[0].status).toBe('exited');
  expect((await f.call({ requestKey: 'late', recipe: 'inspect', brief: 'late' })).rejected).toBe(
    true,
  );
  expect(JSON.stringify((await f.family()).json())).not.toMatch(
    /grant|policy_json|runtime_ref|credential/,
  );
});

it('reads the same durable outcome after reconnect and never charges a read or wait', async () => {
  const f = await fixture();
  const admitted = await f.delegate([
    'start',
    '--key',
    'results',
    '--recipe',
    'inspect',
    '--brief',
    'Read',
  ]);
  expect(admitted).toMatchObject({ exit: 0, stdout: { result: { requestKey: 'results' } } });
  const pending = await f.delegate(['results']);
  expect(pending).toMatchObject({ exit: 0, stdout: { result: { nextCursor: 0, results: [] } } });
  const waited = await f.delegate(['wait', '--timeout-ms', '5']);
  expect(waited).toMatchObject({ exit: 0, stdout: { result: { timedOut: true, results: [] } } });
  f.source.f.advance(401);
  const service = new ManagedPodService(
    f.p.db,
    f.source.f.admission,
    f.source.f.runtime,
    () => 401,
    true,
  );
  await service.enforceExpiry(); // requests stop for the expired worker
  await service.enforceExpiry(); // observes the worker's actual exit
  const first = await f.delegate(['results']);
  expect(first).toMatchObject({
    exit: 0,
    stdout: { result: { results: [{ requestKey: 'results', cursor: expect.any(Number) }] } },
  });
  await f.restart();
  expect(await f.delegate(['results'])).toEqual(first);
  const latestCursor = first.stdout.result.nextCursor;
  expect(await f.delegate(['results', '--after', String(latestCursor)])).toMatchObject({
    exit: 0,
    stdout: { result: { nextCursor: latestCursor, results: [] } },
  });
  const replacement = await f.owner().provision(f.parentId);
  expect(replacement).toBeTruthy();
  expect((await f.delegate(['results'])).exit).toBe(1); // old attempt has no read authority
  expect(await f.delegate(['results'], replacement)).toEqual(first); // same run, fresh attempt
  expect(f.remaining()).toBe(0);
  expect(f.boundaryCalls()).toBe(1);
});

it('freezes two verified same-run reports as follow-up evidence and replays without rereading them', async () => {
  const f = await fixture(6, 2, 3);
  const followup = {
    requestKey: 'followup',
    recipe: 'inspect',
    brief: 'Choose the next assertion using both findings',
    from: [1, 2],
  };
  expect((await f.call(followup)).rejected).toBe(true);
  expect(f.reservations()).toBe(0);
  expect(f.boundaryCalls()).toBe(0);
  expect(f.remaining()).toBe(6);
  for (const key of ['playback', 'history']) {
    expect(
      (await f.call({ requestKey: key, recipe: 'inspect', brief: 'Investigate' })).rejected,
    ).toBe(false);
  }
  const workers = (await f.family()).json().children as { requestKey: string; child: string }[];
  for (const { requestKey, child } of workers) {
    const dir = path.join(await realpath(f.p.directory), 'report-' + requestKey);
    await mkdir(dir);
    await writeFile(path.join(dir, 'report.md'), 'Finding from ' + requestKey);
    const binding = f.p.db
      .prepare(
        'SELECT pod_id AS podId, dispatcher_attempt_id AS dispatcherAttemptId, execution_spec_digest AS executionSpecDigest FROM managed_pods WHERE pod_id=?',
      )
      .get(child) as { podId: string; dispatcherAttemptId: string; executionSpecDigest: string };
    await new ArtifactExports(f.p.db, new MemoryArtifactStore()).export(
      binding,
      dir,
      {
        ...f.source.request.outputs.artifacts,
        mode: 'required',
        include: ['report.md'],
        requiredPaths: ['report.md'],
      },
      true,
    );
    f.p.db
      .prepare(
        "UPDATE managed_pods SET state='complete',observed_exit=1,exit_code=0 WHERE pod_id=?",
      )
      .run(child);
  }
  const results = (await f.delegate(['results'])).stdout.result.results as {
    cursor: number;
    requestKey: string;
  }[];
  expect(results.map(({ requestKey }) => requestKey)).toEqual(['playback', 'history']);
  const selected = results.slice().reverse(); // Preserve caller order, not cursor order.
  const from = selected.map(({ cursor }) => cursor);
  const args = [
    'start',
    '--key',
    followup.requestKey,
    '--recipe',
    followup.recipe,
    '--brief',
    followup.brief,
    '--from',
    from.join(','),
  ];
  expect(await f.delegate(args)).toMatchObject({
    exit: 0,
    stdout: { result: { requestKey: 'followup' } },
  });
  const record = f.p.db
    .prepare(
      `SELECT q.report_dependencies_json AS edges, json_extract(c.request_json,'$.task.objective') AS objective
       FROM parent_managed_requests q JOIN orchestration_continuations c USING (run_id,start_key)
      WHERE q.request_key='followup'`,
    )
    .get() as { edges: string; objective: string };
  expect(JSON.parse(record.edges)).toEqual(
    selected.map(({ cursor, requestKey }) => ({
      cursor,
      requestKey,
      childId: workers.find((worker) => worker.requestKey === requestKey)?.child,
      artifactId: expect.any(String),
      excerptDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      truncated: false,
    })),
  );
  expect(record.objective).toContain('untrusted observations');
  expect(record.objective).toContain('Finding from playback');
  expect(record.objective).toContain('Finding from history');
  expect(record.objective.indexOf('Finding from history')).toBeLessThan(
    record.objective.indexOf('Finding from playback'),
  );
  expect(f.remaining()).toBe(0);
  expect(f.reservations()).toBe(3);
  expect(f.boundaryCalls()).toBe(3);
  f.p.db.prepare('UPDATE artifact_exports SET bundle_bytes=?').run(Buffer.from('corrupt fixture'));
  await f.restart();
  expect(await f.delegate(args)).toMatchObject({ exit: 0 });
  expect((await f.call({ ...followup, from: from.slice().reverse() })).rejected).toBe(true);
  expect(f.reservations()).toBe(3);
  expect(f.boundaryCalls()).toBe(3);
});

it('retains the continuation identity when current runtime observation is unavailable', async () => {
  const f = await fixture();
  await f.call({ requestKey: 'history', recipe: 'inspect', brief: 'Read the pinned source' });
  const { child } = (await f.family()).json().children[0];
  expect(child).toMatch(/^managed-/);
  // A synthetic retained history without a matching runtime observation.
  f.p.db
    .prepare('UPDATE orchestration_continuations SET attempt_id=? WHERE pod_id=?')
    .run('fixture-unavailable-observation', child);
  expect((await f.family()).json().children[0]).toMatchObject({ child, status: 'unknown' });
});

it('rejects humans, unrelated pods, stale attempts, absent policy, unknown recipes and over-budget requests without allocations', async () => {
  const f = await fixture(3, 2, 3);
  const request = { requestKey: 'one', recipe: 'inspect', brief: 'Bounded report' };
  expect((await f.operatorStart()).statusCode).toBe(409);
  for (const credential of [
    'operator',
    f.issuer.generate('unrelated'),
    f.issuer.generate(f.parentId),
  ])
    expect((await f.call(request, credential)).rejected).toBe(true);
  expect((await f.call({ ...request, parentId: 'forged' })).rejected).toBe(true);
  expect((await f.call({ ...request, recipe: 'unlisted' })).rejected).toBe(true);
  expect((await f.call({ ...request, brief: 'x'.repeat(2049) })).rejected).toBe(true);
  expect((await f.family('other')).statusCode).toBe(401);
  expect((await f.family('operator', 'unrelated')).statusCode).toBe(404);
  expect(f.remaining()).toBe(3);
  expect(f.reservations()).toBe(0);
  expect(f.source.f.launches()).toBe(0);
  f.setPolicy(false);
  expect((await f.call(request)).rejected).toBe(true);
  expect(f.reservations()).toBe(0);
  f.setPolicy(true);
  const newToken = await f.owner().provision(f.parentId);
  expect((await f.call(request)).rejected).toBe(true); // superseded attempt
  expect((await f.call(request, newToken)).rejected).toBe(false);
  expect(f.remaining()).toBe(1);
  expect((await f.call({ ...request, requestKey: 'over' }, newToken)).rejected).toBe(true);
  expect((await f.call({ ...request, brief: 'changed' }, newToken)).rejected).toBe(true);
  expect(f.remaining()).toBe(1);
  expect(f.reservations()).toBe(1);
  expect(f.source.f.launches()).toBe(1);
});

it('rejects a second reservation at parent capacity without spending or allocating', async () => {
  const f = await fixture(8, 1, 4);
  const request = { requestKey: 'one', recipe: 'inspect', brief: 'Bounded report' };
  expect((await f.call(request)).rejected).toBe(false);
  expect((await f.call({ ...request, requestKey: 'two' })).rejected).toBe(true);
  expect(f.remaining()).toBe(6);
  expect(f.reservations()).toBe(1);
  expect(f.source.f.launches()).toBe(1);
});

it('retains an uncertain allocation across restart without another external attempt, refund or slot reuse', async () => {
  const f = await fixture(8, 1, 4, false, true);
  const request = { requestKey: 'uncertain', recipe: 'inspect', brief: 'Bounded report' };
  expect((await f.call(request)).rejected).toBe(false);
  const before = (await f.family()).json();
  expect(before.children[0]).toMatchObject({ requestKey: 'uncertain', status: 'unknown' });
  expect(before.children[0].child).toMatch(/^managed-/);
  expect(f.stages).toEqual(['reserved']);
  await f.restart();
  expect((await f.call(request)).rejected).toBe(false);
  expect((await f.call({ ...request, requestKey: 'another' })).rejected).toBe(true);
  expect((await f.family()).json()).toEqual(before);
  expect(f.remaining()).toBe(6);
  expect(f.reservations()).toBe(1);
  expect(f.boundaryCalls()).toBe(1);
});

it('enforces the frozen lifetime worker count even when active capacity and request budget remain', async () => {
  const f = await fixture(8, 2, 1);
  const request = { requestKey: 'one', recipe: 'inspect', brief: 'Bounded report' };
  const replies = await Promise.all([f.call(request), f.call(request)]);
  expect(replies.every((r) => !r.rejected)).toBe(true);
  expect((await f.call({ ...request, requestKey: 'two' })).rejected).toBe(true);
  expect(f.remaining()).toBe(6);
  expect(f.reservations()).toBe(1);
  expect(f.boundaryCalls()).toBe(1);
});
