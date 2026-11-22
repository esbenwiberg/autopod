import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
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
import { ManagedArtifactPipeline } from '../managed/artifact-pipeline.js';
import { MemoryArtifactStore } from '../managed/artifact-store.js';
import { canonical, digest, sha256 } from '../managed/canonical.js';
import { ManagedControls } from '../managed/managed-controls.js';
import { ManagedPodService } from '../managed/managed-service.js';
import {
  PRIVATE_COMMIT_EFFECTS,
  PRIVATE_PARENT_VERIFIER,
} from '../managed/private-commit-policy.js';
import { managedGit, managedGitBytes } from '../managed/source-git.js';
import {
  PARENT_DELEGATE_BIN,
  PARENT_DELEGATE_DESCRIPTOR,
} from '../pods/parent-delegate-materials.js';
import { createSessionBridge } from '../pods/pod-bridge-impl.js';
import type { PodManagerDependencies } from '../pods/pod-manager.js';
import { createPodRepository } from '../pods/pod-repository.js';
import { runDelegate } from '../pods/runtime/ap-delegate.mjs';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { fixtureSigner } from '../test-utils/gate-signer.js';
import { resign } from '../test-utils/managed-fixture.js';
import { setupOrchestrationRun } from '../test-utils/orchestration-run-fixture.js';
import { createProvisioningFixture } from '../test-utils/provisioning-helpers.js';
import { combinedPolicyDigest } from './combined-attestation.js';
import { LocalCheckpointHost, withVerifiedCheckpointMirror } from './local-checkpoints.js';
import { type OperatorRunsConfig, operatorRunId, registerOperatorRuns } from './operator-runs.js';
import { initializeParentCandidateKeys, openParentCandidateKeys } from './parent-candidate-keys.js';
import { createParentEvaluatorClient } from './parent-evaluator-client.js';
import { parentExactTreeEvaluator } from './parent-exact-tree-evaluator.js';
import { composeParentHostGates } from './parent-host-gates.js';
import { ParentManagedLaunch } from './parent-managed-launch.js';
import { parentPrivateCompletion } from './parent-private-completion.js';
import { parentQualificationJob } from './parent-qualification-job.js';
import { ParentReportResults } from './parent-report-results.js';

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
  coding: boolean | 'sandbox' = false,
  qualify: boolean | 'isolated-review' = false,
  changeSubmission = false,
) {
  // Real provisioning, SQLite and custody; model/container and external HTTP are fixture ports.
  const p = createProvisioningFixture(true, false);
  onTestFinished(() => p.close());
  const checks = fixtureSigner('checks', 'fixture-checks', digest('fixture-checks'));
  const review = fixtureSigner('independentReview', 'fixture-review', digest('fixture-review'));
  const localKeys =
    qualify === 'isolated-review'
      ? await (async () => {
          const directory = path.join(await realpath(p.directory), 'receipt-custody');
          await mkdir(directory, { mode: 0o700 });
          await initializeParentCandidateKeys(directory);
          return openParentCandidateKeys(
            directory,
            checks.authority.configurationDigest,
            review.authority.configurationDigest,
          );
        })()
      : undefined;
  const policy = {
    basePolicyDigest: digest('fixture-policy'),
    ...(localKeys?.pins ?? { checks: checks.authority, independentReview: review.authority }),
  };
  const evaluation = {
    checks: 'https://checks.fixture.example/verify',
    independentReview: 'https://review.fixture.example/verify',
  };
  const source = await setupOrchestrationRun(
    requests,
    active,
    operatorRunId(operator, 'parent-fixture'),
    qualify ? combinedPolicyDigest(policy) : undefined,
  );
  const recipe = structuredClone(source.request);
  const paths = ['proof.txt'];
  const sandbox =
    coding === 'sandbox'
      ? {
          resourceScopeDigest: digest('fixture Azure scope'),
          readyDiskImageId: 'fixture-disk',
          secondPaths: ['other.txt'],
        }
      : undefined;
  let writerExited = false;
  let exposeFixtureExits = false;
  const commitFixture = async (id: string, file: string, content: string) => {
    const cwd = path.join(source.root, id);
    const seedBundle = path.join(source.root, id + '-base.bundle');
    await writeFile(seedBundle, source.bytes);
    await managedGit(source.root, ['init', '-b', 'main', cwd]);
    await managedGit(cwd, ['bundle', 'unbundle', seedBundle]);
    await managedGit(cwd, ['checkout', '--detach', source.cp.commit]);
    await writeFile(path.join(cwd, file), content);
    await managedGit(cwd, ['add', '--', file]);
    await managedGit(cwd, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'Fixture change',
    ]);
    const commit = await managedGit(cwd, ['rev-parse', 'HEAD']);
    const tree = await managedGit(cwd, ['rev-parse', 'HEAD^{tree}']);
    const bundle = path.join(source.root, id + '-output.bundle');
    await managedGit(cwd, ['-c', 'pack.window=0', 'bundle', 'create', bundle, 'HEAD']);
    await writeFile(path.join(cwd, file), 'dirty fixture edit\n');
    return { commit, tree, bundle: await readFile(bundle) };
  };
  const exited = new Map<string, Awaited<ReturnType<typeof commitFixture>>>();
  const exportPrivateHead = vi.fn(async (ref: string) => {
    if (!qualify) return commitFixture('coding-output', 'proof.txt', 'coding child output\n');
    const candidate = exited.get(ref);
    if (!candidate) throw new Error('fixture exit required');
    return candidate;
  });
  const readPrivateSubmission = vi.fn(
    async (_ref: string, podId: string, _spec: string, assertCurrent: () => void) => {
      assertCurrent();
      const assigned = p.db
        .prepare(`
      SELECT q.private_scope_json FROM parent_managed_requests q
      JOIN orchestration_continuations c ON c.run_id=q.run_id AND c.start_key=q.start_key
      WHERE c.pod_id=?`)
        .pluck()
        .get(podId);
      const [{ path: filename }] = JSON.parse(String(assigned));
      return Buffer.from(
        JSON.stringify({
          version: 1,
          files: [
            { path: filename, content: filename === 'proof.txt' ? '24\n' : '24 is twice 12\n' },
          ],
        }),
      );
    },
  );
  const evaluatorFetch = vi.fn<typeof fetch>(async (url, init) => {
    const role = url === evaluation.checks ? 'checks' : 'independentReview';
    expect(url).toBe(evaluation[role]);
    const { request, bundle } = JSON.parse(String(init?.body));
    const signer = role === 'checks' ? checks : review;
    const receipt = await parentExactTreeEvaluator(source.root, policy, role, {
      async evaluate({ mirror, commit, tree, predecessor }) {
        expect(predecessor).toBe(source.cp.commit);
        const files = await managedGit(mirror, [
          'diff-tree',
          '-r',
          '--name-status',
          predecessor,
          commit,
        ]);
        const passed =
          role === 'checks'
            ? (await managedGitBytes(mirror, ['show', commit + ':proof.txt'])).equals(
                Buffer.from('24\n'),
              ) &&
              (await managedGitBytes(mirror, ['show', commit + ':other.txt'])).equals(
                Buffer.from('24 is twice 12\n'),
              )
            : files === 'A\tother.txt\nM\tproof.txt';
        return {
          status: passed ? 'passed' : 'failed',
          evidence: Buffer.from(JSON.stringify({ role, commit, tree, files, passed })),
        };
      },
      async sign(statement) {
        return signer.attest(statement);
      },
    })(request, Buffer.from(bundle, 'base64'));
    return Response.json(receipt);
  });
  const gates = createParentEvaluatorClient(evaluation, policy, evaluatorFetch);
  const admission = source.f.admission;
  if (coding) {
    recipe.task.kind = 'implementation';
    const profile = recipe.profileSnapshot;
    if (sandbox) {
      admission.targets = ['sandbox'];
      recipe.route.executionTarget =
        profile.route.executionTarget =
        recipe.effectiveGrant.route.executionTarget =
          'sandbox';
    }
    profile.scope = {
      ...profile.scope,
      allowedEffects: [...PRIVATE_COMMIT_EFFECTS],
      identityBindings: [],
      network: { ...profile.scope.network, destinations: [] },
      repositories: [
        {
          enrollmentId: source.cp.repository,
          access: 'write',
          baseRevision: source.cp.commit,
          remote: 'private',
          branchNamespace: 'autopod/',
        },
      ],
    };
    const { snapshotDigest: _, ...fields } = profile;
    profile.snapshotDigest = digest(fields);
    recipe.effectiveGrant.profileSnapshotDigest = profile.snapshotDigest;
    recipe.effectiveGrant.scope = structuredClone(profile.scope);
    recipe.outputs.source = {
      mode: 'commit',
      repository: source.cp.repository,
      remote: 'private',
      base: 'main',
      head: 'autopod/fixture-private',
    };
    recipe.outputs.artifacts.mode = 'required';
    recipe.outputs.artifacts.include = recipe.outputs.artifacts.requiredPaths = [
      changeSubmission ? 'change-submission.json' : 'report.md',
    ];
    if (changeSubmission)
      recipe.outputs.artifacts.limits = { maxFiles: 1, maxFileBytes: 16384, maxTotalBytes: 16384 };
    recipe.validation.verifierPolicy = PRIVATE_PARENT_VERIFIER;
    resign(recipe);
    admission.profiles = new Map([[profile.snapshotDigest, profile]]);
    admission.enrollmentCeiling =
      admission.identityCeiling =
      admission.backendCeiling =
        profile.scope;
  }
  const original = { id: 'prepare' };
  if (qualify === 'isolated-review') {
    p.accounts.create({
      id: 'review-fixture',
      name: 'Fixture reviewer',
      provider: 'anthropic',
      credentials: { provider: 'anthropic', apiKey: 'synthetic-fixture-review-key' },
    });
  }
  const { store, services } = createTestConfiguration(p.db);
  services.resolveAgentRoute = async (route) => resolveLaunchAgentRoute(route, p.accounts);
  const snapshots = createLaunchSnapshotRepository(p.db, store);
  const requestId = randomUUID();
  // Resolve first, so operator enrollment selects the exact launch preview before admission.
  const { resolveLaunch } = await import('../configuration/launch-resolver.js');
  const launchRequest = {
    repositoryId: 'repo-a',
    task: qualify
      ? 'Set the synthetic count to 24 and document why'
      : 'Commission a confined report worker',
    requestId,
    overrides: {
      execution: { networkPolicy: { enabled: true, mode: 'restricted', allowedHosts: [] } },
      ...(qualify === 'isolated-review'
        ? {
            ai: {
              reviewer: {
                mode: 'independent' as const,
                route: {
                  providerAccountId: 'review-fixture',
                  runtime: 'claude' as const,
                  model: 'claude-sonnet-4-6',
                },
              },
            },
          }
        : {}),
    },
  };
  const preview = await resolveLaunch(launchRequest, services, 'operator');
  let boundaryCalls = 0;
  const stages: string[] = [];
  const artifactStore = new MemoryArtifactStore();
  const stagingRoot = path.join(await realpath(p.directory), 'artifacts');
  const serviceForDb = () => {
    const service = new ManagedPodService(
      p.db,
      source.f.admission,
      {
        ...source.f.runtime,
        observe: async (ref) =>
          writerExited || (exposeFixtureExits && (changeSubmission || exited.has(ref)))
            ? { state: 'stopped', consumedTokens: 0, exitCode: 0 }
            : source.f.runtime.observe(ref),
        extractOutput: async (_ref, staging) => {
          await mkdir(staging, { recursive: true });
          await writeFile(path.join(staging, 'report.md'), 'Fixture implementation notes');
        },
        ensure: async (...args) => {
          boundaryCalls++;
          if (loseAllocation) throw new Error('synthetic-external-allocation-reply-lost');
          const result = await source.f.runtime.ensure(...args);
          if (qualify && !changeSubmission) {
            const scope = p.db
              .prepare(
                'SELECT private_scope_json FROM parent_managed_requests WHERE run_id=? AND start_key=?',
              )
              .pluck()
              .get(source.cp.run, args[1].startKey);
            const left = canonical([{ kind: 'file', path: 'proof.txt' }]);
            const right = canonical([{ kind: 'file', path: 'other.txt' }]);
            expect([left, right]).toContain(scope);
            const first = scope === left;
            exited.set(
              result.runtimeRef,
              await commitFixture(
                args[0],
                first ? 'proof.txt' : 'other.txt',
                first ? '24\n' : '24 is twice 12\n',
              ),
            );
          }
          return result;
        },
      },
      () => 100,
      true,
    );
    service.onTransition = () => {
      const view = owner.family(original.id);
      stages.push((view.children[0] as { status: string }).status);
    };
    if (coding) {
      service.privateCommit = parentPrivateCompletion(
        service,
        { exportPrivateHead, readPrivateSubmission },
        p.directory,
        source.cp,
        paths,
        job?.reserve,
        sandbox?.secondPaths,
      );
      new ManagedArtifactPipeline(
        service,
        new ArtifactExports(p.db, artifactStore),
        stagingRoot,
        new ManagedControls(service),
      );
    }
    return service;
  };
  const host = () => new LocalCheckpointHost(p.db, path.join(p.directory, 'scratch'), serviceForDb);
  const runReview = vi.fn(async (input: { prompt: string }) => {
    expect(p.pod().status).toBe('failed');
    const packet = JSON.parse(input.prompt.split('\n').at(-1)!);
    expect(packet).toMatchObject({
      base: source.cp.commit,
      task: launchRequest.task,
      paths: ['other.txt', 'proof.txt'],
    });
    expect(packet.diff).toContain('+24 is twice 12');
    expect(packet.diff).toContain('+24\n');
    expect(packet.diff).not.toContain('dirty fixture edit');
    return { stdout: JSON.stringify({ verdict: 'pass', reason: 'Fixture packet accepted' }) };
  });
  const runChecks = vi.fn(
    async ({ mirror, commit, tree }: { mirror: string; commit: string; tree: string }) => {
      // Execute Git checks on the verified mirror; no worker checkout or provider.
      const count = await managedGitBytes(mirror, ['show', commit + ':proof.txt']);
      const reason = await managedGitBytes(mirror, ['show', commit + ':other.txt']);
      const passed =
        count.equals(Buffer.from('24\n')) && reason.equals(Buffer.from('24 is twice 12\n'));
      return {
        status: passed ? ('passed' as const) : ('failed' as const),
        evidence: Buffer.from(canonical({ commit, tree, passed })),
      };
    },
  );
  let job = makeJob();
  function makeJob() {
    const boundGates =
      qualify === 'isolated-review'
        ? composeParentHostGates(
            {
              db: p.db,
              scratch: source.root,
              policy,
              run: source.cp.run,
              excludedReviewerAccounts: [recipe.route.providerAccountId],
            },
            {
              checks: { evaluate: runChecks, sign: localKeys!.bind(policy, 'checks') },
              review: {
                readPod: (id) => createPodRepository(p.db).getOrThrow(id),
                readLaunch: (id) =>
                  createLaunchSnapshotRepository(p.db, createConfigurationStore(p.db)).get(id),
                reviewer: {
                  parentQualification: (_pod, _config, _inputDigest, guard) => async (input) => {
                    guard();
                    return runReview(input);
                  },
                },
                sign: localKeys!.bind(policy, 'independentReview'),
              },
            },
          )
        : gates;
    return qualify
      ? parentQualificationJob(
          p.db,
          host(),
          p.directory,
          source.cp.run,
          paths,
          boundGates,
          sandbox?.secondPaths,
        )
      : undefined;
  }
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
    qualification: job,
    slots: [
      {
        slot: 'parent-fixture',
        operator,
        checkpoint: source.cp,
        catalog: coding ? { implement: recipe } : { inspect: source.request },
        parent: {
          requestId,
          launchDigest: preview.digest,
          ...(coding
            ? {
                coding: {
                  recipe: 'implement',
                  paths,
                  ...(sandbox
                    ? {
                        ...(qualify === 'isolated-review'
                          ? { sandbox: { ...sandbox, hostQualification: true as const } }
                          : { sandbox, evaluation }),
                      }
                    : {}),
                },
              }
            : {}),
        },
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
  expect(owner.inspectLaunchOwner(requestId, principal)).toEqual({
    uniqueSlot: true,
    objectMatches: true,
    issuerMatches: true,
    audienceMatches: true,
  });
  expect(owner.inspectLaunchOwner(requestId, { ...principal, oid: 'other' })).toEqual({
    uniqueSlot: true,
    objectMatches: false,
    issuerMatches: true,
    audienceMatches: true,
  });
  expect(owner.inspectLaunchOwner(undefined, principal)).toEqual({
    uniqueSlot: false,
    objectMatches: false,
    issuerMatches: false,
    audienceMatches: false,
  });
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
    const watchdog = qualify ? serviceForDb() : undefined;
    scheduler = registerOperatorRuns(
      app,
      {
        ...config(),
        lifetimeOwner: { owns: () => true },
        ...(watchdog
          ? {
              watchdog: {
                service: watchdog,
                finishOutputs: () => watchdog.artifactPipeline?.tick() ?? Promise.resolve(),
              },
            }
          : {}),
      },
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
    job = makeJob();
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
        coding ? 'implement' : 'inspect',
        '--brief',
        coding ? 'Update the enrolled file' : 'Read the pinned source',
      ]);
      expect(commissioned).toMatchObject({
        exit: 0,
        stdout: { ok: true, result: { requestKey: 'model-turn-one' } },
        stderr: [],
      });
      if (qualify) {
        expect(
          await delegate([
            'start',
            '--key',
            'model-turn-two',
            '--recipe',
            'implement',
            '--brief',
            'Document the expected count',
          ]),
        ).toMatchObject({ exit: 0 });
      }
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        fatal: true,
        message: 'Synthetic parent exits after commissioning',
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
    recipe,
    exportPrivateHead,
    readPrivateSubmission,
    serviceForDb,
    exitWriter: () => {
      writerExited = true;
    },
    exposeFixtureExits: () => {
      exposeFixtureExits = true;
    },
    call,
    delegate,
    family,
    evaluatorFetch,
    runChecks,
    runReview,
    review: (suffix: string, credential = 'operator', approval?: object) =>
      app.inject({
        method: approval ? 'POST' : 'GET',
        url: '/orchestration/parents/' + original.id + '/review/' + suffix,
        headers: { authorization: 'Bearer ' + credential },
        payload: approval,
      }),
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
])('qualifies the exact tree and releases only after approval (explicit submission: %s)', async (explicit) => {
  const f = await fixture(4, 2, 2, true, false, false, 'sandbox', true, explicit);
  const during = (await f.family()).json();
  expect(during.children).toMatchObject([
    { requestKey: 'model-turn-one', status: 'started' },
    { requestKey: 'model-turn-two', status: 'started' },
  ]);
  expect(f.p.pod().status).toBe('failed'); // The fixture parent exits before child custody.
  expect(f.evaluatorFetch).not.toHaveBeenCalled();
  f.exposeFixtureExits();
  await vi.waitFor(
    async () => {
      expect((await f.review('status')).json().status).toBe('ready');
    },
    { timeout: 8000, interval: 100 },
  );

  const ready = (await f.family()).json();
  expect(ready.children).toEqual(
    during.children.map((child: object) => ({
      ...child,
      status: 'exited',
      exitCode: 0,
      collectionStatus: 'collected',
    })),
  );
  expect(ready.review).toMatchObject({ status: 'ready' });
  expect(f.readPrivateSubmission).toHaveBeenCalledTimes(explicit ? 2 : 0);
  expect(f.exportPrivateHead).toHaveBeenCalledTimes(explicit ? 0 : 2);
  const { evidenceDigest, commit } = ready.review;
  const selector = encodeURIComponent(evidenceDigest);
  expect((await f.review(selector + '/bundle')).statusCode).toBe(409);
  expect((await f.review(selector + '/preview', 'other')).statusCode).toBe(404);
  expect(f.evaluatorFetch.mock.calls.map(([url]) => url)).toEqual([
    'https://checks.fixture.example/verify',
    'https://review.fixture.example/verify',
  ]);
  expect(f.evaluatorFetch).toHaveBeenCalledTimes(2);
  const evaluations = f.evaluatorFetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(evaluations[1]).toEqual(evaluations[0]);

  await f.restart();
  expect((await f.family()).json()).toEqual(ready);
  expect((await f.review(selector + '/bundle')).statusCode).toBe(409);
  const preview = await f.review(selector + '/preview');
  expect(preview.statusCode).toBe(200);
  const { tree, bundleDigest, reviewDigest, paths } = preview.json();
  expect(paths).toEqual(['other.txt', 'proof.txt']);
  const approval = { evidenceDigest, expectedReviewDigest: reviewDigest };
  expect((await f.review(selector + '/approve', 'other', approval)).statusCode).toBe(404);
  expect((await f.review(selector + '/approve', 'operator', approval)).statusCode).toBe(200);
  const download = await f.review(selector + '/bundle');
  expect(download.statusCode).toBe(200);
  expect(sha256(download.rawPayload)).toBe(bundleDigest);
  expect(download.rawPayload.equals(Buffer.from(evaluations[0].bundle, 'base64'))).toBe(true);
  await withVerifiedCheckpointMirror(
    f.source.root,
    { commit, tree, predecessor: f.source.cp.commit },
    download.rawPayload,
    async (mirror) => {
      expect(await managedGit(mirror, ['show', commit + ':proof.txt'])).toBe('24');
      expect(await managedGit(mirror, ['show', commit + ':other.txt'])).toBe('24 is twice 12');
    },
  );
  expect(f.evaluatorFetch).toHaveBeenCalledTimes(2);
  expect(f.boundaryCalls()).toBe(2);
  expect(f.p.db.prepare('SELECT count(*) FROM managed_source_operations').pluck().get()).toBe(0);
  expect(f.p.db.prepare('SELECT accepted_commit FROM orchestration_runs').pluck().get()).toBe(
    f.source.cp.commit,
  );
}, 15_000);

