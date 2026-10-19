import { AutopodError } from '@autopod/shared';
import {
  computeNetworkPolicyAllowlist,
  networkNameForPod,
} from '../containers/docker-network-manager.js';
import { sandboxEgressRefreshPayload } from '../containers/sandbox-container-manager.js';
import { mergeMcpServers } from './injection-merger.js';
import { resolveProviderPreflight } from './provider-preflight.js';
import type {
  ResourceNetworkCaptured,
  ResourceNetworkLiveDependencies,
} from './resource-contracts.js';
import { hostnameFromUrl, portFromUrl } from './resource-policy.js';
import { addRuntimeNetworkDefaults } from './runtime-network-defaults.js';

export function createResourceNetwork(
  deps: ResourceNetworkLiveDependencies,
  captured: ResourceNetworkCaptured,
) {
  const {
    networkManager,
    logger,
    profileStore,
    podRepo,
    daemonConfig,
    sidecarManager,
    providerAccountStore,
    providerCatalog,
    mcpBaseUrl,
    containerManagerFactory,
  } = captured;

  async function destroyPodNetwork(podId: string, strict = false): Promise<void> {
    if (!networkManager?.destroyNetworkForPod) return;
    try {
      await networkManager.destroyNetworkForPod(podId);
    } catch (err) {
      logger.warn({ err, podId }, 'Failed to destroy pod network');
      if (strict) throw err;
    }
  }

  async function refreshNetworkPolicy(profileName: string): Promise<void> {
    if (deps.launchConfiguration)
      throw new AutopodError(
        'Running pods retain their launch network policy. Change the reusable profile for a new launch.',
        'CONFIG_API_VERSION_UNSUPPORTED',
        410,
      );
    const profile = profileStore.get(profileName);
    if (!profile.networkPolicy?.enabled) return;

    const runningSessions = podRepo
      .list({ status: 'running' })
      .filter(
        (s) =>
          s.profileName === profileName &&
          (s.executionTarget === 'local' || s.executionTarget === 'sandbox') &&
          s.containerId != null,
      );

    if (runningSessions.length === 0) return;

    const mergedServers = mergeMcpServers(daemonConfig.mcpServers, profile.mcpServers);

    // Resolve the current bridge IP of each sidecar for a given pod. With
    // per-pod networks each pod has its own `autopod-<podId>` bridge, and
    // sidecar IPs can be different across pods.
    const collectSidecarIps = async (pod: import('@autopod/shared').Pod): Promise<string[]> => {
      if (!sidecarManager || !pod.sidecarContainerIds) return [];
      const networkName = networkNameForPod(pod.id);
      const ips: string[] = [];
      for (const [name, containerId] of Object.entries(pod.sidecarContainerIds)) {
        const ip = await sidecarManager.getBridgeIp({ containerId, name }, networkName);
        if (ip) ips.push(ip);
      }
      return ips;
    };

    // With per-pod networks, each pod has its own bridge and may have
    // different sidecar IPs to allowlist. Build the firewall script per
    // pod rather than once for the whole profile.
    await Promise.all(
      runningSessions.map(async (pod) => {
        try {
          const providerPreflight = resolveProviderPreflight(profile, pod.runtime, pod.model, {
            profileStore,
            providerAccountStore,
            manifest: providerCatalog,
            ...(pod.providerIdSnapshot
              ? {
                  expectedBinding: {
                    accountId: pod.providerAccountIdSnapshot,
                    providerId: pod.providerIdSnapshot,
                  },
                }
              : {}),
          });
          const runtimeNetworkPolicy = addRuntimeNetworkDefaults(
            profile.networkPolicy,
            profile,
            pod.runtime,
            providerPreflight.manifestProvider,
            providerPreflight.account,
          );
          // biome-ignore lint/style/noNonNullAssertion: runningSessions always have a containerId
          const containerId = pod.containerId!;
          if (pod.executionTarget === 'sandbox') {
            if (!runtimeNetworkPolicy?.enabled) return;
            const allowedHosts = computeNetworkPolicyAllowlist(
              runtimeNetworkPolicy,
              mergedServers,
              hostnameFromUrl(mcpBaseUrl),
              profile.privateRegistries,
            );
            const cm = containerManagerFactory.get('sandbox');
            await cm.refreshFirewall(
              containerId,
              sandboxEgressRefreshPayload(runtimeNetworkPolicy.mode ?? 'restricted', allowedHosts),
            );
          } else {
            if (!networkManager) return;
            const gatewayIp = await networkManager.getGatewayIp(pod.id);
            const sidecarIps = await collectSidecarIps(pod);
            const netConfig = await networkManager.buildNetworkConfig(
              runtimeNetworkPolicy,
              mergedServers,
              gatewayIp,
              profile.privateRegistries,
              pod.id,
              sidecarIps,
              [hostnameFromUrl(mcpBaseUrl)],
              portFromUrl(mcpBaseUrl),
            );
            if (!netConfig) return;
            const cm = containerManagerFactory.get('local');
            await cm.refreshFirewall(containerId, netConfig.firewallScript);
          }
          logger.info(
            { podId: pod.id, profileName },
            'Network policy refreshed on running container',
          );
        } catch (err) {
          logger.warn(
            { err, podId: pod.id, profileName },
            'Failed to refresh network policy on running container',
          );
        }
      }),
    );
  }
  return { destroyPodNetwork, refreshNetworkPolicy };
}
