import type { PodBridge } from '@autopod/escalation-mcp';
import type { PendingRequests } from '@autopod/escalation-mcp';
import websocket from '@fastify/websocket';
import type Database from 'better-sqlite3';
import type Dockerode from 'dockerode';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { build as buildPrettyStream } from 'pino-pretty';
import type { ActionRegistry } from '../actions/action-registry.js';
import type { PodTokenIssuer } from '../crypto/pod-tokens.js';
import type { ImageBuilder } from '../images/index.js';
import type { AuthModule } from '../interfaces/index.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import type { IssueWatcherRepository } from '../issue-watcher/issue-watcher-repository.js';
import type {
  ContainerManagerFactory,
  EscalationRepository,
  EventBus,
  EventRepository,
  MemoryRepository,
  PendingOverrideRepository,
  PodManager,
  PodQueue,
  PodRepository,
  QualityScoreRepository,
} from '../pods/index.js';
import type { ValidationRepository } from '../pods/validation-repository.js';
import type { ProfileStore } from '../profiles/index.js';
import type { ScheduledJobManager } from '../scheduled-jobs/scheduled-job-manager.js';
import { errorHandler } from './error-handler.js';
import { mcpHandler } from './mcp-handler.js';
import { mcpProxyHandler } from './mcp-proxy-handler.js';
import { authPlugin } from './plugins/auth.js';
import { corsPlugin } from './plugins/cors.js';
import { rateLimitPlugin } from './plugins/rate-limit.js';
import { requestLoggerPlugin } from './plugins/request-logger.js';
import { actionRoutes } from './routes/actions.js';
import { diffRoutes } from './routes/diff.js';
import { filesRoutes } from './routes/files.js';
import { healthRoutes } from './routes/health.js';
import { historyRoutes } from './routes/history.js';
import { issueWatcherRoutes } from './routes/issue-watcher.js';
import { memoryRoutes } from './routes/memory.js';
import { memoryWorkspaceRoutes } from './routes/memory-workspace.js';
import { podRoutes } from './routes/pods.js';
import { profileRoutes } from './routes/profiles.js';
import { scheduledJobRoutes } from './routes/scheduled-jobs.js';
import { seriesRoutes } from './routes/series.js';
import { terminalRoutes } from './routes/terminal.js';
import { websocketHandler } from './websocket.js';
import './types.js';

export interface ServerDependencies {
  authModule: AuthModule;
  podManager: PodManager;
  profileStore: ProfileStore;
  worktreeManager?: WorktreeManager;
  eventBus: EventBus;
  eventRepo: EventRepository;
  podRepo?: PodRepository;
  escalationRepo?: EscalationRepository;
  qualityScoreRepo?: QualityScoreRepository;
  validationRepo?: ValidationRepository;
  podBridge: PodBridge;
  pendingRequestsByPod: Map<string, PendingRequests>;
  containerManagerFactory?: ContainerManagerFactory;
  docker?: Dockerode;
  db?: Database.Database;
  podQueue?: PodQueue;
  maxConcurrency?: number;
  imageBuilder?: ImageBuilder;
  actionRegistry?: ActionRegistry;
  sessionTokenIssuer?: PodTokenIssuer;
  memoryRepo?: MemoryRepository;
  pendingOverrideRepo?: PendingOverrideRepository;
  scheduledJobManager?: ScheduledJobManager;
  issueWatcherRepo?: IssueWatcherRepository;
  logLevel?: string;
  prettyLog?: boolean;
  onShutdown?: () => void;
}

export async function createServer(deps: ServerDependencies): Promise<FastifyInstance> {
  // Fail closed in production: MCP escalation and proxy endpoints rely on the
  // pod-token issuer to isolate pods from one another. Missing it would
  // silently downgrade to user-token-only auth, which a containerised agent
  // cannot present — effectively locking itself out or (worse) opening the
  // door if a future refactor adds `auth: false`.
  if (process.env.NODE_ENV === 'production' && !deps.sessionTokenIssuer) {
    throw new Error(
      'sessionTokenIssuer is required in production — refusing to start server without it',
    );
  }

  // Use pino-pretty as a direct stream (not a transport) to avoid worker-thread crashes
  const fastifyLogger = deps.prettyLog
    ? pino({ level: deps.logLevel ?? 'info' }, buildPrettyStream({ colorize: true }))
    : { level: deps.logLevel ?? 'info' };

  const app = Fastify({
    ...(deps.prettyLog
      ? { loggerInstance: fastifyLogger as import('pino').Logger }
      : { logger: fastifyLogger }),
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
  healthRoutes(app, {
    onShutdown: deps.onShutdown,
    docker: deps.docker,
    db: deps.db,
    podQueue: deps.podQueue,
    maxConcurrency: deps.maxConcurrency,
  });
  podRoutes(
    app,
    deps.podManager,
    deps.sessionTokenIssuer,
    deps.eventRepo,
    deps.pendingOverrideRepo,
    deps.podRepo,
    deps.escalationRepo,
    deps.qualityScoreRepo,
    deps.validationRepo,
  );
  if (deps.worktreeManager) {
    seriesRoutes(app, deps.podManager, deps.profileStore, deps.worktreeManager);
  } else {
    // Preview-branch endpoint is unavailable without a WorktreeManager (e.g.
    // in tests that don't exercise it). Existing series endpoints still work.
    seriesRoutes(app, deps.podManager, deps.profileStore, {
      readBranchFolder: async () => {
        throw new Error('WorktreeManager not configured — preview-branch unavailable');
      },
    } as unknown as WorktreeManager);
  }
  historyRoutes(app, deps.podManager);
  memoryWorkspaceRoutes(app, deps.podManager);
  profileRoutes(
    app,
    deps.profileStore,
    (profileName) => deps.podManager.refreshNetworkPolicy(profileName),
    deps.imageBuilder,
  );

  // Scheduled jobs routes
  if (deps.scheduledJobManager) {
    scheduledJobRoutes(app, deps.scheduledJobManager);
  }

  // Memory store routes
  if (deps.memoryRepo) {
    memoryRoutes(app, { memoryRepo: deps.memoryRepo });
  }

  // Issue watcher routes
  if (deps.issueWatcherRepo) {
    issueWatcherRoutes(app, { issueWatcherRepo: deps.issueWatcherRepo });
  }

  // Action catalog
  if (deps.actionRegistry) {
    actionRoutes(app, deps.actionRegistry);
  }

  // Diff routes (requires container manager)
  if (deps.containerManagerFactory) {
    diffRoutes(app, deps.podManager, deps.containerManagerFactory, deps.profileStore);
  }

  // Files routes — browse/read files from pod worktree (markdown viewer, etc.)
  filesRoutes(app, deps.podManager);

  // Terminal WebSocket (requires docker instance)
  if (deps.containerManagerFactory && deps.docker) {
    terminalRoutes(
      app,
      deps.podManager,
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
    deps.podBridge,
    deps.pendingRequestsByPod,
    app.log as unknown as import('pino').Logger,
    deps.sessionTokenIssuer,
  );

  // MCP proxy handler — forwards agent requests to injected profile MCP servers,
  // stamping the real auth headers server-side so the agent never sees them.
  // Auth is enforced at the route level (pod-token, matches path podId).
  mcpProxyHandler(app, {
    getServersForPod: (podId) => deps.podManager.getInjectedMcpServers(podId),
    logger: app.log as unknown as import('pino').Logger,
  });

  return app;
}
