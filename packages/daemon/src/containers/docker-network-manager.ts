import type Dockerode from 'dockerode';
import type { Logger } from 'pino';
import type { NetworkPolicy, InjectedMcpServer } from '@autopod/shared';

const NETWORK_NAME = 'autopod-net';

export const DEFAULT_ALLOWED_HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  'registry.npmjs.org',
  'pypi.org',
  'github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
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

    // Add profile-specified hosts
    for (const h of policy.allowedHosts) {
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
   * Generate an iptables firewall script that:
   * 1. Resolves all allowed hostnames to IPs
   * 2. Allows DNS (port 53) for resolution
   * 3. Allows established connections
   * 4. Allows traffic to resolved IPs
   * 5. Drops everything else outbound
   *
   * The script is designed to be idempotent and to fail gracefully.
   */
  generateFirewallScript(allowedHosts: string[]): string {
    const lines = [
      '#!/bin/sh',
      'set -e',
      '',
      '# Resolve allowed hosts to IPs at container start',
      'ALLOWED_IPS=""',
    ];

    for (const host of allowedHosts) {
      // If it looks like an IP already, use it directly
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        lines.push(`ALLOWED_IPS="$ALLOWED_IPS ${host}"`);
      } else {
        // Resolve hostname — use getent for reliability, fall back to nslookup
        lines.push(`for ip in $(getent ahosts "${host}" 2>/dev/null | awk '{print $1}' | sort -u); do`);
        lines.push(`  ALLOWED_IPS="$ALLOWED_IPS $ip"`);
        lines.push('done');
      }
    }

    lines.push('');
    lines.push('# Flush existing OUTPUT rules');
    lines.push('iptables -F OUTPUT 2>/dev/null || true');
    lines.push('');
    lines.push('# Allow loopback');
    lines.push('iptables -A OUTPUT -o lo -j ACCEPT');
    lines.push('');
    lines.push('# Allow established/related connections');
    lines.push('iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT');
    lines.push('');
    lines.push('# Allow DNS (UDP + TCP port 53)');
    lines.push('iptables -A OUTPUT -p udp --dport 53 -j ACCEPT');
    lines.push('iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT');
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
    const firewallScript = this.generateFirewallScript(allowlist);

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
