import type { SessionBridge } from '@autopod/escalation-mcp';
import type { PendingRequests } from '@autopod/escalation-mcp';
import websocket from '@fastify/websocket';
import type Dockerode from 'dockerode';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { SessionTokenIssuer } from '../crypto/session-tokens.js';
import type { ImageBuilder } from '../images/index.js';
import type { AuthModule } from '../interfaces/index.js';
import type { ProfileStore } from '../profiles/index.js';
import type {
  ContainerManagerFactory,
  EventBus,
  EventRepository,
  SessionManager,
} from '../sessions/index.js';
import { errorHandler } from './error-handler.js';
import { mcpHandler } from './mcp-handler.js';
import { authPlugin } from './plugins/auth.js';
import { corsPlugin } from './plugins/cors.js';
import { rateLimitPlugin } from './plugins/rate-limit.js';
import { requestLoggerPlugin } from './plugins/request-logger.js';
import { diffRoutes } from './routes/diff.js';
import { healthRoutes } from './routes/health.js';
import { profileRoutes } from './routes/profiles.js';
import { sessionRoutes } from './routes/sessions.js';
import { terminalRoutes } from './routes/terminal.js';
import { websocketHandler } from './websocket.js';
import './types.js';

export interface ServerDependencies {
  authModule: AuthModule;
  sessionManager: SessionManager;
  profileStore: ProfileStore;
  eventBus: EventBus;
  eventRepo: EventRepository;
  sessionBridge: SessionBridge;
  pendingRequestsBySession: Map<string, PendingRequests>;
  containerManagerFactory?: ContainerManagerFactory;
  docker?: Dockerode;
  imageBuilder?: ImageBuilder;
  sessionTokenIssuer?: SessionTokenIssuer;
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
  authPlugin(app, deps.authModule, deps.sessionTokenIssuer);
  requestLoggerPlugin(app);

  // WebSocket support
  await app.register(websocket);

  // Routes
  healthRoutes(app, deps.onShutdown);
  sessionRoutes(app, deps.sessionManager, deps.sessionTokenIssuer, deps.eventRepo);
  profileRoutes(
    app,
    deps.profileStore,
    (profileName) => deps.sessionManager.refreshNetworkPolicy(profileName),
    deps.imageBuilder,
  );

  // Diff routes (requires container manager)
  if (deps.containerManagerFactory) {
    diffRoutes(app, deps.sessionManager, deps.containerManagerFactory, deps.profileStore);
  }

  // Terminal WebSocket (requires docker instance)
  if (deps.containerManagerFactory && deps.docker) {
    terminalRoutes(
      app,
      deps.sessionManager,
      deps.containerManagerFactory,
      deps.authModule,
      deps.docker,
    );
  }

  // WebSocket handler
  websocketHandler(app, deps.authModule, deps.eventBus, deps.eventRepo);

  // MCP handler for escalation tools
  mcpHandler(
    app,
    deps.sessionBridge,
    deps.pendingRequestsBySession,
    app.log as unknown as import('pino').Logger,
    deps.sessionTokenIssuer,
  );

  return app;
}
