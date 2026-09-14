import {
  type ConfigurationEntity,
  type ConfigurationKind,
  type LaunchRequest,
  launchRequestSchema,
} from '@autopod/shared';

export interface LaunchFlags {
  repo?: string;
  reference?: string[];
  references?: boolean;
  emptyWorkspace?: boolean;
  repositorySetup?: string;
  profile?: string;
  task?: string;
  goal?: string;
  intent?: 'task' | 'goal';
  environment?: string;
  ai?: string;
  workflow?: string;
  githubAccess?: string | false;
  sidecar?: string[];
  sidecars?: boolean;
  toolPack?: string[];
  toolPacks?: boolean;
  execution?: 'local' | 'sandbox';
  memoryGb?: number;
  cpus?: number;
  requestId?: string;
  overrideConfig?: boolean;
}
export type ConfigurationLookup = (kind: ConfigurationKind) => Promise<ConfigurationEntity[]>;
export async function configurationId(
  kind: ConfigurationKind,
  name: string,
  lookup: ConfigurationLookup,
): Promise<string> {
  const values = await lookup(kind);
  const exact = values.find((value) => value.id === name && !value.archived);
  if (exact) return exact.id;
  const named = values.filter((value) => value.name === name && !value.archived);
  if (named.length !== 1 || !named[0])
    throw new Error(`No unique ${kind} named "${name}". List configurations to select its ID.`);
  return named[0].id;
}

