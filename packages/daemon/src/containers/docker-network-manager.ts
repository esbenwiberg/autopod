import type { InjectedMcpServer, NetworkPolicy, NetworkPolicyMode } from '@autopod/shared';
import type Dockerode from 'dockerode';
import type { Logger } from 'pino';

// Defense-in-depth: only allow hostnames/IPs that are safe to interpolate into shell scripts.
// Blocks shell metacharacters even if an unsafe value somehow bypassed schema validation.
const SAFE_HOST_REGEX =
  /^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$|^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

const NETWORK_NAME = 'autopod-net';

export const DEFAULT_ALLOWED_HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  'registry.npmjs.org',
  'pypi.org',
  // NuGet (.NET package registry + CDN)
  'api.nuget.org',
  'globalcdn.nuget.org',
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
   * profile policy, daemon gateway, and MCP server hosts.
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
   * - 'deny-all'   — flush rules, allow loopback + established + DNS, DROP everything else
   * - 'restricted' — (default) resolve allowed hosts to IPs, allow them, DROP the rest
   *
   * The script is idempotent: it always flushes OUTPUT before re-applying rules,
   * making it safe to re-exec on a running container for live policy updates.
   * Note: there is a brief window (~ms) between flush and new rules where all
   * traffic is allowed — acceptable for this use case.
   */
  generateFirewallScript(allowedHosts: string[], mode: NetworkPolicyMode = 'restricted'): string {
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
      lines.push('# Drop everything else outbound');
      lines.push('iptables -A OUTPUT -j DROP');
      lines.push('');
      lines.push('echo "Firewall: deny-all mode — all outbound blocked"');
      return lines.join('\n');
    }

    // restricted — resolve hosts to IPs and allow them
    lines.push('');
    lines.push('# Resolve allowed hosts to IPs');
    lines.push('ALLOWED_IPS=""');

    for (const host of allowedHosts) {
      // Defense-in-depth: skip any host that contains characters unsafe in shell scripts.
      // This guards against injection even if a value bypassed schema validation.
      if (!SAFE_HOST_REGEX.test(host)) {
        this.logger.warn({ host }, 'Skipping unsafe hostname in firewall script generation');
        continue;
      }
      // If it looks like an IP already, use it directly
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        lines.push(`ALLOWED_IPS="$ALLOWED_IPS ${host}"`);
      } else {
        lines.push(
          `for ip in $(getent ahosts "${host}" 2>/dev/null | awk '{print $1}' | sort -u); do`,
        );
        lines.push(`  ALLOWED_IPS="$ALLOWED_IPS $ip"`);
        lines.push('done');
      }
    }

    lines.push('');
    lines.push('# Allow traffic to each resolved IP');
    lines.push('for ip in $ALLOWED_IPS; do');
    lines.push('  iptables -A OUTPUT -d "$ip" -j ACCEPT');
    lines.push('done');
    lines.push('');
    lines.push('# Drop everything else outbound');
    lines.push('iptables -A OUTPUT -j DROP');
    lines.push('');
    lines.push('echo "Firewall rules applied: $(echo $ALLOWED_IPS | wc -w) IPs allowed"');

    return lines.join('\n');
  }

  /**
   * Build the full network config for a container, or null if network
   * isolation is not enabled for this profile.
   */
  async buildNetworkConfig(
    policy: NetworkPolicy | null,
    mcpServers: InjectedMcpServer[],
    daemonGatewayIp: string,
  ): Promise<NetworkConfig | null> {
    if (!policy?.enabled) return null;

    await this.ensureNetwork();

    const allowlist = this.computeAllowlist(policy, mcpServers, daemonGatewayIp);
    const firewallScript = this.generateFirewallScript(allowlist, policy.mode);

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
