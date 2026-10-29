import type { JwtPayload } from '@autopod/shared';
import type {} from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    user: JwtPayload;
  }

  interface FastifyContextConfig {
    auth?: boolean;
  }
}
