import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { rateLimitPlugin } from './rate-limit.js';

describe('rateLimitPlugin', () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('isolates clients forwarded by the trusted local Caddy hop', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    await rateLimitPlugin(app);
    app.get('/probe', async () => ({ ok: true }));

    for (let index = 0; index < 500; index += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/probe',
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': '203.0.113.10' },
      });
      expect(response.statusCode).toBe(200);
    }

    const otherClient = await app.inject({
      method: 'GET',
      url: '/probe',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.11' },
    });

    expect(otherClient.statusCode).toBe(200);
  });

  it('uses the authenticated user populated by the auth pre-handler', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    await rateLimitPlugin(app);
    app.decorateRequest('user', null);
    app.addHook('preHandler', async (request) => {
      const userId = String(request.headers['x-test-user']);
      request.user = {
        oid: userId,
        preferred_username: userId,
        name: userId,
        roles: [],
        aud: '',
        iss: '',
        exp: 9_999_999_999,
        iat: 0,
      };
    });
    app.get('/probe', async () => ({ ok: true }));

    for (let index = 0; index < 500; index += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/probe',
        remoteAddress: '198.51.100.20',
        headers: { 'x-test-user': 'user-a' },
      });
      expect(response.statusCode).toBe(200);
    }

    const otherUser = await app.inject({
      method: 'GET',
      url: '/probe',
      remoteAddress: '198.51.100.20',
      headers: { 'x-test-user': 'user-b' },
    });

    expect(otherUser.statusCode).toBe(200);
  });

  it('ignores forwarded identities from an untrusted remote peer', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    await rateLimitPlugin(app);
    app.get('/probe', async () => ({ ok: true }));

    for (let index = 0; index < 500; index += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/probe',
        remoteAddress: '198.51.100.20',
        headers: { 'x-forwarded-for': `203.0.113.${index % 200}` },
      });
      expect(response.statusCode).toBe(200);
    }

    const exhausted = await app.inject({
      method: 'GET',
      url: '/probe',
      remoteAddress: '198.51.100.20',
      headers: { 'x-forwarded-for': '203.0.113.250' },
    });

    expect(exhausted.statusCode).toBe(429);
  });
});
