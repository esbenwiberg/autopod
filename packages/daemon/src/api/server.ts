import { existsSync } from 'node:fs';
import type { SessionBridge } from '@autopod/escalation-mcp';
import type { PendingRequests } from '@autopod/escalation-mcp';
import staticPlugin from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { ImageBuilder } from '../images/index.js';
import type { AuthModule } from '../interfaces/index.js';
import type { ProfileStore } from '../profiles/index.js';
import type { EventBus, EventRepository, SessionManager } from '../sessions/index.js';
import { errorHandler } from './error-handler.js';
import { mcpHandler } from './mcp-handler.js';
import { authPlugin } from './plugins/auth.js';
import { corsPlugin } from './plugins/cors.js';
import { rateLimitPlugin } from './plugins/rate-limit.js';
import { requestLoggerPlugin } from './plugins/request-logger.js';
import { healthRoutes } from './routes/health.js';
import { profileRoutes } from './routes/profiles.js';
import { sessionRoutes } from './routes/sessions.js';
import { terminalHandler } from './terminal.js';
import { websocketHandler } from './websocket.js';
import './types.js';

/** API path prefixes — requests to these are never served as static files. */
const API_PREFIXES = [
  '/sessions',
  '/profiles',
  '/health',
  '/version',
  '/config',
  '/events',
  '/mcp',
  '/shutdown',
];

export interface ServerDependencies {
  authModule: AuthModule;
  sessionManager: SessionManager;
  profileStore: ProfileStore;
  eventBus: EventBus;
  eventRepo: EventRepository;
  sessionBridge: SessionBridge;
  pendingRequestsBySession: Map<string, PendingRequests>;
  imageBuilder?: ImageBuilder;
  /** Absolute path to the built web PWA dist directory. If absent or missing, static serving is skipped. */
  webDistPath?: string;
  logLevel?: string;
  prettyLog?: boolean;
  onShutdown?: () => void;
}

export async function createServer(deps: ServerDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.logLevel ?? 'info',
      ...(deps.prettyLog
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    },
  });

  // Error handler
  app.setErrorHandler(errorHandler);

  // Plugins
  await corsPlugin(app);
  await rateLimitPlugin(app);
  authPlugin(app, deps.authModule);
  requestLoggerPlugin(app);

  // WebSocket support
  await app.register(websocket);

  // Routes
  healthRoutes(app, deps.onShutdown);
  sessionRoutes(app, deps.sessionManager);
  profileRoutes(
    app,
    deps.profileStore,
    (profileName) => deps.sessionManager.refreshNetworkPolicy(profileName),
    deps.imageBuilder,
  );

  // WebSocket handlers
  websocketHandler(app, deps.authModule, deps.eventBus, deps.eventRepo);
  terminalHandler(app, deps.authModule, deps.sessionManager);

  // MCP handler for escalation tools
  mcpHandler(
    app,
    deps.sessionBridge,
    deps.pendingRequestsBySession,
    app.log as unknown as import('pino').Logger,
  );

  // PWA static file serving — registered last so API routes take priority.
  // Unknown non-API paths fall back to index.html for SPA client-side routing.
  if (deps.webDistPath && existsSync(deps.webDistPath)) {
    await app.register(staticPlugin, {
      root: deps.webDistPath,
      prefix: '/',
      wildcard: false,
      decorateReply: true,
    });

    app.setNotFoundHandler(async (request, reply) => {
      const isApiPath = API_PREFIXES.some((prefix) => request.url.startsWith(prefix));
      if (isApiPath) {
        return reply.status(404).send({ error: 'Not found', path: request.url });
      }
      return reply.sendFile('index.html');
    });

    app.log.info({ webDistPath: deps.webDistPath }, 'Serving PWA from daemon');
  }

  return app;
}