it('uses the durable qualification claim for exact-tree packet review after the parent exits', async () => {
  const f = await fixture(4, 2, 2, true, false, false, 'sandbox', 'isolated-review');
  expect(f.p.pod().status).toBe('failed'); // The scripted runtime has exited.
  expect(f.runReview).not.toHaveBeenCalled();
  f.exposeFixtureExits();
  await vi.waitFor(
    async () => {
      expect((await f.review('status')).json().status).toBe('ready');
    },
    { timeout: 8000, interval: 100 },
  );
  expect(f.evaluatorFetch).not.toHaveBeenCalled();
  expect(f.runChecks).toHaveBeenCalledOnce();
  expect(f.runReview).toHaveBeenCalledOnce();
  expect(f.runChecks.mock.invocationCallOrder[0]).toBeLessThan(
    f.runReview.mock.invocationCallOrder[0]!,
  );
  const ready = (await f.family()).json().review;
  const received = JSON.parse(f.runReview.mock.calls[0]![0].prompt.split('\n').at(-1)!);
  expect(ready.commit).toBe(received.commit);
  expect(f.runChecks.mock.calls[0]?.[0]).toMatchObject({
    commit: received.commit,
    tree: received.tree,
  });
  await f.restart();
  expect((await f.family()).json().review).toEqual(ready);
  expect(f.runReview).toHaveBeenCalledOnce();
}, 15_000);

