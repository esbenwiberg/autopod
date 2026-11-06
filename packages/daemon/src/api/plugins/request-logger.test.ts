import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { requestLoggerPlugin, sanitizeRequestUrl } from './request-logger.js';

describe('requestLoggerPlugin', () => {
  it('continues to downstream response hooks after logging', async () => {
    const app = Fastify();
    const afterLogger = vi.fn(async () => {});
    requestLoggerPlugin(app);
    app.addHook('onResponse', afterLogger);
    app.get('/test', async () => ({ ok: true }));

    try {
      const response = await app.inject({ method: 'GET', url: '/test' });
      expect(response.statusCode).toBe(200);
      expect(afterLogger).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});

describe('sanitizeRequestUrl', () => {
  it('redacts sensitive query parameters before logging', () => {
    expect(sanitizeRequestUrl('/events?token=eyJ.secret&lastEventId=42')).toBe(
      '/events?token=[REDACTED]&lastEventId=42',
    );
    expect(sanitizeRequestUrl('/callback?access_token=abc&apiKey=def&code=ghi&state=ok')).toBe(
      '/callback?access_token=[REDACTED]&apiKey=[REDACTED]&code=[REDACTED]&state=[REDACTED]',
    );
  });

  it('preserves non-sensitive query parameters', () => {
    expect(sanitizeRequestUrl('/pods/sess-001/events?limit=500')).toBe(
      '/pods/sess-001/events?limit=500',
    );
  });
});
