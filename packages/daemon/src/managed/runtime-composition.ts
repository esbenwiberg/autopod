import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import type { FollowUpEnvelope, ManagedPodRequest, Route } from '@autopod/shared';
import type { DaemonGitHubAuth } from '../github/daemon-github-auth.js';
import type { ContainerManager, ContainerSpawnConfig } from '../interfaces/container-manager.js';
import { type ManagedComponentsConfig, managedComponents } from './bootstrap.js';
import type { BoundedProviderTransport } from './bounded-provider.js';
import { canonical } from './canonical.js';
import { ManagedContainerRuntime } from './container-runtime.js';
import { type ManagedGitHubReadConfig, ManagedGitHubReadGateway } from './github-read-gateway.js';
import type { ManagedPodRow } from './managed-service.js';
import { ManagedProviderGateway } from './provider-gateway.js';
import { ManagedPublicReadGateway } from './public-read-gateway.js';
import { ManagedQuotaFeed } from './quota-feed.js';
import type { ManagedValidationConfig } from './validation.js';
import { ManagedSupervisedValidation } from './validation-runtime.js';
import { type ManagedRepositoryMirror, ManagedWorkspaces } from './workspaces.js';

export interface ManagedWorkerProviderChannel {
  /** Prove the reviewed command uses only this gateway and cannot reach a direct provider. */
  preflight(request: ManagedPodRequest): Promise<void>;
  /** Trusted host binding. The worker cannot select installation, pod, revision or route. */
  attach(binding: {
    podId: string;
    runtimeRef: string;
    stateRoot: string;
    /** Recover only the host side of an existing live channel; never install or spawn. */
    existingOnly?: true;
    invoke: (
      key: string,
      prompt: string,
      maximumTokens: number,
    ) => ReturnType<ManagedProviderGateway['invoke']>;
    invokeGitHub?: (key: string, request: string) => Promise<string>;
    invokePublic?: (key: string, request: string) => Promise<string>;
  }): Promise<() => void>;
  /** Queue one digest-bound follow-up inside the already-bound runtime. */
  send?(
    runtimeRef: string,
    stateRoot: string,
    message: FollowUpEnvelope,
    key: string,
  ): Promise<void>;
}
export interface ManagedRuntimeBinding {
  publicRead?: boolean;
  route: Route;
  /** Optional stage binding when several reviewed profiles share one exact route. */
  profileId?: string;
  manager: ContainerManager;
  image: string;
  command: readonly string[];
  /** Image-internal immutable dependency tree linked from the reviewed repository checkout. */
  dependencyCache?: { enrollmentId: string; path: string };
  /** Frozen projection of AutoPod deterministic validation; omission keeps validation dark. */
  validation?: { configuration: ManagedValidationConfig };
  transport: BoundedProviderTransport;
  channel: ManagedWorkerProviderChannel;
  maximumRequests?: number;
  githubRead?: {
    config: ManagedGitHubReadConfig;
    auth: DaemonGitHubAuth;
    transport?: typeof fetch;
  };
  /** Reviewed target networking; volumes, environment and identity are supplied below. */
  network(
    request: ManagedPodRequest,
    podId: string,
  ):
    | Pick<ContainerSpawnConfig, 'firewallScript' | 'networkName'>
    | Promise<Pick<ContainerSpawnConfig, 'firewallScript' | 'networkName'>>;
  cleanupNetwork?(podId: string): Promise<void>;
}
export interface ManagedRuntimeCompositionConfig extends Omit<ManagedComponentsConfig, 'runtime'> {
  mirrors: readonly ManagedRepositoryMirror[];
  sandboxCheckpoints?: boolean;
  bindings: readonly ManagedRuntimeBinding[];
}

/** Library composition only: never discovers credentials, changes native config or starts a listener.
 * The selected runtime's channel is a reviewed deployment input, not inferred from a profile name.
 */
import { ownedRuntimeRow } from './owned-runtime-row.js';

