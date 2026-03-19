import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import type { PendingRequests } from '@autopod/escalation-mcp';
import { createDatabase } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { createProfileStore } from './profiles/index.js';
import {
  createSessionRepository,
  createEventRepository,
  createEscalationRepository,
  createEventBus,
  createSessionQueue,
  createSessionManager,
} from './sessions/index.js';
import { createSessionBridge } from './sessions/session-bridge-impl.js';
import { createServer } from './api/server.js';
import type { AuthModule } from './interfaces/index.js';
import { LocalWorktreeManager } from './worktrees/local-worktree-manager.js';
import { LocalContainerManager } from './containers/local-container-manager.js';
import { DockerContainerManager } from './containers/docker-container-manager.js';
import { createRuntimeRegistry, ClaudeRuntime, CodexRuntime } from './runtimes/index.js';
import { createLocalValidationEngine } from './validation/local-validation-engine.js';
import { createNotificationService, createTeamsAdapter, createRateLimiter } from './notifications/index.js';
import type { NotificationConfig } from './notifications/index.js';
import type { ContainerManager } from './interfaces/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
const IS_DEV = process.env.NODE_ENV !== 'production';
const PORT = Number.parseInt(process.env.PORT ?? '3100', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_PATH = process.env.DB_PATH ?? './autopod.db';
const MAX_CONCURRENCY = Number.parseInt(process.env.MAX_CONCURRENCY ?? '3', 10);
const TEAMS_WEBHOOK_URL = process.env.TEAMS_WEBHOOK_URL;
const CONTAINER_RUNTIME = process.env.AUTOPOD_CONTAINER_RUNTIME ?? 'local'; // 'local' | 'docker'
const ACR_REGISTRY_URL = process.env.ACR_REGISTRY_URL;

// Logger
const logger = pino({
  level: LOG_LEVEL,
  transport: IS_DEV ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
});

// Database
const db = createDatabase(DB_PATH, logger);

// Migrations
const migrationsDir =
  [
    path.join(__dirname, 'db', 'migrations'),
    path.join(__dirname, '..', 'src', 'db', 'migrations'),
  ].find((dir) => fs.existsSync(dir)) ?? path.join(__dirname, '..', 'src', 'db', 'migrations');

runMigrations(db, migrationsDir, logger);

// Repositories
const profileStore = createProfileStore(db);
const sessionRepo = createSessionRepository(db);
const eventRepo = createEventRepository(db);
const escalationRepo = createEscalationRepository(db);

// Event bus
const eventBus = createEventBus(eventRepo, logger);

// Auth module (dev stub — real Entra ID module plugs in for production)
const authModule: AuthModule = {
  async validateToken(_token: string) {
    // Stub: accept any token in dev, reject all in prod
    if (!IS_DEV) {
      const { AuthError } = await import('@autopod/shared');
      throw new AuthError('Auth module not configured');
    }
    return {
      oid: 'dev-user',
      preferred_username: 'developer',
      name: 'Developer',
      roles: ['admin' as const],
      aud: 'autopod',
      iss: 'autopod-dev',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    };
  },
  validateTokenSync(_token: string) {
    if (!IS_DEV) {
      throw new Error('Auth module not configured');
    }
    return {
      oid: 'dev-user',
      preferred_username: 'developer',
      name: 'Developer',
      roles: ['admin' as const],
      aud: 'autopod',
      iss: 'autopod-dev',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    };
  },
};

const worktreeManager = new LocalWorktreeManager({ logger });

// Container manager: Docker for isolated builds, or filesystem passthrough for local dev
let containerManager: ContainerManager;
let imageBuilder: import('./images/index.js').ImageBuilder | undefined;

if (CONTAINER_RUNTIME === 'docker') {
  const Dockerode = (await import('dockerode')).default;
  const docker = new Dockerode();
  containerManager = new DockerContainerManager({ docker, logger });
  logger.info('Using Docker container runtime');

  // Wire up ImageBuilder when Docker + ACR are available
  if (ACR_REGISTRY_URL) {
    const { AcrClient } = await import('./images/acr-client.js');
    const { ImageBuilder } = await import('./images/image-builder.js');
    const acr = new AcrClient({ registryUrl: ACR_REGISTRY_URL }, docker);
    imageBuilder = new ImageBuilder({ docker, acr, profileStore });
    logger.info({ acrRegistry: ACR_REGISTRY_URL }, 'Image warming enabled');
  }
} else {
  containerManager = new LocalContainerManager(logger);
  logger.info('Using local filesystem container runtime');
}

const runtimeRegistry = createRuntimeRegistry([
  new ClaudeRuntime(logger),
  new CodexRuntime(logger),
]);
const validationEngine = createLocalValidationEngine(containerManager, logger);

// Session queue + manager (circular dep resolved via closure)
let sessionManager: ReturnType<typeof createSessionManager>;

const sessionQueue = createSessionQueue(
  MAX_CONCURRENCY,
  async (sessionId) => {
    await sessionManager.processSession(sessionId);
  },
  logger,
);

sessionManager = createSessionManager({
  sessionRepo,
  escalationRepo,
  profileStore,
  eventBus,
  containerManager,
  worktreeManager,
  runtimeRegistry,
  validationEngine,
  enqueueSession: (id) => sessionQueue.enqueue(id),
  mcpBaseUrl: `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`,
  daemonConfig: {
    mcpServers: JSON.parse(process.env.DAEMON_MCP_SERVERS ?? '[]'),
    claudeMdSections: JSON.parse(process.env.DAEMON_CLAUDE_MD_SECTIONS ?? '[]'),
  },
  logger,
});

// Session bridge for MCP escalation
const pendingRequestsBySession = new Map<string, PendingRequests>();
const sessionBridge = createSessionBridge({
  sessionManager,
  escalationRepo,
  profileStore,
  pendingRequestsBySession,
  logger,
});

// Notifications (opt-in via TEAMS_WEBHOOK_URL)
const notificationConfig: NotificationConfig = TEAMS_WEBHOOK_URL
  ? {
      teams: {
        webhookUrl: TEAMS_WEBHOOK_URL,
        enabledEvents: ['session_validated', 'session_failed', 'session_needs_input', 'session_error'],
      },
    }
  : {};

const notificationService = createNotificationService({
  eventBus,
  config: notificationConfig,
  teamsAdapter: createTeamsAdapter(TEAMS_WEBHOOK_URL ?? '', logger),
  rateLimiter: createRateLimiter(),
  sessionLookup: sessionManager,
  logger,
});
notificationService.start();

// Server
const app = await createServer({
  authModule,
  sessionManager,
  profileStore,
  eventBus,
  eventRepo,
  sessionBridge,
  pendingRequestsBySession,
  imageBuilder,
  logLevel: LOG_LEVEL,
  prettyLog: IS_DEV,
});

// Start listening
try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info({ port: PORT, host: HOST }, 'Autopod daemon started');
} catch (err) {
  app.log.fatal(err, 'Failed to start daemon');
  process.exit(1);
}

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down...');

  // Stop accepting new requests
  await app.close();

  // Stop notifications
  notificationService.stop();

  // Drain session queue
  await sessionQueue.drain();

  // Close database
  db.close();

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
