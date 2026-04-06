import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { healthRoutes } from './health.js';

describe('healthRoutes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify();
    healthRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /health', () => {
    it('returns status ok', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('ok');
    });

    it('returns version', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.json().version).toBe('0.0.1');
    });

    it('returns timestamp as ISO string', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      const body = res.json();
      expect(body.timestamp).toBeDefined();
      expect(() => new Date(body.timestamp)).not.toThrow();
    });

    it('returns requestDurationMs as a number', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      const body = res.json();
      expect(body).toHaveProperty('requestDurationMs');
      expect(typeof body.requestDurationMs).toBe('number');
      expect(body.requestDurationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('GET /version', () => {
    it('returns version', async () => {
      const res = await app.inject({ method: 'GET', url: '/version' });
      expect(res.statusCode).toBe(200);
      expect(res.json().version).toBe('0.0.1');
    });
  });
});
