import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliAuthBroker, cliAuthBrokerRoutes } from './cli-auth-broker.js';

describe('CLI auth broker routes', () => {
  let app: ReturnType<typeof Fastify>;
  let now: number;

  beforeEach(async () => {
    now = Date.parse('2026-09-12T10:00:00.000Z');
    app = Fastify();
    cliAuthBrokerRoutes(app, new CliAuthBroker({ now: () => now }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('relays one matching authorization response exactly once', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/auth/cli/transactions',
      payload: { state: 'expected-state-1234' },
    });
    expect(created.statusCode).toBe(201);
    const transaction = created.json<{ id: string; pollToken: string }>();

    const pending = await app.inject({
      method: 'GET',
      url: `/auth/cli/transactions/${transaction.id}`,
      headers: { 'x-autopod-auth-transaction': transaction.pollToken },
    });
    expect(pending.statusCode).toBe(202);

    const callback = await app.inject({
      method: 'GET',
      url: '/auth/cli/callback?code=authorization-code&state=expected-state-1234',
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.body).not.toContain('authorization-code');
    expect(callback.headers['cache-control']).toBe('no-store');
    expect(callback.headers['referrer-policy']).toBe('no-referrer');

    const completed = await app.inject({
      method: 'GET',
      url: `/auth/cli/transactions/${transaction.id}`,
      headers: { 'x-autopod-auth-transaction': transaction.pollToken },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toEqual({
      status: 'complete',
      response: { code: 'authorization-code', state: 'expected-state-1234' },
    });

    const replay = await app.inject({
      method: 'GET',
      url: `/auth/cli/transactions/${transaction.id}`,
      headers: { 'x-autopod-auth-transaction': transaction.pollToken },
    });
    expect(replay.statusCode).toBe(404);
  });

  it('rejects mismatched, unauthorized, and expired transactions', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/auth/cli/transactions',
      payload: { state: 'expected-state-1234' },
    });
    const transaction = created.json<{ id: string; pollToken: string; expiresAt: string }>();

    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/auth/cli/callback?code=authorization-code&state=wrong-state',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/auth/cli/transactions/${transaction.id}`,
          headers: { 'x-autopod-auth-transaction': 'wrong-token' },
        })
      ).statusCode,
    ).toBe(404);

    now = Date.parse(transaction.expiresAt) + 1;
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/auth/cli/transactions/${transaction.id}`,
          headers: { 'x-autopod-auth-transaction': transaction.pollToken },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('bounds pending transactions', async () => {
    const boundedApp = Fastify();
    cliAuthBrokerRoutes(boundedApp, new CliAuthBroker({ maxTransactions: 1 }));
    await boundedApp.ready();
    try {
      expect(
        (
          await boundedApp.inject({
            method: 'POST',
            url: '/auth/cli/transactions',
            payload: { state: 'first-state-12345' },
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await boundedApp.inject({
            method: 'POST',
            url: '/auth/cli/transactions',
            payload: { state: 'second-state-1234' },
          })
        ).statusCode,
      ).toBe(503);
    } finally {
      await boundedApp.close();
    }
  });
});
