import {
  type ConfigurationKind,
  type EnvironmentPreset,
  type GitHubAccessPreset,
  type PimSelection,
  type Profile,
  type ProviderFailoverPolicy,
  type RepositoryConfig,
  type ServiceAccessRule,
  type ToolPack,
  launchValidationPhaseSchema,
  mergeValidationPhaseSkips,
  pimSelectionSchema,
  podOptionsFromOutputMode,
  repositoryConfigSchema,
  repositorySetupSchema,
  resolvePodOptions,
} from '@autopod/shared';
import { resolveInheritance, validateInheritanceChain } from '../profiles/inheritance.js';
import { type ConfigurationWrite, parseConfigurationPayload } from './configuration-store.js';
import { configurationDigest } from './launch-resolver.js';

export const LEGACY_PROFILE_FIELD_OWNERS = {
  name: 'identity',
  createdAt: 'identity',
  updatedAt: 'identity',
  version: 'identity',
  repoUrl: 'repository',
  defaultBranch: 'setup',
  buildCommand: 'setup',
  startCommand: 'setup',
  buildWorkDir: 'setup',
  healthPath: 'setup',
  healthTimeout: 'setup',
  smokePages: 'setup',
  testCommand: 'setup',
  validationSetupCommand: 'setup',
  buildEnv: 'setup',
  buildTimeout: 'setup',
  testTimeout: 'setup',
  lintCommand: 'setup',
  lintTimeout: 'setup',
  sastCommand: 'setup',
  sastTimeout: 'setup',
  hasWebUi: 'setup',
  template: 'environment',
  sidecars: 'environment',
  executionTarget: 'execution',
  containerMemoryGb: 'execution',
  networkPolicy: 'execution',
  defaultModel: 'ai',
  defaultRuntime: 'ai',
  reasoningEffort: 'ai',
  modelProvider: 'ai',
  providerAccountId: 'ai',
  providerFailover: 'ai',
  reviewerModel: 'ai',
  providerCredentials: 'credential-reference',
  openrouterApiKey: 'credential-reference',
  pod: 'workflow',
  outputMode: 'retired-mirror',
  maxValidationAttempts: 'workflow',
  mergePollIntervalSec: 'workflow',
  preflightConflictPolicy: 'workflow',
  branchPrefix: 'workflow',
  tokenBudget: 'workflow',
  tokenBudgetWarnAt: 'workflow',
  tokenBudgetPolicy: 'workflow',
  maxBudgetExtensions: 'workflow',
  escalation: 'workflow',
  agentDonePrompt: 'workflow',
  skipValidationPhases: 'workflow',
  securityScan: 'workflow',
  customInstructions: 'toolPack',
  mcpServers: 'toolPack',
  claudeMdSections: 'toolPack',
  skills: 'toolPack',
  codeIntelligence: 'toolPack',
  actionPolicy: 'scoped-access-or-retired-actions',
  prProvider: 'integration',
  privateRegistries: 'integration',
  testPipeline: 'retired-integration',
  deployment: 'integration',
  githubPat: 'retired-secret',
  githubPatExpiresAt: 'retired-secret',
  registryPat: 'credential-reference',
  registryPatExpiresAt: 'integration',
  workerProfile: 'profile',
  pimActivations: 'pim',
  trustedSource: 'repository-trust',
  issueWatcherEnabled: 'watcher',
  issueWatcherLabelPrefix: 'watcher',
  warmImageTag: 'legacy-cache',
  warmImageBuiltAt: 'legacy-cache',
  extends: 'retired-inheritance',
  mergeStrategy: 'retired-inheritance',
} as const satisfies Record<keyof Profile, string>;