export function composeManagedRuntime(config: ManagedRuntimeCompositionConfig) {
  const identities = config.bindings.map((binding) =>
    canonical({
      route: binding.route,
      profileId: binding.profileId ?? null,
    }),
  );
  if (new Set(identities).size !== identities.length) throw new Error('managed-route-ambiguous');
  const bindings = config.bindings.map((binding) => ({
    ...binding,
    route: structuredClone(binding.route),
    command: [...binding.command],
    ...(binding.validation
      ? { validation: { configuration: structuredClone(binding.validation.configuration) } }
      : {}),
  }));
  let closed = false;
  const channels = new Map<string, () => void>();
  const pending = new Map<string, Promise<void>>();
  const rowFor = (ref: string) => ownedRuntimeRow(config.db, ref, config.ownsInstallation);
  const workspaces = new ManagedWorkspaces(
    config.db,
    path.join(config.stateRoot, 'workspaces'),
    config.mirrors,
  );
  // This scope exists only while the owner is restoring an admitted continuation.
  // It is not a request field. Ordinary managed starts keep the enrolled mirror.
  const checkpointScope = new AsyncLocalStorage<{
    run: string;
    repository: string;
    commit: string;
    mirror: string;
  }>();
  const prepareWorkspaces = async (podId: string, request: ManagedPodRequest) => {
    const owner = config.db
      .prepare('SELECT dispatcher_installation_id FROM managed_pods WHERE pod_id=?')
      .pluck()
      .get(podId);
    const cp = checkpointScope.getStore();
    if (typeof owner !== 'string') throw new Error('managed-workspace-owner-missing');
    if (!owner.startsWith('native.') && !cp) return workspaces.prepare(podId, request);
    const [repo] = request.effectiveGrant.scope.repositories;
    const enrolled = config.mirrors.filter((m) => m.enrollmentId === repo?.enrollmentId);
    if (
      !cp ||
      owner !== 'native.' + cp.run ||
      (request.route.executionTarget !== 'local' &&
        !(
          request.route.executionTarget === 'sandbox' &&
          config.sandboxCheckpoints &&
          repo?.access === 'read'
        )) ||
      request.effectiveGrant.scope.repositories.length !== 1 ||
      !repo ||
      repo.baseRevision !== cp.commit ||
      repo.enrollmentId !== cp.repository ||
      enrolled.length !== 1 ||
      enrolled[0]?.remote !== repo.remote
    )
      throw new Error('managed-checkpoint-workspace-binding');
    const source = { ...enrolled[0]!, path: cp.mirror, baseRevision: cp.commit };
    return new ManagedWorkspaces(config.db, workspaces.root, [source]).prepare(podId, request);
  };
  const attach = async (
    index: number,
    podId: string,
    ref: string,
    root: string,
    existingOnly?: true,
  ) => {
    if (closed) throw new Error('managed-composition-closed');
    if (channels.has(podId)) return;
    const existing = pending.get(podId);
    if (existing) return existing;
    const run = async () => {
      const row = rowFor(ref);
      const binding = bindings[index]!;
      if (!row || row.pod_id !== podId || root !== `/run/dispatcher-${podId}`)
        throw new Error('managed-channel-binding');
      components.service.requireActive(row);
      const request = JSON.parse(row.request_json) as ManagedPodRequest;
      if (canonical(request.route) !== canonical(binding.route))
        throw new Error('managed-channel-route');
      gateways[index]!.preflight(request);
      await binding.channel.preflight(request);
      publicGateways[index]?.preflight(request);
      const stop = await binding.channel.attach({
        podId,
        runtimeRef: ref,
        stateRoot: root,
        ...(existingOnly ? { existingOnly } : {}),
        invoke: (key, prompt, maximumTokens) =>
          gateways[index]!.invoke(
            row.dispatcher_installation_id,
            podId,
            row.grant_revision,
            key,
            prompt,
            maximumTokens,
          ),
        ...(publicGateways[index]
          ? {
              invokePublic: (key: string, request: string) =>
                publicGateways[index]!.invoke(
                  row.dispatcher_installation_id,
                  podId,
                  row.grant_revision,
                  key,
                  request,
                ),
            }
          : {}),
        ...(githubGateways[index]
          ? {
              invokeGitHub: (key: string, request: string) =>
                githubGateways[index]!.invoke(
                  row.dispatcher_installation_id,
                  podId,
                  row.grant_revision,
                  key,
                  request,
                ),
            }
          : {}),
      });
      try {
        if (closed) throw new Error('managed-composition-closed');
        components.service.requireActive(
          components.service.row(row.dispatcher_installation_id, podId),
        );
        if ('maxTokens' in request.effectiveGrant.budget)
          await feeds[index]!.attach(row.dispatcher_installation_id, podId, ref, root);
        if (closed) throw new Error('managed-composition-closed');
        channels.set(podId, stop);
      } catch (error) {
        feeds[index]!.detach(podId);
        stop();
        throw error;
      }
    };
    const task = run();
    pending.set(podId, task);
    try {
      await task;
    } finally {
      pending.delete(podId);
    }
  };
  const runtime = new ManagedContainerRuntime(
    bindings.map((binding, index) => ({
      route: binding.route,
      profileId: binding.profileId,
      identityBinding: binding.githubRead
        ? {
            alias: binding.githubRead.config.alias,
            bindingDigest: binding.githubRead.config.bindingDigest,
          }
        : undefined,
      manager: binding.manager,
      image: binding.image,
      command: binding.command,
      dependencyCache: binding.dependencyCache,
      cleanupNetwork: binding.cleanupNetwork,
      sourceWorkspace: (podId: string, repositoryId: string) =>
        workspaces.path(podId, repositoryId),
      quotaReady: async (request) => {
        if (closed) throw new Error('managed-composition-closed');
        gateways[index]!.preflight(request);
        await binding.channel.preflight(request);
        return true;
      },
      prepare: async (podId, request) => {
        const cp = checkpointScope.getStore();
        const volumes = await prepareWorkspaces(podId, request);
        for (const input of components.service.inputs!.mounts(podId))
          volumes.push({ host: input.hostPath, container: input.containerPath, readOnly: true });
        return {
          ...(cp && request.route.executionTarget === 'sandbox'
            ? { sandboxCheckpoint: { repository: cp.repository, commit: cp.commit } }
            : {}),
          ...(await binding.network(request, podId)),
          podId,
          image: binding.image,
          env: {},
          exposeHostGateway: false,
          allowedHosts: [...request.effectiveGrant.scope.network.destinations],
          networkPolicyMode: request.effectiveGrant.scope.network.destinations.length
            ? ('restricted' as const)
            : ('deny-all' as const),
          volumes,
          workingDir: request.outputs.artifacts.mode === 'none' ? '/tmp' : '/output',
        };
      },
      attachProviderChannel: (podId, ref, root, _request, existingOnly) =>
        attach(index, podId, ref, root, existingOnly),
      ...(binding.channel.send
        ? {
            sendMessage: (ref: string, message: FollowUpEnvelope, key: string) => {
              const row = rowFor(ref);
              if (!row) throw new Error('managed-channel-binding');
              if (!binding.channel.send) throw new Error('managed-follow-up-unavailable');
              return binding.channel.send(ref, `/run/dispatcher-${row.pod_id}`, message, key);
            },
          }
        : {}),
    })),
    (ref) => {
      const row = rowFor(ref);
      return row
        ? {
            request: JSON.parse(row.request_json) as ManagedPodRequest,
            podId: row.pod_id,
            createdAt: row.created_at,
            observedExit: Boolean(row.observed_exit),
          }
        : null;
    },
  );
  runtime.cleanupUnallocated = async (podId, request) => {
    // Sandbox allocation is durably reserved before any remote create. Missing
    // runtime_ref alone is insufficient; reject even uncertain allocation rows.
    if (request.route.executionTarget !== 'sandbox') return false;
    const row = config.db
      .prepare('SELECT runtime_ref,observed_exit,revoked FROM managed_pods WHERE pod_id=?')
      .get(podId) as
      | { runtime_ref: string | null; observed_exit: number; revoked: number }
      | undefined;
    if (
      !row ||
      row.runtime_ref ||
      !row.observed_exit ||
      !row.revoked ||
      config.db.prepare('SELECT 1 FROM managed_sandbox_allocations WHERE pod_id=?').get(podId)
    )
      return false;
    return workspaces.discardUnallocated(podId);
  };
  const validationBoundaries = bindings.flatMap((binding) =>
    binding.validation
      ? [
          {
            route: binding.route,
            profileId: binding.profileId,
            manager: binding.manager,
            image: binding.image,
            configuration: binding.validation.configuration,
            dependencyCache: binding.dependencyCache,
            sourceWorkspace: (podId: string, repositoryId: string) =>
              workspaces.path(podId, repositoryId),
            network: () => ({}),
            prepareNetwork: binding.network,
          },
        ]
      : [],
  );
  if (config.validation && validationBoundaries.length)
    throw new Error('managed-validation-composition-ambiguous');
  const components = managedComponents({
    ...config,
    runtime,
    validation:
      config.validation ??
      (validationBoundaries.length
        ? new ManagedSupervisedValidation(validationBoundaries)
        : undefined),
  });
  const gateways = bindings.map(
    (binding) =>
      new ManagedProviderGateway(components.service, binding.transport, binding.maximumRequests),
  );
  const githubGateways = bindings.map((binding) =>
    binding.githubRead
      ? new ManagedGitHubReadGateway(
          components.service,
          binding.githubRead.config,
          binding.githubRead.auth,
          binding.githubRead.transport,
        )
      : undefined,
  );
  const publicGateways = bindings.map((binding) =>
    binding.publicRead ? new ManagedPublicReadGateway(components.service) : undefined,
  );
  const feeds = bindings.map(
    (binding) => new ManagedQuotaFeed(components.service, binding.manager),
  );
  return {
    ...components,
    runtime,
    workspaces,
    withCheckpoint<T>(
      cp: { run: string; repository: string; commit: string },
      mirror: string,
      use: (service: typeof components.service) => Promise<T>,
    ) {
      return checkpointScope.run({ ...cp, mirror }, () => use(components.service));
    },
    /** Reattach leases/channels to durable identities; never allocate or restart a worker. */
    async resume(profileIds?: ReadonlySet<string>) {
      if (!components.service.enabled) throw new Error('managed-lane-disabled');
      if (closed) throw new Error('managed-composition-closed');
      const rows = config.db
        .prepare('SELECT * FROM managed_pods WHERE runtime_ref IS NOT NULL AND observed_exit=0')
        .all() as ManagedPodRow[];
      for (const row of rows) {
        if (!components.service.ownsInstallation(row.dispatcher_installation_id)) continue;
        if (row.revoked || row.stop_requested || components.service.expired(row)) continue;
        const request = JSON.parse(row.request_json) as ManagedPodRequest;
        if (profileIds && !profileIds.has(request.profileSnapshot.profileId)) continue;
        if (config.sandboxCheckpoints && row.state === 'queued') {
          // An ID alone cannot authorize replay or attachment.
          try {
            await components.service.restoreCheckpoint(row);
          } catch {
            // Leave the reservation untouched. Record the failure once, without channel output.
            config.db
              .prepare(`INSERT INTO managed_results(pod_id, limitations_json) VALUES (@podId, json_array(@code))
                ON CONFLICT(pod_id) DO UPDATE SET limitations_json=json_insert(limitations_json, '$[#]', @code)
                WHERE NOT EXISTS (SELECT 1 FROM json_each(limitations_json) WHERE value=@code)`)
              .run({ podId: row.pod_id, code: 'managed-checkpoint-reattach-failed' });
          }
          continue;
        }
        const index = bindings.findIndex(
          (binding) =>
            canonical(binding.route) === canonical(request.route) &&
            (binding.profileId === undefined ||
              binding.profileId === request.profileSnapshot.profileId),
        );
        if (index < 0) throw new Error('managed-resume-route-unavailable');
        await attach(index, row.pod_id, row.runtime_ref!, `/run/dispatcher-${row.pod_id}`);
      }
    },
    close() {
      closed = true;
      for (const gateway of gateways) gateway.close();
      for (const feed of feeds) feed.close();
      for (const stop of channels.values()) stop();
      channels.clear();
    },
  };
}
