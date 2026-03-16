import type { FastifyInstance } from 'fastify';

export function requestLoggerPlugin(app: FastifyInstance): void {
  app.addHook('onResponse', (request, reply) => {
    const duration = reply.elapsedTime;
    request.log.info({
      method: request.method,
      path: request.url,
      status: reply.statusCode,
      duration: Math.round(duration),
    }, 'request completed');
  });
}