it('uses the parent reservation, then collects a private candidate only after exit', async () => {
  const f = await fixture(2, 1, 1, true, false, false, true);
  expect(f.boundaryCalls()).toBe(1);
  expect(f.remaining()).toBe(0);
  expect(
    f.p.db.prepare('SELECT private_scope_json FROM parent_managed_requests').pluck().get(),
  ).toBe(canonical([{ kind: 'file', path: 'proof.txt' }]));
  const family = await f.family();
  expect(family.headers['cache-control']).toBe('no-store');
  expect(family.json().review).toEqual({ status: 'not-configured' });
  expect((await f.family('other')).statusCode).not.toBe(200);
  expect((await f.family(f.token)).statusCode).not.toBe(200);
  expect(f.owner().family(f.parentId)).not.toHaveProperty('review'); // worker projection
  const service = f.serviceForDb();
  await service.artifactPipeline?.tick();
  expect(f.exportPrivateHead).not.toHaveBeenCalled();
  f.exitWriter();
  await service.enforceExpiry();
  expect(f.p.db.prepare('SELECT state, exit_code FROM managed_pods').get()).toEqual({
    state: 'validating',
    exit_code: 0,
  });
  await service.artifactPipeline?.tick();
  expect(
    f.p.db.prepare('SELECT limitations_json FROM managed_results').pluck().all(),
  ).not.toContainEqual(expect.stringMatching(/incomplete/));
  expect(f.exportPrivateHead).toHaveBeenCalledTimes(1);
  expect(f.p.db.prepare('SELECT count(*) FROM parent_private_candidates').pluck().get()).toBe(1);
  expect(f.p.db.prepare('SELECT count(*) FROM managed_source_candidates').pluck().get()).toBe(0);
  await f.restart();
  await f.serviceForDb().artifactPipeline?.tick();
  expect(f.exportPrivateHead).toHaveBeenCalledTimes(1);
  expect((await f.family()).json().children[0]).toMatchObject({
    status: 'exited',
    exitCode: 0,
    collectionStatus: 'collected',
  });
  expect(f.owner().family(f.parentId).children[0]).not.toHaveProperty('collectionStatus');
  expect(f.p.db.prepare('SELECT state FROM managed_pods').pluck().get()).toBe('complete');
  const results = new ParentReportResults(f.p.db);
  const authenticate = () => f.source.cp.run;
  const page = await results.results({}, authenticate);
  expect(page.results).toMatchObject([{ report: { status: 'private-candidate-retained' } }]);
  await expect(results.dependencies([page.nextCursor], authenticate)).rejects.toThrow(
    'parent-report-dependency-refused',
  );
});

