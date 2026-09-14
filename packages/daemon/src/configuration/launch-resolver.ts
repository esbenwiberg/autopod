import {
  type AgentRoute,
  type ConfigurationEntity,
  type ConfigurationKind,
  type ConfigurationRevision,
  type EffectiveLaunchConfig,
  type EnvironmentPreset,
  type ExecutionCapabilities,
  type GitHubAccessPreset,
  type LaunchProvenance,
  type RepositoryConfig,
  type ResolvedAgentAccount,
  type ResolvedEnvironment,
  type ResolvedGitHubRule,
  type ToolPack,
  aiPresetSchema,
  environmentPresetSchema,
  executionSettingsSchema,
  githubAccessPresetSchema,
  launchRequestSchema,
  repositorySetupSchema,
  workflowPresetSchema,
} from '@autopod/shared';
import { assertAnalysisWorkspace } from './analysis-workspace.js';
import { type ConfigurationStore, configurationError } from './configuration-store.js';
import { deriveLaunch } from './derive-launch.js';
import { resolveExecution } from './resolve-execution.js';

export { canonicalConfiguration, configurationDigest } from './configuration-digest.js';
import { environmentImageKey } from '../images/environment-image-key.js';
import { configurationDigest } from './configuration-digest.js';
export interface LaunchResolutionServices {
  deploymentAvailable?: boolean;
  readLaunch?(podId: string): EffectiveLaunchConfig | null;
  store: ConfigurationStore;
  resolveEnvironment(
    environment: EnvironmentPreset,
    target: EffectiveLaunchConfig['execution']['target'],
  ): Promise<ResolvedEnvironment>;
  // All services are read-only. Unavailable discovery/preflight rejects, never grants a fallback.
  githubRepositories(
    rule: GitHubAccessPreset['rules'][number],
    repository: RepositoryConfig | null,
  ): Promise<string[]>;
  githubWorkflows(rule: ResolvedGitHubRule): Promise<ResolvedGitHubRule>;
  referenceRevision(repository: RepositoryConfig, ref: string): Promise<string>;
  skillContent(skill: ToolPack['skills'][number]): Promise<string>;
  resolveAgentRoute(route: AgentRoute): Promise<ResolvedAgentAccount>;
  executionCapabilities(
    target: EffectiveLaunchConfig['execution']['target'],
  ): Promise<ExecutionCapabilities>;
  assertCapabilities(config: EffectiveLaunchConfig): Promise<void>;
  resolveCredentialReferences(
    config: EffectiveLaunchConfig,
  ): Promise<EffectiveLaunchConfig['credentialReferences']>;
}

/** The same resolver serves preview and admission. It never creates external resources. */
export async function resolveLaunch(
  raw: unknown,
  services: LaunchResolutionServices,
): Promise<EffectiveLaunchConfig> {
  const config = await resolveLaunchRequest(raw, services);
  assertAnalysisWorkspace(config);
  return config;
}

