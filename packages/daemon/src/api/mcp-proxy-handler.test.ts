import { describe, expect, it } from 'vitest';
import { rewriteMcpUrls } from './mcp-proxy-handler.js';

interface InjectedMcpServer {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

const PROXY_BASE = 'http://localhost:4000';
const POD_ID = 'sess-abc';

describe('rewriteMcpUrls', () => {
  it('rewrites URL correctly with server name and pod ID', () => {
    const servers: InjectedMcpServer[] = [{ name: 'github', url: 'https://mcp.github.com/sse' }];

    const result = rewriteMcpUrls(servers, POD_ID, PROXY_BASE);

    expect(result).toHaveLength(1);
    expect(result[0].url).toBe(`${PROXY_BASE}/mcp-proxy/${encodeURIComponent('github')}/${POD_ID}`);
  });

  it('encodes server names with special characters', () => {
    const servers: InjectedMcpServer[] = [{ name: 'my server/v2', url: 'https://example.com' }];

    const result = rewriteMcpUrls(servers, POD_ID, PROXY_BASE);

    expect(result[0].url).toBe(
      `${PROXY_BASE}/mcp-proxy/${encodeURIComponent('my server/v2')}/${POD_ID}`,
    );
    expect(result[0].url).toContain('my%20server%2Fv2');
  });

  it('strips auth headers from rewritten servers', () => {
    const servers: InjectedMcpServer[] = [
      {
        name: 'secure',
        url: 'https://secure.example.com',
        headers: { Authorization: 'Bearer secret-token', 'X-Api-Key': 'key123' },
      },
    ];

    const result = rewriteMcpUrls(servers, POD_ID, PROXY_BASE);

    expect(result[0].headers).toBeUndefined();
  });

  it('preserves server name property', () => {
    const servers: InjectedMcpServer[] = [{ name: 'my-tool', url: 'https://tool.example.com' }];

    const result = rewriteMcpUrls(servers, POD_ID, PROXY_BASE);

    expect(result[0].name).toBe('my-tool');
  });

  it('handles multiple servers', () => {
    const servers: InjectedMcpServer[] = [
      { name: 'alpha', url: 'https://alpha.example.com' },
      { name: 'beta', url: 'https://beta.example.com', headers: { Authorization: 'Bearer x' } },
      { name: 'gamma', url: 'https://gamma.example.com' },
    ];

    const result = rewriteMcpUrls(servers, POD_ID, PROXY_BASE);

    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('alpha');
    expect(result[1].name).toBe('beta');
    expect(result[2].name).toBe('gamma');

    for (const server of result) {
      expect(server.url).toMatch(new RegExp(`^${PROXY_BASE}/mcp-proxy/.+/${POD_ID}$`));
      expect(server.headers).toBeUndefined();
    }
  });

  it('empty server list returns empty array', () => {
    const result = rewriteMcpUrls([], POD_ID, PROXY_BASE);
    expect(result).toEqual([]);
  });
});