it('cleans a closed explicit-submission worker only after validating retained private custody', async () => {
  const f = await fixture(4, 2, 2, false, false, false, 'sandbox', false, true);
  expect(
    await f.call({ requestKey: 'retained', recipe: 'implement', brief: 'Implement' }),
  ).toMatchObject({ rejected: false });
  f.exitWriter();
  const service = f.serviceForDb();
  await service.enforceExpiry();
  await service.artifactPipeline?.tick();
  const podId = (await f.family()).json().children[0].child;
  const installation = `native.${f.source.cp.run}`;
  const pod = service.row(installation, podId);
  expect(pod.state).toBe('complete');
  expect(f.p.db.prepare('SELECT count(*) FROM artifact_exports').pluck().get()).toBe(0);
  const resource = vi.fn(async () => true);
  service.runtime.cleanup = resource;
  const controls = new ManagedControls(service);
  const cleanup = () =>
    controls.control(
      installation,
      podId,
      {
        schemaVersion: 1,
        dispatcherAttemptId: pod.dispatcher_attempt_id,
        grantId: pod.grant_id,
        grantRevision: pod.grant_revision,
        operation: 'cleanup',
      },
      'operator-cleanup-fixture',
    );
  await expect(cleanup()).rejects.toThrow('parent-private-cleanup-custody-required');
  f.host().ledger.cancel(f.source.cp.run);
  const original = f.p.db
    .prepare('SELECT bundle FROM parent_private_candidates WHERE pod_id=?')
    .pluck()
    .get(podId);
  expect(Buffer.isBuffer(original)).toBe(true);
  const setBundle = f.p.db.prepare('UPDATE parent_private_candidates SET bundle=? WHERE pod_id=?');
  setBundle.run(Buffer.from('corrupt fixture'), podId);
  await expect(cleanup()).rejects.toThrow('parent-candidate-binding');
  expect(resource).not.toHaveBeenCalled();
  setBundle.run(original, podId);
  await expect(cleanup()).resolves.toMatchObject({ cleanup: 'observed' });
  await expect(cleanup()).resolves.toMatchObject({ cleanup: 'observed' });
  expect(resource).toHaveBeenCalledTimes(1);
  expect(
    f.p.db
      .prepare('SELECT bundle FROM parent_private_candidates WHERE pod_id=?')
      .pluck()
      .get(podId),
  ).toEqual(original);
});

