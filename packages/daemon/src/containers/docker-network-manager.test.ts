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

    it('includes wildcard CDN domains for dnsmasq mode', () => {
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

    describe('restricted mode — dnsmasq+ipset path', () => {
      it('generates dnsmasq feature detection', async () => {
        const script = await manager.generateFirewallScript(['example.com']);
        expect(script).toContain('command -v dnsmasq');
        expect(script).toContain('command -v ipset');
      });

      it('creates ipset named allowed_ips', async () => {
        const script = await manager.generateFirewallScript(['example.com']);
        expect(script).toContain('ipset create allowed_ips hash:net');
      });

      it('pre-seeds ipset with daemon-resolved CIDRs', async () => {
        const script = await manager.generateFirewallScript(['10.0.0.1']);
        expect(script).toContain('ipset add allowed_ips "10.0.0.1"');
      });

      it('resolves host.docker.internal and adds to ipset for MCP access', async () => {
        const script = await manager.generateFirewallScript(['example.com']);
        expect(script).toContain('getent ahostsv4 host.docker.internal');
        expect(script).toContain('ipset add allowed_ips "$_gw_ip"');
      });

      it('writes dnsmasq config with server and ipset entries', async () => {
        const script = await manager.generateFirewallScript(['api.nuget.org']);
        expect(script).toContain('server=/api.nuget.org/127.0.0.11');
        expect(script).toContain('ipset=/api.nuget.org/allowed_ips');
      });

      it('converts wildcards to dnsmasq suffix match', async () => {
        const script = await manager.generateFirewallScript(['*.blob.core.windows.net']);
        // dnsmasq treats /domain/ as suffix match — *.blob.core.windows.net → blob.core.windows.net
        expect(script).toContain('server=/blob.core.windows.net/127.0.0.11');
        expect(script).toContain('ipset=/blob.core.windows.net/allowed_ips');
      });

      it('blocks all other DNS with address=/#/', async () => {
        const script = await manager.generateFirewallScript(['example.com']);
        expect(script).toContain('address=/#/');
      });

      it('starts dnsmasq on 127.0.0.53', async () => {
        const script = await manager.generateFirewallScript(['example.com']);
        expect(script).toContain('listen-address=127.0.0.53');
        expect(script).toContain('dnsmasq --conf-file=/tmp/dnsmasq-firewall.conf');
      });

      it('rewrites resolv.conf to dnsmasq', async () => {
        const script = await manager.generateFirewallScript(['example.com']);
        expect(script).toContain('nameserver 127.0.0.53');
        expect(script).toContain('/etc/resolv.conf');
      });

      it('restricts Docker DNS access to dnsmasq user only', async () => {
        const script = await manager.generateFirewallScript(['example.com']);
        // Only nobody (dnsmasq user) can reach Docker DNS
        expect(script).toContain('--dport 53 -d 127.0.0.11 -m owner --uid-owner nobody -j ACCEPT');
        // Others are rejected
        expect(script).toContain('--dport 53 -d 127.0.0.11 -j REJECT');
      });

      it('allows traffic via ipset match', async () => {
        const script = await manager.generateFirewallScript(['example.com']);
        expect(script).toContain('-m set --match-set allowed_ips dst -j ACCEPT');
      });

      it('has final REJECT rule', async () => {
        const script = await manager.generateFirewallScript(['example.com']);
        expect(script).toContain(
          'iptables -A OUTPUT -j REJECT --reject-with icmp-port-unreachable',
        );
      });
    });

    describe('restricted mode — CIDR fallback path', () => {
      it('includes fallback in else branch', async () => {
        const script = await manager.generateFirewallScript(['example.com']);
        expect(script).toContain('else');
        expect(script).toContain('falling back to CIDR mode');
      });

      it('fallback allows DNS broadly', async () => {
        const script = await manager.generateFirewallScript(['example.com']);
        // In the else branch, DNS is allowed to any resolver
        expect(script).toMatch(/else[\s\S]*-p udp --dport 53 -j ACCEPT/);
      });

      it('fallback resolves wildcards by stripping prefix', async () => {
        const script = await manager.generateFirewallScript(['*.blob.core.windows.net']);
        // In container_resolve, wildcard stripped to parent domain
        expect(script).toContain('"blob.core.windows.net"');
      });

      it('fallback has REJECT rule', async () => {
        const script = await manager.generateFirewallScript(['example.com']);
        // Both branches end with REJECT
        const rejectCount = (script.match(/iptables -A OUTPUT -j REJECT/g) || []).length;
        expect(rejectCount).toBeGreaterThanOrEqual(2); // one per branch
      });
    });

    it('resolves real hostnames to /32 CIDRs for pre-seeding (fix 2.5)', async () => {
      const script = await manager.generateFirewallScript(['api.nuget.org']);
      // Exact /32 host routes — not the former /24 subnet expansion
      expect(script).toContain('/32');
      expect(script).not.toContain('.0/24');
    });

    it('gracefully skips unresolvable hostnames', async () => {
      const script = await manager.generateFirewallScript(['this-host-does-not-exist.invalid']);
      // Should still produce a valid script
      expect(script).toContain('iptables -A OUTPUT -j REJECT');
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

      it('restricted mode ip6tables rules appear after the fi closing the dnsmasq/CIDR if-else', async () => {
        const script = await manager.generateFirewallScript(['example.com']);
        const fiIdx = script.lastIndexOf('\nfi\n');
        const ip6tablesIdx = script.indexOf('ip6tables -F OUTPUT');
        expect(fiIdx).toBeGreaterThan(0);
        expect(ip6tablesIdx).toBeGreaterThan(fiIdx);
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
  });
});