export interface LegacyMigrationBindings {
  accountByProfile?: Record<string, string>;
  accountFailover?: Record<string, ProviderFailoverPolicy | null>;
  registryCredentialByProfile?: Record<string, string>;
  /** Exact field paths such as buildEnv.API_KEY, deployment.env.AZURE_TOKEN or mcp.name.Authorization. */
  secretReferencesByProfile?: Record<string, Record<string, string>>;
  githubAccessByProfile?: Record<string, GitHubAccessPreset>;
  /** Explicit replacement for a legacy remote containing user-info or another unsafe component. */
  remoteByProfile?: Record<string, string>;
  /** Reviewed replacement of legacy ADO/log actions with complete, scoped read rules. */
  serviceAccessByProfile?: Record<string, ServiceAccessRule[]>;
  /** Explicitly accept published-default semantics and an independently enrolled runner target. */
  deploymentByProfile?: Record<
    string,
    { source: 'published-default'; targetId: string; allowedScripts: string[] }
  >;
  /** Retire a specialized legacy profile while retaining its repository setup. */
  profileReplacementByProfile?: Record<string, string>;
  resolvedToolPackByProfile?: Record<string, ToolPack>;
  /** Exact public tool versions used to replace legacy code-intelligence switches. */
  codeIntelligenceVersions?: { serena?: string; roslynCodeLens?: string };
  pimByProfile?: Record<string, PimSelection[]>;
  /** Canonical remote -> old profile name. Omit to leave ambiguous defaults unset. */
  usualProfileByRemote?: Record<string, string>;
  /** Explicit old-profile trust decisions; conflicts otherwise block conversion. */
  trustedByProfile?: Record<string, boolean>;
  watcherEnabledByProfile?: Record<string, boolean>;
}
export interface LegacyMigrationManifest {
  schemaVersion: 1;
  sourceDigest: string;
  entities: ConfigurationWrite[];
  bindings: Array<{
    legacyProfileName: string;
    legacyVersion: number;
    repositoryId: string | null;
    setupId: string | null;
    profileId: string;
    watcher: { enabled: boolean; labelPrefix: string };
    memoryScope: { repositoryId: string | null; setupId: string | null; legacyProfileName: string };
    legacyCache: { tag: string | null; builtAt: string | null };
  }>;
  blockers: Array<{ profile: string; field: string; code: string }>;
  warnings: Array<{ profile: string; code: string }>;
}
const stableId = (kind: string, content: unknown) =>
  `${kind}-${configurationDigest(content).slice(0, 24)}`;

