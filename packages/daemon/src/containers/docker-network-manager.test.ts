import type { InjectedMcpServer, NetworkPolicy } from '@autopod/shared';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ALLOWED_HOSTS, DockerNetworkManager } from './docker-network-manager.js';

const logger = pino({ level: 'silent' });

function createMockDocker() {
  const inspectFn = vi.fn();
  const getNetworkFn = vi.fn().mockReturnValue({ inspect: inspectFn });
  const createNetworkFn = vi.fn().mockResolvedValue({});
  return {
    mock: {
      getNetwork: getNetworkFn,
      createNetwork: createNetworkFn,
      _inspect: inspectFn,
    },
    instance: {
      getNetwork: getNetworkFn,
      createNetwork: createNetworkFn,
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

describe('DockerNetworkManager', () => {
  let docker: ReturnType<typeof createMockDocker>;
  let manager: DockerNetworkManager;

  beforeEach(() => {
    docker = createMockDocker();
    manager = new DockerNetworkManager({ docker: docker.instance, logger });
  });

  describe('computeAllowlist()', () => {
    const GATEWAY = '172.17.0.1';

    it('includes NuGet hosts in defaults', () => {
      expect(DEFAULT_ALLOWED_HOSTS).toContain('api.nuget.org');
      expect(DEFAULT_ALLOWED_HOSTS).toContain('globalcdn.nuget.org');
    });

    it('includes default hosts when replaceDefaults is false', () => {
      const result = manager.computeAllowlist(makePolicy(), [], GATEWAY);
      for (const host of DEFAULT_ALLOWED_HOSTS) {
        expect(result).toContain(host);
      }
    });

    it('includes default hosts when replaceDefaults is undefined', () => {
      const result = manager.computeAllowlist(
        makePolicy({ replaceDefaults: undefined }),
        [],
        GATEWAY,
      );
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

    it('adds profile-specified hosts', () => {
      const result = manager.computeAllowlist(
        makePolicy({ allowedHosts: ['custom.example.com', 'another.dev'] }),
        [],
        GATEWAY,
      );
      expect(result).toContain('custom.example.com');
      expect(result).toContain('another.dev');
    });

    it('extracts hostnames from MCP server URLs', () => {
      const servers = [
        makeMcpServer('https://mcp.example.com:8080/v1'),
        makeMcpServer('http://internal.service.local/api', 'svc'),
      ];
      const result = manager.computeAllowlist(makePolicy(), servers, GATEWAY);
      expect(result).toContain('mcp.example.com');
      expect(result).toContain('internal.service.local');
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

    it('deduplicates hosts', () => {
      const result = manager.computeAllowlist(
        makePolicy({ allowedHosts: ['github.com', 'github.com', GATEWAY] }),
        [makeMcpServer('https://github.com/path')],
        GATEWAY,
      );
      const githubCount = result.filter((h) => h === 'github.com').length;
      const gatewayCount = result.filter((h) => h === GATEWAY).length;
      expect(githubCount).toBe(1);
      expect(gatewayCount).toBe(1);
    });
  });

  describe('generateFirewallScript()', () => {
    it('starts with #!/bin/sh', async () => {
      const script = await manager.generateFirewallScript([]);
      expect(script.startsWith('#!/bin/sh')).toBe(true);
    });

    it('contains iptables rules for resolved hosts', async () => {
      const script = await manager.generateFirewallScript(['example.com']);
      expect(script).toContain('iptables -A OUTPUT');
    });

    it('adds IP addresses directly', async () => {
      const script = await manager.generateFirewallScript(['10.0.0.1']);
      expect(script).toContain('10.0.0.1');
    });

    it('resolves real hostnames to /24 CIDRs via daemon DNS', async () => {
      const script = await manager.generateFirewallScript(['api.nuget.org']);
      // Should contain CIDR rules resolved by Node.js DNS (not getent)
      expect(script).toContain('.0/24');
      expect(script).not.toContain('getent');
    });

    it('gracefully skips unresolvable hostnames', async () => {
      const script = await manager.generateFirewallScript(['this-host-does-not-exist.invalid']);
      // Should still have the REJECT rule even if resolution fails
      expect(script).toContain('iptables -A OUTPUT -j REJECT');
    });

    it('has DNS allow rules for port 53', async () => {
      const script = await manager.generateFirewallScript([]);
      expect(script).toContain('--dport 53 -j ACCEPT');
      expect(script).toContain('-p udp --dport 53');
      expect(script).toContain('-p tcp --dport 53');
    });

    it('has a final REJECT rule in restricted mode', async () => {
      const script = await manager.generateFirewallScript([], 'restricted');
      expect(script).toContain('iptables -A OUTPUT -j REJECT');
    });

    it('has a final REJECT rule when mode is omitted (defaults to restricted)', async () => {
      const script = await manager.generateFirewallScript([]);
      expect(script).toContain('iptables -A OUTPUT -j REJECT');
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
    });
  });

  describe('wildcard hosts', () => {
    const GATEWAY = '172.17.0.1';

    it('strips wildcard prefix and resolves parent domain', () => {
      const result = manager.computeAllowlist(
        makePolicy({ allowedHosts: ['*.example.com'] }),
        [],
        GATEWAY,
      );
      expect(result).toContain('example.com');
      expect(result).not.toContain('*.example.com');
    });

    it('leaves non-wildcard hosts unchanged', () => {
      const result = manager.computeAllowlist(
        makePolicy({ allowedHosts: ['api.example.com', '*.foo.com', '10.0.0.1'] }),
        [],
        GATEWAY,
      );
      expect(result).toContain('api.example.com');
      expect(result).toContain('foo.com');
      expect(result).toContain('10.0.0.1');
    });
  });

  describe('ensureNetwork()', () => {
    it('creates network if it does not exist', async () => {
      docker.mock._inspect.mockRejectedValueOnce(new Error('not found'));
      await manager.ensureNetwork();
      expect(docker.mock.createNetwork).toHaveBeenCalledWith(
        expect.objectContaining({ Name: 'autopod-net', Driver: 'bridge' }),
      );
    });

    it('skips creation if network already exists', async () => {
      docker.mock._inspect.mockResolvedValueOnce({});
      await manager.ensureNetwork();
      expect(docker.mock.createNetwork).not.toHaveBeenCalled();
    });

    it('is idempotent -- second call is a no-op', async () => {
      docker.mock._inspect.mockResolvedValueOnce({});
      await manager.ensureNetwork();
      await manager.ensureNetwork();
      // getNetwork called only once (first call); second call short-circuits
      expect(docker.mock.getNetwork).toHaveBeenCalledTimes(1);
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

    it('returns config with networkName and firewallScript when enabled', async () => {
      docker.mock._inspect.mockResolvedValueOnce({});
      const result = await manager.buildNetworkConfig(
        makePolicy({ enabled: true, allowedHosts: ['example.com'] }),
        [],
        GATEWAY,
      );
      expect(result).not.toBeNull();
      expect(result?.networkName).toBe('autopod-net');
      expect(result?.firewallScript).toContain('#!/bin/sh');
      // Hostnames are now resolved to CIDRs by the daemon, not embedded as strings
      expect(result?.firewallScript).toContain('iptables -A OUTPUT -d');
    });
  });
});
