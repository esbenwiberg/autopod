import type {
  InjectedMcpServer,
  NetworkPolicy,
  NetworkPolicyMode,
  PrivateRegistry,
} from '@autopod/shared';
import type Dockerode from 'dockerode';
import type { Logger } from 'pino';

// Defense-in-depth: only allow hostnames/IPs that are safe to interpolate into shell scripts.
// Blocks shell metacharacters even if an unsafe value somehow bypassed schema validation.
const SAFE_HOST_REGEX =
  /^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$|^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

const NETWORK_NAME = 'autopod-net';

/** Public NuGet v3 service index — used to discover CDN backend hosts at provisioning time */
const NUGET_PUBLIC_INDEX = 'https://api.nuget.org/v3/index.json';

/** Timeout for NuGet service index fetches during provisioning */
const NUGET_DISCOVERY_TIMEOUT_MS = 10_000;

export const DEFAULT_ALLOWED_HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  'registry.npmjs.org',
  'pypi.org',
  // NuGet — specific hosts only; CDN/blob backends are discovered dynamically
  // via resolveNugetBackendHosts() at provisioning time
  'api.nuget.org',
  'globalcdn.nuget.org',
  'nupkg.nuget.org',
  'github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  // Azure DevOps package feeds (npm / NuGet)
  'pkgs.dev.azure.com',
  // Required for MAX/PRO OAuth token refresh (Claude Code refreshes internally)
  'platform.claude.com',
  // Required for GitHub Copilot CLI
  'api.github.com',
  'api.enterprise.githubcopilot.com',
  'copilot-proxy.githubusercontent.com',
  'githubcopilot.com',
];

interface DockerNetworkManagerOptions {
  docker: Dockerode;
  logger: Logger;
}

export interface NetworkConfig {
  networkName: string;
  firewallScript: string;
}

export class DockerNetworkManager {
  private docker: Dockerode;
  private logger: Logger;
  private networkEnsured = false;

  constructor({ docker, logger }: DockerNetworkManagerOptions) {
    this.docker = docker;
    this.logger = logger.child({ component: 'docker-network-manager' });
  }

  async ensureNetwork(): Promise<void> {
    if (this.networkEnsured) return;

    try {
      const network = this.docker.getNetwork(NETWORK_NAME);
      await network.inspect();
      this.logger.debug('Network %s already exists', NETWORK_NAME);
    } catch {
      this.logger.info('Creating Docker network %s', NETWORK_NAME);
      await this.docker.createNetwork({
        Name: NETWORK_NAME,
        Driver: 'bridge',
        Options: {
          'com.docker.network.bridge.enable_icc': 'false',
        },
      });
    }

    this.networkEnsured = true;
  }

  /**
   * Compute the effective allowlist for a session, merging defaults,
   * profile policy, daemon gateway, MCP server hosts, and dynamically
   * discovered hosts.
   *
   * Wildcard entries (e.g. `*.example.com`) are resolved by stripping the
   * `*.` prefix and resolving the parent domain. This is best-effort: it works
   * when all subdomains share the same IP block, but won't cover CDN-dispersed
   * hostnames where subdomains resolve to different PoPs.
   */
  computeAllowlist(
    policy: NetworkPolicy,
    mcpServers: InjectedMcpServer[],
    daemonGatewayIp: string,
    additionalHosts: string[] = [],
  ): string[] {
    const hosts = new Set<string>();

    // Start with defaults (unless explicitly replaced)
    if (!policy.replaceDefaults) {
      for (const h of DEFAULT_ALLOWED_HOSTS) {
        hosts.add(h);
      }
    }

    // Add profile-specified hosts, normalising wildcard entries
    for (const h of policy.allowedHosts) {
      // *.example.com → resolve example.com (best-effort wildcard support)
      hosts.add(h.startsWith('*.') ? h.slice(2) : h);
    }

    // Add dynamically discovered hosts (e.g. NuGet CDN backends)
    for (const h of additionalHosts) {
      hosts.add(h);
    }

    // Add daemon gateway so the container can reach the daemon's MCP endpoint
    hosts.add(daemonGatewayIp);
    // Also add host.docker.internal as a common alternative
    hosts.add('host.docker.internal');

    // Extract hostnames from MCP server URLs
    for (const server of mcpServers) {
      try {
        const url = new URL(server.url);
        hosts.add(url.hostname);
      } catch {
        // Malformed URL — skip
      }
    }

    return [...hosts];
  }

