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
import { ManagedQuotaFeed } from './quota-feed.js';
import { type ManagedRepositoryMirror, ManagedWorkspaces } from './workspaces.js';

export interface ManagedWorkerProviderChannel {
  /** Prove the reviewed command uses only this gateway and cannot reach a direct provider. */
  preflight(request: ManagedPodRequest): Promise<void>;
  /** Trusted host binding. The worker cannot select installation, pod, revision or route. */
  attach(binding: {
    podId: string;
    runtimeRef: string;
    stateRoot: string;
    invoke: (
      key: string,
      prompt: string,
      maximumTokens: number,
    ) => ReturnType<ManagedProviderGateway['invoke']>;
    invokeGitHub?: (key: string, request: string) => Promise<string>;
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
  route: Route;
  /** Optional stage binding when several reviewed profiles share one exact route. */
  profileId?: string;
  manager: ContainerManager;
  image: string;
  command: readonly string[];
  /** Image-internal immutable dependency tree linked from the reviewed repository checkout. */
  dependencyCache?: { enrollmentId: string; path: string };
  transport: BoundedProviderTransport;
  channel: ManagedWorkerProviderChannel;
  maximumRequests?: number;
  githubRead?: {
    config: ManagedGitHubReadConfig;
    auth: DaemonGitHubAuth;
    transport?: typeof fetch;
  };
  /** Reviewed target networking; volumes, environment and identity are supplied below. */
  network(request: ManagedPodRequest): Pick<ContainerSpawnConfig, 'firewallScript' | 'networkName'>;
}
export interface ManagedRuntimeCompositionConfig extends Omit<ManagedComponentsConfig, 'runtime'> {
  mirrors: readonly ManagedRepositoryMirror[];
  bindings: readonly ManagedRuntimeBinding[];
}

/** Library composition only: never discovers credentials, changes native config or starts a listener.
 * The selected runtime's channel is a reviewed deployment input, not inferred from a profile name.
 */
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
  }));
  let closed = false;
  const channels = new Map<string, () => void>();
  const pending = new Map<string, Promise<void>>();
  const rowFor = (ref: string) =>
    config.db.prepare('SELECT * FROM managed_pods WHERE runtime_ref=?').get(ref) as
      | ManagedPodRow
      | undefined;
  const workspaces = new ManagedWorkspaces(
    config.db,
    path.join(config.stateRoot, 'workspaces'),
    config.mirrors,
  );
  const attach = async (index: number, podId: string, ref: string, root: string) => {
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
      const stop = await binding.channel.attach({
        podId,
        runtimeRef: ref,
        stateRoot: root,
        invoke: (key, prompt, maximumTokens) =>
          gateways[index]!.invoke(
            row.dispatcher_installation_id,
            podId,
            row.grant_revision,
            key,
            prompt,
            maximumTokens,
          ),
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
      quotaReady: async (request) => {
        if (closed) throw new Error('managed-composition-closed');
        gateways[index]!.preflight(request);
        await binding.channel.preflight(request);
        return true;
      },
      prepare: async (podId, request) => {
        const volumes = await workspaces.prepare(podId, request);
        for (const input of components.service.inputs!.mounts(podId))
          volumes.push({ host: input.hostPath, container: input.containerPath, readOnly: true });
        return {
          ...binding.network(request),
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
      attachQuota: (podId, ref, root) => attach(index, podId, ref, root),
      ...(binding.channel.send
        ? {
            sendMessage: (ref: string, message: FollowUpEnvelope, key: string) => {
              const row = rowFor(ref);
              if (!row) throw new Error('managed-channel-binding');
              const send = binding.channel.send;
              if (!send) throw new Error('managed-follow-up-unavailable');
              return send(ref, `/run/dispatcher-${row.pod_id}`, message, key);
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
  const components = managedComponents({ ...config, runtime });
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
  const feeds = bindings.map(
    (binding) => new ManagedQuotaFeed(components.service, binding.manager),
  );
  return {
    ...components,
    runtime,
    workspaces,
    /** Reattach leases/channels to durable identities; never allocate or restart a worker. */
    async resume() {
      if (!components.service.enabled) throw new Error('managed-lane-disabled');
      if (closed) throw new Error('managed-composition-closed');
      const rows = config.db
        .prepare('SELECT * FROM managed_pods WHERE runtime_ref IS NOT NULL AND observed_exit=0')
        .all() as ManagedPodRow[];
      for (const row of rows) {
        if (row.revoked || row.stop_requested || components.service.expired(row)) continue;
        const request = JSON.parse(row.request_json) as ManagedPodRequest;
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
