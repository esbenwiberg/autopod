import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type Dockerode from 'dockerode';
import { block } from '../pods/retained-cleanup-proof.js';
import { overlaps, type Target } from '../pods/retained-cleanup-repository.js';
import { retainedPathIdentity } from '../pods/retained-path-identity.js';
import { ALLOCATION_LABEL } from './docker-allocation-evidence.js';
import { boundedDockerCall } from './docker-bounds.js';

type DockerTarget = Extract<Target, { kind: 'docker_container' | 'docker_bridge' }>;
const dockerTarget = (t: Target): t is DockerTarget =>
  t.kind === 'docker_container' || t.kind === 'docker_bridge';
const observe = <T>(call: Promise<T>) =>
  boundedDockerCall(call, { label: 'retained cleanup exact observation', timeoutMs: 5000 });
async function inspect<T>(call: Promise<T>): Promise<T | null> {
  try {
    return await observe(call);
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return null;
    throw error;
  }
}
export function createRetainedCleanupDocker(docker: Dockerode, requireLocalSocket = false) {
  async function endpoint(guard: () => void) {
    if (!requireLocalSocket) return null;
    const modem = docker.modem as {
      host?: string;
      getSocketPath?: () => Promise<string>;
      pathPrefix?: string;
    };
    if (process.platform !== 'linux' || modem.host || modem.pathPrefix || !modem.getSocketPath)
      block('UNSUPPORTED_TOPOLOGY', 'A Linux host and its local Docker Unix socket are required.');
    try {
      const socket = await modem.getSocketPath!();
      if (!path.isAbsolute(socket)) throw new Error('not a local socket');
      const canonical = await realpath(socket);
      const st = await lstat(canonical, { bigint: true });
      guard();
      if (!st.isSocket() || !st.ino || !st.birthtimeNs)
        throw new Error('socket identity unavailable');
      return JSON.stringify([canonical, String(st.dev), String(st.ino), String(st.birthtimeNs)]);
    } catch {
      guard();
      block(
        'OBSERVATION_UNAVAILABLE',
        'The local Docker socket identity could not be established.',
      );
    }
  }
  async function engine(expected: string, guard: () => void) {
    const before = await endpoint(guard);
    guard();
    const info = (await observe(docker.info())) as { ID?: unknown };
    guard();
    if (info.ID !== expected)
      block('IDENTITY_CHANGED', 'The Docker Engine ID differs from the producer identity.');
    if ((await endpoint(guard)) !== before)
      block('IDENTITY_CHANGED', 'The local Docker socket changed during Engine observation.');
    guard();
    return before;
  }
  async function proof(targets: Target[], guard: () => void): Promise<Set<string>> {
    const selected = targets.filter(dockerTarget);
    const ns = selected[0]!.namespace;
    const socket = await engine(ns, guard);
    const containers = selected.filter((t) => t.kind === 'docker_container');
    const bridges = selected.filter((t) => t.kind === 'docker_bridge');
    const host = targets.filter((t) => !dockerTarget(t)).map((t) => t.id);
    const nativeAbsent = new Set<string>();
    const present = new Map<string, Set<string>>();
    const bridgeRefs = (ref: string | undefined) =>
      !!ref && bridges.some((b) => b.id === ref || b.name === ref);
    const checkedEndpoints: { id: string; endpoints: string[] }[] = [];
    const liveList = await observe(docker.listContainers({ all: true }));
    guard();
    for (const listed of liveList) {
      if (!/^[a-f0-9]{64}$/.test(listed.Id))
        block('OBSERVATION_UNAVAILABLE', 'Docker returned an incomplete container ID.');
      if (containers.some((t) => t.id === listed.Id)) continue;
      if ((listed.Names ?? []).some((n) => containers.some((t) => n === '/' + t.name)))
        block(
          'IDENTITY_CHANGED',
          'A foreign container occupies an original allocation name.',
          listed.Id,
        );
      const foreign = await inspect(docker.getContainer(listed.Id).inspect());
      guard();
      if (
        !foreign ||
        foreign.Id !== listed.Id ||
        !foreign.NetworkSettings?.Networks ||
        !foreign.HostConfig ||
        !foreign.Mounts
      )
        block(
          'OBSERVATION_UNAVAILABLE',
          'Docker did not return complete mount/network closure for a container.',
          listed.Id,
        );
      const foreignLabels = foreign.Config?.Labels ?? {};
      if (
        containers.some(
          (t) =>
            t.attemptId === foreignLabels[ALLOCATION_LABEL] ||
            (foreignLabels['com.autopod.pod-id'] &&
              t.name === 'autopod-' + foreignLabels['com.autopod.pod-id']),
        )
      )
        block(
          'FOREIGN_ATTACHMENT',
          'A container outside inventory claims this pod or an allocation attempt.',
          listed.Id,
        );
      const shared = [
        foreign.HostConfig.NetworkMode,
        foreign.HostConfig.IpcMode,
        foreign.HostConfig.PidMode,
        ...(foreign.HostConfig.VolumesFrom ?? []).map(
          (v: string) => 'container:' + v.split(':')[0],
        ),
      ];
      for (const mode of shared) {
        if (!mode?.startsWith('container:')) continue;
        const ref = mode.slice('container:'.length).replace(/^\//, '');
        if (!ref || containers.some((t) => t.id.startsWith(ref) || t.name === ref))
          block(
            'FOREIGN_ATTACHMENT',
            'A foreign container shares an owned execution namespace.',
            listed.Id,
          );
      }
      if (
        bridgeRefs(foreign.HostConfig.NetworkMode) ||
        Object.entries(foreign.NetworkSettings.Networks).some(([name, n]) =>
          bridges.some((b) => n.NetworkID === b.id || name === b.name),
        )
      )
        block('FOREIGN_ATTACHMENT', 'A foreign container references an owned bridge.', listed.Id);
      if (
        foreign.Mounts.some(
          (m) =>
            m.Source &&
            path.isAbsolute(m.Source) &&
            [path.resolve(m.Source), retainedPathIdentity(m.Source)].some((source) =>
              host.some((p) => overlaps(p, source)),
            ),
        )
      )
        block('FOREIGN_ATTACHMENT', 'A foreign container mounts a selected host path.', listed.Id);
    }
    const nets = await observe(docker.listNetworks());
    guard();
    if (
      nets.some(
        (n) => bridges.some((b) => b.name === n.Name) && !bridges.some((b) => b.id === n.Id),
      )
    )
      block('IDENTITY_CHANGED', 'A foreign bridge occupies an original allocation name.');
    for (const t of selected) {
      guard();
      if (t.kind === 'docker_container') {
        const live = await inspect(docker.getContainer(t.id).inspect());
        guard();
        if (!live) {
          if (liveList.some((c) => c.Id === t.id))
            block(
              'OBSERVATION_UNAVAILABLE',
              'Container inventory changed during observation.',
              t.id,
            );
          nativeAbsent.add(t.id);
          continue;
        }
        if (
          live.Id !== t.id ||
          live.Name !== '/' + t.name ||
          live.Config?.Labels?.[ALLOCATION_LABEL] !== t.attemptId ||
          !live.NetworkSettings?.Networks ||
          !live.Mounts ||
          !live.HostConfig
        )
          block(
            'IDENTITY_CHANGED',
            'Container identity or topology does not match its exact producer record.',
            t.id,
          );
        const st = live.State;
        if (
          !st ||
          st.Running !== false ||
          st.Paused !== false ||
          st.Restarting !== false ||
          !['exited', 'created'].includes(st.Status)
        )
          block(
            'EXECUTION_NOT_STOPPED',
            'An exact guest execution is not proven stopped; cleanup never stops it.',
            t.id,
          );
        const hc = live.HostConfig;
        if (
          hc.Privileged ||
          hc.PidMode === 'host' ||
          hc.PidMode?.startsWith('container:') ||
          hc.IpcMode === 'host' ||
          hc.IpcMode?.startsWith('container:') ||
          !bridges.some(
            (b) => b.id === t.bridgeId && (b.name === hc.NetworkMode || b.id === hc.NetworkMode),
          ) ||
          (hc.VolumesFrom?.length ?? 0) ||
          !['no', '', undefined].includes(hc.RestartPolicy?.Name)
        )
          block(
            'UNSUPPORTED_TOPOLOGY',
            'Container uses unsupported namespace, restart or mount sharing.',
            t.id,
          );
        const checkout = targets.find((q) => q.kind === 'host_worktree' && q.id === t.sourceMount);
        if (checkout?.kind !== 'host_worktree')
          block('IDENTITY_CHANGED', 'No exact checkout covers the source mount.', t.id);
        const common = checkout.git.commonStore.path;
        const source = live.Mounts.filter((m) => m.Destination === '/mnt/worktree');
        const git = live.Mounts.filter((m) => m.Destination === common);
        if (
          source.length !== 1 ||
          source[0]?.Type !== 'bind' ||
          source[0].Source !== t.sourceMount ||
          git.length !== 1 ||
          git[0]?.Type !== 'bind' ||
          git[0].Source !== common ||
          live.Mounts.some(
            (m) =>
              m !== source[0] &&
              m !== git[0] &&
              (overlaps(m.Destination, '/mnt/worktree') ||
                overlaps(m.Destination, common) ||
                (m.Source &&
                  path.isAbsolute(m.Source) &&
                  host.some(
                    (p) =>
                      overlaps(p, path.resolve(m.Source)) ||
                      overlaps(p, retainedPathIdentity(m.Source)),
                  ))),
          )
        )
          block(
            'IDENTITY_CHANGED',
            'The exact checkout or common-store mount topology changed.',
            t.id,
          );
        for (const [name, endpoint] of Object.entries(live.NetworkSettings.Networks)) {
          if (
            !bridges.some((b) => b.id === endpoint.NetworkID && b.name === name) ||
            (endpoint.NetworkID !== t.bridgeId &&
              name !== bridges.find((b) => b.id === t.bridgeId)?.name)
          )
            block(
              'FOREIGN_ATTACHMENT',
              'Owned execution refers to an unrecorded or unrelated bridge.',
              t.id,
            );
        }
        present.set(
          t.id,
          new Set(Object.values(live.NetworkSettings.Networks).map((n) => n.NetworkID)),
        );
      } else {
        const live = await inspect(docker.getNetwork(t.id).inspect());
        guard();
        if (!live) {
          if (nets.some((n) => n.Id === t.id))
            block('OBSERVATION_UNAVAILABLE', 'Bridge inventory changed during observation.', t.id);
          nativeAbsent.add(t.id);
          continue;
        }
        if (
          live.Id !== t.id ||
          live.Name !== t.name ||
          live.Scope !== 'local' ||
          live.Driver !== 'bridge' ||
          live.Labels?.[ALLOCATION_LABEL] !== t.attemptId ||
          live.Ingress
        )
          block(
            'IDENTITY_CHANGED',
            'Bridge identity or topology does not match its exact producer record.',
            t.id,
          );
        checkedEndpoints.push({ id: t.id, endpoints: Object.keys(live.Containers ?? {}) });
      }
    }
    for (const bridge of checkedEndpoints)
      if (bridge.endpoints.some((id) => !present.get(id)?.has(bridge.id)))
        block(
          'FOREIGN_ATTACHMENT',
          'An owned bridge has a foreign or uncertain attached endpoint.',
          bridge.id,
        );
    if ((await engine(ns, guard)) !== socket)
      block('IDENTITY_CHANGED', 'Docker socket changed during resource inspection.');
    return nativeAbsent;
  }
  async function remove(t: DockerTarget, guard: () => void, dispatch: () => boolean) {
    await engine(t.namespace, guard);
    guard();
    if (!dispatch()) return;
    await boundedDockerCall(
      t.kind === 'docker_container'
        ? docker.getContainer(t.id).remove({ force: false, v: false })
        : docker.getNetwork(t.id).remove(),
      { label: 'retained cleanup exact removal', timeoutMs: 10_000 },
    );
  }
  return { proof, remove };
}
export type RetainedCleanupDocker = ReturnType<typeof createRetainedCleanupDocker>;
