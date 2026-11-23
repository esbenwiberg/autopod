import path from 'node:path';
import type { ManagedPodRequest, ProfileSnapshot, Scope } from '@autopod/shared';
import { parseManagedRecord } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { DaemonGitHubAuth } from '../github/daemon-github-auth.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import {
  chatGptCredential,
  type ManagedAcceptanceRuntime,
  type ManagedProviderAccountReader,
} from './acceptance-config.js';
import type { ManagedComponentsConfig } from './bootstrap.js';
import { canonical, digest } from './canonical.js';
import { ChatGptReportTransport } from './chatgpt-provider.js';
import { createManagedArtifactStore, type ManagedCliConfig } from './cli-config.js';
import { ContainerCodexChannel, codexAgentCommand } from './codex-channel.js';
import type { ManagedGitHubReadConfig } from './github-read-gateway.js';
import { REQUIRED_ENFORCEMENT } from './grants.js';
import {
  isPrivateParentCommit,
  PRIVATE_PARENT_VERIFIER,
  PRIVATE_SUBMISSION_FILE,
} from './private-commit-policy.js';
import { composeManagedRuntime } from './runtime-composition.js';
import { ManagedGitBroker } from './source-git.js';
import { GitHubDraftBroker } from './source-github.js';
import { managedValidationConfigSchema } from './validation-runtime.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/);
const stageSchema = z
  .object({
    profileSnapshot: z.unknown(),
    taskKind: z.enum([
      'research',
      'planning',
      'implementation',
      'verification',
      'review',
      'report',
      'custom',
    ]),
    artifactPath: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/),
    inputNames: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)).max(8),
    privateCommit: z.literal(true).optional(),
    caseDirectory: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,31}$/)
      .optional(),
    sourceMode: z.enum(['none', 'commit', 'branch', 'draft-pr']),
    /** Reviewed command projection for an implementation stage. Presence requires an explicit
     * per-attempt on/off choice carrying this configuration's digest.
     */
    validation: managedValidationConfigSchema.optional(),
  })
  .strict();
const mirrorSchema = z
  .object({
    enrollmentId: id,
    path: z.string().min(1).max(4096),
    remote: id,
    baseRevision: z.string().regex(/^[a-f0-9]{40}$/),
    dependencyCachePath: z
      .string()
      .regex(/^\/opt\/autopod-managed\/[A-Za-z0-9_.-]+\/node_modules$/)
      .optional(),
  })
  .strict();
const sourceSchema = z
  .object({
    repository: id,
    remote: id,
    remoteUrl: z.string().url().startsWith('https://github.com/'),
    base: id,
    baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
    branchNamespace: id,
    verifierPolicy: id,
    verifierIdentity: id,
    githubRepository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    draftBody: z.string().min(1).max(8192),
  })
  .strict();
