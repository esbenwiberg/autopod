import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const CONTROL_PLANE_RATE_LIMIT_MAX = 500;

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function forwardedClientFromTrustedProxy(request: FastifyRequest): string | null {
  if (!isLoopbackAddress(request.raw.socket.remoteAddress)) return null;

  const forwardedFor = request.headers['x-forwarded-for'];
  const value = Array.isArray(forwardedFor) ? forwardedFor.at(-1) : forwardedFor;
  return value?.split(',').at(-1)?.trim() || null;
}

export function rateLimitIdentity(request: FastifyRequest): string {
  const userId = request.user?.oid;
  if (userId) return `user:${userId}`;

  return `ip:${forwardedClientFromTrustedProxy(request) ?? request.ip}`;
}

export async function rateLimitPlugin(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    max: CONTROL_PLANE_RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    hook: 'preHandler',
    keyGenerator: rateLimitIdentity,
  });
}
