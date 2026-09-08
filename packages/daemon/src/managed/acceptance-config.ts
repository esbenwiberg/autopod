import path from 'node:path';
import type { ManagedPodRequest, ProviderAccount } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ContainerManager } from '../interfaces/container-manager.js';
import {
  type ArtifactStore,
  AzureBlobArtifactStore,
  ManagedIdentityBlobTransport,
} from './artifact-store.js';
import type { managedComponents } from './bootstrap.js';
import { canonical } from './canonical.js';
import { type ChatGptCredential, ChatGptReportTransport } from './chatgpt-provider.js';
import type { ManagedCliConfig } from './cli-config.js';
import { ContainerCodexChannel, codexReportCommand } from './codex-channel.js';
import { REQUIRED_ENFORCEMENT, validateManagedRequest } from './grants.js';
import { composeManagedRuntime } from './runtime-composition.js';
import type { ManagedUserBinding } from './user-auth.js';

const mirrorSchema = z
  .object({
    enrollmentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
    path: z.string().min(1).max(4096),
    remote: z.string().min(1).max(4096),
    baseRevision: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .strict();
const configSchema = z
  .object({
    mode: z.literal('single-job-canary-v1'),
    installationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    request: z.unknown(),
    mirror: mirrorSchema,
    image: z
      .string()
      .max(1024)
      .regex(/^[^\s@:]+(?:[.:][^\s@:]*)*\/[^\s@]+@sha256:[a-f0-9]{64}$/),
  })
  .strict();

export interface ManagedAcceptanceConfig {
  mode: 'single-job-canary-v1';
  installationId: string;
  request: ManagedPodRequest;
  mirror: z.infer<typeof mirrorSchema>;
  image: string;
}

export interface ManagedAcceptanceRuntime {
  components: ReturnType<typeof managedComponents>;
  db: Database.Database;
  store: ArtifactStore;
  bindings: readonly ManagedUserBinding[];
  resume(): Promise<void>;
  close(): void;
}

export interface ManagedProviderAccountReader {
  get(id: string): ProviderAccount;
}

/** Parse one complete, non-secret request. There is deliberately no general enable flag. */
export function parseManagedAcceptanceConfig(
  raw: string | undefined,
): ManagedAcceptanceConfig | undefined {
  if (raw === undefined) return undefined;
  try {
    if (Buffer.byteLength(raw) > 256 * 1024) throw new Error('invalid');
    const parsed = configSchema.parse(JSON.parse(raw));
    const request = validateManagedRequest(parsed.request);
    const scope = request.effectiveGrant.scope;
    const profileScope = request.profileSnapshot.scope;
    const budget = request.effectiveGrant.budget;
    const profileBudget = request.profileSnapshot.budget;
    const repository = scope.repositories[0];
    if (
      request.route.executionTarget !== 'sandbox' ||
      request.route.runtime !== 'codex' ||
      !('maxProviderRequests' in budget) ||
      !('maxProviderRequests' in profileBudget) ||
      budget.maxProviderRequests !== 1 ||
      profileBudget.maxProviderRequests !== 1 ||
      budget.maxDurationSeconds > 180 ||
      profileBudget.maxDurationSeconds > 180 ||
      scope.repositories.length !== 1 ||
      profileScope.repositories.length !== 1 ||
      !repository ||
      repository.access !== 'read' ||
      scope.network.destinations.length !== 0 ||
      scope.identityBindings.length !== 0 ||
      canonical([...scope.allowedEffects].sort()) !==
        canonical(['artifact.write', 'repository.read']) ||
      canonical(scope) !== canonical(profileScope) ||
      request.outputs.source.mode !== 'none' ||
      request.outputs.artifacts.mode !== 'required' ||
      canonical(request.outputs.artifacts.requiredPaths) !== canonical(['report.md']) ||
      canonical(request.outputs.artifacts.include) !== canonical(['report.md']) ||
      request.outputs.artifacts.limits.maxFiles !== 1 ||
      request.outputs.artifacts.limits.maxFileBytes > 16 * 1024 ||
      request.outputs.artifacts.limits.maxTotalBytes > 16 * 1024 ||
      request.inputArtifacts.length !== 0 ||
      parsed.mirror.enrollmentId !== repository.enrollmentId ||
      parsed.mirror.remote !== repository.remote ||
      parsed.mirror.baseRevision !== repository.baseRevision ||
      !path.isAbsolute(parsed.mirror.path)
    ) {
      throw new Error('invalid');
    }
    return { ...parsed, request };
  } catch {
    throw new Error('managed-acceptance-config-invalid');
  }
}

function chatGptCredential(
  providerAccounts: ManagedProviderAccountReader,
  accountId: string,
): ChatGptCredential {
  const account = providerAccounts.get(accountId);
  const credentials = account.credentials;
  if (
    account.provider !== 'openai' ||
    credentials?.provider !== 'openai' ||
    credentials.authMode !== 'chatgpt' ||
    !credentials.authJson
  ) {
    throw new Error('managed-provider-account-invalid');
  }
  try {
    const auth = z
      .object({
        auth_mode: z.literal('chatgpt'),
        tokens: z
          .object({ access_token: z.string().min(1), account_id: z.string().min(1).max(200) })
          .passthrough(),
      })
      .passthrough()
      .parse(JSON.parse(credentials.authJson));
    return {
      accountId,
      mode: 'chatgpt',
      chatgptAccountId: auth.tokens.account_id,
      token: auth.tokens.access_token,
    };
  } catch {
    throw new Error('managed-provider-account-invalid');
  }
}

export function composeManagedAcceptance(
  config: ManagedAcceptanceConfig,
  cli: ManagedCliConfig | undefined,
  dependencies: {
    db: Database.Database;
    databasePath: string;
    manager: ContainerManager | undefined;
    providerAccounts: ManagedProviderAccountReader;
  },
): ManagedAcceptanceRuntime {
  if (
    !cli ||
    cli.bindings.length !== 1 ||
    cli.bindings[0]?.installationId !== config.installationId ||
    !dependencies.manager
  ) {
    throw new Error('managed-acceptance-dependency-invalid');
  }
  const rows = dependencies.db
    .prepare('SELECT dispatcher_installation_id, request_json FROM managed_pods')
    .all() as Array<{ dispatcher_installation_id: string; request_json: string }>;
  if (
    rows.length > 1 ||
    rows.some(
      (row) =>
        row.dispatcher_installation_id !== config.installationId ||
        canonical(JSON.parse(row.request_json)) !== canonical(config.request),
    )
  ) {
    throw new Error('managed-acceptance-existing-attempt-conflict');
  }

  const transport = new ManagedIdentityBlobTransport(cli.blobContainerUrl);
  const store = new AzureBlobArtifactStore(transport, async (id) => {
    const row = dependencies.db
      .prepare('SELECT blob_manifest_name FROM artifact_exports WHERE artifact_id=?')
      .get(id) as { blob_manifest_name: string } | undefined;
    if (!row || !row.blob_manifest_name.endsWith('/manifest.json'))
      throw new Error('artifact-unregistered');
    return row.blob_manifest_name.slice(0, -'/manifest.json'.length);
  });
  const initial = chatGptCredential(
    dependencies.providerAccounts,
    config.request.route.providerAccountId,
  );
  const provider = new ChatGptReportTransport(
    config.request.route,
    initial.chatgptAccountId,
    async () =>
      chatGptCredential(dependencies.providerAccounts, config.request.route.providerAccountId),
  );
  const channel = new ContainerCodexChannel(dependencies.manager, config.request.route, 0);
  const scope = config.request.effectiveGrant.scope;
  const components = composeManagedRuntime({
    db: dependencies.db,
    admission: {
      profiles: new Map([
        [config.request.profileSnapshot.snapshotDigest, config.request.profileSnapshot],
      ]),
      enrollmentCeiling: scope,
      identityCeiling: scope,
      backendCeiling: scope,
      enforcement: REQUIRED_ENFORCEMENT,
      targets: ['sandbox'],
      expectedRequest: config.request,
    },
    store,
    stateRoot: path.join(path.dirname(path.resolve(dependencies.databasePath)), 'managed'),
    enabled: true,
    mirrors: [config.mirror],
    bindings: [
      {
        route: config.request.route,
        manager: dependencies.manager,
        image: config.image,
        command: codexReportCommand(config.request.route, config.mirror.enrollmentId),
        transport: provider,
        channel,
        maximumRequests: 1,
        network: () => ({}),
      },
    ],
  });
  return {
    components,
    db: dependencies.db,
    store,
    bindings: cli.bindings,
    resume: () => components.resume(),
    close: () => components.close(),
  };
}
