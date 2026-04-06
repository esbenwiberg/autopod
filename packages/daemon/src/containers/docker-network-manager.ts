import type { InjectedMcpServer, NetworkPolicy, NetworkPolicyMode } from '@autopod/shared';
import type Dockerode from 'dockerode';
import type { Logger } from 'pino';

// Defense-in-depth: only allow hostnames/IPs that are safe to interpolate into shell scripts.
// Blocks shell metacharacters even if an unsafe value somehow bypassed schema validation.
const SAFE_HOST_REGEX =
  /^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$|^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

const NETWORK_NAME = 'autopod-net';

/** Docker's embedded DNS resolver address on custom bridge networks */
const DOCKER_DNS = '127.0.0.11';
/** Local dnsmasq listener — avoids conflict with Docker DNS */
const DNSMASQ_LISTEN = '127.0.0.53';

export const DEFAULT_ALLOWED_HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  'registry.npmjs.org',
  'pypi.org',
  // NuGet (.NET package registry + CDN)
  'api.nuget.org',
  'globalcdn.nuget.org',
  'nupkg.nuget.org',
  // Azure CDN wildcards — only effective in dnsmasq mode; covers ADO NuGet feed
  // blob storage redirects and NuGet CDN endpoints with unpredictable subdomains
  '*.blob.core.windows.net',
  '*.vo.msecnd.net',
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
   * Wildcard entries (e.g. `*.blob.core.windows.net`) are preserved so that
   * `generateFirewallScript()` can produce dnsmasq wildcard rules. In fallback
   * CIDR mode, wildcards are stripped to the parent domain for best-effort
   * DNS resolution.
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

    // Add profile-specified hosts (wildcards preserved)
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
   * Generate a firewall script for the container. Behaviour depends on mode:
   *
   * - 'allow-all'  — flush rules, allow loopback + established; no DROP (open egress)
   * - 'deny-all'   — flush rules, allow loopback + established + DNS, REJECT everything else
   * - 'restricted' — domain-based filtering via dnsmasq+ipset (preferred) or CIDR fallback
   *
   * **dnsmasq+ipset mode** (when dnsmasq and ipset are installed):
   *   - dnsmasq acts as a filtering DNS resolver, only forwarding allowed domains
   *   - Resolved IPs are auto-added to an ipset via dnsmasq's `--ipset` flag
   *   - iptables allows only IPs in the ipset — true domain-based filtering
   *   - Wildcard support is native: `*.blob.core.windows.net` covers all subdomains
   *
   * **CIDR fallback** (when dnsmasq/ipset not available):
   *   - Resolves hosts to IPs on the daemon side, expands to /24 CIDRs
   *   - Wildcards stripped to parent domain for best-effort resolution
   *   - Less reliable for CDN services with rotating IPs
   *
   * The script is idempotent: safe to re-exec on a running container for live updates.
   */
  async generateFirewallScript(
    allowedHosts: string[],
    mode: NetworkPolicyMode = 'restricted',
    daemonGatewayIp?: string,
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

    if (mode === 'deny-all') {
      lines.push('');
      // Always allow the daemon gateway so the container can reach the MCP endpoint.
      // Without this, escalation tools (ask_human, report_plan, etc.) are unreachable.
      // host.docker.internal is in /etc/hosts (injected via ExtraHosts), not DNS,
      // so we must resolve it via getent inside the container.
      lines.push('# Allow daemon gateway (MCP escalation endpoint)');
      lines.push(
        'for _gw_ip in $(getent ahostsv4 host.docker.internal 2>/dev/null | awk \'{print $1}\' | sort -u); do',
      );
      lines.push('  iptables -A OUTPUT -d "$_gw_ip" -j ACCEPT');
      lines.push('done');
      if (daemonGatewayIp) {
        lines.push(`iptables -A OUTPUT -d "${daemonGatewayIp}" -j ACCEPT 2>/dev/null || true`);
      }
      lines.push('');
      lines.push('# Allow DNS');
      lines.push('iptables -A OUTPUT -p udp --dport 53 -j ACCEPT');
      lines.push('iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT');
      lines.push('');
      lines.push(
        '# Reject everything else outbound (REJECT, not DROP — fast failure for debugging)',
      );
      lines.push('iptables -A OUTPUT -j REJECT --reject-with icmp-port-unreachable');
      lines.push('');
      lines.push('echo "Firewall: deny-all mode — all outbound blocked (daemon gateway allowed)"');
      return lines.join('\n');
    }

    // restricted mode — try dnsmasq+ipset, fall back to CIDR-only
    const safeHosts = allowedHosts.filter((h) => SAFE_HOST_REGEX.test(h));
    const ipHosts = safeHosts.filter((h) => /^\d+\.\d+\.\d+\.\d+$/.test(h));
    const wildcardHosts = safeHosts.filter((h) => h.startsWith('*.'));
    const exactHosts = safeHosts.filter(
      (h) => !h.startsWith('*.') && !/^\d+\.\d+\.\d+\.\d+$/.test(h),
    );

    // Resolve exact hosts to /24 CIDRs (used by both modes for pre-seeding)
    const cidrs = new Set<string>();
    for (const ip of ipHosts) {
      cidrs.add(ip);
    }
    await Promise.all(
      exactHosts.map(async (host) => {
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

    // Build dnsmasq domain entries: for each domain, generate server= and ipset= lines.
    // dnsmasq treats /domain/ as a suffix match, so /blob.core.windows.net/ covers all subdomains.
    const dnsmasqDomains: string[] = [];
    for (const h of exactHosts) {
      dnsmasqDomains.push(h);
    }
    for (const h of wildcardHosts) {
      // *.blob.core.windows.net → blob.core.windows.net (dnsmasq suffix match)
      dnsmasqDomains.push(h.slice(2));
    }

    // --- dnsmasq+ipset mode ---
    lines.push('');
    lines.push('# Attempt dnsmasq+ipset mode (domain-based filtering)');
    lines.push('if command -v dnsmasq >/dev/null 2>&1 && command -v ipset >/dev/null 2>&1; then');
    lines.push('');
    lines.push('  # Stop any running dnsmasq');
    lines.push('  killall dnsmasq 2>/dev/null || true');
    lines.push('');
    lines.push('  # Create ipset for allowed IPs');
    lines.push('  ipset destroy allowed_ips 2>/dev/null || true');
    lines.push('  ipset create allowed_ips hash:net');
    lines.push('');

    // Pre-seed ipset with daemon-resolved CIDRs
    if (cidrs.size > 0) {
      lines.push(`  # Pre-seed ipset with ${cidrs.size} daemon-resolved CIDRs`);
      for (const cidr of cidrs) {
        lines.push(`  ipset add allowed_ips "${cidr}" 2>/dev/null || true`);
      }
      lines.push('');
    }

    // host.docker.internal resolves from /etc/hosts (ExtraHosts), not DNS.
    // dnsmasq has no-hosts so it can't resolve it, and Docker DNS doesn't know about it.
    // Resolve it via getent inside the container and add the IP directly to the ipset.
    lines.push('  # Ensure daemon gateway (host.docker.internal) is reachable for MCP');
    lines.push(
      '  for _gw_ip in $(getent ahostsv4 host.docker.internal 2>/dev/null | awk \'{print $1}\' | sort -u); do',
    );
    lines.push('    ipset add allowed_ips "$_gw_ip" 2>/dev/null || true');
    lines.push('  done');
    lines.push('');

    // Write dnsmasq config
    lines.push('  # Write dnsmasq config');
    lines.push("  cat > /tmp/dnsmasq-firewall.conf << 'DNSCONF'");
    lines.push('no-resolv');
    lines.push('no-hosts');
    lines.push(`listen-address=${DNSMASQ_LISTEN}`);
    lines.push('bind-interfaces');
    // dnsmasq drops privileges to the dnsmasq user if it exists, otherwise nobody.
    // We need a known user for the iptables owner match.
    lines.push('user=nobody');
    lines.push('');
    lines.push('# Allowed domains — forward to Docker DNS and populate ipset');
    for (const domain of dnsmasqDomains) {
      lines.push(`server=/${domain}/${DOCKER_DNS}`);
      lines.push(`ipset=/${domain}/allowed_ips`);
    }
    lines.push('');
    lines.push('# Block everything else');
    lines.push('address=/#/');
    lines.push('DNSCONF');
    lines.push('');

    // Start dnsmasq
    lines.push('  # Start dnsmasq');
    lines.push('  dnsmasq --conf-file=/tmp/dnsmasq-firewall.conf --pid-file=/tmp/dnsmasq.pid');
    lines.push('');

    // Rewrite resolv.conf to use dnsmasq
    lines.push('  # Point DNS to dnsmasq');
    lines.push(`  echo "nameserver ${DNSMASQ_LISTEN}" > /etc/resolv.conf`);
    lines.push('');

    // iptables rules for dnsmasq mode
    lines.push('  # DNS: only dnsmasq (nobody) can reach Docker DNS');
    lines.push(
      `  iptables -A OUTPUT -p udp --dport 53 -d ${DOCKER_DNS} -m owner --uid-owner nobody -j ACCEPT`,
    );
    lines.push(
      `  iptables -A OUTPUT -p tcp --dport 53 -d ${DOCKER_DNS} -m owner --uid-owner nobody -j ACCEPT`,
    );
    lines.push('  # Block direct DNS to Docker resolver from other users');
    lines.push(`  iptables -A OUTPUT -p udp --dport 53 -d ${DOCKER_DNS} -j REJECT`);
    lines.push(`  iptables -A OUTPUT -p tcp --dport 53 -d ${DOCKER_DNS} -j REJECT`);
    lines.push('  # Allow all users to reach dnsmasq (on loopback, already covered)');
    lines.push('');
    lines.push('  # Allow traffic to IPs in the ipset');
    lines.push('  iptables -A OUTPUT -m set --match-set allowed_ips dst -j ACCEPT');
    lines.push('');
    lines.push('  # Reject everything else');
    lines.push('  iptables -A OUTPUT -j REJECT --reject-with icmp-port-unreachable');
    lines.push('');
    lines.push(
      `  echo "Firewall: restricted mode (dnsmasq+ipset) — ${dnsmasqDomains.length} domains, ${cidrs.size} pre-seeded CIDRs"`,
    );
    lines.push('');

    // --- CIDR fallback mode ---
    lines.push('else');
    lines.push('');
    lines.push('  echo "dnsmasq/ipset not available — falling back to CIDR mode"');
    lines.push('');
    lines.push('  # Allow DNS');
    lines.push('  iptables -A OUTPUT -p udp --dport 53 -j ACCEPT');
    lines.push('  iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT');
    lines.push('');

    lines.push(`  # ${cidrs.size} CIDRs resolved from allowed hosts (daemon-side DNS)`);
    for (const cidr of cidrs) {
      lines.push(`  iptables -A OUTPUT -d "${cidr}" -j ACCEPT`);
    }

    // Container-side resolution pass for CIDR fallback
    const resolvableHosts = [...exactHosts, ...wildcardHosts.map((h) => h.slice(2))];
    if (resolvableHosts.length > 0) {
      lines.push('');
      lines.push('  # Container-side DNS resolution (covers CDN PoP differences)');
      lines.push('  container_resolve() {');
      lines.push('    for host in "$@"; do');
      lines.push(
        '      for ip in $(getent ahostsv4 "$host" 2>/dev/null | awk \'{print $1}\' | sort -u); do',
      );
      lines.push('        cidr="$(echo "$ip" | awk -F. \'{print $1"."$2"."$3".0/24"}\')"');
      lines.push('        iptables -C OUTPUT -d "$cidr" -j ACCEPT 2>/dev/null || \\');
      lines.push('          iptables -I OUTPUT -d "$cidr" -j ACCEPT 2>/dev/null || true');
      lines.push('      done');
      lines.push('    done');
      lines.push('  }');
      lines.push(`  container_resolve ${resolvableHosts.map((h) => `"${h}"`).join(' ')}`);
    }

    lines.push('');
    lines.push(
      '  # Reject everything else outbound (REJECT, not DROP — fast failure for debugging)',
    );
    lines.push('  iptables -A OUTPUT -j REJECT --reject-with icmp-port-unreachable');
    lines.push('');
    lines.push(`  echo "Firewall: restricted mode (CIDR fallback) — ${cidrs.size} CIDRs"`);
    lines.push('');
    lines.push('fi');

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
    const firewallScript = await this.generateFirewallScript(allowlist, policy.mode, daemonGatewayIp);

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
