import Fastify from 'fastify';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PodTokenIssuer } from '../crypto/pod-tokens.js';
import { mcpHandler } from './mcp-handler.js';
import { authPlugin } from './plugins/auth.js';

const state = vi.hoisted(() => ({ connect: async () => {}, handled: vi.fn() }));
vi.mock('@autopod/escalation-mcp', () => ({
  createEscalationMcpServer: () => ({
    server: { connect: () => state.connect() },
    pendingRequests: { cancelAll: vi.fn(), markAllDetached: vi.fn(() => 0) },
  }),
}));
vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: class {
    async handleRequest(_req: unknown, res: { end(body: string): void }) {
      state.handled();
      res.end('{"ok":true}');
    }
    async close() {}
  },
}));
beforeEach(() => {
  state.connect = async () => {};
  state.handled.mockClear();
});
async function fixture() {
  const app = Fastify();
  // light-my-request omits IncomingMessage.setTimeout; the real HTTP adapter has it.
  app.addHook('onRequest', async (request, reply) => {
    request.raw.setTimeout = () => request.raw;
    reply.raw.setTimeout = () => reply.raw;
  });
  let current = true;
  const issuer: PodTokenIssuer = {
    generate: () => 'worker-token',
    verify: (token) => (current && token === 'worker-token' ? 'pod' : null),
  };
  authPlugin(
    app,
    {
      validateToken: async (token: string) => {
        if (token !== 'human-token') throw new Error('invalid');
        return { oid: 'operator' };
      },
    } as unknown as Parameters<typeof authPlugin>[1],
    issuer,
  );
  const scope = vi.fn(async (_podId: string, run: () => Promise<void>) => run());
  mcpHandler(
    app,
    { getAvailableActions: () => [] } as unknown as Parameters<typeof mcpHandler>[1],
    new Map(),
    pino({ level: 'silent' }),
    issuer,
    scope,
  );
  await app.ready();
  return {
    app,
    scope,
    revoke: () => {
      current = false;
    },
  };
}
describe('MCP retained worker scope credential fencing', () => {
  it('accepts a current pod token (verify returns the pod ID string)', async () => {
    const f = await fixture();
    const result = await f.app.inject({
      method: 'POST',
      url: '/mcp/pod',
      headers: { authorization: 'Bearer worker-token' },
      payload: {},
    });
    expect(result.statusCode).toBe(200);
    expect(state.handled).toHaveBeenCalledTimes(1);
    expect(f.scope).toHaveBeenCalledTimes(1);
    await f.app.close();
  });
  it('cannot lend a new coding scope to an old token revoked while transport setup awaited', async () => {
    const f = await fixture();
    state.connect = async () => {
      f.revoke();
    };
    const result = await f.app.inject({
      method: 'POST',
      url: '/mcp/pod',
      headers: { authorization: 'Bearer worker-token' },
      payload: {},
    });
    expect(result.statusCode).toBe(401);
    expect(state.handled).not.toHaveBeenCalled();
    expect(f.scope).not.toHaveBeenCalled();
    await f.app.close();
  });
  it('preserves the existing authenticated human MCP transport path', async () => {
    const f = await fixture();
    const result = await f.app.inject({
      method: 'POST',
      url: '/mcp/pod',
      headers: { authorization: 'Bearer human-token' },
      payload: {},
    });
    expect(result.statusCode).toBe(200);
    expect(state.handled).toHaveBeenCalledTimes(1);
    await f.app.close();
  });
});