  /**
   * Generate an iptables firewall script. Behaviour depends on mode:
   *
   * - 'allow-all'  — flush rules, allow loopback + established; no DROP (open egress)
   * - 'deny-all'   — flush rules, allow loopback + established + DNS, REJECT everything else
   * - 'restricted' — (default) resolve allowed hosts to IPs, allow them, REJECT the rest
   *
   * The script is idempotent: it always flushes OUTPUT before re-applying rules,
   * making it safe to re-exec on a running container for live policy updates.
   * Note: there is a brief window (~ms) between flush and new rules where all
   * traffic is allowed — acceptable for this use case.
   */
  async generateFirewallScript(
    allowedHosts: string[],
    mode: NetworkPolicyMode = 'restricted',
  ): Promise<string> {
    const lines = ['#!/bin/sh', 'set -e', ''];

    lines.push('# Flush existing OUTPUT rules');
    lines.push('iptables -F OUTPUT 2>/dev/null || true');
    lines.push('');
    lines.push('# Allow loopback');
    lines.push('iptables -A OUTPUT -o lo -j ACCEPT');
    lines.push('');
    lines.push('# Allow established/related connections');
    lines.push('iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT');

    if (mode === 'allow-all') {
      lines.push('');
      lines.push('echo "Firewall: allow-all mode — no outbound restrictions"');
      return lines.join('\n');
    }

    lines.push('');
    lines.push('# Allow DNS (UDP + TCP port 53)');
    lines.push('iptables -A OUTPUT -p udp --dport 53 -j ACCEPT');
    lines.push('iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT');

    if (mode === 'deny-all') {
      lines.push('');
      lines.push(
        '# Reject everything else outbound (REJECT, not DROP — fast failure for debugging)',
      );
      lines.push('iptables -A OUTPUT -j REJECT --reject-with icmp-port-unreachable');
      lines.push('');
      lines.push('echo "Firewall: deny-all mode — all outbound blocked"');
      return lines.join('\n');
    }

    // restricted — resolve hosts to IPs on the daemon side (reliable DNS) and
    // expand to /24 CIDRs to handle CDN IP rotation.
    // Previous approach resolved inside the container, but Docker's embedded DNS
    // on custom bridge networks isn't always ready immediately after container start.
    const cidrs = new Set<string>();
    await Promise.all(
      allowedHosts.map(async (host) => {
        if (!SAFE_HOST_REGEX.test(host)) {
          this.logger.warn({ host }, 'Skipping unsafe hostname in firewall script generation');
          return;
        }
        if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
          cidrs.add(host);
          return;
        }
        try {
          const { resolve4 } = await import('node:dns/promises');
          const ips = await resolve4(host);
          for (const ip of ips) {
            const parts = ip.split('.');
            cidrs.add(`${parts[0]}.${parts[1]}.${parts[2]}.0/24`);
          }
        } catch {
          this.logger.warn({ host }, 'Failed to resolve host for firewall allowlist');
        }
      }),
    );

    // Collect resolvable hostnames for the container-side second pass
    const resolvableHosts = allowedHosts.filter(
      (h) => SAFE_HOST_REGEX.test(h) && !/^\d+\.\d+\.\d+\.\d+$/.test(h),
    );

    lines.push('');
    lines.push(
      `# ${cidrs.size} CIDRs resolved from ${allowedHosts.length} hosts (daemon-side DNS)`,
    );
    for (const cidr of cidrs) {
      lines.push(`iptables -A OUTPUT -d "${cidr}" -j ACCEPT`);
    }

    // Second pass: resolve allowed hosts from the container's perspective.
    // CDN services (Azure Front Door, NuGet, etc.) return different IPs depending
    // on the resolver's location. The daemon may resolve to one set of /24 ranges
    // while the container's DNS returns a different set. This pass catches the gap.
    //
    // Uses getent (available in all our container images) and deduplicates against
    // existing rules via iptables -C (check) before inserting.
    if (resolvableHosts.length > 0) {
      lines.push('');
      lines.push('# Container-side DNS resolution pass (covers CDN PoP differences)');
      lines.push('container_resolve() {');
      lines.push('  for host in "$@"; do');
      lines.push(
        '    for ip in $(getent ahostsv4 "$host" 2>/dev/null | awk \'{print $1}\' | sort -u); do',
      );
      lines.push('      cidr="$(echo "$ip" | awk -F. \'{print $1"."$2"."$3".0/24"}\')"');
      lines.push('      iptables -C OUTPUT -d "$cidr" -j ACCEPT 2>/dev/null || \\');
      lines.push('        iptables -I OUTPUT -d "$cidr" -j ACCEPT 2>/dev/null || true');
      lines.push('    done');
      lines.push('  done');
      lines.push('}');
      lines.push(`container_resolve ${resolvableHosts.map((h) => `"${h}"`).join(' ')}`);
    }

