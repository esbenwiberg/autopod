import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PendingRequests } from '@autopod/escalation-mcp';
import pino from 'pino';
import { createServer } from './api/server.js';
import { DockerContainerManager } from './containers/docker-container-manager.js';
import { DockerNetworkManager } from './containers/docker-network-manager.js';
import { createDatabase } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import type { AuthModule } from './interfaces/index.js';
import type { ContainerManager } from './interfaces/index.js';
import {
  createNotificationService,
  createRateLimiter,
  createTeamsAdapter,
} from './notifications/index.js';
import type { NotificationConfig } from './notifications/index.js';
import { loadOrCreateKey } from './crypto/credentials-cipher.js';
import { createProfileStore } from './profiles/index.js';
import { ClaudeRuntime, CodexRuntime, createRuntimeRegistry } from './runtimes/index.js';
import {
  createEscalationRepository,
  createEventBus,
  createEventRepository,
  createNudgeRepository,
  createSessionManager,
  createSessionQueue,
  createSessionRepository,
} from './sessions/index.js';
import { createSessionBridge } from './sessions/session-bridge-impl.js';
import { createLocalValidationEngine } from './validation/local-validation-engine.js';
import { LocalWorktreeManager } from './worktrees/local-worktree-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
const IS_DEV = process.env.NODE_ENV !== 'production';
const PORT = Number.parseInt(process.env.PORT ?? '3100', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_PATH = process.env.DB_PATH ?? './autopod.db';
const MAX_CONCURRENCY = Number.parseInt(process.env.MAX_CONCURRENCY ?? '3', 10);
const TEAMS_WEBHOOK_URL = process.env.TEAMS_WEBHOOK_URL;
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

// Credentials encryption key (generated on first run, persisted at ~/.autopod/secrets.key)
const credentialsCipher = loadOrCreateKey(
  path.join(os.homedir(), '.autopod', 'secrets.key'),
);

// Repositories
const profileStore = createProfileStore(db, credentialsCipher);
const sessionRepo = createSessionRepository(db);
const eventRepo = createEventRepository(db);
const escalationRepo = createEscalationRepository(db);
const nudgeRepo = createNudgeRepository(db);

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

// Docker is required — all agent work runs inside containers
const Dockerode = (await import('dockerode')).default;
const docker = new Dockerode();

// Verify Docker is reachable before proceeding
try {
  await docker.ping();
  logger.info('Docker connection verified');
} catch (err) {
  logger.fatal({ err }, 'autopod requires Docker Desktop — docker.ping() failed');
  process.exit(1);
}

const containerManager: ContainerManager = new DockerContainerManager({ docker, logger });
const networkManager = new DockerNetworkManager({ docker, logger });

let imageBuilder: import('./images/index.js').ImageBuilder | undefined;
if (ACR_REGISTRY_URL) {
  const { AcrClient } = await import('./images/acr-client.js');
  const { ImageBuilder } = await import('./images/image-builder.js');
  const acr = new AcrClient({ registryUrl: ACR_REGISTRY_URL }, docker);
  imageBuilder = new ImageBuilder({ docker, acr, profileStore });
  logger.info({ acrRegistry: ACR_REGISTRY_URL }, 'Image warming enabled');
}

const runtimeRegistry = createRuntimeRegistry([
  new ClaudeRuntime(logger, containerManager),
  new CodexRuntime(logger, containerManager),
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

// ACI container manager (opt-in via env vars)
const ACI_SUBSCRIPTION_ID = process.env.AZURE_SUBSCRIPTION_ID;
const ACI_RESOURCE_GROUP = process.env.AZURE_RESOURCE_GROUP;
const ACI_LOCATION = process.env.AZURE_LOCATION ?? 'westeurope';
const ACI_ACR_USERNAME = process.env.ACR_USERNAME;
const ACI_ACR_PASSWORD = process.env.ACR_PASSWORD;

let aciContainerManager:
  | import('./containers/aci-container-manager.js').AciContainerManager
  | undefined;
if (
  ACI_SUBSCRIPTION_ID &&
  ACI_RESOURCE_GROUP &&
  ACR_REGISTRY_URL &&
  ACI_ACR_USERNAME &&
  ACI_ACR_PASSWORD
) {
  const { AciContainerManager } = await import('./containers/aci-container-manager.js');
  aciContainerManager = new AciContainerManager(
    {
      subscriptionId: ACI_SUBSCRIPTION_ID,
      resourceGroup: ACI_RESOURCE_GROUP,
      acrRegistryUrl: ACR_REGISTRY_URL,
      acrUsername: ACI_ACR_USERNAME,
      acrPassword: ACI_ACR_PASSWORD,
      location: ACI_LOCATION,
    },
    logger,
  );
  logger.info(
    { subscriptionId: ACI_SUBSCRIPTION_ID, resourceGroup: ACI_RESOURCE_GROUP },
    'ACI execution target enabled',
  );
}

// Container manager factory — routes to Docker (local) or ACI based on execution target
const containerManagerFactory = {
  get(target: import('@autopod/shared').ExecutionTarget) {
    if (target === 'aci') {
      if (!aciContainerManager) {
        throw new Error(
          'ACI execution target requested but not configured. ' +
            'Set AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP, ACR_REGISTRY_URL, ACR_USERNAME, ACR_PASSWORD.',
        );
      }
      return aciContainerManager;
    }
    return containerManager;
  },
};

sessionManager = createSessionManager({
  sessionRepo,
  escalationRepo,
  nudgeRepo,
  profileStore,
  eventBus,
  containerManagerFactory,
  worktreeManager,
  runtimeRegistry,
  validationEngine,
  networkManager,
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
  nudgeRepo,
  profileStore,
  pendingRequestsBySession,
  logger,
});

// Notifications (opt-in via TEAMS_WEBHOOK_URL)
const notificationConfig: NotificationConfig = TEAMS_WEBHOOK_URL
  ? {
      teams: {
        webhookUrl: TEAMS_WEBHOOK_URL,
        enabledEvents: [
          'session_validated',
          'session_failed',
          'session_needs_input',
          'session_error',
        ],
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
  onShutdown: () => void shutdown('API'),
});

// Start listening
try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info({ port: PORT, host: HOST }, 'Autopod daemon started');
} catch (err) {
  app.log.fatal(err, 'Failed to start daemon');
  process.exit(1);
}

// Reconcile ACI sessions after startup (non-blocking — errors are logged, not fatal)
if (aciContainerManager) {
  const { reconcileAciSessions } = await import('./sessions/reconciler.js');
  reconcileAciSessions({
    sessionRepo,
    eventBus,
    aciContainerManager,
    onReconnected: async (sessionId, _containerId) => {
      // Re-trigger completion handling for reconnected sessions
      await sessionManager.handleCompletion(sessionId);
    },
    logger,
  }).catch((err) => {
    logger.error({ err }, 'ACI session reconciliation failed');
  });
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
