import Fastify from 'fastify';
import type { FastifyBaseLogger } from 'fastify';

export interface ServerOptions {
  logLevel: string;
  prettyLog: boolean;
}

export function createServer(options: ServerOptions) {
  const app = Fastify({
    logger: {
      level: options.logLevel,
      ...(options.prettyLog
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    },
  });

  app.get('/health', async () => {
    return { status: 'ok', version: '0.0.1' };
  });

  return app;
}

export type { FastifyBaseLogger as Logger };
