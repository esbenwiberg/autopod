import path from 'node:path';
import type { ManagedPodRequest, Scope } from '@autopod/shared';
import { z } from 'zod';
import type { ConfigurationStore } from '../configuration/configuration-store.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import { chatGptCredential } from './acceptance-config.js';
import { type ManagedComponentsConfig, managedComponents } from './bootstrap.js';
import { canonical, digest, sha256 } from './canonical.js';
import { ChatGptReportTransport } from './chatgpt-provider.js';
import { ContainerCodexChannel, codexAgentCommand } from './codex-channel.js';
import type { ManagedGitHubReadConfig } from './github-read-gateway.js';
import { type ManagedAdmission, REQUIRED_ENFORCEMENT } from './grants.js';
import type { ManagedPodRow, ManagedRuntimePort } from './managed-service.js';
import type { ManagedProfileSetConfig, composeManagedProfileSet } from './profile-set-config.js';
import { composeManagedRuntime } from './runtime-composition.js';
import type { ManagedRepositoryMirror } from './workspaces.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/);
const descriptorSchema = z
  .object({
    jobId: id,
    attemptId: id,
    startKey: id,
    kind: z.enum(['research', 'planning', 'verification', 'report', 'custom']),
    objective: z.string().min(1).max(4096),
    profileId: z.string().min(1).max(200).optional(),
    artifactPath: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/),
    repositories: z
      .array(
        z
          .object({
            repositoryId: z.string().min(1).max(4096),
            access: z.literal('read'),
            ref: z.string().min(1).max(200).optional(),
          })
          .strict(),
      )
      .max(17),
    seconds: z.number().int().positive().optional(),
  })
  .strict();
type Descriptor = z.infer<typeof descriptorSchema>;
interface Recipe {
  template: ManagedPodRequest;
  mirrors: ManagedRepositoryMirror[];
  descriptor: Descriptor;
  githubRead?: ManagedGitHubReadConfig;
  catalogBindings: Array<{ id: string; remote: string }>;
}
type Dependencies = Parameters<typeof composeManagedProfileSet>[2] & {
  catalog: ConfigurationStore;
  worktrees: Pick<WorktreeManager, 'create' | 'cleanup'>;
};
type Legacy = ReturnType<typeof composeManagedProfileSet>;

/** The catalog widens repository discovery, never the reviewed artifact runtime's route.
 * Each authenticated preparation freezes exact source commits before any worker start.
 */
