import { randomUUID } from 'node:crypto';
import type {
  ObservedContainer,
  RetainedNetworkCandidate,
  RetainedNetworkReleaseResult,
  RetainedNetworkReleaseTrigger,
  RetainedNetworkSource,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import type Dockerode from 'dockerode';
import type { Logger } from 'pino';
import {
  checkpointResourceIdentity,
  createRetainedCheckpointRepository,
} from '../pods/retained-checkpoint-repository.js';
import { boundedDockerCall, DOCKER_CALL_TIMEOUTS } from './docker-bounds.js';

/**
 * Release protocol for empty bridges of superseded retained identities (#565).
 *
 * A bridge is an execution resource, not custody evidence. Only identities from
 * `retained_checkpoint_recoveries` and `artifact_checks` are in scope. Pods with
 * a retained finalization or a recovery fork are excluded entirely. The current
 * provider identity of a non-terminal pod and in-progress artifact-check
 * identities are never released. Every container on the bridge must be observed
 * not running. The observed network specification is recorded before removal.
 * Containers, mounts, source and reports are never touched.
 */

const POD_NETWORK_LABEL = 'com.autopod.pod-network';
/** Docker container states without a live network endpoint. */
const STOPPED_CONTAINER_STATES = new Set(['created', 'exited', 'dead']);

interface IdentityScope {
  ownerPodId: string;
  source: RetainedNetworkSource;
}

export interface RetainedNetworkReleaseScope {
  /** Identities in release scope, mapped to their owning pod. */
  inScope: Map<string, IdentityScope>;
  /** Owning pods excluded entirely (retained finalization or recovery-fork parent). */
  excludedPods: Set<string>;
  /** Current identities of non-terminal pods and in-progress artifact checks. */
  protectedIdentities: Set<string>;
  /** Current and sidecar container IDs of non-terminal pods. */
  protectedContainers: Set<string>;
}

interface ReleaseDeps {
  docker: Dockerode;
  db: Database.Database;
  logger?: Logger;
}

function podNetworkIdentity(name: string): string | null {
  return name.startsWith('autopod-') ? name.slice('autopod-'.length) : null;
}

/** Fresh read of release scope. Recompute before every release decision. */
export function retainedNetworkReleaseScope(db: Database.Database): RetainedNetworkReleaseScope {
  const inScope = new Map<string, IdentityScope>();
  const recoveries = db
    .prepare(`SELECT r.id,r.pod_id AS podId,e.evidence FROM retained_checkpoint_recoveries r
      LEFT JOIN retained_checkpoint_recovery_events e ON e.recovery_id=r.id AND e.kind='activated'`)
    .all() as { id: string; podId: string; evidence: string | null }[];
  for (const row of recoveries) {
    inScope.set(row.podId, { ownerPodId: row.podId, source: 'retained_checkpoint' });
    if (row.evidence) {
      const identity = checkpointResourceIdentity(
        row.podId,
        row.id,
        JSON.parse(row.evidence).generation,
      );
      inScope.set(identity, { ownerPodId: row.podId, source: 'retained_checkpoint' });
    }
  }
  const protectedIdentities = new Set<string>();
  const artifactChecks = db
    .prepare(`SELECT r.pod_id AS podId,
        json_extract(a.evidence,'$.identity') AS identity,
        EXISTS(SELECT 1 FROM artifact_checks_recovery_events s
          WHERE s.recovery_id=r.id AND s.kind IN ('checked','blocked')) AS settled
      FROM artifact_checks_recoveries r
      LEFT JOIN artifact_checks_recovery_events a ON a.recovery_id=r.id AND a.kind='allocated'`)
    .all() as { podId: string; identity: string | null; settled: number }[];
  for (const row of artifactChecks) {
    if (!inScope.has(row.podId))
      inScope.set(row.podId, { ownerPodId: row.podId, source: 'artifact_checks' });
    if (typeof row.identity === 'string') {
      inScope.set(row.identity, { ownerPodId: row.podId, source: 'artifact_checks' });
      if (!row.settled) protectedIdentities.add(row.identity);
    }
  }
  const excludedPods = new Set<string>([
    ...(
      db.prepare('SELECT pod_id AS id FROM retained_finalizations').all() as { id: string }[]
    ).map((row) => row.id),
    ...(db.prepare('SELECT parent_pod_id AS id FROM recovery_forks').all() as { id: string }[]).map(
      (row) => row.id,
    ),
  ]);
  const protectedContainers = new Set<string>();
  const retained = createRetainedCheckpointRepository(db);
  const live = db
    .prepare(`SELECT id,lifecycle_generation AS generation,container_id AS containerId,
        sidecar_container_ids AS sidecars FROM pods WHERE status NOT IN ('complete','killed')`)
    .all() as {
    id: string;
    generation: number;
    containerId: string | null;
    sidecars: string | null;
  }[];
  for (const pod of live) {
    protectedIdentities.add(retained.providerIdentity(pod.id, pod.generation));
    if (pod.containerId) protectedContainers.add(pod.containerId);
    if (pod.sidecars) {
      try {
        for (const id of Object.values(JSON.parse(pod.sidecars) as Record<string, unknown>))
          if (typeof id === 'string') protectedContainers.add(id);
      } catch {
        // Malformed sidecar metadata cannot authorize anything; live checks still apply.
      }
    }
  }
  return { inScope, excludedPods, protectedIdentities, protectedContainers };
}

function scopeRefusal(scope: RetainedNetworkReleaseScope, identity: string): string | null {
  const owner = scope.inScope.get(identity);
  if (!owner) return 'Identity is not a retained checkpoint or artifact-checks identity';
  if (scope.excludedPods.has(owner.ownerPodId))
    return 'Owning pod has a retained finalization or recovery fork; its bridges stay held';
  if (scope.protectedIdentities.has(identity))
    return 'Identity is the current execution identity of a live pod or in-progress check';
  return null;
}

/** Live, read-only observation of a bridge and every container that references it. */
async function observeNetwork(
  docker: Dockerode,
  networkId: string,
  logger?: Logger,
): Promise<{
  info: Dockerode.NetworkInspectInfo;
  endpoints: number;
  containers: ObservedContainer[];
}> {
  const info = (await boundedDockerCall(docker.getNetwork(networkId).inspect(), {
    label: 'network.inspect (release)',
    timeoutMs: DOCKER_CALL_TIMEOUTS.inspectNetwork,
    logger,
  })) as Dockerode.NetworkInspectInfo;
  if (!info?.Id || !info.Name) throw new Error('Docker network identity unavailable');
  const seen = new Map<string, ObservedContainer>();
  // Docker's network filter also matches stopped containers whose settings name
  // the bridge. Query by ID and name so neither lookup alone is trusted.
  for (const key of [info.Id, info.Name]) {
    const listed = await boundedDockerCall(
      docker.listContainers({ all: true, filters: JSON.stringify({ network: [key] }) }),
      { label: 'container.list (release)', timeoutMs: DOCKER_CALL_TIMEOUTS.listContainers, logger },
    );
    for (const entry of listed) seen.set(entry.Id, { id: entry.Id, name: '', status: '' });
  }
  const containers: ObservedContainer[] = [];
  for (const id of seen.keys()) {
    const live = await boundedDockerCall(docker.getContainer(id).inspect(), {
      label: 'container.inspect (release)',
      timeoutMs: DOCKER_CALL_TIMEOUTS.inspect,
      logger,
      containerId: id,
    });
    containers.push({
      id: live.Id,
      name: live.Name,
      status: live.State?.Running ? 'running' : (live.State?.Status ?? 'unknown'),
    });
  }
  return { info, endpoints: Object.keys(info.Containers ?? {}).length, containers };
}

function liveRefusal(
  scope: RetainedNetworkReleaseScope,
  observed: { endpoints: number; containers: ObservedContainer[] },
): string | null {
  if (observed.endpoints > 0) return 'Bridge has live endpoints';
  const active = observed.containers.find((c) => !STOPPED_CONTAINER_STATES.has(c.status));
  if (active) return `Container ${active.id.slice(0, 12)} is ${active.status}, not stopped`;
  const owned = observed.containers.find((c) => scope.protectedContainers.has(c.id));
  if (owned) return `Container ${owned.id.slice(0, 12)} belongs to a live pod`;
  return null;
}

/** Read-only plan: every held bridge in Docker with its eligibility. Oldest first. */
export async function planRetainedNetworkReleases({
  docker,
  db,
  logger,
}: ReleaseDeps): Promise<RetainedNetworkCandidate[]> {
  const scope = retainedNetworkReleaseScope(db);
  const networks = await boundedDockerCall(
    docker.listNetworks({ filters: JSON.stringify({ label: [`${POD_NETWORK_LABEL}=true`] }) }),
    { label: 'network.list (release)', timeoutMs: DOCKER_CALL_TIMEOUTS.listNetworks, logger },
  );
  const candidates: RetainedNetworkCandidate[] = [];
  for (const network of networks) {
    const identity = podNetworkIdentity(network.Name);
    const owner = identity ? scope.inScope.get(identity) : undefined;
    if (!identity || !owner) continue;
    const base = {
      identity,
      ownerPodId: owner.ownerPodId,
      source: owner.source,
      networkId: network.Id,
      networkName: network.Name,
      created: network.Created ?? null,
    };
    const refusal = scopeRefusal(scope, identity);
    if (refusal) {
      candidates.push({ ...base, eligible: false, reason: refusal, containers: [] });
      continue;
    }
    try {
      const observed = await observeNetwork(docker, network.Id, logger);
      const live = liveRefusal(scope, observed);
      candidates.push({
        ...base,
        eligible: live === null,
        ...(live ? { reason: live } : {}),
        containers: observed.containers,
      });
    } catch (err) {
      candidates.push({
        ...base,
        eligible: false,
        reason: `Live observation failed: ${err instanceof Error ? err.message : String(err)}`,
        containers: [],
      });
    }
  }
  return candidates.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return (a.created ?? '').localeCompare(b.created ?? '');
  });
}

