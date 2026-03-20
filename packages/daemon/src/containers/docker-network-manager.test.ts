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
    } as any,
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
    it('starts with #!/bin/sh', () => {
      const script = manager.generateFirewallScript([]);
      expect(script.startsWith('#!/bin/sh')).toBe(true);
    });

    it('contains iptables rules for each host', () => {
      const script = manager.generateFirewallScript(['example.com']);
      expect(script).toContain('iptables -A OUTPUT');
    });

    it('adds IP addresses directly without resolution', () => {
      const script = manager.generateFirewallScript(['10.0.0.1']);
      expect(script).toContain('ALLOWED_IPS="$ALLOWED_IPS 10.0.0.1"');
      expect(script).not.toContain('getent ahosts "10.0.0.1"');
    });

    it('uses getent for hostname resolution', () => {
      const script = manager.generateFirewallScript(['api.example.com']);
      expect(script).toContain('getent ahosts "api.example.com"');
    });

    it('has DNS allow rules for port 53', () => {
      const script = manager.generateFirewallScript([]);
      expect(script).toContain('--dport 53 -j ACCEPT');
      expect(script).toContain('-p udp --dport 53');
      expect(script).toContain('-p tcp --dport 53');
    });

    it('has a final DROP rule', () => {
      const script = manager.generateFirewallScript([]);
      expect(script).toContain('iptables -A OUTPUT -j DROP');
    });

    it('has loopback allow', () => {
      const script = manager.generateFirewallScript([]);
      expect(script).toContain('-o lo -j ACCEPT');
    });

    it('has ESTABLISHED,RELATED allow', () => {
      const script = manager.generateFirewallScript([]);
      expect(script).toContain('--state ESTABLISHED,RELATED -j ACCEPT');
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
      expect(result?.firewallScript).toContain('example.com');
    });
  });
});
