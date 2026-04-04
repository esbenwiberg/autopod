import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

export async function rateLimitPlugin(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    max: 500,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      return request.user?.oid ?? request.ip;
    },
  });
}