const schema = z
  .object({
    mode: z.literal('reviewed-profile-set-v1'),
    installationId: id,
    catalogArtifacts: z.boolean().optional(),
    profiles: z.array(stageSchema).min(1).max(8),
    mirror: mirrorSchema,
    image: z
      .string()
      .max(1024)
      .regex(/^(?:sha256:[a-f0-9]{64}|[^\s@:]+(?:[.:][^\s@:]*)*\/[^\s@]+@sha256:[a-f0-9]{64})$/),
    source: sourceSchema.optional(),
    githubRead: z
      .object({
        alias: id,
        bindingDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface ManagedProfileStage extends Omit<z.infer<typeof stageSchema>, 'profileSnapshot'> {
  profileSnapshot: ProfileSnapshot;
}
export interface ManagedProfileSetConfig extends Omit<z.infer<typeof schema>, 'profiles'> {
  profiles: ManagedProfileStage[];
}

export interface ManagedLocalNetwork {
  ensureNetworkForPod(podId: string): Promise<string>;
  removeNetworkForPod(podId: string): Promise<void>;
  generateFirewallScript(
    hosts: string[],
    mode: 'restricted' | 'deny-all',
    gateway?: string,
    extraIps?: string[],
    port?: number,
    includeGateway?: boolean,
  ): Promise<string>;
}

export function parseManagedProfileSetConfig(
  raw: string | undefined,
): ManagedProfileSetConfig | undefined {
  if (raw === undefined) return undefined;
  try {
    if (Buffer.byteLength(raw) > 256 * 1024) throw new Error('invalid');
    const parsed = schema.parse(JSON.parse(raw));
    const profiles = parsed.profiles.map((item) => ({
      ...item,
      profileSnapshot: parseManagedRecord('ProfileSnapshotSchema', item.profileSnapshot),
    }));
    const ids = profiles.map((item) => item.profileSnapshot.profileId);
    const digests = profiles.map((item) => item.profileSnapshot.snapshotDigest);
    if (new Set(ids).size !== ids.length || new Set(digests).size !== digests.length)
      throw new Error('invalid');
    for (const stage of profiles) {
      const scope = stage.profileSnapshot.scope;
      const repository = scope.repositories[0];
      if (
        stage.privateCommit &&
        (parsed.source ||
          parsed.githubRead ||
          parsed.catalogArtifacts ||
          parsed.mirror.dependencyCachePath ||
          parsed.mirror.remote !== 'private' ||
          stage.caseDirectory ||
          stage.validation ||
          stage.sourceMode !== 'commit' ||
          stage.taskKind !== 'implementation' ||
          (stage.artifactPath !== 'report.md' &&
            !(
              stage.artifactPath === PRIVATE_SUBMISSION_FILE &&
              stage.profileSnapshot.route.executionTarget === 'sandbox'
            )) ||
          stage.inputNames.length)
      )
        throw new Error('invalid-private-coding-profile');
      if (
        stage.caseDirectory &&
        (stage.taskKind !== 'research' ||
          stage.sourceMode !== 'none' ||
          stage.artifactPath !== 'report.md' ||
          stage.inputNames.length ||
          stage.validation ||
          parsed.catalogArtifacts ||
          parsed.githubRead ||
          parsed.source ||
          parsed.mirror.dependencyCachePath ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(parsed.mirror.enrollmentId) ||
          stage.profileSnapshot.route.executionTarget !== 'sandbox' ||
          scope.identityBindings.length ||
          scope.network.destinations.length ||
          scope.allowedEffects.some((x) => x !== 'repository.read' && x !== 'artifact.write') ||
          !('maxProviderRequests' in stage.profileSnapshot.budget) ||
          stage.profileSnapshot.budget.maxDurationSeconds > 180 ||
          stage.profileSnapshot.budget.maxProviderRequests !== 1)
      )
        throw new Error('invalid-case-report-profile');
      if (
        stage.profileSnapshot.route.runtime !== 'codex' ||
        !['local', 'sandbox'].includes(stage.profileSnapshot.route.executionTarget) ||
        stage.profileSnapshot.route.executionTarget !==
          profiles[0]?.profileSnapshot.route.executionTarget ||
        (stage.profileSnapshot.route.executionTarget !== 'local' &&
          parsed.image.startsWith('sha256:')) ||
        !('maxProviderRequests' in stage.profileSnapshot.budget) ||
        scope.repositories.length !== 1 ||
        !repository ||
        repository.enrollmentId !== parsed.mirror.enrollmentId ||
        repository.remote !== parsed.mirror.remote ||
        repository.baseRevision !== parsed.mirror.baseRevision ||
        !scope.allowedEffects.includes('repository.read') ||
        !scope.allowedEffects.includes('artifact.write') ||
        scope.allowedEffects.includes('github.issue.read') !==
          (scope.identityBindings.length === 1) ||
        (stage.sourceMode === 'none') !== (repository.access === 'read') ||
        (stage.sourceMode !== 'none' && !stage.privateCommit && !parsed.source) ||
        (stage.validation !== undefined &&
          (stage.taskKind !== 'implementation' ||
            stage.sourceMode === 'none' ||
            !scope.allowedEffects.includes('test.run'))) ||
        !path.isAbsolute(parsed.mirror.path) ||
        (scope.identityBindings.length > 0 &&
          (!parsed.githubRead ||
            scope.identityBindings.length !== 1 ||
            canonical(scope.identityBindings[0]) !==
              canonical({
                alias: parsed.githubRead.alias,
                bindingDigest: parsed.githubRead.bindingDigest,
              }) ||
            !scope.allowedEffects.includes('github.issue.read')))
      )
        throw new Error('invalid');
    }
    const sourceStages = profiles.filter(
      (stage) => stage.sourceMode !== 'none' && !stage.privateCommit,
    );
    const identityStages = profiles.filter(
      (stage) => stage.profileSnapshot.scope.identityBindings.length > 0,
    );
    const repository = profiles[0]?.profileSnapshot.scope.repositories[0];
    if (
      Boolean(parsed.source) !== sourceStages.length > 0 ||
      Boolean(parsed.githubRead) !== identityStages.length > 0 ||
      (parsed.source &&
        (!repository ||
          parsed.source.repository !== parsed.mirror.enrollmentId ||
          parsed.source.remote !== parsed.mirror.remote ||
          parsed.source.baseCommit !== parsed.mirror.baseRevision ||
          parsed.source.branchNamespace !== repository.branchNamespace ||
          (parsed.githubRead && parsed.githubRead.repository !== parsed.source.githubRepository)))
    )
      throw new Error('invalid');
    return { ...parsed, profiles };
  } catch {
    throw new Error('managed-profile-set-config-invalid');
  }
}

export function unionScope(profiles: readonly ManagedProfileStage[]): Scope {
  const scopes = profiles.map((item) => item.profileSnapshot.scope);
  const first = scopes[0];
  if (!first) throw new Error('managed-profile-set-empty');
  const repositories = new Map<string, Scope['repositories'][number]>();
  for (const repository of scopes.flatMap((scope) => scope.repositories)) {
    const prior = repositories.get(repository.enrollmentId);
    if (!prior || repository.access === 'write')
      repositories.set(repository.enrollmentId, repository);
  }
  return {
    repositories: [...repositories.values()],
    network: {
      profileId: first.network.profileId,
      destinations: [...new Set(scopes.flatMap((scope) => scope.network.destinations))],
    },
    identityBindings: [
      ...new Map(
        scopes
          .flatMap((scope) => scope.identityBindings)
          .map((binding) => [canonical(binding), binding]),
      ).values(),
    ],
    allowedEffects: [...new Set(scopes.flatMap((scope) => scope.allowedEffects))],
  };
}

export function profileSetRequestPolicy(
  config: ManagedProfileSetConfig,
): (request: ManagedPodRequest) => void {
  return (request) => {
    const stages = config.profiles.filter(
      (stage) => stage.profileSnapshot.snapshotDigest === request.profileSnapshot.snapshotDigest,
    );
    const stage = stages[0];
    const names = request.inputArtifacts.map((input) => input.name);
    const validation = request.validation.autopod;
    if (
      (request.task.contextFiles?.length ?? 0) > 0 ||
      !stage ||
      stages.length !== 1 ||
      request.task.kind !== stage.taskKind ||
      request.outputs.source.mode !== stage.sourceMode ||
      Boolean(stage.privateCommit) !== isPrivateParentCommit(request) ||
      (stage.privateCommit &&
        (request.outputs.source.mode !== 'commit' ||
          request.outputs.source.remote !== 'private' ||
          request.outputs.source.repository !== config.mirror.enrollmentId ||
          request.validation.verifierPolicy !== PRIVATE_PARENT_VERIFIER)) ||
      (stage.sourceMode !== 'none' &&
        !stage.privateCommit &&
        (!config.source ||
          request.outputs.source.repository !== config.source.repository ||
          request.outputs.source.remote !== config.source.remote ||
          request.outputs.source.base !== config.source.base ||
          request.validation.verifierPolicy !== config.source.verifierPolicy)) ||
      canonical(request.outputs.artifacts.requiredPaths) !== canonical([stage.artifactPath]) ||
      canonical(request.outputs.artifacts.include) !== canonical([stage.artifactPath]) ||
      canonical(names) !== canonical(stage.inputNames) ||
      Boolean(validation) !== Boolean(stage.validation) ||
      (stage.validation && validation?.configurationDigest !== digest(stage.validation))
    )
      throw new Error('managed-profile-stage-mismatch');
  };
}

export function composeManagedProfileSet(
  config: ManagedProfileSetConfig,
  cli: ManagedCliConfig | undefined,
  dependencies: {
    db: Database.Database;
    databasePath: string;
    manager: ContainerManager | undefined;
    ownsInstallation?: (installation: string) => boolean;
    sandboxCheckpoints?: boolean;
    sandboxCoding?: { resourceScopeDigest: string; readyDiskImageId: string };
    networkManager?: ManagedLocalNetwork;
    providerAccounts: ManagedProviderAccountReader;
    githubAuth: DaemonGitHubAuth;
  },
): ManagedAcceptanceRuntime &
  Pick<ReturnType<typeof composeManagedRuntime>, 'withCheckpoint'> & {
    privateRuntime: ReturnType<typeof composeManagedRuntime>['runtime'];
    sandboxCoding?: { resourceScopeDigest: string; readyDiskImageId: string };
  } {
  const manager = dependencies.manager;
  if (
    !cli ||
    !manager ||
    !cli.bindings.some((item) => item.installationId === config.installationId)
  )
    throw new Error('managed-profile-set-cli-binding-required');
  if (config.profiles.some((stage) => stage.privateCommit) && !dependencies.ownsInstallation)
    throw new Error('parent-private-runtime-partition-required');
  const target = config.profiles[0]!.profileSnapshot.route.executionTarget;
  const sandboxCoding = dependencies.sandboxCoding;
  const privateCoding = config.profiles.some((s) => s.privateCommit);
  if (
    Boolean(sandboxCoding) !== (privateCoding && target === 'sandbox') ||
    (sandboxCoding &&
      (!dependencies.sandboxCheckpoints ||
        !manager.executionResourceScope ||
        digest(manager.executionResourceScope) !== sandboxCoding.resourceScopeDigest ||
        manager.readyDiskImageId !== sandboxCoding.readyDiskImageId))
  )
    throw new Error('parent-sandbox-coding-runtime-mismatch');
  const caseReports = config.profiles.some((s) => s.caseDirectory);
  if (
    caseReports &&
    (!dependencies.sandboxCheckpoints ||
      !dependencies.ownsInstallation ||
      config.profiles.some((s) => !s.caseDirectory))
  )
    throw new Error('case-report-private-runtime-required');
  const network = dependencies.networkManager;
  if (target === 'local' && !network) throw new Error('managed-local-network-required');
  const store = createManagedArtifactStore(cli, dependencies.db);
  const ceiling = unionScope(config.profiles);
  const requestPolicy = profileSetRequestPolicy(config);
  let source: ManagedComponentsConfig['source'];
  if (config.source) {
    const sourceConfig = config.source;
    const credential = async () => ({
      token: (await dependencies.githubAuth.resolveCredential()).token,
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    });
    const git = new ManagedGitBroker(
      [
        {
          ...sourceConfig,
          credentialMode: 'github-basic',
          workspace: (podId) =>
            path.join(
              path.dirname(path.resolve(dependencies.databasePath)),
              'managed',
              'workspaces',
              podId,
              sourceConfig.repository,
            ),
        },
      ],
      credential,
    );
    const drafts = new GitHubDraftBroker(
      new Map([[sourceConfig.repository, sourceConfig.githubRepository]]),
      async () => (await dependencies.githubAuth.resolveCredential()).token,
      async (bodyDigest) => {
        const { sha256 } = await import('./canonical.js');
        if (sha256(Buffer.from(sourceConfig.draftBody)) !== bodyDigest)
          throw new Error('source-body-digest-mismatch');
        return sourceConfig.draftBody;
      },
    );
    source = {
      git,
      drafts,
      verifierIdentities: new Map([[sourceConfig.verifierPolicy, sourceConfig.verifierIdentity]]),
    };
  }
  const components = composeManagedRuntime({
    db: dependencies.db,
    ownsInstallation: dependencies.ownsInstallation,
    sandboxCheckpoints: dependencies.sandboxCheckpoints,
    sandboxCodingCheckpoints: Boolean(sandboxCoding),
    store,
    enabled: true,
    source,
    runtimeCapabilities: [
      ...(caseReports ? [] : ['managed-agent-session-v1' as const]),
      ...(config.githubRead ? (['managed-github-read-v1'] as const) : []),
    ],
    stateRoot: path.join(path.dirname(path.resolve(dependencies.databasePath)), 'managed'),
    mirrors: [config.mirror],
    admission: {
      profiles: new Map(
        config.profiles.map((stage) => [
          stage.profileSnapshot.snapshotDigest,
          stage.profileSnapshot,
        ]),
      ),
      enrollmentCeiling: ceiling,
      identityCeiling: ceiling,
      backendCeiling: ceiling,
      enforcement: REQUIRED_ENFORCEMENT,
      targets: [target],
      requestPolicy,
    },
    bindings: config.profiles.map((stage) => {
      const route = stage.profileSnapshot.route;
      const budget = stage.profileSnapshot.budget;
      if (!('maxProviderRequests' in budget)) throw new Error('managed-profile-set-budget-mode');
      const initial = chatGptCredential(dependencies.providerAccounts, route.providerAccountId);
      const usesGitHub = stage.profileSnapshot.scope.identityBindings.length > 0;
      const githubRead = usesGitHub ? config.githubRead : undefined;
      if (usesGitHub && !githubRead) throw new Error('managed-github-read-broker-required');
      return {
        profileId: stage.profileSnapshot.profileId,
        route,
        manager,
        image: config.image,
        command: stage.caseDirectory
          ? [
              'python3',
              '/opt/dispatcher/case_report.py',
              '--repository',
              `/repositories/${config.mirror.enrollmentId}`,
              '--case',
              stage.caseDirectory,
              '--model',
              route.model,
              '--reasoning',
              route.reasoning,
            ]
          : [
              ...codexAgentCommand(
                route,
                config.mirror.enrollmentId,
                stage.artifactPath,
                stage.sourceMode !== 'none',
                stage.inputNames,
                githubRead?.repository,
              ),
              ...(stage.privateCommit && stage.artifactPath === PRIVATE_SUBMISSION_FILE
                ? ['--private-change-submission']
                : []),
            ],
        ...(config.mirror.dependencyCachePath
          ? {
              dependencyCache: {
                enrollmentId: config.mirror.enrollmentId,
                path: config.mirror.dependencyCachePath,
              },
            }
          : {}),
        ...(stage.validation
          ? { validation: { configuration: structuredClone(stage.validation) } }
          : {}),
        transport: new ChatGptReportTransport(
          route,
          initial.chatgptAccountId,
          async () => chatGptCredential(dependencies.providerAccounts, route.providerAccountId),
          fetch,
          undefined,
          stage.caseDirectory ? 'report' : 'agent',
        ),
        channel: new ContainerCodexChannel(manager, route, 0, {
          mode: stage.caseDirectory ? 'case-report' : 'agent',
          maximumDurationSeconds: budget.maxDurationSeconds,
          ...(githubRead ? { githubRead } : {}),
        }),
        ...(githubRead
          ? {
              githubRead: {
                config: githubRead as ManagedGitHubReadConfig,
                auth: dependencies.githubAuth,
              },
            }
          : {}),
        maximumRequests: budget.maxProviderRequests,
        network: async (request: ManagedPodRequest, podId: string) => {
          if (target !== 'local' || !network) return {};
          const destinations = request.effectiveGrant.scope.network.destinations;
          const firewallScript = await network.generateFirewallScript(
            destinations,
            destinations.length ? 'restricted' : 'deny-all',
            undefined,
            [],
            3100,
            false,
          );
          return { firewallScript, networkName: await network.ensureNetworkForPod(podId) };
        },
        ...(target === 'local' && network
          ? { cleanupNetwork: (podId: string) => network.removeNetworkForPod(podId) }
          : {}),
      };
    }),
  });
  return {
    components,
    withCheckpoint: components.withCheckpoint,
    privateRuntime: components.runtime,
    sandboxCoding,
    config: { db: dependencies.db, store },
    bindings: cli.bindings,
    resume: (profileIds?: ReadonlySet<string>) => components.resume(profileIds),
    close: () => components.close(),
  };
}
