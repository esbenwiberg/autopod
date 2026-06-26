import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { extractWebSocketBearerToken } from './websocket-auth.js';

function requestWithHeaders(headers: Record<string, string>): FastifyRequest {
  return { headers } as FastifyRequest;
}

describe('extractWebSocketBearerToken', () => {
  it('reads Bearer tokens from the Authorization header', () => {
    expect(
      extractWebSocketBearerToken(requestWithHeaders({ authorization: 'Bearer header-token' })),
    ).toBe('header-token');
  });

  it('reads browser WebSocket tokens from a base64url subprotocol', () => {
    const encoded = Buffer.from('browser-token', 'utf8').toString('base64url');
    expect(
      extractWebSocketBearerToken(
        requestWithHeaders({
          'sec-websocket-protocol': `autopod, autopod.bearer.${encoded}`,
        }),
      ),
    ).toBe('browser-token');
  });

  it('ignores query-string tokens', () => {
    expect(extractWebSocketBearerToken(requestWithHeaders({}))).toBeNull();
  });
});
