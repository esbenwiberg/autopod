import type { InjectedMcpServer, NetworkPolicy, PrivateRegistry } from '@autopod/shared';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ALLOWED_HOSTS, DockerNetworkManager } from './docker-network-manager.js';

const logger = pino({ level: 'silent' });

function createMockDocker() {
  const inspectFn = vi.fn();
  const getNetworkFn = vi.fn().mockReturnValue({ inspect: inspectFn });
  const createNetworkFn = vi.fn().mockResolvedValue({});
  const listNetworksFn = vi.fn().mockResolvedValue([]);
  return {
    mock: {
      getNetwork: getNetworkFn,
      createNetwork: createNetworkFn,
      listNetworks: listNetworksFn,
      _inspect: inspectFn,
    },
    instance: {
      getNetwork: getNetworkFn,
      createNetwork: createNetworkFn,
      listNetworks: listNetworksFn,
    } as unknown as import('dockerode'),
  };
}

function makePolicy(overrides: Partial<NetworkPolicy> = {}): NetworkPolicy {
  return {
    enabled: true,
    allowedHosts: [],
    ...overrides,
  };
}

function makeMcpServer(url: string, name = 'test'): InjectedMcpServer {
  return { name, url };
}

function makeRegistry(url: string, type: 'npm' | 'nuget' = 'nuget'): PrivateRegistry {
  return { type, url };
}

