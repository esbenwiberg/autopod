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

/**
 * Per-pod Docker network naming. Each pod gets its own bridge
 * (`autopod-<podId>`) with inter-container communication enabled — that way
 * a pod and its sidecars (e.g. Dagger engine) can talk to each other without
 * flipping the shared bridge's ICC flag and opening pod-to-pod visibility.
 * Cross-pod isolation is preserved because different pods are on different
 * bridges entirely, so their L2 domains never intersect.
 */
export function networkNameForPod(podId: string): string {
  return `autopod-${podId}`;
}

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
  // NOTE: github.com, objects.githubusercontent.com, and raw.githubusercontent.com are
  // intentionally excluded. Pods commit locally and don't push; npm uses registry.npmjs.org.
  // Including github.com lets agents bypass ACP action tools via WebFetch/curl to GitHub
  // web pages. Profiles that need GitHub for "github:org/repo" npm deps can add it explicitly.
  // Azure DevOps package feeds (npm / NuGet)
  'pkgs.dev.azure.com',
  // Required for MAX/PRO OAuth token refresh (Claude Code refreshes internally)
  'platform.claude.com',
  // Required for GitHub Copilot CLI (token exchange + inference)
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

  constructor({ docker, logger }: DockerNetworkManagerOptions) {
    this.docker = docker;
    this.logger = logger.child({ component: 'docker-network-manager' });
  }

  /**
   * Create (or reuse) the per-pod bridge network. Idempotent — safe to call
   * on recovery paths where the network may already exist from a previous
   * daemon run. Returns the network name.
   *
   * ICC is enabled: every container on this bridge can talk to every other.
   * That's what we want — the pod + its sidecars share this bridge and
   * nothing else lives here. Pod-to-pod isolation comes from each pod
   * having its own bridge, not from ICC.
   */
  async ensureNetworkForPod(podId: string): Promise<string> {
    const name = networkNameForPod(podId);
    try {
      await this.docker.getNetwork(name).inspect();
      this.logger.debug({ network: name, podId }, 'Pod network already exists');
      return name;
    } catch {
      // not found — create it
    }
    this.logger.info({ network: name, podId }, 'Creating pod network');
    const networkConfig = {
      Name: name,
      Driver: 'bridge',
      Labels: {
        'com.autopod.pod-network': 'true',
        'com.autopod.pod-id': podId,
      },
      Options: {
        // ICC on — sidecar + pod must reach each other. Pod-to-pod isolation
        // is provided by the fact that each pod is on its own bridge.
        'com.docker.network.bridge.enable_icc': 'true',
      },
    };
    try {
      await this.docker.createNetwork(networkConfig);
    } catch (err: unknown) {
      const msg = (err as { message?: string }).message ?? '';
      if (msg.includes('all predefined address pools have been fully subnetted')) {
        // Docker's default subnet pool is exhausted by orphaned autopod networks.
        // Prune any autopod network that has no containers attached (safe to
        // remove — active networks always have at least the pod or a sidecar).
        this.logger.warn({ podId }, 'Subnet pool exhausted — pruning unattached autopod networks');
        const nets = await this.docker.listNetworks({
          filters: JSON.stringify({ label: ['com.autopod.pod-network=true'] }),
        });
        await Promise.all(
          nets
            .filter((n) => !n.Containers || Object.keys(n.Containers).length === 0)
            .map(async (n) => {
              try {
                await this.docker.getNetwork(n.Id).remove();
              } catch {
                // best effort
              }
            }),
        );
        await this.docker.createNetwork(networkConfig);
      } else {
        throw err;
      }
    }
    return name;
  }

  /**
   * Remove orphaned pod networks left behind by a crashed daemon. Called on
   * startup after pod reconciliation so we know which pod IDs are still active.
   * Networks whose pod ID is not in `activePodIds` have no living pod and are
   * safe to prune.
   */
  async reconcileOrphanNetworks(activePodIds: Set<string>): Promise<number> {
    const networks = await this.docker.listNetworks({
      filters: JSON.stringify({ label: ['com.autopod.pod-network=true'] }),
    });
    let pruned = 0;
    await Promise.all(
      networks.map(async (net) => {
        const podId = net.Labels?.['com.autopod.pod-id'];
        if (!podId || activePodIds.has(podId)) return;
        const network = this.docker.getNetwork(net.Id);
        try {
          // A previous daemon crash can leave containers attached to the network.
          // Docker rejects `network rm` with 403 ("has active endpoints") until
          // every endpoint is detached, so force-disconnect each one first. The
          // containers themselves get reaped by the sidecar/local reconcilers.
          await this.detachEndpoints(network, net);
          await network.remove();
          this.logger.info({ network: net.Name, podId }, 'Pruned orphan pod network');
          pruned++;
        } catch (err) {
          this.logger.warn({ err, network: net.Name, podId }, 'Failed to prune orphan pod network');
        }
      }),
    );
    return pruned;
  }

  /**
   * Force-disconnect every container currently attached to `network`. Used by
   * the orphan reconciler to clear stale endpoints left behind by a crashed
   * daemon so the network can subsequently be removed.
   */
  private async detachEndpoints(
    network: ReturnType<Dockerode['getNetwork']>,
    listEntry: Dockerode.NetworkInspectInfo,
  ): Promise<void> {
    // Prefer the live inspection — `listNetworks` returns containers only when
    // the network is on the same node as the daemon, and the data can lag.
    let containerIds: string[] = [];
    try {
      const info = (await network.inspect()) as
        | { Containers?: Record<string, unknown> }
        | undefined;
      containerIds = Object.keys(info?.Containers ?? {});
    } catch {
      containerIds = Object.keys(listEntry.Containers ?? {});
    }
    if (containerIds.length === 0) return;
    await Promise.all(
      containerIds.map(async (containerId) => {
        try {
          await network.disconnect({ Container: containerId, Force: true });
          this.logger.info(
            { network: listEntry.Name, containerId },
            'Force-disconnected stale endpoint from orphan pod network',
          );
        } catch (err) {
          this.logger.warn(
            { err, network: listEntry.Name, containerId },
            'Failed to force-disconnect stale endpoint',
          );
        }
      }),
    );
  }

  /**
   * Remove the per-pod bridge. Called from the pod cleanup path so networks
   * don't accumulate. Idempotent — swallows "already gone" errors.
   */
  async destroyNetworkForPod(podId: string): Promise<void> {
    const name = networkNameForPod(podId);
    try {
      const network = this.docker.getNetwork(name);
      await network.remove();
      this.logger.info({ network: name, podId }, 'Pod network removed');
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404) {
        this.logger.debug({ network: name, podId }, 'Pod network already gone');
        return;
      }
      // 403 "has active endpoints" means the pod or sidecar containers are
      // still attached. Log and continue — the orphan reconciler will sweep
      // them on next startup.
      this.logger.warn({ err, network: name, podId }, 'Failed to remove pod network');
    }
  }

  /**
   * Compute the effective allowlist for a pod, merging defaults,
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
    registries: PrivateRegistry[] = [],
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

    // Extract hostnames from private package registries (npm/NuGet feeds)
    for (const reg of registries) {
      try {
        const url = new URL(reg.url);
        hosts.add(url.hostname);
      } catch {
        // Malformed URL — skip
      }
    }

    // Auto-allow common package manager registries when the flag is set
    if (policy.allowPackageManagers) {
      const PACKAGE_MANAGER_HOSTS = [
        'registry.npmjs.org',
        'registry.yarnpkg.com',
        'dl.yarnpkg.com',
        'pypi.org',
        'files.pythonhosted.org',
        'crates.io',
        'static.crates.io',
        'deb.debian.org',
        'security.debian.org',
        'nuget.org',
        'api.nuget.org',
        'proxy.golang.org',
        'sum.golang.org',
        'rubygems.org',
        'api.rubygems.org',
      ];
      for (const h of PACKAGE_MANAGER_HOSTS) {
        hosts.add(h);
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
    /**
     * Raw IPs (e.g. sidecar bridge IPs) that must be reachable regardless of
     * the domain allowlist. These are added as explicit ACCEPT rules /
     * pre-seeded into the ipset before the REJECT default kicks in, so the
     * pod can always reach its companion sidecars even under `deny-all`.
     */
    extraAllowedIps: string[] = [],
    /**
     * DNS names (e.g. `['dagger']`) that must resolve from inside the pod.
     * Iptables-level allowlisting of the IP is not enough on its own: the
     * pod's DNS resolver is dnsmasq, which only forwards queries for
     * allow-listed domains. Without adding the sidecar's name here, the pod's
     * Dagger CLI sees `tcp://dagger:8080` and tries `getent ahostsv4 dagger`
     * → NXDOMAIN → `dagger develop` hangs on DNS.
     */
    extraAllowedDnsNames: string[] = [],
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
        "for _gw_ip in $(getent ahostsv4 host.docker.internal 2>/dev/null | awk '{print $1}' | sort -u); do",
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
      if (extraAllowedIps.length > 0) {
        lines.push('');
        lines.push(`# Allow sidecar IPs (${extraAllowedIps.length})`);
        for (const ip of extraAllowedIps) {
          lines.push(`iptables -A OUTPUT -d "${ip}" -j ACCEPT`);
        }
      }
      lines.push('');
      lines.push(
        '# Reject everything else outbound (REJECT, not DROP — fast failure for debugging)',
      );
      lines.push('iptables -A OUTPUT -j REJECT --reject-with icmp-port-unreachable');
      lines.push('');
      lines.push('# IPv6: deny all outbound (mirrors IPv4 deny-all)');
      lines.push('ip6tables -F OUTPUT 2>/dev/null || true');
      lines.push('ip6tables -A OUTPUT -o lo -j ACCEPT');
      lines.push('ip6tables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT');
      lines.push('ip6tables -A OUTPUT -j REJECT --reject-with icmp6-port-unreachable');
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
    // Sidecar IPs are exact /32s — don't expand to /24 (would accidentally
    // cover the whole bridge subnet and let one pod's sidecar be reached by
    // another pod that somehow got onto the same subnet).
    for (const ip of extraAllowedIps) {
      cidrs.add(ip);
    }
    await Promise.all(
      exactHosts.map(async (host) => {
        try {
          const { resolve4 } = await import('node:dns/promises');
          const ips = await resolve4(host);
          for (const ip of ips) {
            cidrs.add(`${ip}/32`);
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
    // Sidecar DNS names must be resolvable from inside the pod. Without the
    // dnsmasq `server=` line, the pod's CLI (e.g. `dagger`) can't resolve the
    // sidecar hostname and fails before it even opens a TCP connection.
    for (const name of extraAllowedDnsNames) {
      if (SAFE_HOST_REGEX.test(name)) {
        dnsmasqDomains.push(name);
      }
    }

    // --- Probe dnsmasq+ipset+iptables-set integration ---
    // The binaries can exist while the kernel lacks `xt_set` (e.g. Docker
    // Desktop's LinuxKit VM). In that case `iptables -m set` fails at runtime
    // with "Can't open socket to ipset" — the binary check alone isn't enough.
    // Probe end-to-end: create a throwaway set, try a real `-m set` rule, then
    // tear it down. Only if the probe succeeds do we commit to dnsmasq mode.
    lines.push('');
    lines.push('# Probe dnsmasq + ipset + iptables-set integration end-to-end.');
    lines.push('# Binaries can exist without the xt_set kernel module (Docker Desktop).');
    lines.push('AUTOPOD_USE_DNSMASQ=0');
    lines.push('if command -v dnsmasq >/dev/null 2>&1 && command -v ipset >/dev/null 2>&1; then');
    lines.push('  if ipset create _autopod_probe hash:net 2>/dev/null; then');
    lines.push(
      '    if iptables -A OUTPUT -m set --match-set _autopod_probe dst -j ACCEPT 2>/dev/null; then',
    );
    lines.push('      AUTOPOD_USE_DNSMASQ=1');
    lines.push('    fi');
    lines.push(
      '    iptables -D OUTPUT -m set --match-set _autopod_probe dst -j ACCEPT 2>/dev/null || true',
    );
    lines.push('    ipset destroy _autopod_probe 2>/dev/null || true');
    lines.push('  fi');
    lines.push('fi');
    lines.push('');

    // Probe dnsmasq-only mode: dnsmasq available but ipset/xt_set unavailable (e.g. Docker
    // Desktop LinuxKit VM). DNS-level filtering with dnsmasq handles wildcards correctly;
    // iptables allows TCP 443/80 to all IPs (weaker IP control but works for CDN redirects).
    lines.push('# Probe dnsmasq-only mode: dnsmasq present but ipset/xt_set unavailable.');
    lines.push('AUTOPOD_USE_DNSMASQ_ONLY=0');
    lines.push('if [ "$AUTOPOD_USE_DNSMASQ" = "0" ] && command -v dnsmasq >/dev/null 2>&1; then');
    lines.push('  AUTOPOD_USE_DNSMASQ_ONLY=1');
    lines.push('fi');
    lines.push('');

    // --- dnsmasq+ipset mode ---
    lines.push('# Attempt dnsmasq+ipset mode (domain-based filtering)');
    lines.push('if [ "$AUTOPOD_USE_DNSMASQ" = "1" ]; then');
    lines.push('');
    lines.push('  # Stop any running dnsmasq (SIGKILL via PID file, then killall as fallback)');
    lines.push(
      '  if [ -f /tmp/dnsmasq.pid ]; then kill -9 "$(cat /tmp/dnsmasq.pid)" 2>/dev/null; rm -f /tmp/dnsmasq.pid; fi',
    );
    lines.push('  killall -9 dnsmasq 2>/dev/null || true');
    lines.push('  sleep 0.2  # let kernel release the listen socket');
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
      "  for _gw_ip in $(getent ahostsv4 host.docker.internal 2>/dev/null | awk '{print $1}' | sort -u); do",
    );
    lines.push('    ipset add allowed_ips "$_gw_ip" 2>/dev/null || true');
    lines.push('  done');
    lines.push('');

    // Resolve nobody's primary group at runtime — dnsmasq's compile-time default
    // group varies by distro (`dip` on Debian, `nogroup` on some Ubuntu builds,
    // `nobody` on Alpine) and the wrong choice causes dnsmasq to exit during
    // privilege drop. Pinning `group=` to the actual primary group of the
    // `nobody` user makes the config portable.
    lines.push('  # Resolve nobody primary group (varies: nogroup on Debian, nobody on Alpine)');
    lines.push('  NOBODY_GROUP=$(id -gn nobody 2>/dev/null || echo nobody)');
    lines.push('');

    // Write dnsmasq config (unquoted heredoc so $NOBODY_GROUP expands;
    // SAFE_HOST_REGEX guarantees no other shell metachars in interpolated values).
    lines.push('  # Write dnsmasq config');
    lines.push('  cat > /tmp/dnsmasq-firewall.conf << DNSCONF');
    lines.push('no-resolv');
    lines.push('no-hosts');
    lines.push(`listen-address=${DNSMASQ_LISTEN}`);
    lines.push('bind-interfaces');
    // dnsmasq drops privileges to the dnsmasq user if it exists, otherwise nobody.
    // We need a known user for the iptables owner match.
    lines.push('user=nobody');
    lines.push('group=$NOBODY_GROUP');
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

    // --- dnsmasq-only mode (dnsmasq present, ipset/xt_set unavailable) ---
    // Wildcards are handled natively by dnsmasq suffix matching. iptables allows
    // TCP 443/80 to all destinations — DNS is the primary gate (non-allowed domains
    // return NXDOMAIN). Less strict than ipset mode but fixes CDN wildcard subdomains
    // that CIDR fallback cannot pre-resolve (e.g. *.blob.core.windows.net redirects).
    lines.push('elif [ "$AUTOPOD_USE_DNSMASQ_ONLY" = "1" ]; then');
    lines.push('');
    lines.push('  echo "ipset/xt_set unavailable — dnsmasq DNS filtering + port 443/80 allowlist"');
    lines.push('');
    lines.push('  # Stop any running dnsmasq (SIGKILL via PID file, then killall as fallback)');
    lines.push(
      '  if [ -f /tmp/dnsmasq.pid ]; then kill -9 "$(cat /tmp/dnsmasq.pid)" 2>/dev/null; rm -f /tmp/dnsmasq.pid; fi',
    );
    lines.push('  killall -9 dnsmasq 2>/dev/null || true');
    lines.push('  sleep 0.2  # let kernel release the listen socket');
    lines.push('');

    if (cidrs.size > 0) {
      lines.push(`  # Pre-seed iptables with ${cidrs.size} daemon-resolved CIDRs`);
      for (const cidr of cidrs) {
        lines.push(`  iptables -A OUTPUT -d "${cidr}" -j ACCEPT`);
      }
      lines.push('');
    }

    lines.push('  # Ensure daemon gateway (host.docker.internal) is reachable for MCP');
    lines.push(
      "  for _gw_ip in $(getent ahostsv4 host.docker.internal 2>/dev/null | awk '{print $1}' | sort -u); do",
    );
    lines.push('    iptables -A OUTPUT -d "$_gw_ip" -j ACCEPT');
    lines.push('  done');
    lines.push('');

    lines.push('  # Resolve nobody primary group (varies: nogroup on Debian, nobody on Alpine)');
    lines.push('  NOBODY_GROUP=$(id -gn nobody 2>/dev/null || echo nobody)');
    lines.push('');

    // Unquoted heredoc so $NOBODY_GROUP expands; SAFE_HOST_REGEX ensures no shell metachars.
    lines.push('  # Write dnsmasq config (no ipset — DNS sinkhole only)');
    lines.push('  cat > /tmp/dnsmasq-firewall.conf << DNSCONF');
    lines.push('no-resolv');
    lines.push('no-hosts');
    lines.push(`listen-address=${DNSMASQ_LISTEN}`);
    lines.push('bind-interfaces');
    lines.push('user=nobody');
    lines.push('group=$NOBODY_GROUP');
    lines.push('');
    lines.push('# Allowed domains — forward to Docker DNS (no ipset population)');
    for (const domain of dnsmasqDomains) {
      lines.push(`server=/${domain}/${DOCKER_DNS}`);
    }
    lines.push('');
    lines.push('# Block everything else');
    lines.push('address=/#/');
    lines.push('DNSCONF');
    lines.push('');

    lines.push('  # Start dnsmasq');
    lines.push('  dnsmasq --conf-file=/tmp/dnsmasq-firewall.conf --pid-file=/tmp/dnsmasq.pid');
    lines.push('');

    lines.push('  # Point DNS to dnsmasq');
    lines.push(`  echo "nameserver ${DNSMASQ_LISTEN}" > /etc/resolv.conf`);
    lines.push('');

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
    lines.push('');
    lines.push('  # Allow HTTPS and HTTP outbound (domain filtering handled at DNS level;');
    lines.push('  # wildcard CDN subdomains resolve correctly through dnsmasq)');
    lines.push('  iptables -A OUTPUT -p tcp --dport 443 -j ACCEPT');
    lines.push('  iptables -A OUTPUT -p tcp --dport 80 -j ACCEPT');
    lines.push('');
    lines.push('  # Reject everything else');
    lines.push('  iptables -A OUTPUT -j REJECT --reject-with icmp-port-unreachable');
    lines.push('');
    lines.push(
      `  echo "Firewall: restricted mode (dnsmasq DNS-only) — ${dnsmasqDomains.length} domains, port 443/80 open"`,
    );
    lines.push('');

    // --- CIDR fallback mode ---
    lines.push('else');
    lines.push('');
    lines.push(
      '  echo "dnsmasq+ipset+iptables-set integration unavailable — falling back to CIDR mode"',
    );
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
      lines.push('        cidr="${ip}/32"');
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

    // IPv6: deny all outbound in restricted mode.
    // Domain-based IPv6 filtering is not implemented (ipset is IPv4-only by default,
    // and dnsmasq --ipset does not support IPv6 sets). Block all IPv6 egress to prevent
    // bypass of the IPv4 allowlist via IPv6 dual-stack routes.
    lines.push('');
    lines.push(
      '# IPv6: deny all outbound (domain-based IPv6 filtering not supported; fail closed)',
    );
    lines.push('ip6tables -F OUTPUT 2>/dev/null || true');
    lines.push('ip6tables -A OUTPUT -o lo -j ACCEPT');
    lines.push('ip6tables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT');
    lines.push('ip6tables -A OUTPUT -j REJECT --reject-with icmp6-port-unreachable');

    return lines.join('\n');
  }

  /**
   * Build the full network config for a pod, or null if network isolation is
   * not enabled for this profile. Per-pod: each call creates/reuses
   * `autopod-<podId>`. `extraAllowedIps` lets callers whitelist specific IPs
   * (e.g. sidecar bridge IPs discovered after the sidecar is spawned) so the
   * pod can reach them through the restrictive iptables rules.
   */
  async buildNetworkConfig(
    policy: NetworkPolicy | null,
    mcpServers: InjectedMcpServer[],
    daemonGatewayIp: string,
    registries: PrivateRegistry[] = [],
    podId?: string,
    extraAllowedIps: string[] = [],
    extraAllowedDnsNames: string[] = [],
  ): Promise<NetworkConfig | null> {
    if (!policy?.enabled) return null;

    const networkName = podId
      ? await this.ensureNetworkForPod(podId)
      : // Legacy / refresh path — caller didn't pass a podId. Fall back to
        // the default per-pod name format using a synthetic `shared` tag so
        // existing tests that don't thread podId still get a valid string.
        // Real pod spawns always pass podId.
        'autopod-shared';

    const allowlist = this.computeAllowlist(policy, mcpServers, daemonGatewayIp, registries);
    const firewallScript = await this.generateFirewallScript(
      allowlist,
      policy.mode,
      daemonGatewayIp,
      extraAllowedIps,
      extraAllowedDnsNames,
    );

    return {
      networkName,
      firewallScript,
    };
  }

  /**
   * Detect the gateway IP of the pod's bridge network. Falls back to
   * `host.docker.internal` if the network doesn't exist yet or inspection
   * fails — the container's `ExtraHosts: host.docker.internal:host-gateway`
   * provides a safe default.
   */
  async getGatewayIp(podId?: string): Promise<string> {
    if (!podId) return 'host.docker.internal';
    try {
      const network = this.docker.getNetwork(networkNameForPod(podId));
      const info = await network.inspect();
      const gateway = info.IPAM?.Config?.[0]?.Gateway;
      if (gateway) return gateway;
    } catch {
      // Network might not exist yet
    }
    return 'host.docker.internal';
  }
}
