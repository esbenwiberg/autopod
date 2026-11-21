import { AutopodError } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type Dockerode from 'dockerode';
import type { Logger } from 'pino';
import {
  assertCheckpointResourceNotRetained,
  retainedCheckpointNetworkIdentities,
} from '../pods/retained-checkpoint-repository.js';
import { boundedDockerCall, DOCKER_CALL_TIMEOUTS } from './docker-bounds.js';

export const POD_NETWORK_LABEL = 'com.autopod.pod-network';
export const POD_ID_LABEL = 'com.autopod.pod-id';

export function podNetworkIdentity(name: string): string {
  return name.startsWith('autopod-') ? name.slice('autopod-'.length) : '';
}

type StaleOwner = { containerId: string; generation: number };
type PruneOwner = 'unclaimed' | 'blocked' | StaleOwner;

/** The status alone is not teardown authority, even if the bridge looks empty. */
export function podNetworkPruneOwner(db: Database.Database | undefined, name: string): PruneOwner {
  const id = podNetworkIdentity(name);
  if (!db || !id) return 'blocked';
  const pod = db
    .prepare(
      'SELECT status, execution_target, container_id, lifecycle_generation FROM pods WHERE id=?',
    )
    .get(id) as
    | {
        status: string;
        execution_target: string;
        container_id: string | null;
        lifecycle_generation: number;
      }
    | undefined;
  if (pod) {
    if (!['complete', 'killed'].includes(pod.status)) return 'blocked';
    if (pod.container_id === null) return 'unclaimed';
    if (
      pod.status === 'complete' &&
      pod.execution_target === 'local' &&
      /^[a-f0-9]{64}$/.test(pod.container_id)
    ) {
      return { containerId: pod.container_id, generation: pod.lifecycle_generation };
    }
    return 'blocked';
  }
  const reviewer = db
    .prepare('SELECT state,cleanup,reconciled_at FROM isolated_reviewer_runs WHERE id=?')
    .get(id) as { state: string; cleanup: string; reconciled_at: string | null } | undefined;
  if (reviewer) {
    return reviewer.cleanup === 'clean' &&
      !['preparing', 'running'].includes(reviewer.state) &&
      (reviewer.state !== 'uncertain' || reviewer.reconciled_at)
      ? 'unclaimed'
      : 'blocked';
  }
  // Missing records for other isolated protocols cannot authorize teardown.
  return /^(review-|system-|deploy-)/.test(id) || id.includes('-artifact-checks-')
    ? 'blocked'
    : 'unclaimed';
}

function sameOwner(a: PruneOwner, b: PruneOwner): boolean {
  return typeof a === 'object' && typeof b === 'object'
    ? a.containerId === b.containerId && a.generation === b.generation
    : a === b;
}

type OwnershipVerdict = 'eligible' | 'retained' | 'blocked';
type PruneInspection =
  | { kind: Exclude<OwnershipVerdict, 'eligible'> | 'attached' }
  | { kind: 'eligible'; staleContainerId?: string; recheck: () => OwnershipVerdict };

/** Lazily share one read-only inventory per health snapshot, not across mutations. */
export function createPruneContainerInventory(docker: Dockerode, logger?: Logger) {
  let snapshot: Promise<Dockerode.ContainerInfo[]> | undefined;
  return () =>
    (snapshot ??= boundedDockerCall(docker.listContainers({ all: true }), {
      label: 'container.list (network references)',
      timeoutMs: DOCKER_CALL_TIMEOUTS.listContainers,
      logger,
    }));
}

/** Read-only evidence shared by health and pressure cleanup. Never detach endpoints. */
export async function inspectPodNetworkPrune(
  docker: Dockerode,
  db: Database.Database,
  net: Pick<Dockerode.NetworkInspectInfo, 'Id' | 'Name'>,
  live: Dockerode.NetworkInspectInfo,
  logger?: Logger,
  listContainers = createPruneContainerInventory(docker, logger),
): Promise<PruneInspection> {
  if (live.Name !== net.Name || live.Id !== net.Id) {
    throw new Error('Docker network identity changed during prune inspection');
  }
  const podId = podNetworkIdentity(net.Name);
  const isHeld = () => retainedCheckpointNetworkIdentities(db).has(podId);
  if (isHeld()) return { kind: 'retained' };
  if (Object.keys(live.Containers ?? {}).length > 0) return { kind: 'attached' };
  const owner = podNetworkPruneOwner(db, net.Name);
  if (owner === 'blocked') return { kind: 'blocked' };

  const resourceHeld = (containerId: string) => {
    try {
      assertCheckpointResourceNotRetained(db, containerId);
      return false;
    } catch (error) {
      if (error instanceof AutopodError && error.statusCode === 409) return true;
      throw error;
    }
  };
  // Call synchronously immediately before requesting the Docker removal by ID.
  const recheck = (): OwnershipVerdict => {
    if (isHeld()) return 'retained';
    if (!sameOwner(owner, podNetworkPruneOwner(db, net.Name))) return 'blocked';
    if (typeof owner === 'object' && resourceHeld(owner.containerId)) return 'retained';
    return 'eligible';
  };
  if (owner === 'unclaimed') return { kind: 'eligible', recheck };
  if (resourceHeld(owner.containerId)) return { kind: 'retained' };

  const matchesBridge = (info: Dockerode.NetworkInspectInfo) =>
    info.Id === net.Id &&
    info.Name === net.Name &&
    info.Driver === 'bridge' &&
    info.Scope === 'local' &&
    info.Labels?.[POD_NETWORK_LABEL] === 'true' &&
    info.Labels?.[POD_ID_LABEL] === podId;
  if (!matchesBridge(live)) return { kind: 'blocked' };
  try {
    await boundedDockerCall(docker.getContainer(owner.containerId).inspect(), {
      label: 'container.inspect (stale network owner)',
      timeoutMs: DOCKER_CALL_TIMEOUTS.inspect,
      logger,
      containerId: owner.containerId,
    });
    return { kind: 'blocked' }; // A stopped container is still an owner.
  } catch (error) {
    if ((error as { statusCode?: number })?.statusCode !== 404) throw error;
  }
  // Docker's network filter can miss a disconnected container whose configured
  // NetworkMode still names the bridge. Check all containers, including stopped
  // ones, for both declared mode and current network settings.
  const containers = await listContainers();
  const namesBridge = (key: string) => key === net.Name || (key !== '' && net.Id.startsWith(key));
  for (const container of containers) {
    const mode = container.HostConfig?.NetworkMode;
    const networks = container.NetworkSettings?.Networks;
    if (!container.Id || typeof mode !== 'string' || networks === undefined) {
      throw new Error('Docker container network references unavailable');
    }
    if (
      container.Id === owner.containerId ||
      namesBridge(mode) ||
      Object.entries(networks ?? {}).some(
        ([name, info]) => namesBridge(name) || (info?.NetworkID && namesBridge(info.NetworkID)),
      )
    ) {
      return { kind: 'blocked' };
    }
  }

  const latest = await boundedDockerCall(docker.getNetwork(net.Id).inspect(), {
    label: 'network.inspect (stale network owner)',
    timeoutMs: DOCKER_CALL_TIMEOUTS.inspectNetwork,
    logger,
  });
  if (!matchesBridge(latest)) return { kind: 'blocked' };
  if (Object.keys(latest.Containers ?? {}).length > 0) return { kind: 'attached' };
  return { kind: 'eligible', staleContainerId: owner.containerId, recheck };
}