async function resolveLaunchRequest(
  raw: unknown,
  services: LaunchResolutionServices,
): Promise<EffectiveLaunchConfig> {
  const request = launchRequestSchema.parse(raw);
  if (!request.source) return resolve(request, services, []);
  const parent = services.readLaunch?.(request.source.podId);
  if (!parent)
    configurationError('Source launch configuration is unavailable', 'CONFIG_SOURCE_MISSING', 409);
  if (parent.digest !== request.source.digest)
    configurationError(
      'Source launch changed; refresh before continuing',
      'CONFIG_SOURCE_CHANGED',
      409,
    );
  if (('repositoryId' in request ? request.repositoryId : undefined) !== parent.repository?.id)
    configurationError(
      'A follow-up must use its source repository',
      'DEPENDENCY_REPOSITORY_MISMATCH',
      409,
    );
  if (request.source.configuration === 'current') {
    const { digest: _, ...current } = await resolve(
      { ...request, expectedDigest: undefined },
      services,
      [],
    );
    const body = {
      ...current,
      origin: { kind: 'follow-up' as const, ...request.source, configuration: 'current' as const },
    };
    const config = { ...body, digest: configurationDigest(body) };
    if (request.expectedDigest && request.expectedDigest !== config.digest)
      configurationError(
        'Launch preview changed; review the new configuration',
        'CONFIG_CHANGED',
        409,
      );
    return config;
  }
  if (
    request.selections ||
    request.overrides ||
    (request.requiredSidecarIds && request.source.configuration !== 'worker') ||
    request.referenceRepositories.length ||
    (request.profileId !== undefined && request.profileId !== parent.profileId) ||
    ('repositorySetupId' in request &&
      request.repositorySetupId !== undefined &&
      request.repositorySetupId !== parent.repository?.setup.id) ||
    (request.intent !== undefined && request.intent !== parent.intent)
  )
    configurationError(
      'Original configuration is frozen. Choose current configuration to change presets or values.',
      'FROZEN_CONFIGURATION_EDIT',
      409,
    );
  const config = deriveLaunch(parent, {
    source: {
      podId: request.source.podId,
      digest: parent.digest,
      kind: request.source.configuration === 'worker' ? 'spawn-worker' : 'follow-up',
    },
    task: request.task,
    work: request.work,
  });
  if (
    request.source.configuration === 'worker' &&
    request.requiredSidecarIds?.some((id) => !config.resolvedExecution.sidecars[id])
  )
    configurationError(
      'The frozen worker does not include every required sidecar. Select them in the worker profile before starting the workspace.',
      'FROZEN_WORKER_SIDECAR_MISSING',
      409,
    );
  await services.assertCapabilities(config);
  if (request.expectedDigest && request.expectedDigest !== config.digest)
    configurationError(
      'Launch preview changed; review the new configuration',
      'CONFIG_CHANGED',
      409,
    );
  return config;
}
async function resolve(
  raw: unknown,
  services: LaunchResolutionServices,
  workerChain: string[],
): Promise<EffectiveLaunchConfig> {
  const request = launchRequestSchema.parse(raw);
  const revisions = new Map<string, ConfigurationRevision>();
  const provenance: Record<string, LaunchProvenance> = {};
  function read<K extends ConfigurationKind>(kind: K, id: string): ConfigurationEntity<K> {
    const entity = services.store.get(kind, id);
    const { payload: _, ...revision } = entity;
    const previous = revisions.get(id);
    if (previous && previous.revision !== entity.revision)
      configurationError('Configuration changed during resolution', 'CONFIG_CHANGED', 409);
    revisions.set(id, revision);
    return entity;
  }
  function origin(path: string, entity: ConfigurationEntity, source: LaunchProvenance['source']) {
    provenance[path] = { source, entityId: entity.id, revision: entity.revision };
    for (const field of Object.keys(entity.payload))
      provenance[`${path}.${field}`] = provenance[path];
  }
  const repository = 'repositoryId' in request ? read('repository', request.repositoryId) : null;
  const profileId = request.profileId ?? repository?.payload.usualProfileId;
  if (!profileId)
    configurationError('Select a profile or set the repository usual profile', 'PROFILE_REQUIRED');
  if (workerChain.includes(profileId))
    configurationError('Worker profiles form a cycle', 'WORKER_PROFILE_CYCLE');
  const profile = read('profile', profileId);
  origin('profile', profile, 'profile');
  const selected = request.selections;
  const env = read('environment', selected?.environmentId ?? profile.payload.environmentId);
  const requiredSidecarIds =
    request.requiredSidecarIds ??
    (env.id === profile.payload.environmentId ? profile.payload.requiredSidecarIds : []);
  const ai = read('ai', selected?.aiId ?? profile.payload.aiId);
  const workflow = read('workflow', selected?.workflowId ?? profile.payload.workflowId);
  const accessId =
    selected?.githubAccessId !== undefined
      ? selected.githubAccessId
      : profile.payload.githubAccessId;
  const access = accessId ? read('githubAccess', accessId) : null;
  const packs = (selected?.toolPackIds ?? profile.payload.toolPackIds).map((id) =>
    read('toolPack', id),
  );
  origin('environment', env, 'preset');
  origin('ai', ai, 'preset');
  origin('workflow', workflow, 'preset');
  if (access) origin('githubAccess', access, 'preset');
  provenance.execution = { source: 'profile', entityId: profile.id, revision: profile.revision };
  provenance.pim = provenance.execution;
  for (const pack of packs) origin(`toolPacks.${pack.id}`, pack, 'preset');
  const overrides = request.overrides;
  if (!repository && overrides?.repositorySetup)
    configurationError('An empty workspace has no repository setup');
  let setup = repository?.payload.setups.find(
    (s) =>
      s.id ===
      ('repositorySetupId' in request
        ? (request.repositorySetupId ?? repository.payload.defaultSetupId)
        : repository.payload.defaultSetupId),
  );
  if (repository && !setup)
    configurationError('Selected repository setup no longer exists', 'SETUP_NOT_FOUND');
  if (repository && setup) {
    origin('repository', repository, 'repository');
    setup = repositorySetupSchema.parse({ ...setup, ...overrides?.repositorySetup });
  }
  if (setup?.integrations.deployment?.enabled && !services.deploymentAvailable)
    configurationError(
      'Deployment scripts require an isolated execution adapter. The legacy host runner can access daemon credentials and is unavailable for composable launches.',
      'DEPLOYMENT_ISOLATION_UNAVAILABLE',
      409,
    );
  const effectiveWorkflow = workflowPresetSchema.parse({
    ...workflow.payload,
    ...overrides?.workflow,
  });
  const effectiveAi = aiPresetSchema.parse({ ...ai.payload, ...overrides?.ai });
  const effectiveEnvironment = environmentPresetSchema.parse({
    ...env.payload,
    ...overrides?.environment,
  });
  const effectiveAccess = githubAccessPresetSchema.parse({
    ...(access?.payload ?? { rules: [] }),
    ...overrides?.githubAccess,
  });
  const effectiveExecution = executionSettingsSchema.parse({
    ...profile.payload.execution,
    ...overrides?.execution,
    main: { ...profile.payload.execution.main, ...overrides?.execution?.main },
  });
  const intent = request.intent ?? effectiveWorkflow.intent;
  if (intent === 'goal' && (request.task.length > 4000 || effectiveWorkflow.agentMode !== 'auto')) {
    configurationError(
      'Goals require an agent workflow and an objective of at most 4000 characters',
      'GOAL_UNAVAILABLE',
    );
  }
  if (!repository && ['pr', 'branch'].includes(effectiveWorkflow.output))
    configurationError('Source delivery requires a repository');
  if (setup) {
    const commands = {
      setup: 'validationSetupCommand',
      lint: 'lintCommand',
      sast: 'sastCommand',
      build: 'buildCommand',
      test: 'testCommand',
    } as const;
    for (const [phase, field] of Object.entries(commands)) {
      // Setup is optional preparation; an absent setup command means there is nothing to prepare.
      if (
        phase !== 'setup' &&
        effectiveWorkflow.validationPhases.includes(phase as keyof typeof commands) &&
        !setup[field]
      ) {
        configurationError(
          `Repository setup needs ${field} for the selected workflow`,
          'VALIDATION_COMMAND_REQUIRED',
        );
      }
    }
    if (
      effectiveWorkflow.validationPhases.some((p) => p === 'health' || p === 'pages') &&
      !setup.startCommand
    ) {
      configurationError(
        'Repository setup needs startCommand for web validation',
        'VALIDATION_COMMAND_REQUIRED',
      );
    }
  }
  const sidecarIds = effectiveEnvironment.sidecars.map((s) => s.id);
  if (new Set(sidecarIds).size !== sidecarIds.length) configurationError('Duplicate sidecar IDs');
  if (Object.keys(effectiveExecution.sidecars).some((id) => !sidecarIds.includes(id))) {
    configurationError('Sidecar allocation has no matching environment sidecar');
  }
  for (const [category, patch] of Object.entries(overrides ?? {})) {
    if (patch === undefined) continue;
    if (Array.isArray(patch)) provenance[category] = { source: 'override' };
    else
      for (const key of Object.keys(patch))
        provenance[`${category}.${key}`] = { source: 'override' };
  }
  if (request.intent) provenance.intent = { source: 'override' };
  else provenance.intent = provenance['workflow.intent'] ?? { source: 'default' };
  const config: EffectiveLaunchConfig = {
    schemaVersion: 1,
    repository:
      repository && setup ? { id: repository.id, config: repository.payload, setup } : null,
    profileId,
    task: request.task,
    work: request.work ?? {},
    intent,
    environment: effectiveEnvironment,
    resolvedEnvironment: await services.resolveEnvironment(
      effectiveEnvironment,
      effectiveExecution.target,
    ),
    ai: effectiveAi,
    agentAccounts: {},
    credentialReferences: {},
    workflow: effectiveWorkflow,
    execution: effectiveExecution,
    requiredSidecarIds,
    resolvedExecution: resolveExecution({
      environment: effectiveEnvironment,
      execution: effectiveExecution,
      requiredSidecarIds,
      trustedRepository: !!(
        repository &&
        setup &&
        repository.payload.trustedSetupIds.includes(setup.id)
      ),
      capabilities: await services.executionCapabilities(effectiveExecution.target),
    }),
    pim: overrides?.pim ?? profile.payload.pim,
    toolPacks: overrides?.toolPacks ?? packs.map((p) => p.payload),
    toolContents: {},
    githubAccess: [],
    references: [],
    revisions: [],
    provenance,
    worker: null,
    digest: '',
  };
  if (
    config.resolvedEnvironment.imageKey !==
    environmentImageKey({
      environment: config.environment,
      ...config.resolvedEnvironment,
    })
  )
    configurationError(
      'Resolved software image identity is inconsistent',
      'ENVIRONMENT_IDENTITY_MISMATCH',
    );
  const toolNames = new Map<string, { digest: string; source: number }>();
  for (const [index, pack] of config.toolPacks.entries()) {
    for (const capability of pack.requiredCapabilities) {
      if (!config.environment.capabilities.includes(capability))
        configurationError(
          `Tool pack requires environment capability ${capability}`,
          'TOOL_CAPABILITY_MISSING',
        );
    }
    for (const [kind, definitions] of [
      ['skill', pack.skills],
      ['mcp', pack.mcpServers],
    ] as const) {
      for (const definition of definitions) {
        if (
          kind === 'mcp' &&
          ['escalation', 'autopod', 'autopod-escalation'].includes(definition.name.toLowerCase())
        )
          configurationError(
            `MCP server name ${definition.name} is reserved for AutoPod scoped tools`,
            'TOOL_NAME_RESERVED',
          );
        const key = `${kind}:${definition.name}`;
        const definitionDigest = configurationDigest(definition);
        const existing = toolNames.get(key);
        if (existing && existing.digest !== definitionDigest)
          configurationError(
            `Conflicting ${key} in tool packs ${existing.source + 1} and ${index + 1}`,
            'TOOL_CONFLICT',
          );
        toolNames.set(key, { digest: definitionDigest, source: index });
      }
    }
    for (const skill of pack.skills) {
      const key = `skill:${skill.name}`;
      if (config.toolContents[key]) continue;
      const content =
        skill.source.type === 'inline' ? skill.source.content : await services.skillContent(skill);
      if (content.length > 50_000)
        configurationError(
          `Skill ${skill.name} exceeds the supported content limit`,
          'TOOL_CONTENT_TOO_LARGE',
        );
      config.toolContents[key] = { content, digest: configurationDigest(content) };
    }
  }
  for (const rule of effectiveAccess.rules) {
    const ids = await services.githubRepositories(rule, repository?.payload ?? null);
    config.githubAccess.push(
      await services.githubWorkflows({
        rule,
        repositoryIds: [...new Set(ids)].sort(),
        workflowBindings: [],
      }),
    );
  }
  for (const reference of request.referenceRepositories) {
    const repo = read('repository', reference.repositoryId);
    const revision = await services.referenceRevision(repo.payload, reference.ref);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision))
      configurationError(
        'Reference repository did not resolve to an exact commit',
        'REFERENCE_REVISION_UNRESOLVED',
      );
    config.references.push({
      id: repo.id,
      remote: repo.payload.remote,
      revision,
    });
  }
  for (const route of [
    config.ai.main,
    ...(config.ai.reviewer.mode === 'independent' ? [config.ai.reviewer.route] : []),
  ]) {
    for (const target of [
      route,
      ...route.failover.map((target) => ({ ...target, failover: [], maxHops: 0 })),
    ]) {
      const binding = await services.resolveAgentRoute(target);
      const previous = config.agentAccounts[target.providerAccountId];
      if (
        binding.accountId !== target.providerAccountId ||
        (previous && configurationDigest(previous) !== configurationDigest(binding))
      )
        configurationError(
          'Agent account identity changed during resolution',
          'PROVIDER_BINDING_MISMATCH',
        );
      config.agentAccounts[target.providerAccountId] = binding;
    }
  }
  if (profile.payload.workerProfileId) {
    config.worker = await resolve(
      {
        ...(repository
          ? { repositoryId: repository.id, repositorySetupId: setup?.id }
          : { emptyWorkspace: true }),
        profileId: profile.payload.workerProfileId,
        task: '[Worker task supplied at launch]',
        referenceRepositories: request.referenceRepositories,
      },
      services,
      [...workerChain, profileId],
    );
    for (const r of config.worker.revisions) {
      const prior = revisions.get(r.id);
      if (prior && prior.revision !== r.revision)
        configurationError('Worker configuration changed during resolution', 'CONFIG_CHANGED', 409);
      revisions.set(r.id, r);
    }
  }
  config.revisions = [...revisions.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  config.credentialReferences = await services.resolveCredentialReferences(config);
  await services.assertCapabilities(config);
  services.store.assertCurrent(config.revisions);
  const { digest: _, ...body } = config;
  config.digest = configurationDigest(body);
  if (request.expectedDigest && request.expectedDigest !== config.digest)
    configurationError('Configuration changed after preview', 'CONFIG_CHANGED', 409);
  return config;
}