it('does not fall back to worker HEAD or retry an invalid explicit submission', async () => {
  const f = await fixture(4, 2, 2, false, false, false, 'sandbox', false, true);
  expect(
    await f.call({ requestKey: 'invalid', recipe: 'implement', brief: 'Implement' }),
  ).toMatchObject({ rejected: false });
  f.readPrivateSubmission.mockResolvedValueOnce(
    Buffer.from(
      JSON.stringify({
        version: 1,
        files: [{ path: 'other.txt', content: 'not assigned' }],
      }),
    ),
  );
  f.exitWriter();
  const service = f.serviceForDb();
  await service.enforceExpiry();
  await service.artifactPipeline?.tick();
  await f.restart();
  await f.serviceForDb().artifactPipeline?.tick();
  expect(f.readPrivateSubmission).toHaveBeenCalledTimes(1);
  expect(f.exportPrivateHead).not.toHaveBeenCalled();
  expect(f.p.db.prepare('SELECT count(*) FROM parent_private_candidates').pluck().get()).toBe(0);
  expect((await f.family()).json().children).toMatchObject([
    { status: 'exited', exitCode: 0, collectionStatus: 'unavailable' },
  ]);
});

it('reserves distinct signed scopes for sandbox coding in order; exact replay does not debit again', async () => {
  const f = await fixture(8, 2, 3, false, false, false, 'sandbox');
  // Fixture execution and provider are offline; real admission and reservation are used.
  const child = (requestKey: string) => ({ requestKey, recipe: 'implement', brief: 'Implement' });
  const first = await f.call(child('left'));
  expect(first).toMatchObject({ rejected: false });
  const afterFirst = f.remaining();
  expect(await f.call(child('left'))).toMatchObject({ rejected: false });
  expect(f.remaining()).toBe(afterFirst);
  expect(await f.call(child('right'))).toMatchObject({ rejected: false });
  const scopes = f.p.db
    .prepare('SELECT request_key, private_scope_json FROM parent_managed_requests ORDER BY rowid')
    .all();
  expect(scopes).toEqual([
    { request_key: 'left', private_scope_json: '[{"kind":"file","path":"proof.txt"}]' },
    { request_key: 'right', private_scope_json: '[{"kind":"file","path":"other.txt"}]' },
  ]);
  expect(f.reservations()).toBe(2);
  const remaining = f.remaining();
  await f.restart();
  expect(await f.call(child('left'))).toMatchObject({ rejected: false });
  expect(await f.call(child('third'))).toMatchObject({ rejected: true });
  expect(f.reservations()).toBe(2);
  expect(f.remaining()).toBe(remaining);
});