/** Pure conversion preview. Never reads live credentials, activates PIM or mutates a store. */
export function previewLegacyProfileMigration(
  raw: Profile[],
  bindings: LegacyMigrationBindings = {},
): LegacyMigrationManifest {
  const source = new Map(raw.map((p) => [p.name, p]));
  const manifest: LegacyMigrationManifest = {
    schemaVersion: 1,
    sourceDigest: configurationDigest(
      raw
        .map((p) => ({ name: p.name, version: p.version, updatedAt: p.updatedAt }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ),
    entities: [],
    bindings: [],
    blockers: [],
    warnings: [],
  };
  const block = (profile: string, field: string, code: string) => {
    manifest.blockers.push({ profile, field, code });
  };
  const warn = (profile: string, code: string) => {
    manifest.warnings.push({ profile, code });
  };
  const resolved = new Map<string, Profile>();
  const get = (name: string): Profile => {
    const cached = resolved.get(name);
    if (cached) return cached;
    const p = source.get(name);
    if (!p) throw new Error('Missing legacy parent');
    const value = p.extends ? resolveInheritance(p, get(p.extends)) : p;
    resolved.set(name, value);
    return value;
  };
  for (const p of raw) {
    try {
      validateInheritanceChain(p.name, (name) => {
        const current = source.get(name);
        if (!current) throw new Error('Missing legacy parent');
        return current.extends;
      });
      get(p.name);
    } catch {
      block(p.name, 'extends', 'INVALID_LEGACY_CHAIN');
    }
  }
  if (manifest.blockers.length) return manifest;
  const entities = new Map<string, ConfigurationWrite>();
  const repos = new Map<
    string,
    { id: string; config: RepositoryConfig; choices: string[]; trust: Set<boolean> }
  >();
  function add(kind: ConfigurationKind, payload: unknown, label: string) {
    const parsed = parseConfigurationPayload(kind, payload);
    const id = stableId(kind, parsed);
    if (!entities.has(id))
      entities.set(id, { id, kind, name: `${label} (${id.slice(-8)})`, payload: parsed });
    return id;
  }
  const normalizedRemote = (profile: Profile) => {
    if (!profile.repoUrl) return null;
    const replacement = bindings.remoteByProfile?.[profile.name];
    const parsed = new URL(replacement ?? profile.repoUrl);
    if (!replacement && (parsed.username || parsed.password || parsed.search || parsed.hash))
      block(profile.name, 'repoUrl', 'REMOTE_CREDENTIAL_REVIEW_REQUIRED');
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed
      .toString()
      .replace(/\/$/, '')
      .replace(/\.git$/, '');
  };
  for (const p of [...resolved.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const before = manifest.blockers.length;
    try {
      const deploymentMapping = bindings.deploymentByProfile?.[p.name];
      if (p.deployment?.enabled && !deploymentMapping)
        block(p.name, 'deployment', 'DEPLOYMENT_ISOLATION_UNAVAILABLE');
      if (p.testPipeline?.enabled) warn(p.name, 'TEST_PIPELINE_RETIRED');
      const mappedSecrets = bindings.secretReferencesByProfile?.[p.name] ?? {};
      const value = (path: string, input: string): { value: string } | { secretId: string } => {
        if (mappedSecrets[path]) return { secretId: mappedSecrets[path] };
        if (
          /(?:token|password|secret|api[_-]?key|authorization|credential)/i.test(path) ||
          input.startsWith('$DAEMON:')
        ) {
          block(p.name, path, 'SECRET_REFERENCE_REQUIRED');
          return { secretId: 'unresolved' };
        }
        return { value: input };
      };
      const mapValues = (prefix: string, env: Record<string, string>) =>
        Object.fromEntries(Object.entries(env).map(([k, v]) => [k, value(`${prefix}.${k}`, v)]));
      const replacementName = bindings.profileReplacementByProfile?.[p.name];
      const replacement = replacementName ? resolved.get(replacementName) : undefined;
      if (
        replacementName &&
        (!replacement ||
          replacementName === p.name ||
          bindings.profileReplacementByProfile?.[replacementName])
      )
        block(p.name, 'profileReplacement', 'INVALID_PROFILE_REPLACEMENT');
      const remote = normalizedRemote(p);
      if (replacement && normalizedRemote(replacement) !== remote)
        block(p.name, 'profileReplacement', 'REPLACEMENT_REPOSITORY_MISMATCH');
      const accountId = p.providerAccountId ?? bindings.accountByProfile?.[p.name];
      if (!accountId && !replacementName) {
        block(p.name, 'providerAccountId', 'ACCOUNT_MAPPING_REQUIRED');
        continue;
      }
      const registryCredential = bindings.registryCredentialByProfile?.[p.name];
      if (p.registryPat && !registryCredential)
        block(p.name, 'registryPat', 'REGISTRY_REFERENCE_REQUIRED');
      const setupBody = repositorySetupSchema.parse({
        id: 'pending',
        name: p.name,
        defaultBranch: p.defaultBranch ?? 'main',
        buildCommand: p.buildCommand,
        startCommand: p.startCommand,
        buildWorkDir: p.buildWorkDir,
        testCommand: p.testCommand ?? null,
        validationSetupCommand: p.validationSetupCommand ?? null,
        lintCommand: p.lintCommand ?? null,
        sastCommand: p.sastCommand ?? null,
        healthPath: p.healthPath,
        healthTimeout: p.healthTimeout ?? 120,
        smokePages: p.smokePages,
        buildEnv: mapValues('buildEnv', p.buildEnv ?? {}),
        buildTimeout: p.buildTimeout ?? 300,
        testTimeout: p.testTimeout ?? 600,
        lintTimeout: p.lintTimeout ?? 120,
        sastTimeout: p.sastTimeout ?? 300,
        hasWebUi: p.hasWebUi ?? true,
        integrations: {
          serviceAccess: bindings.serviceAccessByProfile?.[p.name] ?? [],
          prProvider: p.prProvider ?? 'github',
          privateRegistries: p.privateRegistries.map((r) => ({
            ...r,
            credential: registryCredential ? { secretId: registryCredential } : null,
            expiresAt: p.registryPatExpiresAt ?? null,
          })),
          deployment: p.deployment
            ? {
                ...p.deployment,
                ...deploymentMapping,
                env: mapValues('deployment.env', p.deployment.env),
              }
            : null,
        },
      });
      const { id: _, name: __, ...setupData } = setupBody;
      const trusted = bindings.trustedByProfile?.[p.name] ?? p.trustedSource === true;
      setupBody.id = stableId('setup', { setupData, trusted });
      const profileId = stableId('profile', replacementName ?? p.name);
      const repoId = remote ? stableId('repository', remote) : null;
      if (remote && repoId) {
        let entry = repos.get(remote);
        if (!entry) {
          entry = {
            id: repoId,
            choices: [],
            trust: new Set(),
            config: repositoryConfigSchema.parse({
              provider: p.prProvider ?? 'github',
              remote,
              setups: [setupBody],
              defaultSetupId: setupBody.id,
            }),
          };
          repos.set(remote, entry);
        }
        if (!entry.config.setups.some((s) => s.id === setupBody.id))
          entry.config.setups.push(setupBody);
        const profileChoice = replacementName ?? p.name;
        if (!entry.choices.includes(profileChoice)) entry.choices.push(profileChoice);
        entry.trust.add(trusted);
        if (trusted && !entry.config.trustedSetupIds.includes(setupBody.id))
          entry.config.trustedSetupIds.push(setupBody.id);
      }
      if (replacementName) {
        if (manifest.blockers.length === before) {
          manifest.bindings.push({
            legacyProfileName: p.name,
            legacyVersion: p.version,
            repositoryId: repoId,
            setupId: repoId ? setupBody.id : null,
            profileId,
            watcher: {
              enabled: bindings.watcherEnabledByProfile?.[p.name] ?? p.issueWatcherEnabled === true,
              labelPrefix: p.issueWatcherLabelPrefix ?? 'autopod',
            },
            memoryScope: {
              repositoryId: repoId,
              setupId: repoId ? setupBody.id : null,
              legacyProfileName: p.name,
            },
            legacyCache: { tag: p.warmImageTag, builtAt: p.warmImageBuiltAt },
          });
          warn(p.name, 'PROFILE_REPLACED');
        }
        continue;
      }
      const dagger = p.sidecars?.dagger;
      const codeIntelligence = bindings.codeIntelligenceVersions;
      const environmentTools: EnvironmentPreset['tools'] = [];
      const codeCapabilities: string[] = [];
      if (p.codeIntelligence?.serena) {
        if (!codeIntelligence?.serena)
          block(p.name, 'codeIntelligence.serena', 'CODE_INTELLIGENCE_VERSION_REQUIRED');
        else {
          environmentTools.push({ name: 'pip:serena-agent', version: codeIntelligence.serena });
          codeCapabilities.push('serena');
        }
      }
      if (p.codeIntelligence?.roslynCodeLens) {
        if (!codeIntelligence?.roslynCodeLens)
          block(p.name, 'codeIntelligence.roslynCodeLens', 'CODE_INTELLIGENCE_VERSION_REQUIRED');
        else {
          environmentTools.push({
            name: 'dotnet:RoslynCodeLens.Mcp',
            version: codeIntelligence.roslynCodeLens,
          });
          codeCapabilities.push('roslyn-codelens');
        }
      }
      const environmentId = add(
        'environment',
        {
          template: p.template ?? 'node22',
          tools: environmentTools,
          capabilities: [
            ...(p.template?.includes('node') ? ['node'] : []),
            ...(p.template?.includes('python') ? ['python'] : []),
            ...(p.template?.includes('dotnet') ? ['dotnet'] : []),
            ...codeCapabilities,
          ],
          sidecars: dagger
            ? [
                {
                  id: 'dagger',
                  type: 'dagger-engine',
                  image: dagger.engineImageDigest,
                  version: dagger.engineVersion,
                  startup: dagger.enabled ? (trusted ? 'always' : 'on-demand') : 'disabled',
                  port: dagger.enginePort ?? 8080,
                },
              ]
            : [],
        },
        `${p.name} environment`,
      );
      if (p.providerFailover == null && !Object.hasOwn(bindings.accountFailover ?? {}, accountId))
        block(p.name, 'providerFailover', 'ACCOUNT_FAILOVER_MAPPING_REQUIRED');
      const failover = p.providerFailover ?? bindings.accountFailover?.[accountId];
      const route = {
        providerAccountId: accountId,
        runtime: p.defaultRuntime ?? 'claude',
        model: p.defaultModel,
        reasoningEffort: p.reasoningEffort ?? 'auto',
        failover: failover?.targets ?? [],
        maxHops: failover?.maxHops ?? failover?.targets.length ?? 0,
      };
      const aiId = add(
        'ai',
        {
          main: route,
          reviewer:
            !p.reviewerModel || p.reviewerModel === p.defaultModel
              ? { mode: 'follow-main' }
              : {
                  mode: 'independent',
                  route: { ...route, model: p.reviewerModel },
                },
        },
        `${p.name} AI`,
      );
      const options = resolvePodOptions(
        p.pod ?? (p.outputMode ? podOptionsFromOutputMode(p.outputMode) : null),
        undefined,
      );
      const skip = mergeValidationPhaseSkips(
        options.validationSuite ?? 'full',
        p.skipValidationPhases,
      );
      if (p.actionPolicy) {
        const policy = p.actionPolicy;
        const hasGithub = policy.enabledGroups.some((g) => g.startsWith('github-'));
        const retiredGroups = new Set(['custom', 'ado-test-pipeline']);
        const hasRetiredActions =
          (policy.customActions?.length ?? 0) > 0 ||
          policy.enabledGroups.some((group) => retiredGroups.has(group));
        if (hasRetiredActions) warn(p.name, 'CUSTOM_ACTIONS_RETIRED');
        const hasOther = policy.enabledGroups.some(
          (g) =>
            !g.startsWith('github-') &&
            !retiredGroups.has(g) &&
            g !== 'azure-pim' &&
            !(g === 'deploy' && deploymentMapping),
        );
        if (hasOther && bindings.serviceAccessByProfile?.[p.name]?.length === 0)
          warn(p.name, 'SCOPED_ACCESS_RETIRED');
        if (
          (hasGithub && !bindings.githubAccessByProfile?.[p.name]) ||
          (hasOther && !bindings.serviceAccessByProfile?.[p.name])
        ) {
          block(p.name, 'actionPolicy', 'ACTION_MAPPING_REQUIRED');
        }
      }
      const workflowId = add(
        'workflow',
        {
          agentMode: options.agentMode,
          output: options.output,
          promotable: options.promotable,
          validationPhases: launchValidationPhaseSchema.options.filter((phase) => {
            if (skip.includes(phase)) return false;
            const commands = {
              lint: p.lintCommand,
              sast: p.sastCommand,
              build: p.buildCommand,
              test: p.testCommand,
            };
            return !(phase in commands) || Boolean(commands[phase as keyof typeof commands]);
          }),
          advisoryBrowserQaEnabled: options.advisoryBrowserQaEnabled ?? false,
          maxValidationAttempts: p.maxValidationAttempts ?? 3,
          mergePollIntervalSec: p.mergePollIntervalSec ?? 60,
          preflightConflictPolicy: p.preflightConflictPolicy ?? 'warn',
          branchPrefix: p.branchPrefix ?? 'autopod/',
          tokenBudget: p.tokenBudget,
          tokenBudgetWarnAt: p.tokenBudgetWarnAt ?? 0.8,
          tokenBudgetPolicy: p.tokenBudgetPolicy ?? 'soft',
          maxBudgetExtensions: p.maxBudgetExtensions,
          escalation: p.escalation,
          agentDonePrompt: p.agentDonePrompt,
          securityScan: p.securityScan,
        },
        `${p.name} workflow`,
      );
      let pack = bindings.resolvedToolPackByProfile?.[p.name];
      if (!pack) {
        if (
          p.claudeMdSections.some((s) => s.fetch) ||
          p.skills.some((s) => s.source.type === 'github')
        ) {
          block(p.name, 'skills', 'RESOLVED_TOOL_MAPPING_REQUIRED');
        }
        pack = parseConfigurationPayload('toolPack', {
          instructions: [
            ...(p.customInstructions
              ? [{ heading: 'Instructions', content: p.customInstructions }]
              : []),
            ...p.claudeMdSections
              .filter((s) => !s.fetch)
              .sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50))
              .map((s) => ({ heading: s.heading, content: s.content ?? '' })),
          ],
          skills: p.skills.filter((s) => s.source.type !== 'github'),
          mcpServers: p.mcpServers
            .map((mcp) => {
              if (mcp.type === 'stdio') {
                return {
                  name: mcp.name,
                  transport: {
                    type: 'stdio',
                    command: mcp.command,
                    args: mcp.args ?? [],
                    env: mapValues(`mcp.${mcp.name}`, mcp.env ?? {}),
                  },
                };
              }
              if ('url' in mcp)
                return {
                  name: mcp.name,
                  transport: {
                    type: 'http',
                    url: mcp.url,
                    headers: mapValues(`mcp.${mcp.name}`, mcp.headers ?? {}),
                  },
                };
              block(p.name, 'mcpServers', 'TOOL_TRANSPORT_MAPPING_REQUIRED');
              return null;
            })
            .filter((mcp) => mcp !== null),
          requiredCapabilities: [],
        });
        if (p.codeIntelligence?.serena)
          pack.mcpServers.push({
            name: 'serena',
            transport: {
              type: 'stdio',
              command: 'serena',
              args: ['start-mcp-server', '--context=claude-code', '--project=/workspace'],
              env: {},
            },
          });
        if (p.codeIntelligence?.roslynCodeLens)
          pack.mcpServers.push({
            name: 'roslyn-codelens',
            transport: {
              type: 'stdio',
              command: 'roslyn-codelens-mcp',
              args: [],
              env: {},
            },
          });
        pack.requiredCapabilities.push(...codeCapabilities);
      }
      const toolPackIds =
        pack.instructions.length || pack.skills.length || pack.mcpServers.length
          ? [add('toolPack', pack, `${p.name} tools`)]
          : [];
      const pim = (bindings.pimByProfile?.[p.name] ?? []).map((selection) =>
        pimSelectionSchema.parse(selection),
      );
      const legacyPim = p.pimActivations ?? [];
      if (
        legacyPim.length !== pim.length ||
        legacyPim.some(
          (old) =>
            !pim.some(
              (mapped) =>
                (old.type === 'group'
                  ? mapped.type === 'group' &&
                    mapped.roleId === old.groupId &&
                    mapped.timing === 'startup'
                  : mapped.type === 'azure-role' &&
                    mapped.roleId === old.roleDefinitionId &&
                    mapped.scope === old.scope &&
                    mapped.timing === 'when-needed') &&
                mapped.duration === (old.duration ?? 'PT8H') &&
                (old.justification === undefined || mapped.justification === old.justification),
            ),
        )
      )
        block(p.name, 'pimActivations', 'EXACT_PIM_MAPPING_REQUIRED');
      const access = bindings.githubAccessByProfile?.[p.name];
      const githubAccessId = access ? add('githubAccess', access, `${p.name} GitHub`) : null;
      if (manifest.blockers.length > before) continue;
      entities.set(profileId, {
        id: profileId,
        kind: 'profile',
        name: p.name,
        payload: parseConfigurationPayload('profile', {
          environmentId,
          aiId,
          workflowId,
          githubAccessId,
          toolPackIds,
          pim,
          workerProfileId: p.workerProfile ? stableId('profile', p.workerProfile) : null,
          execution: {
            target: p.executionTarget ?? 'local',
            main: { memoryGb: p.containerMemoryGb },
            networkPolicy: p.networkPolicy,
            sidecars: dagger
              ? {
                  dagger: {
                    memoryGb: dagger.memoryGb ?? 2,
                    cpus: dagger.cpus ?? 1,
                    storageGb: dagger.storageGb ?? 10,
                  },
                }
              : {},
          },
        }),
      });
      if (p.githubPat)
        manifest.warnings.push({
          profile: p.name,
          code: 'LEGACY_GITHUB_PAT_RETAINED_IN_BACKUP_ONLY',
        });
      manifest.bindings.push({
        legacyProfileName: p.name,
        legacyVersion: p.version,
        repositoryId: repoId,
        setupId: repoId ? setupBody.id : null,
        profileId,
        watcher: {
          enabled: bindings.watcherEnabledByProfile?.[p.name] ?? p.issueWatcherEnabled === true,
          labelPrefix: p.issueWatcherLabelPrefix ?? 'autopod',
        },
        memoryScope: {
          repositoryId: repoId,
          setupId: repoId ? setupBody.id : null,
          legacyProfileName: p.name,
        },
        legacyCache: { tag: p.warmImageTag, builtAt: p.warmImageBuiltAt },
      });
    } catch {
      // Validation errors can include legacy values; the preview reports paths/codes only.
      block(p.name, 'configuration', 'LEGACY_VALUE_REQUIRES_MAPPING');
    }
  }
  for (const [remote, entry] of repos) {
    if (
      entry.trust.size > 1 &&
      entry.choices.some((p) => bindings.trustedByProfile?.[p] === undefined)
    ) {
      for (const p of entry.choices) block(p, 'trustedSource', 'CONFLICTING_REPOSITORY_TRUST');
    }
    const selected = bindings.usualProfileByRemote?.[remote];
    if (selected && !entry.choices.includes(selected))
      block(selected, 'usualProfile', 'INVALID_DEFAULT_MAPPING');
    entry.config.usualProfileId = selected
      ? stableId('profile', selected)
      : entry.choices.length === 1
        ? stableId('profile', entry.choices[0])
        : null;
    if (selected) {
      const setupId = manifest.bindings.find((b) => b.legacyProfileName === selected)?.setupId;
      if (setupId) entry.config.defaultSetupId = setupId;
    }
    if (!entry.config.usualProfileId)
      manifest.warnings.push({
        profile: entry.choices.join(', '),
        code: 'REPOSITORY_DEFAULT_UNSET',
      });
    entities.set(entry.id, {
      id: entry.id,
      kind: 'repository',
      name:
        remote.length <= 128
          ? remote
          : `${remote.slice(0, 103)}-${configurationDigest(remote).slice(0, 24)}`,
      payload: entry.config,
    });
  }
  // An incomplete proposal is never applyable. Do not emit orphaned partial entities.
  manifest.entities = manifest.blockers.length ? [] : [...entities.values()];
  return manifest;
}
