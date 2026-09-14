import {
  type ConfigurationKind,
  type EffectiveLaunchConfig,
  type OperatorActor,
  type Pod,
  configurationIdSchema,
  configurationKindSchema,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { configurationError } from '../../configuration/configuration-store.js';
import type { ConfigurationCredentialStore } from '../../configuration/credential-store.js';
import {
  type LaunchResolutionServices,
  resolveLaunch,
} from '../../configuration/launch-resolver.js';
import {
  proposeLaunchProfile,
  saveLaunchProfile,
} from '../../configuration/save-launch-profile.js';
import type { ConfigurationSecurityPolicyStore } from '../../configuration/security-policy.js';

export interface ConfigurationRouteDependencies {
  deployments?: import('../../actions/deployment-service.js').DeploymentService;
  series?: import('../../configuration/series-launches.js').SeriesLaunches;
  watchers?: import('../../issue-watcher/watcher-binding-repository.js').WatcherBindingRepository;
  resolution: LaunchResolutionServices;
  db: Database.Database;
  credentials?: ConfigurationCredentialStore;
  githubDiscovery?: import('../../github/discovery.js').GitHubDiscovery;
  securityPolicy?: ConfigurationSecurityPolicyStore;
  /** Reports actually enabled features. Supplying configuration routes never enables creation. */
  capabilities: () => unknown;
  goals?: {
    get(podId: string): import('@autopod/shared').PodGoal | null;
    control(
      podId: string,
      intent: 'pause' | 'cancel',
      revision: number,
    ): Promise<import('@autopod/shared').PodGoal>;
    resume(podId: string, revision: number): Promise<void>;
  };
  /** Supplied only after conversion and the execution dependencies are ready. */
  admit?: (
    request: unknown,
    identity: { userId: string; email?: string; name?: string; actor: OperatorActor },
  ) => Promise<Pod>;
}
const writeSchema = z
  .object({
    id: configurationIdSchema.optional(),
    name: z.string().trim().min(1).max(128),
    payload: z.unknown(),
    expectedRevision: z.number().int().positive().optional(),
  })
  .strict();
const presetKind = configurationKindSchema.exclude(['repository', 'profile']);

/** Operator-only configuration API. Registered only for the composable configuration path. */
export function configurationRoutes(
  app: FastifyInstance,
  deps: ConfigurationRouteDependencies,
): void {
  const store = deps.resolution.store;
  app.get('/pods/:podId/configuration', async (request) => {
    const { podId } = request.params as { podId: string };
    const config = deps.resolution.readLaunch?.(podId);
    if (!config)
      configurationError('Pod launch configuration is unavailable', 'CONFIG_SOURCE_MISSING', 404);
    return config;
  });
  app.get('/configuration/capabilities', async () => deps.capabilities());
  if (deps.deployments) {
    const deployments = deps.deployments;
    app.get('/deployments', async (request) => deployments.list(request.user.oid));
    app.post('/deployments/:runId/reconcile', async (request) => {
      const body = z
        .object({
          digest: z.string().regex(/^[a-f0-9]{64}$/),
          externalOutcome: z.enum(['deployed', 'not-deployed']),
          note: z.string().trim().min(1).max(2000),
        })
        .strict()
        .parse(request.body);
      const { runId } = z.object({ runId: z.string().uuid() }).parse(request.params);
      return deployments.reconcile(
        runId,
        body.digest,
        request.user.oid,
        body.externalOutcome,
        body.note,
      );
    });
    const runId = (params: unknown) => z.object({ runId: z.string().uuid() }).parse(params).runId;
    // These routes use regular user authentication; no pod-token or AI approval path.
    app.post('/pods/:podId/deployments', async (request) => {
      const { podId } = z.object({ podId: configurationIdSchema }).parse(request.params);
      const run = await deployments.prepare(podId, request.body, request.user.oid);
      return deployments.get(run.id, request.user.oid);
    });
    app.get('/deployments/:runId', async (request) =>
      deployments.get(runId(request.params), request.user.oid),
    );
    app.get('/deployments/:runId/review', async (request) =>
      deployments.review(runId(request.params), request.user.oid),
    );
    app.post('/deployments/:runId/decision', async (request) => {
      const body = z
        .object({
          digest: z.string().regex(/^[a-f0-9]{64}$/),
          decision: z.enum(['approve', 'deny']),
        })
        .strict()
        .parse(request.body);
      return deployments.decide(
        runId(request.params),
        body.digest,
        request.user.oid,
        body.decision,
      );
    });
  }
  if (deps.watchers) {
    const watchers = deps.watchers;
    app.get('/configuration/watchers', async () => watchers.list());
    app.post('/configuration/watchers', async (request) =>
      watchers.write(request.body, request.user.oid),
    );
  }
  if (deps.goals) {
    const goals = deps.goals;
    app.get('/pods/:podId/goal', async (request) => {
      const { podId } = z.object({ podId: configurationIdSchema }).parse(request.params);
      const goal = goals.get(podId);
      if (!goal) configurationError('Pod Goal is unavailable', 'GOAL_NOT_FOUND', 404);
      return goal;
    });
    app.post('/pods/:podId/goal/control', async (request) => {
      const { podId } = z.object({ podId: configurationIdSchema }).parse(request.params);
      const body = z
        .object({
          revision: z.number().int().positive(),
          intent: z.enum(['pause', 'resume', 'cancel']),
        })
        .strict()
        .parse(request.body);
      if (body.intent === 'resume') {
        await goals.resume(podId, body.revision);
        return goals.get(podId);
      }
      return goals.control(podId, body.intent, body.revision);
    });
  }
  if (deps.securityPolicy) {
    const policy = deps.securityPolicy;
    app.get('/configuration/security-policy', async () => policy.get());
    app.put('/configuration/security-policy', async (request) => {
      const input = z
        .object({ payload: z.unknown(), expectedRevision: z.number().int().positive() })
        .strict()
        .parse(request.body);
      return policy.write(input.payload, input.expectedRevision, request.user.oid);
    });
  }
  if (deps.githubDiscovery) {
    const github = deps.githubDiscovery;
    app.get('/configuration/github/repositories', async () => github.accessibleRepositories());
    app.get('/configuration/github/repositories/:id/workflows', async (request) => {
      const { id } = z.object({ id: z.string().regex(/^[1-9][0-9]*$/) }).parse(request.params);
      return github.workflowsForRepository(id);
    });
    app.get('/configuration/github/repositories/:id/branches', async (request) => {
      const { id } = z.object({ id: z.string().regex(/^[1-9][0-9]*$/) }).parse(request.params);
      return github.branchesForRepository(id);
    });
  }
  if (deps.credentials) {
    const credentials = deps.credentials;
    app.get('/configuration/credentials', async () => credentials.list());
    app.post('/configuration/credentials', async (request, reply) => {
      const created = await credentials.create(request.body);
      reply.status(201);
      return created;
    });
    app.put('/configuration/credentials/:id', async (request) => {
      const { id } = z.object({ id: configurationIdSchema }).parse(request.params);
      const { value, expectedRevision } = z
        .object({
          value: z.string().min(1).max(100_000),
          expectedRevision: z.number().int().positive(),
        })
        .strict()
        .parse(request.body);
      return credentials.rotate(id, expectedRevision, value);
    });
    app.delete('/configuration/credentials/:id', async (request) => {
      const { id } = z.object({ id: configurationIdSchema }).parse(request.params);
      const { expectedRevision } = z
        .object({ expectedRevision: z.number().int().positive() })
        .strict()
        .parse(request.body);
      return credentials.revoke(id, expectedRevision);
    });
  }
  app.post(
    '/launch/resolve',
    async (request): Promise<EffectiveLaunchConfig> => resolveLaunch(request.body, deps.resolution),
  );
  app.post('/profiles/from-launch', async (request) => {
    const input = z
      .object({
        launch: z.unknown(),
        names: z
          .object({
            profile: z.string().min(1),
            environment: z.string().optional(),
            ai: z.string().optional(),
            workflow: z.string().optional(),
            githubAccess: z.string().optional(),
            toolPacks: z.array(z.string()).optional(),
          })
          .strict(),
        mode: z.enum(['preview', 'save']).default('preview'),
        expectedDigest: z.string().optional(),
      })
      .strict()
      .parse(request.body);
    const config = await resolveLaunch(input.launch, deps.resolution);
    const proposal = proposeLaunchProfile(config, input.names, store);
    if (input.mode === 'preview') return proposal;
    if (!input.expectedDigest)
      configurationError('Review the save proposal before saving', 'CONFIG_DIGEST_REQUIRED', 409);
    return saveLaunchProfile(deps.db, store, proposal, input.expectedDigest);
  });
  for (const [base, fixedKind] of [
    ['/repositories', 'repository'],
    ['/profiles', 'profile'],
    ['/presets/:kind', null],
  ] as const) {
    const kindOf = (params: unknown): ConfigurationKind =>
      fixedKind ?? presetKind.parse((params as { kind: unknown }).kind);
    app.get(base, async (request) => store.list(kindOf(request.params)));
    app.get(`${base}/:id`, async (request) => {
      const { id } = z.object({ id: configurationIdSchema }).passthrough().parse(request.params);
      return store.get(kindOf(request.params), id);
    });
    app.post(base, async (request, reply) => {
      const input = writeSchema.parse(request.body);
      if (input.expectedRevision !== undefined)
        configurationError('Creation cannot specify an existing revision');
      const entity = store.write({
        ...input,
        payload: input.payload,
        kind: kindOf(request.params),
      });
      reply.status(201);
      return entity;
    });
    app.put(`${base}/:id`, async (request) => {
      const input = writeSchema.parse(request.body);
      const { id } = z.object({ id: configurationIdSchema }).passthrough().parse(request.params);
      if (input.expectedRevision === undefined)
        configurationError('expectedRevision is required', 'CONFIG_REVISION_REQUIRED', 409);
      if (input.id && input.id !== id) configurationError('Configuration ID cannot change');
      return store.write({ ...input, payload: input.payload, id, kind: kindOf(request.params) });
    });
    app.delete(`${base}/:id`, async (request, reply) => {
      const { id } = z.object({ id: configurationIdSchema }).passthrough().parse(request.params);
      const { expectedRevision } = z
        .object({ expectedRevision: z.number().int().positive() })
        .strict()
        .parse(request.body);
      store.archive(kindOf(request.params), id, expectedRevision);
      reply.status(204);
    });
  }
}