it('stops on collection uncertainty across daemon restart without exporting again', async () => {
  const f = await fixture(2, 1, 1, true, false, false, true);
  f.exitWriter();
  await f.serviceForDb().enforceExpiry();
  expect((await f.family()).json().children[0]).toMatchObject({
    status: 'exited',
    exitCode: 0,
    collectionStatus: 'pending',
  });
  // Simulate a crash at the durable pre-export claim, with no committed custody.
  f.p.db
    .prepare('INSERT INTO parent_private_collection_claims SELECT pod_id FROM managed_pods')
    .run();
  await f.restart();
  await f.serviceForDb().artifactPipeline?.tick();
  expect(f.p.db.prepare('SELECT state FROM managed_pods').pluck().get()).toBe('review_required');
  expect(f.exportPrivateHead).not.toHaveBeenCalled();
  expect(f.p.db.prepare('SELECT limitations_json FROM managed_results').pluck().get()).toBe(
    '["private-collection-uncertain"]',
  );
  expect((await f.family()).json()).toMatchObject({
    review: { status: 'not-configured' },
    children: [{ status: 'exited', exitCode: 0, collectionStatus: 'unavailable' }],
  });
  await f.serviceForDb().artifactPipeline?.tick();
  expect(f.exportPrivateHead).not.toHaveBeenCalled();
});

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
  expect(history).not.toHaveProperty('review');
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

it('projects only a settled provider request-budget stop for the matching family', async () => {
  const f = await fixture();
  await f.call({ requestKey: 'limited', recipe: 'inspect', brief: 'Read the pinned source' });
  const first = (await f.family()).json().children[0];
  f.p.db
    .prepare('INSERT INTO managed_results(pod_id,limitations_json) VALUES(?,?)')
    .run(first.child, JSON.stringify(['agent-provider-request-limit-reached', 'private-evidence']));
  expect((await f.family()).json().children[0].exitReason).toBeNull();
  f.p.db
    .prepare('UPDATE managed_pods SET observed_exit=1, exit_code=1 WHERE pod_id=?')
    .run(first.child);
  const family = (await f.family()).json();
  expect(family.children).toMatchObject([
    { status: 'exited', exitReason: 'provider-request-limit' },
  ]);
  expect(JSON.stringify(family)).not.toContain('private-evidence');
  expect((await f.family('other')).statusCode).not.toBe(200);
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