    lines.push('');
    lines.push('# Reject everything else outbound (REJECT, not DROP — fast failure for debugging)');
    lines.push('iptables -A OUTPUT -j REJECT --reject-with icmp-port-unreachable');
    lines.push('');
    lines.push(
      `echo "Firewall: restricted mode — ${cidrs.size} CIDRs (daemon) + container-side resolution"`,
    );

    return lines.join('\n');
  }

  /**
   * Discover CDN/blob storage backend hostnames from NuGet feed service indices.
   *
   * NuGet feeds expose a v3 service index (JSON) that lists resource endpoints.
   * Package downloads often redirect to CDN or blob storage hosts (e.g.
   * `*.blob.core.windows.net`) whose subdomains are unpredictable at config time.
   *
   * This method fetches each feed's service index, extracts all hostnames from
   * the resource URLs, and also probes the public NuGet index when `includePublic`
   * is true (default). The discovered hosts are then passed to `computeAllowlist()`
   * so that the firewall CIDRs cover the actual download targets.
   *
   * Non-fatal: fetch failures are logged and silently skipped.
   */
  async resolveNugetBackendHosts(
    registries: PrivateRegistry[],
    includePublic = true,
  ): Promise<string[]> {
    const nugetFeeds = registries.filter((r) => r.type === 'nuget').map((r) => r.url);

    // Always probe public NuGet for .NET sessions (CDN hosts rotate)
    if (includePublic) {
      nugetFeeds.push(NUGET_PUBLIC_INDEX);
    }

    if (nugetFeeds.length === 0) return [];

    const hosts = new Set<string>();
    await Promise.all(
      nugetFeeds.map(async (feedUrl) => {
        try {
          const resp = await fetch(feedUrl, {
            signal: AbortSignal.timeout(NUGET_DISCOVERY_TIMEOUT_MS),
            headers: { Accept: 'application/json' },
          });
          if (!resp.ok) return;
          const index = (await resp.json()) as { resources?: { '@id'?: string }[] };
          if (!Array.isArray(index.resources)) return;

          for (const resource of index.resources) {
            const id = resource['@id'];
            if (typeof id !== 'string') continue;
            try {
              const parsed = new URL(id);
              if (SAFE_HOST_REGEX.test(parsed.hostname)) {
                hosts.add(parsed.hostname);
              }
            } catch {
              // Malformed resource URL — skip
            }
          }
        } catch {
          this.logger.warn(
            { feedUrl },
            'Failed to fetch NuGet service index for firewall discovery',
          );
        }
      }),
    );

    return [...hosts];
  }

  /**
   * Build the full network config for a container, or null if network
   * isolation is not enabled for this profile.
   */
  async buildNetworkConfig(
    policy: NetworkPolicy | null,
    mcpServers: InjectedMcpServer[],
    daemonGatewayIp: string,
    additionalHosts: string[] = [],
  ): Promise<NetworkConfig | null> {
    if (!policy?.enabled) return null;

    await this.ensureNetwork();

    const allowlist = this.computeAllowlist(policy, mcpServers, daemonGatewayIp, additionalHosts);
    const firewallScript = await this.generateFirewallScript(allowlist, policy.mode);

    return {
      networkName: NETWORK_NAME,
      firewallScript,
    };
  }

  /**
   * Detect the gateway IP of the autopod-net bridge network.
   * Falls back to 'host.docker.internal' if detection fails.
   */
  async getGatewayIp(): Promise<string> {
    try {
      const network = this.docker.getNetwork(NETWORK_NAME);
      const info = await network.inspect();
      const gateway = info.IPAM?.Config?.[0]?.Gateway;
      if (gateway) return gateway;
    } catch {
      // Network might not exist yet
    }
    return 'host.docker.internal';
  }
}
