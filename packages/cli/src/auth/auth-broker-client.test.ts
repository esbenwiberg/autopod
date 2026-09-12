import { describe, expect, it, vi } from 'vitest';
import { CliAuthBrokerClient } from './auth-broker-client.js';

describe('CliAuthBrokerClient', () => {
  it('polls a one-time transaction without putting its secret in the URL', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'transaction-id',
            pollToken: 'poll-secret',
            expiresAt: '2099-01-01T00:00:00.000Z',
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'pending' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'complete',
            response: { code: 'authorization-code', state: 'expected-state' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const broker = new CliAuthBrokerClient('https://daemon.example.com', {
      fetcher,
      pollIntervalMs: 0,
    });

    const result = await broker.waitForAuthorization('expected-state');

    expect(result).toEqual({ code: 'authorization-code', state: 'expected-state' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const pollCalls = fetcher.mock.calls.slice(1);
    for (const [url, init] of pollCalls) {
      expect(String(url)).not.toContain('poll-secret');
      expect(new Headers(init?.headers).get('x-autopod-auth-transaction')).toBe('poll-secret');
    }
  });

  it('rejects insecure non-local broker URLs', () => {
    expect(() => new CliAuthBrokerClient('http://daemon.example.com')).toThrow(
      'Auth broker requires HTTPS',
    );
    expect(() => new CliAuthBrokerClient('http://127.0.0.1:3100')).not.toThrow();
    expect(() => new CliAuthBrokerClient('https://user:secret@daemon.example.com')).toThrow(
      'must not contain credentials',
    );
  });
});
