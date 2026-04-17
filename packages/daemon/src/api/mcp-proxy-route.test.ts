import type { InjectedMcpServer } from '@autopod/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PodTokenIssuer } from '../crypto/pod-tokens.js';
import type { AuthModule } from '../interfaces/index.js';
import { errorHandler } from './error-handler.js';
import { mcpProxyHandler } from './mcp-proxy-handler.js';
import { authPlugin } from './plugins/auth.js';

const logger = pino({ level: 'silent' });

// Deterministic pod-token issuer for tests — pure in-memory, no file I/O.
function makeIssuer(): PodTokenIssuer {
  const valid = new Map<string, string>(); // token → podId
  return {
    generate(podId: string) {
      const token = `tok-${podId}-${Math.random().toString(36).slice(2)}`;
      valid.set(token, podId);
      return token;
    },
    verify(token: string) {
      return valid.get(token) ?? null;
    },
  };
}

const rejectAuthModule: AuthModule = {
  validateToken: async () => {
    throw new Error('no user tokens in these tests');
  },
  validateTokenSync: () => {
    throw new Error('no user tokens in these tests');
  },
};

describe('mcp-proxy route wiring (F2e follow-up)', () => {
  let app: FastifyInstance;
  let issuer: PodTokenIssuer;
  let serversBySession: Map<string, InjectedMcpServer[]>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    originalFetch = globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(async () => {
    issuer = makeIssuer();
    serversBySession = new Map();

    fetchMock = vi.fn(async () => {
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    authPlugin(app, rejectAuthModule, issuer);
    mcpProxyHandler(app, {
      getServersForPod: (sid) => serversBySession.get(sid) ?? [],
      logger,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects requests without a token (401)', async () => {
    serversBySession.set('sess-a', [{ name: 'github', url: 'https://mcp.github.example/sse' }]);
    const res = await app.inject({
      method: 'POST',
      url: '/mcp-proxy/github/sess-a',
      payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects cross-pod impersonation (token for B, path for A)', async () => {
    serversBySession.set('sess-a', [{ name: 'github', url: 'https://mcp.github.example/sse' }]);
    const tokenForB = issuer.generate('sess-b');

    const res = await app.inject({
      method: 'POST',
      url: '/mcp-proxy/github/sess-a',
      headers: { authorization: `Bearer ${tokenForB}` },
      payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      error: 'AUTH_ERROR',
      message: expect.stringContaining('does not match'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards to the real upstream when the token matches', async () => {
    serversBySession.set('sess-a', [
      {
        name: 'github',
        url: 'https://mcp.github.example/sse',
        headers: { Authorization: 'Bearer real-github-token', 'X-Api': 'k' },
      },
    ]);
    const tokenForA = issuer.generate('sess-a');

    const res = await app.inject({
      method: 'POST',
      url: '/mcp-proxy/github/sess-a',
      headers: { authorization: `Bearer ${tokenForA}` },
      payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://mcp.github.example/sse');
    const headers = init.headers as Record<string, string>;
    // Real upstream auth headers are stamped server-side, agent never sees them
    expect(headers.Authorization).toBe('Bearer real-github-token');
    expect(headers['X-Api']).toBe('k');
  });

  it('returns 404 when the pod has no matching server name', async () => {
    serversBySession.set('sess-a', [{ name: 'github', url: 'https://mcp.github.example/sse' }]);
    const tokenForA = issuer.generate('sess-a');

    const res = await app.inject({
      method: 'POST',
      url: '/mcp-proxy/not-configured/sess-a',
      headers: { authorization: `Bearer ${tokenForA}` },
      payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });

    expect(res.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks SSRF to private addresses even with valid auth', async () => {
    serversBySession.set('sess-a', [
      { name: 'evil', url: 'http://169.254.169.254/latest/meta-data/' },
    ]);
    const tokenForA = issuer.generate('sess-a');

    const res = await app.inject({
      method: 'POST',
      url: '/mcp-proxy/evil/sess-a',
      headers: { authorization: `Bearer ${tokenForA}` },
      payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });

    expect(res.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