export function composeManagedCatalog(
  config: ManagedProfileSetConfig,
  legacy: Legacy,
  dependencies: Dependencies,
) {
  const { db, catalog, worktrees } = dependencies;
  const stages = config.profiles.filter((stage) => stage.sourceMode === 'none');
  if (!stages.length || !dependencies.manager)
    throw new Error('managed-catalog-runtime-unavailable');
  const stateRoot = path.join(path.dirname(path.resolve(dependencies.databasePath)), 'managed');
  const pending = new Map<string, Promise<Recipe>>();
  const compositions = new Map<string, ReturnType<typeof composeManagedRuntime>>();
  const blank: Scope = {
    repositories: [],
    identityBindings: [],
    allowedEffects: [],
    network: { profileId: 'managed-catalog', destinations: [] },
  };

  function recipe(installation: string, key: string): Recipe | undefined {
    const row = db
      .prepare(
        'SELECT recipe_json FROM managed_catalog_preparations WHERE installation_id=? AND preparation_key=?',
      )
      .get(installation, key) as { recipe_json: string } | undefined;
    return row ? (JSON.parse(row.recipe_json) as Recipe) : undefined;
  }
  function forRequest(request: ManagedPodRequest): Recipe | undefined {
    const value = recipe(config.installationId, request.dispatcherJobId);
    return value?.template.profileSnapshot.profileId === request.profileSnapshot.profileId
      ? value
      : undefined;
  }
  function admission(value: Recipe): ManagedAdmission {
    const template = value.template;
    const scope = template.profileSnapshot.scope;
    return {
      profiles: new Map([[template.profileSnapshot.snapshotDigest, template.profileSnapshot]]),
      enrollmentCeiling: scope,
      identityCeiling: scope,
      backendCeiling: scope,
      enforcement: REQUIRED_ENFORCEMENT,
      targets: [template.route.executionTarget],
      requestPolicy(request) {
        for (const binding of value.catalogBindings) {
          const current = catalog.get('repository', binding.id);
          if (current.payload.remote !== binding.remote)
            throw new Error('managed-catalog-repository-identity-changed');
        }
        const grant = request.effectiveGrant;
        if (
          request.dispatcherJobId !== template.dispatcherJobId ||
          request.dispatcherAttemptId !== template.dispatcherAttemptId ||
          request.startKey !== template.startKey ||
          request.task.kind !== template.task.kind ||
          request.task.objective !== template.task.objective ||
          canonical(
            request.task.contextFiles?.slice(0, template.task.contextFiles?.length ?? 0),
          ) !== canonical(template.task.contextFiles) ||
          canonical(request.outputs) !== canonical(template.outputs) ||
          canonical(request.validation) !== canonical(template.validation) ||
          canonical(grant.scope) !== canonical(scope) ||
          request.inputArtifacts.length ||
          grant.budget.maxDurationSeconds !== template.effectiveGrant.budget.maxDurationSeconds
        )
          throw new Error('managed-catalog-request-binding');
      },
    };
  }
  function composition(request: ManagedPodRequest) {
    const value = forRequest(request);
    if (!value) throw new Error('managed-catalog-preparation-missing');
    const key = request.executionSpecDigest;
    const existing = compositions.get(key);
    if (existing) return existing;
    const route = value.template.route;
    const budget = value.template.profileSnapshot.budget;
    if (!('maxProviderRequests' in budget)) throw new Error('managed-catalog-budget-mode');
    const initial = chatGptCredential(dependencies.providerAccounts, route.providerAccountId);
    const command = [
      ...codexAgentCommand(
        route,
        value.mirrors[0]?.enrollmentId ?? null,
        value.descriptor.artifactPath,
        false,
        [],
        value.githubRead?.repository,
      ),
    ];
    command.push('--public-read');
    if (request.task.contextFiles?.length) command.push('--input-root', '/inputs/context');
    const network = dependencies.networkManager;
    const components = composeManagedRuntime({
      db,
      store: legacy.config.store,
      enabled: true,
      stateRoot,
      admission: admission(value),
      mirrors: value.mirrors,
      runtimeCapabilities: [
        'managed-agent-session-v1',
        'managed-context-files-v1',
        'managed-public-read-v1',
        ...(value.githubRead ? ['managed-github-read-v1' as const] : []),
      ],
      bindings: [
        {
          route,
          publicRead: true,
          profileId: request.profileSnapshot.profileId,
          manager: dependencies.manager!,
          image: config.image,
          command,
          maximumRequests: budget.maxProviderRequests,
          transport: new ChatGptReportTransport(
            route,
            initial.chatgptAccountId,
            async () => chatGptCredential(dependencies.providerAccounts, route.providerAccountId),
            fetch,
            undefined,
            'agent',
          ),
          channel: new ContainerCodexChannel(dependencies.manager!, route, 0, {
            mode: 'agent',
            publicRead: true,
            maximumDurationSeconds: budget.maxDurationSeconds,
            ...(value.githubRead ? { githubRead: value.githubRead } : {}),
          }),
          ...(value.githubRead
            ? { githubRead: { config: value.githubRead, auth: dependencies.githubAuth } }
            : {}),
          network: async (bound, podId) => {
            if (route.executionTarget !== 'local') return {};
            if (!network) throw new Error('managed-local-network-required');
            const destinations = bound.effectiveGrant.scope.network.destinations;
            return {
              firewallScript: await network.generateFirewallScript(
                destinations,
                destinations.length ? 'restricted' : 'deny-all',
                undefined,
                [],
                3100,
                false,
              ),
              networkName: await network.ensureNetworkForPod(podId),
            };
          },
          ...(route.executionTarget === 'local' && network
            ? { cleanupNetwork: (podId: string) => network.removeNetworkForPod(podId) }
            : {}),
        },
      ],
    });
    compositions.set(key, components);
    return components;
  }
  function runtimeFor(request: ManagedPodRequest): ManagedRuntimePort {
    return forRequest(request) ? composition(request).runtime : legacy.components.service.runtime;
  }
  function byRef(ref: string): ManagedRuntimePort {
    const row = db.prepare('SELECT request_json FROM managed_pods WHERE runtime_ref=?').get(ref) as
      | { request_json: string }
      | undefined;
    if (!row) throw new Error('managed-catalog-runtime-binding');
    return runtimeFor(JSON.parse(row.request_json) as ManagedPodRequest);
  }
  const runtime: ManagedRuntimePort = {
    preflight: (request) => runtimeFor(request).preflight(request),
    ensure: (podId, request, checkpoint, fault) =>
      runtimeFor(request).ensure(podId, request, checkpoint, fault),
    observe: (ref) => byRef(ref).observe(ref),
    stop: (ref) => byRef(ref).stop(ref),
    send: async (ref, message, key) => {
      const port = byRef(ref);
      if (!port.send) throw new Error('managed-follow-up-unavailable');
      return port.send(ref, message, key);
    },
    cleanup: async (ref) => (await byRef(ref).cleanup?.(ref)) ?? false,
    cleanupUnallocated: async (podId, request) =>
      (await runtimeFor(request).cleanupUnallocated?.(podId, request)) ?? false,
    extractOutput: async (ref, staging, output) => {
      const port = byRef(ref);
      if (!port.extractOutput) throw new Error('managed-output-unavailable');
      return port.extractOutput(ref, staging, output);
    },
    extractSource: async (ref, repositoryId) => {
      const port = byRef(ref);
      if (!port.extractSource) throw new Error('managed-source-unavailable');
      return port.extractSource(ref, repositoryId);
    },
  };
  const componentsConfig: ManagedComponentsConfig = {
    db,
    store: legacy.config.store,
    enabled: true,
    stateRoot,
    runtime,
    runtimeCapabilities: [
      'managed-agent-session-v1',
      'managed-catalog-v1',
      'managed-context-files-v1',
      'managed-github-read-v1',
      'managed-public-read-v1',
    ],
    admission: {
      profiles: new Map(),
      enrollmentCeiling: blank,
      identityCeiling: blank,
      backendCeiling: blank,
      targets: [...legacy.components.service.admission.targets],
      enforcement: REQUIRED_ENFORCEMENT,
      resolveAdmission: (request) => {
        const value = forRequest(request);
        return value ? admission(value) : legacy.components.service.admission;
      },
    },
  };
  const components = managedComponents(componentsConfig);
  // Existing source/validation contracts remain owned by their exact legacy composition.
  components.service.source = legacy.components.service.source;
  components.service.validation = legacy.components.service.validation;

  async function prepare(installation: string, raw: unknown): Promise<Recipe> {
    if (installation !== config.installationId) throw new Error('managed-catalog-installation');
    const descriptor = descriptorSchema.parse(raw);
    const descriptorDigest = digest(descriptor);
    const previous = recipe(installation, descriptor.jobId);
    if (previous) {
      if (digest(previous.descriptor) !== descriptorDigest)
        throw new Error('managed-catalog-preparation-conflict');
      return previous;
    }
    const key = `${installation}:${descriptor.jobId}`;
    const inFlight = pending.get(key);
    if (inFlight) {
      const value = await inFlight;
      if (digest(value.descriptor) !== descriptorDigest)
        throw new Error('managed-catalog-preparation-conflict');
      return value;
    }
    const run = async (): Promise<Recipe> => {
      const stage = descriptor.profileId
        ? stages.find((item) => item.profileSnapshot.profileId === descriptor.profileId)
        : (stages.find((item) => item.taskKind === descriptor.kind) ?? stages[0]);
      if (!stage) throw new Error('managed-catalog-profile-unavailable');
      const profile = structuredClone(stage.profileSnapshot);
      const maxSeconds = descriptor.seconds ?? profile.budget.maxDurationSeconds;
      if (maxSeconds > profile.budget.maxDurationSeconds)
        throw new Error('managed-catalog-budget-outside-profile');
      const mirrors: ManagedRepositoryMirror[] = [];
      const catalogBindings: Recipe['catalogBindings'] = [];
      const scopes: Scope['repositories'] = [];
      const seen = new Set<string>();
      for (const selected of descriptor.repositories) {
        const entries = catalog.list('repository');
        const exact = entries.filter((entry) => entry.id === selected.repositoryId);
        const candidates = exact.length
          ? exact
          : entries.filter(
              (entry) =>
                entry.name === selected.repositoryId ||
                entry.payload.remote === selected.repositoryId,
            );
        const repository = candidates[0];
        if (!repository || candidates.length !== 1 || seen.has(repository.id))
          throw new Error('managed-catalog-repository-unavailable');
        seen.add(repository.id);
        catalogBindings.push({ id: repository.id, remote: repository.payload.remote });
        const setup = repository.payload.setups.find(
          (item) => item.id === repository.payload.defaultSetupId,
        );
        if (!setup) throw new Error('managed-catalog-repository-default-missing');
        const prepared = await worktrees.create({
          repoUrl: repository.payload.remote,
          branch: `dispatcher/catalog/${descriptor.jobId}-${scopes.length}`,
          baseBranch: setup.defaultBranch,
          startBranch: selected.ref ?? setup.defaultBranch,
          sessionId: `catalog-${descriptor.jobId}-${scopes.length}`,
        });
        try {
          mirrors.push({
            enrollmentId: repository.id,
            path: prepared.bareRepoPath,
            remote: repository.id,
            baseRevision: prepared.startCommitSha,
          });
          scopes.push({
            enrollmentId: repository.id,
            remote: repository.id,
            baseRevision: prepared.startCommitSha,
            branchNamespace: 'dispatcher/',
            access: 'read',
          });
        } finally {
          await worktrees.cleanup(prepared.worktreePath);
        }
      }
      const primary = descriptor.repositories[0];
      const selected = primary
        ? catalog
            .list('repository')
            .find(
              (entry) =>
                entry.id === primary.repositoryId ||
                entry.name === primary.repositoryId ||
                entry.payload.remote === primary.repositoryId,
            )
        : undefined;
      const match = selected?.payload.remote.match(
        /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/,
      );
      const githubRead = match
        ? {
            alias: `catalog-${descriptor.jobId}`,
            repository: match[1]!,
            bindingDigest: digest({ repository: match[1]!, access: 'issues-read' }),
          }
        : undefined;
      const now = Math.floor(Date.now() / 1000);
      profile.profileId = `catalog-${descriptor.jobId}`;
      profile.scope = {
        repositories: scopes,
        identityBindings: githubRead
          ? [{ alias: githubRead.alias, bindingDigest: githubRead.bindingDigest }]
          : [],
        network: structuredClone(stage.profileSnapshot.scope.network),
        allowedEffects: [
          'repository.read',
          'artifact.write',
          'web.public-read',
          ...(githubRead ? ['github.issue.read' as const] : []),
        ],
      };
      profile.budget = { ...profile.budget, expiresAt: now + 86400 };
      if ('maxObservedTokens' in profile.budget) {
        const { maxObservedTokens: _telemetryCeiling, ...artifactBudget } = profile.budget;
        profile.budget = artifactBudget;
      }
      profile.snapshotDigest = digest(
        Object.fromEntries(Object.entries(profile).filter(([name]) => name !== 'snapshotDigest')),
      );
      const grant = {
        schemaVersion: 1 as const,
        grantId: `grant-${descriptor.attemptId}`,
        revision: 1,
        dispatcherAttemptId: descriptor.attemptId,
        profileSnapshotDigest: profile.snapshotDigest,
        route: profile.route,
        scope: profile.scope,
        budget: { ...profile.budget, maxDurationSeconds: maxSeconds, expiresAt: now + maxSeconds },
        digest: '',
      };
      grant.digest = digest(
        Object.fromEntries(Object.entries(grant).filter(([name]) => name !== 'digest')),
      );
      const repositoryMap = {
        path: 'dispatcher-scope/repositories.json',
        content: canonical(
          catalogBindings.map((binding, index) => ({
            repositoryId: binding.id,
            remote: binding.remote,
            directory: `/repositories/${scopes[index]!.enrollmentId}`,
            revision: scopes[index]!.baseRevision,
            access: 'read',
          })),
        ),
        sha256: '',
        sourceJobId: descriptor.jobId,
        evidenceLevel: 'dispatcher-observed' as const,
      };
      repositoryMap.sha256 = sha256(Buffer.from(repositoryMap.content));
      const template: ManagedPodRequest = {
        schemaVersion: 1,
        managedMode: true,
        dispatcherJobId: descriptor.jobId,
        dispatcherAttemptId: descriptor.attemptId,
        startKey: descriptor.startKey,
        executionSpecDigest: '',
        profileSnapshot: profile,
        effectiveGrant: grant,
        task: {
          kind: descriptor.kind,
          objective: descriptor.objective,
          contextBundleDigest: digest([repositoryMap]),
          contextFiles: [repositoryMap],
        },
        route: profile.route,
        outputs: {
          source: { mode: 'none', repository: 'none', remote: 'none', head: 'none', base: 'none' },
          artifacts: {
            mode: 'required',
            root: '/output',
            requiredPaths: [descriptor.artifactPath],
            include: [descriptor.artifactPath],
            exclude: [],
            limits: { maxFiles: 1, maxFileBytes: 1_000_000, maxTotalBytes: 1_000_000 },
            links: { allowSymlinks: false, allowHardlinks: false },
          },
        },
        inputArtifacts: [],
        validation: { suite: 'artifact-contract-v1', verifierPolicy: 'artifact-contract-v1' },
      };
      template.executionSpecDigest = digest(
        Object.fromEntries(
          Object.entries(template).filter(([name]) => name !== 'executionSpecDigest'),
        ),
      );
      const value = {
        template,
        mirrors,
        descriptor,
        catalogBindings,
        ...(githubRead ? { githubRead } : {}),
      };
      db.prepare('INSERT INTO managed_catalog_preparations VALUES (?,?,?,?)').run(
        installation,
        descriptor.jobId,
        descriptorDigest,
        canonical(value),
      );
      return value;
    };
    const effect = run();
    pending.set(key, effect);
    try {
      return await effect;
    } finally {
      pending.delete(key);
    }
  }
  components.service.catalog = {
    assertInstallation(request, installation) {
      if (forRequest(request) && installation !== config.installationId)
        throw new Error('managed-catalog-installation');
    },
    options: () => ({
      enabled: true,
      repositoryRestrictions: 'autopod-catalog',
      defaultProfileId: stages[0]!.profileSnapshot.profileId,
      profiles: stages.map((stage) => ({
        profileId: stage.profileSnapshot.profileId,
        route: stage.profileSnapshot.route,
        maximumSeconds: stage.profileSnapshot.budget.maxDurationSeconds,
      })),
      contextFiles: 'digest-bound-read-only',
      humanApproval: 'not-required',
      validation: 'artifact-contract-only',
    }),
    prepare: async (installation, raw) => (await prepare(installation, raw)).template,
  };
  return {
    components,
    config: legacy.config,
    bindings: legacy.bindings,
    async resume() {
      await legacy.resume(new Set(config.profiles.map((stage) => stage.profileSnapshot.profileId)));
      const rows = db
        .prepare('SELECT * FROM managed_pods WHERE runtime_ref IS NOT NULL AND observed_exit=0')
        .all() as ManagedPodRow[];
      for (const row of rows) {
        const request = JSON.parse(row.request_json) as ManagedPodRequest;
        if (forRequest(request))
          await composition(request).resume(new Set([request.profileSnapshot.profileId]));
      }
    },
    close() {
      legacy.close();
      for (const value of compositions.values()) value.close();
    },
  };
}
