import type { FastifyInstance } from 'fastify';

export function healthRoutes(app: FastifyInstance, onShutdown?: () => void): void {
  app.get('/health', { config: { auth: false } }, async () => {
    return { status: 'ok', version: '0.0.1', timestamp: new Date().toISOString() };
  });

  app.get('/version', { config: { auth: false } }, async () => {
    return { version: '0.0.1' };
  });

  /**
   * Public endpoint used by the PWA on startup to determine auth mode.
   * Returns Entra ID client/tenant IDs so the browser can initialise MSAL,
   * plus a devMode flag that tells the PWA to use the simple token-paste UI instead.
   */
  app.get('/config', { config: { auth: false } }, async () => {
    const devMode = process.env.NODE_ENV !== 'production';
    return {
      devMode,
      clientId: process.env.ENTRA_CLIENT_ID ?? null,
      tenantId: process.env.ENTRA_TENANT_ID ?? null,
    };
  });

  if (onShutdown) {
    app.post('/shutdown', async (_request, reply) => {
      reply.status(202).send({ ok: true, message: 'Shutting down...' });
      // Defer so the response is sent before shutdown begins
      setImmediate(onShutdown);
    });
  }
}