/** Flags compose a shared request; only the daemon resolves defaults and effective configuration. */
export async function buildLaunchRequest(
  flags: LaunchFlags,
  lookup: ConfigurationLookup,
  file?: unknown,
): Promise<LaunchRequest> {
  if (flags.task !== undefined && flags.goal !== undefined)
    throw new Error('Choose --task or --goal, not both.');
  if (flags.repo && flags.emptyWorkspace) throw new Error('Choose --repo or --empty-workspace.');
  if (flags.sidecars === false && flags.sidecar?.length)
    throw new Error('Choose --sidecar or --no-sidecars.');
  if (flags.toolPacks === false && flags.toolPack?.length)
    throw new Error('Choose --tool-pack or --no-tool-packs.');
  if (flags.goal !== undefined && flags.intent === 'task')
    throw new Error('--goal cannot use --intent task.');
  if (flags.references === false && flags.reference?.length)
    throw new Error('Choose --reference or --no-references.');
  const configuredFlags = [
    flags.reference,
    flags.references === false ? false : undefined,
    flags.repo,
    flags.emptyWorkspace,
    flags.repositorySetup,
    flags.profile,
    flags.task,
    flags.goal,
    flags.intent,
    flags.environment,
    flags.ai,
    flags.workflow,
    flags.githubAccess,
    flags.toolPack?.length ? flags.toolPack : undefined,
    flags.toolPacks === false ? false : undefined,
    flags.sidecar,
    flags.sidecars === false ? false : undefined,
    flags.execution,
    flags.memoryGb,
    flags.cpus,
    flags.requestId,
  ];
  if (
    file !== undefined &&
    !flags.overrideConfig &&
    configuredFlags.some((value) => value !== undefined)
  )
    throw new Error(
      'Launch flags conflict with --config. Add --override-config to make explicit flags win.',
    );
  // Parse file first so unknown keys and incomplete requests are never silently ignored.
  const saved = file === undefined ? undefined : launchRequestSchema.parse(file);
  const selections: NonNullable<LaunchRequest['selections']> = { ...saved?.selections };
  const overrides: NonNullable<LaunchRequest['overrides']> = structuredClone(
    saved?.overrides ?? {},
  );
  const cache = new Map<ConfigurationKind, Promise<ConfigurationEntity[]>>();
  const cached: ConfigurationLookup = (kind) => {
    let pending = cache.get(kind);
    if (!pending) {
      pending = lookup(kind);
      cache.set(kind, pending);
    }
    return pending;
  };
  const choices = [
    ['environment', flags.environment, 'environmentId'],
    ['ai', flags.ai, 'aiId'],
    ['workflow', flags.workflow, 'workflowId'],
  ] as const;
  await Promise.all(
    choices.map(async ([kind, name, key]) => {
      if (name !== undefined) {
        selections[key] = await configurationId(kind, name, cached);
        Reflect.deleteProperty(overrides, kind);
      }
    }),
  );
  if (flags.githubAccess !== undefined) Reflect.deleteProperty(overrides, 'githubAccess');
  if (flags.githubAccess === false) selections.githubAccessId = null;
  else if (flags.githubAccess !== undefined)
    selections.githubAccessId = await configurationId('githubAccess', flags.githubAccess, cached);
  if (flags.toolPacks === false || flags.toolPack) Reflect.deleteProperty(overrides, 'toolPacks');
  if (flags.toolPacks === false) selections.toolPackIds = [];
  else if (flags.toolPack)
    selections.toolPackIds = await Promise.all(
      flags.toolPack.map((name) => configurationId('toolPack', name, cached)),
    );
  if (flags.execution !== undefined || flags.memoryGb !== undefined || flags.cpus !== undefined) {
    overrides.execution = {
      ...overrides.execution,
      ...(flags.execution ? { target: flags.execution } : {}),
    };
    if (flags.memoryGb !== undefined || flags.cpus !== undefined)
      overrides.execution.main = {
        ...overrides.execution.main,
        ...(flags.memoryGb !== undefined ? { memoryGb: flags.memoryGb } : {}),
        ...(flags.cpus !== undefined ? { cpus: flags.cpus } : {}),
      };
  }
  const target = flags.repo
    ? {
        repositoryId: await configurationId('repository', flags.repo, cached),
        ...(flags.repositorySetup ? { repositorySetupId: flags.repositorySetup } : {}),
      }
    : flags.emptyWorkspace
      ? { emptyWorkspace: true as const }
      : saved && 'repositoryId' in saved
        ? {
            repositoryId: saved.repositoryId,
            ...((flags.repositorySetup ?? saved.repositorySetupId)
              ? { repositorySetupId: flags.repositorySetup ?? saved.repositorySetupId }
              : {}),
          }
        : saved && 'emptyWorkspace' in saved
          ? { emptyWorkspace: true as const }
          : {};
  if ('repositoryId' in target && flags.repositorySetup) {
    const repository = (await cached('repository')).find((item) => item.id === target.repositoryId);
    if (!repository || repository.kind !== 'repository')
      throw new Error('Selected repository is unavailable.');
    const setups = repository.payload.setups;
    const exactSetup = setups.find((item) => item.id === flags.repositorySetup);
    const namedSetups = setups.filter((item) => item.name === flags.repositorySetup);
    if (!exactSetup && namedSetups.length > 1)
      throw new Error('Repository setup name is ambiguous. Select its ID.');
    const setup = exactSetup ?? namedSetups[0];
    if (!setup) throw new Error(`No repository setup named "${flags.repositorySetup}".`);
    target.repositorySetupId = setup.id;
  }
  if (flags.repositorySetup && 'emptyWorkspace' in target)
    throw new Error('--repository-setup requires --repo.');
  const {
    repositoryId: _repo,
    repositorySetupId: _setup,
    emptyWorkspace: _empty,
    ...rest
  } = (saved ?? {}) as Partial<LaunchRequest> & {
    repositoryId?: string;
    repositorySetupId?: string;
    emptyWorkspace?: boolean;
  };
  if (flags.environment !== undefined) Reflect.deleteProperty(rest, 'requiredSidecarIds');
  if (flags.overrideConfig && configuredFlags.some((value) => value !== undefined)) {
    Reflect.deleteProperty(rest, 'expectedDigest');
    Reflect.deleteProperty(rest, 'requestId');
  }
  const references =
    flags.references === false
      ? []
      : flags.reference
        ? await Promise.all(
            flags.reference.map(async (value) => {
              const separator = value.indexOf('=');
              if (separator < 1 || separator === value.length - 1)
                throw new Error('--reference requires repository=ref.');
              return {
                repositoryId: await configurationId(
                  'repository',
                  value.slice(0, separator),
                  cached,
                ),
                ref: value.slice(separator + 1),
                access: 'read' as const,
              };
            }),
          )
        : undefined;
  return launchRequestSchema.parse({
    ...rest,
    ...target,
    ...(references !== undefined ? { referenceRepositories: references } : {}),
    ...(flags.profile
      ? { profileId: await configurationId('profile', flags.profile, cached) }
      : {}),
    ...(flags.task !== undefined || flags.goal !== undefined
      ? { task: flags.goal ?? flags.task }
      : {}),
    ...(flags.goal !== undefined
      ? { intent: 'goal' }
      : flags.intent
        ? { intent: flags.intent }
        : {}),
    ...(flags.sidecars === false
      ? { requiredSidecarIds: [] }
      : flags.sidecar
        ? { requiredSidecarIds: flags.sidecar }
        : {}),
    ...(flags.requestId ? { requestId: flags.requestId } : {}),
    ...(Object.keys(selections).length || saved?.selections !== undefined ? { selections } : {}),
    ...(Object.keys(overrides).length || saved?.overrides !== undefined ? { overrides } : {}),
  });
}
