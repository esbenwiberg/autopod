import path from 'node:path';
import type { ManagedPodRequest, ProfileSnapshot, Scope } from '@autopod/shared';
import { parseManagedRecord } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { DaemonGitHubAuth } from '../github/daemon-github-auth.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import {
  type ManagedAcceptanceRuntime,
  type ManagedProviderAccountReader,
  chatGptCredential,
} from './acceptance-config.js';
import { AzureBlobArtifactStore, ManagedIdentityBlobTransport } from './artifact-store.js';
import type { ManagedComponentsConfig } from './bootstrap.js';
import { canonical } from './canonical.js';
import { ChatGptReportTransport } from './chatgpt-provider.js';
import type { ManagedCliConfig } from './cli-config.js';
import { ContainerCodexChannel, codexAgentCommand } from './codex-channel.js';
import type { ManagedGitHubReadConfig } from './github-read-gateway.js';
import { REQUIRED_ENFORCEMENT } from './grants.js';
import { composeManagedRuntime } from './runtime-composition.js';
import { ManagedGitBroker } from './source-git.js';
import { GitHubDraftBroker } from './source-github.js';

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
    sourceMode: z.enum(['none', 'commit', 'branch', 'draft-pr']),
  })
  .strict();
const mirrorSchema = z
  .object({
    enrollmentId: id,
    path: z.string().min(1).max(4096),
    remote: id,
    baseRevision: z.string().regex(/^[a-f0-9]{40}$/),
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
    profiles: z.array(stageSchema).min(1).max(8),
    mirror: mirrorSchema,
    image: z
      .string()
      .max(1024)
      .regex(/^[^\s@:]+(?:[.:][^\s@:]*)*\/[^\s@]+@sha256:[a-f0-9]{64}$/),
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
        stage.profileSnapshot.route.runtime !== 'codex' ||
        stage.profileSnapshot.route.executionTarget !== 'sandbox' ||
        !('maxProviderRequests' in stage.profileSnapshot.budget) ||
        scope.repositories.length !== 1 ||
        !repository ||
        repository.enrollmentId !== parsed.mirror.enrollmentId ||
        repository.remote !== parsed.mirror.remote ||
        repository.baseRevision !== parsed.mirror.baseRevision ||
        scope.network.destinations.length !== 0 ||
        !scope.allowedEffects.includes('repository.read') ||
        !scope.allowedEffects.includes('artifact.write') ||
        scope.allowedEffects.includes('github.issue.read') !==
          (scope.identityBindings.length === 1) ||
        (stage.sourceMode === 'none') !== (repository.access === 'read') ||
        (stage.sourceMode !== 'none' && !parsed.source) ||
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
    const sourceStages = profiles.filter((stage) => stage.sourceMode !== 'none');
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

function unionScope(profiles: readonly ManagedProfileStage[]): Scope {
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
    network: first.network,
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
    if (
      !stage ||
      stages.length !== 1 ||
      request.task.kind !== stage.taskKind ||
      request.outputs.source.mode !== stage.sourceMode ||
      (stage.sourceMode !== 'none' &&
        (!config.source ||
          request.outputs.source.repository !== config.source.repository ||
          request.outputs.source.remote !== config.source.remote ||
          request.outputs.source.base !== config.source.base ||
          request.validation.verifierPolicy !== config.source.verifierPolicy)) ||
      canonical(request.outputs.artifacts.requiredPaths) !== canonical([stage.artifactPath]) ||
      canonical(request.outputs.artifacts.include) !== canonical([stage.artifactPath]) ||
      canonical(names) !== canonical(stage.inputNames)
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
    providerAccounts: ManagedProviderAccountReader;
    githubAuth: DaemonGitHubAuth;
  },
): ManagedAcceptanceRuntime {
  const manager = dependencies.manager;
  if (
    !cli ||
    !manager ||
    !cli.bindings.some((item) => item.installationId === config.installationId)
  )
    throw new Error('managed-profile-set-cli-binding-required');
  const transport = new ManagedIdentityBlobTransport(cli.blobContainerUrl);
  const store = new AzureBlobArtifactStore(transport, async (artifactId) => {
    const row = dependencies.db
      .prepare('SELECT blob_manifest_name FROM artifact_exports WHERE artifact_id=?')
      .get(artifactId) as { blob_manifest_name: string } | undefined;
    if (!row?.blob_manifest_name.endsWith('/manifest.json'))
      throw new Error('artifact-unregistered');
    return row.blob_manifest_name.slice(0, -'/manifest.json'.length);
  });
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
    store,
    enabled: true,
    source,
    runtimeCapabilities: [
      'managed-agent-session-v1',
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
      targets: ['sandbox'],
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
        command: codexAgentCommand(
          route,
          config.mirror.enrollmentId,
          stage.artifactPath,
          stage.sourceMode !== 'none',
          stage.inputNames,
          githubRead?.repository,
        ),
        transport: new ChatGptReportTransport(
          route,
          initial.chatgptAccountId,
          async () => chatGptCredential(dependencies.providerAccounts, route.providerAccountId),
          fetch,
          undefined,
          'agent',
        ),
        channel: new ContainerCodexChannel(manager, route, 0, {
          mode: 'agent',
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
        network: () => ({}),
      };
    }),
  });
  return {
    components,
    config: { db: dependencies.db, store },
    bindings: cli.bindings,
    resume: () => components.resume(),
    close: () => components.close(),
  };
}
