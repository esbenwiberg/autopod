import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { AuthModule } from '../interfaces/index.js';
import type { SessionManager, EventBus, EventRepository } from '../sessions/index.js';
import type { ProfileStore } from '../profiles/index.js';
import type { SessionBridge } from '@autopod/escalation-mcp';
import type { PendingRequests } from '@autopod/escalation-mcp';
import { errorHandler } from './error-handler.js';
import { authPlugin } from './plugins/auth.js';
import { corsPlugin } from './plugins/cors.js';
import { rateLimitPlugin } from './plugins/rate-limit.js';
import { requestLoggerPlugin } from './plugins/request-logger.js';
import { healthRoutes } from './routes/health.js';
import { sessionRoutes } from './routes/sessions.js';
import { profileRoutes } from './routes/profiles.js';
import { websocketHandler } from './websocket.js';
import { mcpHandler } from './mcp-handler.js';
import './types.js';

export interface ServerDependencies {
  authModule: AuthModule;
  sessionManager: SessionManager;
  profileStore: ProfileStore;
  eventBus: EventBus;
  eventRepo: EventRepository;
  sessionBridge: SessionBridge;
  pendingRequestsBySession: Map<string, PendingRequests>;
  logLevel?: string;
  prettyLog?: boolean;
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
  healthRoutes(app);
  sessionRoutes(app, deps.sessionManager);
  profileRoutes(app, deps.profileStore);

  // WebSocket handler
  websocketHandler(app, deps.authModule, deps.eventBus, deps.eventRepo);

  // MCP handler for escalation tools
  mcpHandler(app, deps.sessionBridge, deps.pendingRequestsBySession, app.log as unknown as import('pino').Logger);

  return app;
}