describe('DockerNetworkManager', () => {
  let docker: ReturnType<typeof createMockDocker>;
  let manager: DockerNetworkManager;

  beforeEach(() => {
    docker = createMockDocker();
    manager = new DockerNetworkManager({ docker: docker.instance, logger });
  });

  describe('DEFAULT_ALLOWED_HOSTS', () => {
    it('includes NuGet hosts', () => {
      expect(DEFAULT_ALLOWED_HOSTS).toContain('api.nuget.org');
      expect(DEFAULT_ALLOWED_HOSTS).toContain('globalcdn.nuget.org');
    });

    it('includes OpenAI API and ChatGPT Codex hosts', () => {
      expect(DEFAULT_ALLOWED_HOSTS).toContain('api.openai.com');
      expect(DEFAULT_ALLOWED_HOSTS).toContain('chatgpt.com');
      expect(DEFAULT_ALLOWED_HOSTS).toContain('*.chatgpt.com');
      expect(DEFAULT_ALLOWED_HOSTS).toContain('files.openai.com');
    });

    it('includes Claude MAX/OAuth hosts', () => {
      expect(DEFAULT_ALLOWED_HOSTS).toContain('platform.claude.com');
      expect(DEFAULT_ALLOWED_HOSTS).toContain('mcp-proxy.anthropic.com');
    });

    it('includes wildcard CDN domains for HAProxy SNI suffix match', () => {
      expect(DEFAULT_ALLOWED_HOSTS).toContain('*.blob.core.windows.net');
      expect(DEFAULT_ALLOWED_HOSTS).toContain('*.vo.msecnd.net');
    });
  });

  describe('computeAllowlist()', () => {
    const GATEWAY = '172.17.0.1';

    it('includes default hosts when replaceDefaults is false', () => {
      const result = manager.computeAllowlist(makePolicy(), [], GATEWAY);
      for (const host of DEFAULT_ALLOWED_HOSTS) {
        expect(result).toContain(host);
      }
    });

    it('excludes default hosts when replaceDefaults is true', () => {
      const result = manager.computeAllowlist(makePolicy({ replaceDefaults: true }), [], GATEWAY);
      for (const host of DEFAULT_ALLOWED_HOSTS) {
        expect(result).not.toContain(host);
      }
    });

    it('preserves wildcard prefixes from profile hosts', () => {
      const result = manager.computeAllowlist(
        makePolicy({ allowedHosts: ['*.example.com', 'exact.com'] }),
        [],
        GATEWAY,
      );
      expect(result).toContain('*.example.com');
      expect(result).toContain('exact.com');
    });

    it('preserves wildcard prefixes from defaults', () => {
      const result = manager.computeAllowlist(makePolicy(), [], GATEWAY);
      expect(result).toContain('*.blob.core.windows.net');
    });

    it('adds profile-specified hosts', () => {
      const result = manager.computeAllowlist(
        makePolicy({ allowedHosts: ['custom.example.com'] }),
        [],
        GATEWAY,
      );
      expect(result).toContain('custom.example.com');
    });

    it('extracts hostnames from MCP server URLs', () => {
      const servers = [makeMcpServer('https://mcp.example.com:8080/v1')];
      const result = manager.computeAllowlist(makePolicy(), servers, GATEWAY);
      expect(result).toContain('mcp.example.com');
    });

    it('skips malformed MCP server URLs without throwing', () => {
      const servers = [makeMcpServer('not-a-valid-url')];
      expect(() => manager.computeAllowlist(makePolicy(), servers, GATEWAY)).not.toThrow();
    });

    it('includes daemon gateway IP', () => {
      const result = manager.computeAllowlist(makePolicy(), [], GATEWAY);
      expect(result).toContain(GATEWAY);
    });

    it('always includes host.docker.internal', () => {
      const result = manager.computeAllowlist(makePolicy({ replaceDefaults: true }), [], GATEWAY);
      expect(result).toContain('host.docker.internal');
    });

    it('includes extra control-plane hostnames even when defaults are replaced', () => {
      const result = manager.computeAllowlist(
        makePolicy({ replaceDefaults: true }),
        [],
        GATEWAY,
        [],
        ['daemon.example.com'],
      );
      expect(result).toContain('daemon.example.com');
    });

    it('extracts hostnames from private registries', () => {
      const registries = [
        makeRegistry('https://pkgs.dev.azure.com/myorg/_packaging/myfeed/nuget/v3/index.json'),
        makeRegistry('https://npm.pkg.github.com/', 'npm'),
      ];
      const result = manager.computeAllowlist(makePolicy(), [], GATEWAY, registries);
      expect(result).toContain('pkgs.dev.azure.com');
      expect(result).toContain('npm.pkg.github.com');
    });

    it('skips malformed registry URLs without throwing', () => {
      const registries = [makeRegistry('not-a-url')];
      expect(() => manager.computeAllowlist(makePolicy(), [], GATEWAY, registries)).not.toThrow();
    });

    it('deduplicates hosts', () => {
      const result = manager.computeAllowlist(
        makePolicy({ allowedHosts: ['github.com', 'github.com', GATEWAY] }),
        [makeMcpServer('https://github.com/path')],
        GATEWAY,
      );
      const githubCount = result.filter((h) => h === 'github.com').length;
      expect(githubCount).toBe(1);
    });
  });

  describe('generateFirewallScript()', () => {
    it('starts with #!/bin/sh', async () => {
      const script = await manager.generateFirewallScript([]);
      expect(script.startsWith('#!/bin/sh')).toBe(true);
    });

    it('has loopback allow', async () => {
      const script = await manager.generateFirewallScript([]);
      expect(script).toContain('-o lo -j ACCEPT');
    });

    it('has ESTABLISHED,RELATED allow', async () => {
      const script = await manager.generateFirewallScript([]);
      expect(script).toContain('--state ESTABLISHED,RELATED -j ACCEPT');
    });

    it("restores Docker's embedded-DNS DNAT jump after flushing nat OUTPUT", async () => {
      // Flushing nat OUTPUT drops the `-d 127.0.0.11 -j DOCKER_OUTPUT` jump
      // Docker installs; without re-adding it, every hostname lookup fails.
      for (const mode of ['allow-all', 'deny-all', 'restricted'] as const) {
        const script = await manager.generateFirewallScript(['api.anthropic.com'], mode);
        expect(script).toContain('iptables -t nat -L DOCKER_OUTPUT');
        expect(script).toContain('iptables -t nat -A OUTPUT -d 127.0.0.11 -j DOCKER_OUTPUT');
      }
    });

    describe('allow-all mode', () => {
      it('has no REJECT rule', async () => {
        const script = await manager.generateFirewallScript([], 'allow-all');
        expect(script).not.toContain('iptables -A OUTPUT -j REJECT');
      });

      it('still allows loopback and established', async () => {
        const script = await manager.generateFirewallScript([], 'allow-all');
        expect(script).toContain('-o lo -j ACCEPT');
        expect(script).toContain('--state ESTABLISHED,RELATED -j ACCEPT');
      });
    });

    describe('deny-all mode', () => {
      it('has a REJECT rule', async () => {
        const script = await manager.generateFirewallScript([], 'deny-all');
        expect(script).toContain('iptables -A OUTPUT -j REJECT');
      });

      it('allows DNS', async () => {
        const script = await manager.generateFirewallScript([], 'deny-all');
        expect(script).toContain('--dport 53 -j ACCEPT');
      });

      it('resolves host.docker.internal for daemon gateway access', async () => {
        const script = await manager.generateFirewallScript([], 'deny-all');
        expect(script).toContain('getent ahostsv4 host.docker.internal');
        expect(script).toContain('iptables -A OUTPUT -d "$_gw_ip" -j ACCEPT');
        // Gateway resolution must come before the REJECT rule
        const gatewayIdx = script.indexOf('host.docker.internal');
        const rejectIdx = script.indexOf('-j REJECT --reject-with');
        expect(gatewayIdx).toBeLessThan(rejectIdx);
      });

      it('includes explicit gateway IP when provided', async () => {
        const script = await manager.generateFirewallScript([], 'deny-all', '172.18.0.1');
        expect(script).toContain('iptables -A OUTPUT -d "172.18.0.1" -j ACCEPT');
      });
    });

    describe('restricted mode — HAProxy SNI allowlist', () => {
      it('writes an HAProxy config heredoc with the allowlist', async () => {
        const script = await manager.generateFirewallScript(['api.anthropic.com']);
        expect(script).toContain("cat > /etc/haproxy/haproxy.cfg << 'HAPROXYCFG'");
        expect(script).toContain('acl allowed_sni var(sess.sni) -m str api.anthropic.com');
        expect(script).toContain('HAPROXYCFG');
      });

      it('converts wildcards into HAProxy suffix-match ACLs', async () => {
        const script = await manager.generateFirewallScript(['*.blob.core.windows.net']);
        expect(script).toContain('acl allowed_sni var(sess.sni) -m end .blob.core.windows.net');
      });

      it('REDIRECTs outbound port 443 to HAProxy, exempting HAProxy itself', async () => {
        // HAProxy's spliced upstream connections also hit port 443 — without
        // the `! --uid-owner haproxy` exemption they get redirected back into
        // HAProxy's own listener (infinite loopback → SSL_ERROR_SYSCALL).
        const script = await manager.generateFirewallScript(['api.anthropic.com']);
        expect(script).toContain(
          'iptables -t nat -A OUTPUT -p tcp --dport 443 ! -d 127.0.0.0/8 -m owner ! --uid-owner haproxy -j REDIRECT --to-ports 8443',
        );
      });

      it('DROPs outbound port 80 (HTTPS-only policy)', async () => {
        const script = await manager.generateFirewallScript(['api.anthropic.com']);
        expect(script).toContain('iptables -A OUTPUT -p tcp --dport 80 -j DROP');
      });

      it('allows HAProxy itself to reach upstream via uid-owner match', async () => {
        const script = await manager.generateFirewallScript(['api.anthropic.com']);
        expect(script).toContain('iptables -A OUTPUT -m owner --uid-owner haproxy -j ACCEPT');
      });

      it('accepts the REDIRECT-ed traffic by destination before the final REJECT', async () => {
        // The REDIRECT rewrites dst to 127.0.0.1:8443 but the packet keeps its
        // original output interface (eth0) at filter-OUTPUT time, so the `-o lo`
        // accept never matches it. Without a destination-matched accept it hits
        // the final REJECT and the agent gets ECONNREFUSED.
        const script = await manager.generateFirewallScript(['api.anthropic.com']);
        expect(script).toContain('iptables -A OUTPUT -p tcp -d 127.0.0.1 --dport 8443 -j ACCEPT');
        const acceptIdx = script.indexOf(
          'iptables -A OUTPUT -p tcp -d 127.0.0.1 --dport 8443 -j ACCEPT',
        );
        const rejectIdx = script.indexOf(
          'iptables -A OUTPUT -j REJECT --reject-with icmp-port-unreachable',
        );
        expect(acceptIdx).toBeGreaterThan(-1);
        expect(acceptIdx).toBeLessThan(rejectIdx);
      });

      it('starts HAProxy and reloads with -sf if a PID file is present', async () => {
        const script = await manager.generateFirewallScript(['api.anthropic.com']);
        expect(script).toContain(
          'haproxy -f /etc/haproxy/haproxy.cfg -D -p /var/run/haproxy/haproxy.pid',
        );
        expect(script).toContain('-sf "$(cat /var/run/haproxy/haproxy.pid)"');
      });

      it('does not start the deny log receiver inline — that is owned by streamHaproxyDenials', async () => {
        // Backgrounded socat under `docker exec` doesn't reliably survive the
        // exec's exit. The daemon-side `streamHaproxyDenials` opens a separate
        // long-running exec that owns the UDP receiver.
        const script = await manager.generateFirewallScript(['api.anthropic.com']);
        expect(script).not.toContain('socat -u UDP-RECV');
      });

      it('allows DNS using the container default resolver (no in-pod DNS filter)', async () => {
        const script = await manager.generateFirewallScript(['api.anthropic.com']);
        expect(script).toContain('iptables -A OUTPUT -p udp --dport 53 -j ACCEPT');
        expect(script).toContain('iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT');
        // No more dnsmasq listener overriding /etc/resolv.conf
        expect(script).not.toContain('listen-address=127.0.0.53');
        expect(script).not.toContain('nameserver 127.0.0.53');
      });

      it('resolves host.docker.internal for daemon gateway access', async () => {
        const script = await manager.generateFirewallScript(['api.anthropic.com']);
        expect(script).toContain('getent ahostsv4 host.docker.internal');
        expect(script).toContain('iptables -A OUTPUT -d "$_gw_ip" -j ACCEPT');
      });

      it('includes explicit gateway IP when provided', async () => {
        const script = await manager.generateFirewallScript(
          ['api.anthropic.com'],
          'restricted',
          '172.18.0.1',
        );
        expect(script).toContain('iptables -A OUTPUT -d "172.18.0.1" -j ACCEPT');
      });

      it('ACCEPTs sidecar IPs unconditionally before the HAProxy redirect', async () => {
        const script = await manager.generateFirewallScript(
          ['api.anthropic.com'],
          'restricted',
          undefined,
          ['172.19.0.5', '172.19.0.6'],
        );
        expect(script).toContain('iptables -A OUTPUT -d "172.19.0.5" -j ACCEPT');
        expect(script).toContain('iptables -A OUTPUT -d "172.19.0.6" -j ACCEPT');
        const sidecarIdx = script.indexOf('iptables -A OUTPUT -d "172.19.0.5"');
        const redirectIdx = script.indexOf('REDIRECT --to-ports 8443');
        expect(sidecarIdx).toBeLessThan(redirectIdx);
      });

      it('flushes both the filter and nat OUTPUT chains so the script is idempotent', async () => {
        const script = await manager.generateFirewallScript(['api.anthropic.com']);
        expect(script).toContain('iptables -F OUTPUT 2>/dev/null || true');
        expect(script).toContain('iptables -t nat -F OUTPUT 2>/dev/null || true');
      });

      it('has a final REJECT for anything not explicitly accepted or redirected', async () => {
        const script = await manager.generateFirewallScript(['api.anthropic.com']);
        expect(script).toContain(
          'iptables -A OUTPUT -j REJECT --reject-with icmp-port-unreachable',
        );
      });

      it('contains no dnsmasq / ipset / xt_set references', async () => {
        const script = await manager.generateFirewallScript([
          'api.anthropic.com',
          '*.blob.core.windows.net',
        ]);
        expect(script).not.toMatch(/\bdnsmasq\b/);
        expect(script).not.toMatch(/\bipset\b/);
        expect(script).not.toMatch(/xt_set/);
        expect(script).not.toMatch(/--match-set/);
      });

      it('drops unsafe hosts defensively before they reach the HAProxy config', async () => {
        const script = await manager.generateFirewallScript(['api.anthropic.com', 'evil;rm -rf /']);
        expect(script).toContain('acl allowed_sni var(sess.sni) -m str api.anthropic.com');
        expect(script).not.toContain('evil;rm -rf /');
      });
    });

    describe('ip6tables rules (fix 2.2)', () => {
      it('deny-all mode includes ip6tables REJECT rule', async () => {
        const script = await manager.generateFirewallScript([], 'deny-all');
        expect(script).toContain('ip6tables -F OUTPUT');
        expect(script).toContain(
          'ip6tables -A OUTPUT -j REJECT --reject-with icmp6-port-unreachable',
        );
      });

      it('deny-all ip6tables rules appear before the final echo', async () => {
        const script = await manager.generateFirewallScript([], 'deny-all');
        const ip6tablesIdx = script.indexOf('ip6tables -A OUTPUT -j REJECT');
        const echoIdx = script.lastIndexOf('echo "Firewall:');
        expect(ip6tablesIdx).toBeGreaterThan(0);
        expect(ip6tablesIdx).toBeLessThan(echoIdx);
      });

      it('restricted mode includes ip6tables REJECT rule', async () => {
        const script = await manager.generateFirewallScript(['example.com']);
        expect(script).toContain('ip6tables -F OUTPUT');
        expect(script).toContain(
          'ip6tables -A OUTPUT -j REJECT --reject-with icmp6-port-unreachable',
        );
      });

      it('restricted mode ip6tables rules appear after the HAProxy setup', async () => {
        const script = await manager.generateFirewallScript(['example.com']);
        const haproxyIdx = script.indexOf('haproxy -f /etc/haproxy/haproxy.cfg');
        const ip6tablesIdx = script.indexOf('ip6tables -F OUTPUT');
        expect(haproxyIdx).toBeGreaterThan(0);
        expect(ip6tablesIdx).toBeGreaterThan(haproxyIdx);
      });

      it('allow-all mode does NOT include ip6tables rules', async () => {
        const script = await manager.generateFirewallScript([], 'allow-all');
        expect(script).not.toContain('ip6tables');
      });
    });
  });

  describe('ensureNetworkForPod()', () => {
    it('creates a per-pod bridge with ICC enabled when it does not exist', async () => {
      docker.mock._inspect.mockRejectedValueOnce(new Error('not found'));
      const name = await manager.ensureNetworkForPod('pod-abc');
      expect(name).toBe('autopod-pod-abc');
      expect(docker.mock.createNetwork).toHaveBeenCalledWith(
        expect.objectContaining({
          Name: 'autopod-pod-abc',
          Driver: 'bridge',
          Options: expect.objectContaining({
            'com.docker.network.bridge.enable_icc': 'true',
          }),
        }),
      );
    });

    it('skips creation when the pod bridge already exists', async () => {
      docker.mock._inspect.mockResolvedValueOnce({});
      const name = await manager.ensureNetworkForPod('pod-abc');
      expect(name).toBe('autopod-pod-abc');
      expect(docker.mock.createNetwork).not.toHaveBeenCalled();
    });

    it('prunes unattached autopod networks and retries when subnet pool is exhausted', async () => {
      docker.mock._inspect.mockRejectedValueOnce(new Error('not found'));

      const exhaustedError = Object.assign(
        new Error(
          '(HTTP code 400) unexpected - all predefined address pools have been fully subnetted ',
        ),
        { statusCode: 400 },
      );
      docker.mock.createNetwork.mockRejectedValueOnce(exhaustedError).mockResolvedValueOnce({});

      const removeFn = vi.fn().mockResolvedValue(undefined);
      docker.mock.listNetworks.mockResolvedValueOnce([
        // attached — should be preserved
        {
          Id: 'net1',
          Name: 'autopod-active',
          Labels: { 'com.autopod.pod-id': 'active' },
          Containers: { ctr1: {} },
        },
        // unattached orphan — should be pruned
        {
          Id: 'net2',
          Name: 'autopod-orphan',
          Labels: { 'com.autopod.pod-id': 'orphan' },
          Containers: {},
        },
      ]);
      // Route getNetwork by argument: inspect path uses the shared _inspect mock;
      // the prune step uses the removeFn.
      docker.mock.getNetwork.mockImplementation((id: string) => {
        if (id === 'net2') return { remove: removeFn, inspect: vi.fn() };
        return { inspect: docker.mock._inspect };
      });

      const name = await manager.ensureNetworkForPod('pod-abc');
      expect(name).toBe('autopod-pod-abc');
      expect(docker.mock.createNetwork).toHaveBeenCalledTimes(2);
      expect(removeFn).toHaveBeenCalledTimes(1);
    });

    it('re-throws non-subnet errors from createNetwork', async () => {
      docker.mock._inspect.mockRejectedValueOnce(new Error('not found'));
      docker.mock.createNetwork.mockRejectedValueOnce(new Error('server error'));
      await expect(manager.ensureNetworkForPod('pod-abc')).rejects.toThrow('server error');
    });
  });

  describe('reconcileOrphanNetworks()', () => {
    it('removes networks whose pod ID is not in the active set', async () => {
      const removeFn = vi.fn().mockResolvedValue(undefined);
      docker.mock.listNetworks.mockResolvedValueOnce([
        {
          Id: 'net-a',
          Name: 'autopod-aaa',
          Labels: { 'com.autopod.pod-id': 'aaa' },
          Containers: {},
        },
        {
          Id: 'net-b',
          Name: 'autopod-bbb',
          Labels: { 'com.autopod.pod-id': 'bbb' },
          Containers: {},
        },
      ]);
      docker.mock.getNetwork.mockImplementation((id: string) => ({
        remove: removeFn,
        inspect: vi.fn(),
      }));

      const pruned = await manager.reconcileOrphanNetworks(new Set(['aaa']));
      expect(pruned).toBe(1);
      expect(docker.mock.getNetwork).toHaveBeenCalledWith('net-b');
      expect(removeFn).toHaveBeenCalledTimes(1);
    });

    it('preserves networks whose pod ID is active', async () => {
      const removeFn = vi.fn().mockResolvedValue(undefined);
      docker.mock.listNetworks.mockResolvedValueOnce([
        {
          Id: 'net-a',
          Name: 'autopod-aaa',
          Labels: { 'com.autopod.pod-id': 'aaa' },
          Containers: {},
        },
      ]);
      docker.mock.getNetwork.mockReturnValue({ remove: removeFn, inspect: vi.fn() });

      const pruned = await manager.reconcileOrphanNetworks(new Set(['aaa']));
      expect(pruned).toBe(0);
      expect(removeFn).not.toHaveBeenCalled();
    });

    it('skips networks with no pod-id label', async () => {
      const removeFn = vi.fn().mockResolvedValue(undefined);
      docker.mock.listNetworks.mockResolvedValueOnce([
        { Id: 'net-x', Name: 'bridge', Labels: {}, Containers: {} },
      ]);
      docker.mock.getNetwork.mockReturnValue({ remove: removeFn, inspect: vi.fn() });

      const pruned = await manager.reconcileOrphanNetworks(new Set());
      expect(pruned).toBe(0);
      expect(removeFn).not.toHaveBeenCalled();
    });

    it('returns 0 and does not throw when Docker returns no networks', async () => {
      docker.mock.listNetworks.mockResolvedValueOnce([]);
      await expect(manager.reconcileOrphanNetworks(new Set())).resolves.toBe(0);
    });

    it('force-disconnects stale endpoints before removing the network', async () => {
      const removeFn = vi.fn().mockResolvedValue(undefined);
      const disconnectFn = vi.fn().mockResolvedValue(undefined);
      const inspectFn = vi.fn().mockResolvedValue({
        Containers: { 'container-1': {}, 'container-2': {} },
      });
      docker.mock.listNetworks.mockResolvedValueOnce([
        {
          Id: 'net-orphan',
          Name: 'autopod-yappy-goat',
          Labels: { 'com.autopod.pod-id': 'yappy-goat' },
          Containers: {},
        },
      ]);
      docker.mock.getNetwork.mockReturnValue({
        remove: removeFn,
        inspect: inspectFn,
        disconnect: disconnectFn,
      });

      const pruned = await manager.reconcileOrphanNetworks(new Set());
      expect(pruned).toBe(1);
      expect(disconnectFn).toHaveBeenCalledTimes(2);
      expect(disconnectFn).toHaveBeenCalledWith({ Container: 'container-1', Force: true });
      expect(disconnectFn).toHaveBeenCalledWith({ Container: 'container-2', Force: true });
      expect(removeFn).toHaveBeenCalledTimes(1);
      // disconnect must run before remove, otherwise Docker returns 403
      expect(disconnectFn.mock.invocationCallOrder[0]).toBeLessThan(
        removeFn.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    });

    it('still removes the network when one disconnect fails', async () => {
      const removeFn = vi.fn().mockResolvedValue(undefined);
      const disconnectFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('container gone'))
        .mockResolvedValueOnce(undefined);
      const inspectFn = vi.fn().mockResolvedValue({
        Containers: { 'container-1': {}, 'container-2': {} },
      });
      docker.mock.listNetworks.mockResolvedValueOnce([
        {
          Id: 'net-orphan',
          Name: 'autopod-bad',
          Labels: { 'com.autopod.pod-id': 'bad' },
          Containers: {},
        },
      ]);
      docker.mock.getNetwork.mockReturnValue({
        remove: removeFn,
        inspect: inspectFn,
        disconnect: disconnectFn,
      });

      const pruned = await manager.reconcileOrphanNetworks(new Set());
      expect(pruned).toBe(1);
      expect(disconnectFn).toHaveBeenCalledTimes(2);
      expect(removeFn).toHaveBeenCalledTimes(1);
    });

    it('falls back to listNetworks endpoints when inspect fails', async () => {
      const removeFn = vi.fn().mockResolvedValue(undefined);
      const disconnectFn = vi.fn().mockResolvedValue(undefined);
      const inspectFn = vi.fn().mockRejectedValue(new Error('inspect blew up'));
      docker.mock.listNetworks.mockResolvedValueOnce([
        {
          Id: 'net-orphan',
          Name: 'autopod-fallback',
          Labels: { 'com.autopod.pod-id': 'fallback' },
          Containers: { 'container-from-list': {} },
        },
      ]);
      docker.mock.getNetwork.mockReturnValue({
        remove: removeFn,
        inspect: inspectFn,
        disconnect: disconnectFn,
      });

      const pruned = await manager.reconcileOrphanNetworks(new Set());
      expect(pruned).toBe(1);
      expect(disconnectFn).toHaveBeenCalledWith({
        Container: 'container-from-list',
        Force: true,
      });
      expect(removeFn).toHaveBeenCalledTimes(1);
    });

    it('continues and returns partial count when a remove fails', async () => {
      const removeFail = vi.fn().mockRejectedValue(new Error('busy'));
      const removeOk = vi.fn().mockResolvedValue(undefined);
      docker.mock.listNetworks.mockResolvedValueOnce([
        {
          Id: 'net-a',
          Name: 'autopod-aaa',
          Labels: { 'com.autopod.pod-id': 'aaa' },
          Containers: {},
        },
        {
          Id: 'net-b',
          Name: 'autopod-bbb',
          Labels: { 'com.autopod.pod-id': 'bbb' },
          Containers: {},
        },
      ]);
      docker.mock.getNetwork.mockImplementation((id: string) => ({
        remove: id === 'net-a' ? removeFail : removeOk,
        inspect: vi.fn(),
      }));

      const pruned = await manager.reconcileOrphanNetworks(new Set());
      expect(pruned).toBe(1);
    });
  });

  describe('destroyNetworkForPod()', () => {
    it('removes the per-pod bridge', async () => {
      const remove = vi.fn().mockResolvedValue(undefined);
      docker.mock.getNetwork.mockReturnValue({ remove, inspect: vi.fn() });
      await manager.destroyNetworkForPod('pod-abc');
      expect(docker.mock.getNetwork).toHaveBeenCalledWith('autopod-pod-abc');
      expect(remove).toHaveBeenCalled();
    });

    it('swallows 404 when the network is already gone', async () => {
      const remove = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
      docker.mock.getNetwork.mockReturnValue({ remove, inspect: vi.fn() });
      await expect(manager.destroyNetworkForPod('pod-abc')).resolves.not.toThrow();
    });
  });

  describe('buildNetworkConfig()', () => {
    const GATEWAY = '172.17.0.1';

    it('returns null if policy is null', async () => {
      const result = await manager.buildNetworkConfig(null, [], GATEWAY);
      expect(result).toBeNull();
    });

    it('returns null if policy.enabled is false', async () => {
      const result = await manager.buildNetworkConfig(makePolicy({ enabled: false }), [], GATEWAY);
      expect(result).toBeNull();
    });

    it('returns per-pod networkName and firewallScript when podId is supplied', async () => {
      docker.mock._inspect.mockResolvedValueOnce({});
      const result = await manager.buildNetworkConfig(
        makePolicy({ enabled: true, allowedHosts: ['example.com'] }),
        [],
        GATEWAY,
        [],
        'pod-abc',
      );
      expect(result).not.toBeNull();
      expect(result?.networkName).toBe('autopod-pod-abc');
      expect(result?.firewallScript).toContain('#!/bin/sh');
    });

    it('injects extraAllowedIps into the firewall script so the pod can reach sidecars', async () => {
      docker.mock._inspect.mockResolvedValueOnce({});
      const result = await manager.buildNetworkConfig(
        makePolicy({ enabled: true, mode: 'deny-all' }),
        [],
        GATEWAY,
        [],
        'pod-abc',
        ['172.19.0.5'],
      );
      expect(result?.firewallScript).toContain('iptables -A OUTPUT -d "172.19.0.5" -j ACCEPT');
    });

    it('injects extraAllowedHosts into the HAProxy SNI allowlist for explicit MCP URLs', async () => {
      docker.mock._inspect.mockResolvedValueOnce({});
      const result = await manager.buildNetworkConfig(
        makePolicy({ enabled: true, replaceDefaults: true }),
        [],
        GATEWAY,
        [],
        'pod-abc',
        [],
        ['daemon.example.com'],
      );
      expect(result?.firewallScript).toContain(
        'acl allowed_sni var(sess.sni) -m str daemon.example.com',
      );
    });
  });
});
