import type { FastifyInstance } from 'fastify';

export function healthRoutes(app: FastifyInstance, onShutdown?: () => void): void {
  app.get('/health', { config: { auth: false } }, async () => {
    return { status: 'ok', version: '0.0.1', timestamp: new Date().toISOString() };
  });

  app.get('/version', { config: { auth: false } }, async () => {
    return { version: '0.0.1' };
  });

  if (onShutdown) {
    app.post('/shutdown', async (_request, reply) => {
      reply.status(202).send({ ok: true, message: 'Shutting down...' });
      // Defer so the response is sent before shutdown begins
      setImmediate(onShutdown);
    });
  }
}
