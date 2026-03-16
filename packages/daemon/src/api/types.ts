import type { JwtPayload } from '@autopod/shared';

declare module 'fastify' {
  interface FastifyRequest {
    user: JwtPayload;
  }

  interface FastifyContextConfig {
    auth?: boolean;
  }
}

export {}; // ensure this is a module
