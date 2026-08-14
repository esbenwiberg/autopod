import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { errorHandler } from './error-handler.js';

describe('errorHandler', () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('preserves rate-limit status and retry metadata without exposing internals', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    app.setErrorHandler(errorHandler);
    app.get('/limited', async (_request, reply) => {
      reply.header('Retry-After', '7');
      const error = new Error('Rate limit exceeded, retry in 7 seconds') as Error & {
        statusCode: number;
      };
      error.statusCode = 429;
      throw error;
    });

    const response = await app.inject({ method: 'GET', url: '/limited' });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('7');
    expect(response.json()).toEqual({
      error: 'RATE_LIMITED',
      message: 'Too many requests; retry later',
    });
    expect(response.body).not.toContain('Rate limit exceeded, retry in 7 seconds');
  });

  it('continues to conceal unexpected server errors', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    app.setErrorHandler(errorHandler);
    app.get('/broken', async () => {
      throw new Error('secret internal detail');
    });

    const response = await app.inject({ method: 'GET', url: '/broken' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: 'INTERNAL_ERROR',
      message: 'An internal error occurred',
    });
    expect(response.body).not.toContain('secret internal detail');
  });
});
