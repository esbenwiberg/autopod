import type { FastifyInstance } from 'fastify';

export function healthRoutes(app: FastifyInstance): void {
  app.get('/health', { config: { auth: false } }, async () => {
    return { status: 'ok', version: '0.0.1', timestamp: new Date().toISOString() };
  });

  app.get('/version', { config: { auth: false } }, async () => {
    return { version: '0.0.1' };
  });
}