/**
 * Release one bridge. Scope and live state are re-established immediately before
 * the durable record is written, and removal targets the exact observed network ID.
 */
export async function releaseRetainedNetwork(
  { docker, db, logger }: ReleaseDeps,
  candidate: Pick<RetainedNetworkCandidate, 'identity' | 'networkId' | 'networkName'>,
  trigger: RetainedNetworkReleaseTrigger,
  actor: Record<string, unknown> | null = null,
): Promise<RetainedNetworkReleaseResult> {
  const base = {
    identity: candidate.identity,
    networkId: candidate.networkId,
    networkName: candidate.networkName,
  };
  let observed: Awaited<ReturnType<typeof observeNetwork>>;
  try {
    observed = await observeNetwork(docker, candidate.networkId, logger);
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    return {
      ...base,
      outcome: 'refused',
      detail: statusCode === 404 ? 'Bridge already absent' : 'Live observation failed',
    };
  }
  if (observed.info.Name !== candidate.networkName)
    return { ...base, outcome: 'refused', detail: 'Bridge identity changed' };
  if (observed.info.Labels?.[POD_NETWORK_LABEL] !== 'true')
    return { ...base, outcome: 'refused', detail: 'Bridge is not an autopod pod network' };

  const releaseId = randomUUID();
  const record = db.transaction(() => {
    const scope = retainedNetworkReleaseScope(db);
    const refusal = scopeRefusal(scope, candidate.identity) ?? liveRefusal(scope, observed);
    if (refusal) return refusal;
    const owner = scope.inScope.get(candidate.identity) as IdentityScope;
    db.prepare(
      `INSERT INTO retained_network_releases
        (id,identity,owner_pod_id,source,network_id,network_name,trigger,actor,spec,containers,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      releaseId,
      candidate.identity,
      owner.ownerPodId,
      owner.source,
      observed.info.Id,
      observed.info.Name,
      trigger,
      actor ? JSON.stringify(actor) : null,
      JSON.stringify({
        driver: observed.info.Driver,
        scope: observed.info.Scope,
        created: observed.info.Created,
        internal: observed.info.Internal,
        enableIPv6: observed.info.EnableIPv6,
        ipam: observed.info.IPAM ?? null,
        options: observed.info.Options ?? {},
        labels: observed.info.Labels ?? {},
      }),
      JSON.stringify(observed.containers),
      new Date().toISOString(),
    );
    return null;
  })();
  if (record) return { ...base, outcome: 'refused', detail: record };

  const outcome = (value: 'removed' | 'already_absent' | 'failed', detail: string | null) =>
    db
      .prepare(
        'INSERT INTO retained_network_release_outcomes(release_id,outcome,detail,created_at) VALUES (?,?,?,?)',
      )
      .run(releaseId, value, detail, new Date().toISOString());
  try {
    await boundedDockerCall(docker.getNetwork(observed.info.Id).remove(), {
      label: 'network.remove (release)',
      timeoutMs: DOCKER_CALL_TIMEOUTS.removeNetwork,
      logger,
    });
    outcome('removed', null);
    logger?.warn(
      { identity: candidate.identity, network: observed.info.Name, trigger, releaseId },
      'Released superseded retained bridge',
    );
    return { ...base, outcome: 'removed', releaseId };
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      outcome('already_absent', null);
      return { ...base, outcome: 'already_absent', releaseId };
    }
    const detail = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    outcome('failed', detail);
    logger?.warn(
      { err, identity: candidate.identity, releaseId },
      'Retained bridge release failed',
    );
    return { ...base, outcome: 'failed', releaseId, detail };
  }
}

/** Operator release (B2): oldest eligible first, at most `limit`. */
export async function releaseRetainedNetworks(
  deps: ReleaseDeps,
  options: { limit: number; actor: Record<string, unknown> | null },
): Promise<RetainedNetworkReleaseResult[]> {
  const eligible = (await planRetainedNetworkReleases(deps)).filter((c) => c.eligible);
  const results: RetainedNetworkReleaseResult[] = [];
  for (const candidate of eligible.slice(0, options.limit))
    results.push(await releaseRetainedNetwork(deps, candidate, 'operator', options.actor));
  return results;
}
