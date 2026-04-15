import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PendingRequests } from '@autopod/escalation-mcp';
import { config as loadDotenv } from 'dotenv';
import pino from 'pino';
import { build as buildPrettyStream } from 'pino-pretty';
import {
  createActionAuditRepository,
  createActionEngine,
  createActionRegistry,
} from './actions/index.js';
import { createServer } from './api/server.js';
import { DockerContainerManager } from './containers/docker-container-manager.js';
import { DockerNetworkManager } from './containers/docker-network-manager.js';
import { loadOrCreateKey } from './crypto/credentials-cipher.js';
import { createSessionTokenIssuer } from './crypto/session-tokens.js';
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
import { createProfileStore } from './profiles/index.js';
import {
  ClaudeRuntime,
  CodexRuntime,
  CopilotRuntime,
  createRuntimeRegistry,
} from './runtimes/index.js';
import { createScheduledJobManager } from './scheduled-jobs/scheduled-job-manager.js';
import { createScheduledJobRepository } from './scheduled-jobs/scheduled-job-repository.js';
import { createScheduledJobScheduler } from './scheduled-jobs/scheduled-job-scheduler.js';
import {
  createEscalationRepository,
  createEventBus,
  createEventRepository,
  createMemoryRepository,
  createNudgeRepository,
  createPendingOverrideRepository,
  createProgressEventRepository,
  createSessionManager,
  createSessionQueue,
  createSessionRepository,
  createValidationRepository,
} from './sessions/index.js';
import { createSessionBridge } from './sessions/session-bridge-impl.js';
import { createHostBrowserRunner } from './validation/host-browser-runner.js';
import { createLocalValidationEngine } from './validation/local-validation-engine.js';
import { AdoPrManager, parseAdoRepoUrl } from './worktrees/ado-pr-manager.js';
import { LocalWorktreeManager } from './worktrees/local-worktree-manager.js';
import { GhPrManager, GitHubApiPrManager } from './worktrees/pr-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadDotenv(); // load .env if present (no-op if missing)

const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
const IS_DEV = process.env.NODE_ENV !== 'production';
const PORT = Number.parseInt(process.env.PORT || '3100', 10);
const HOST = process.env.HOST ?? '127.0.0.1';
const DB_PATH = process.env.DB_PATH ?? './autopod.db';
const MAX_CONCURRENCY = Number.parseInt(process.env.MAX_CONCURRENCY ?? '3', 10);
const TEAMS_WEBHOOK_URL = process.env.TEAMS_WEBHOOK_URL;
const ACR_REGISTRY_URL = process.env.ACR_REGISTRY_URL;

// Logger — use pino-pretty as a direct stream (not a transport) to avoid worker-thread issues
const logger = IS_DEV
  ? pino({ level: LOG_LEVEL }, buildPrettyStream({ colorize: true }))
  : pino({ level: LOG_LEVEL });

// Database
const db = createDatabase(DB_PATH, logger);

// Migrations
const migrationsDir =
  [
    path.join(__dirname, 'db', 'migrations'),
    path.join(__dirname, '..', 'src', 'db', 'migrations'),
  ].find((dir) => fs.existsSync(dir)) ?? path.join(__dirname, '..', 'src', 'db', 'migrations');

runMigrations(db, migrationsDir, logger);

const actionAuditRepo = createActionAuditRepository(db);
const actionRegistry = createActionRegistry(logger);

// Credentials encryption key (generated on first run, persisted at ~/.autopod/secrets.key)
const secretsKeyPath = path.join(os.homedir(), '.autopod', 'secrets.key');
const credentialsCipher = loadOrCreateKey(secretsKeyPath);

// Session token issuer (HMAC-based, derived from secrets.key).
// Declared early so it can be passed to createSessionManager for container authentication.
const sessionTokenIssuer = createSessionTokenIssuer(secretsKeyPath);

// Repositories
const profileStore = createProfileStore(db, credentialsCipher);
const sessionRepo = createSessionRepository(db);
const eventRepo = createEventRepository(db);
const escalationRepo = createEscalationRepository(db);
const nudgeRepo = createNudgeRepository(db);
const validationRepo = createValidationRepository(db);
const progressEventRepo = createProgressEventRepository(db);
const memoryRepo = createMemoryRepository(db);
const pendingOverrideRepo = createPendingOverrideRepository(db);

// Event bus
const eventBus = createEventBus(eventRepo, logger);

// Auth module (dev stub — real Entra ID module plugs in for production)
//
// In dev mode a random token is generated on first run and written to
// ~/.autopod/dev-token (chmod 600). The CLI reads it automatically so
// `ap` commands work without `ap login`. Any other caller must present
// the same token — "accept any Bearer string" is no longer allowed.
function getOrCreateDevToken(): string {
  const dir = path.join(os.homedir(), '.autopod');
  const tokenPath = path.join(dir, 'dev-token');
  fs.mkdirSync(dir, { recursive: true });
  try {
    return fs.readFileSync(tokenPath, 'utf-8').trim();
  } catch {
    const token = randomBytes(32).toString('hex');
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    return token;
  }
}

// In dev mode, create the token file so the CLI can read it as a convenience credential.
// The daemon itself no longer validates against this specific token — any Bearer string is accepted.
if (IS_DEV) {
  getOrCreateDevToken();
  logger.info({ path: path.join(os.homedir(), '.autopod', 'dev-token') }, 'Dev auth token path');
}

const devPayload = () => ({
  oid: 'dev-user',
  preferred_username: 'developer',
  name: 'Developer',
  roles: ['admin' as const],
  aud: 'autopod',
  iss: 'autopod-dev',
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
});

const authModule: AuthModule = {
  async validateToken(token: string) {
    if (!IS_DEV) {
      const { AuthError } = await import('@autopod/shared');
      throw new AuthError('Auth module not configured');
    }
    // In dev mode, accept any non-empty Bearer token (documented behaviour).
    // The CLI stores the dev token at ~/.autopod/dev-token for convenience,
    // but the daemon does not enforce it — any caller with any Bearer string is accepted.
    if (!token) {
      const { AuthError } = await import('@autopod/shared');
      throw new AuthError('Missing token');
    }
    return devPayload();
  },
  validateTokenSync(token: string) {
    if (!IS_DEV) {
      throw new Error('Auth module not configured');
    }
    if (!token) {
      throw new Error('Missing token');
    }
    return devPayload();
  },
};

const worktreeManager = new LocalWorktreeManager({ logger });

const MOCK_DOCKER = process.env.AUTOPOD_MOCK_DOCKER === 'true';

// Docker is required for real sessions — all agent work runs inside containers.
// Set AUTOPOD_MOCK_DOCKER=true to skip Docker entirely (API/health-check dev mode).
const Dockerode = (await import('dockerode')).default;
type DockerodeInstance = InstanceType<typeof Dockerode>;

let docker: DockerodeInstance | undefined;
let containerManager: ContainerManager;
let networkManager: DockerNetworkManager | undefined;

if (MOCK_DOCKER) {
  logger.warn('AUTOPOD_MOCK_DOCKER=true — Docker disabled. Sessions will not run real containers.');
  const { createDevMockContainerManager } = await import('./containers/mock-container-manager.js');
  containerManager = createDevMockContainerManager();
} else {
  // Verify Docker is reachable before proceeding
  const d = new Dockerode();
  try {
    await d.ping();
    logger.info('Docker connection verified');
  } catch (err) {
    logger.fatal(
      { err },
      'autopod requires Docker Desktop — docker.ping() failed. Set AUTOPOD_MOCK_DOCKER=true to start without Docker.',
    );
    process.exit(1);
  }
  docker = d;
  containerManager = new DockerContainerManager({ docker: d, logger });
  networkManager = new DockerNetworkManager({ docker: d, logger });
}

let imageBuilder: import('./images/index.js').ImageBuilder | undefined;
if (ACR_REGISTRY_URL && docker) {
  const { AcrClient } = await import('./images/acr-client.js');
  const { ImageBuilder } = await import('./images/image-builder.js');
  const acr = new AcrClient({ registryUrl: ACR_REGISTRY_URL }, docker);
  imageBuilder = new ImageBuilder({ docker, acr, profileStore });
  logger.info({ acrRegistry: ACR_REGISTRY_URL }, 'Image warming enabled');
}

const runtimeRegistry = createRuntimeRegistry([
  new ClaudeRuntime(logger, containerManager),
  new CodexRuntime(logger, containerManager),
  new CopilotRuntime(logger, containerManager),
]);
const hostBrowserRunner = createHostBrowserRunner(logger);
const validationEngine = createLocalValidationEngine(containerManager, logger, hostBrowserRunner);

// Session queue + manager (circular dep resolved via closure)
// biome-ignore lint/style/useConst: assigned after sessionQueue to break circular dependency
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

const ghPrManager = new GhPrManager({ logger });

function prManagerFactory(
  profile: import('@autopod/shared').Profile,
): import('./interfaces/pr-manager.js').PrManager | null {
  if (profile.prProvider === 'ado') {
    if (!profile.adoPat) {
      logger.warn(
        { profileName: profile.name },
        'ADO pr provider configured but adoPat is missing — skipping PR creation',
      );
      return null;
    }
    try {
      const { orgUrl, project, repoName } = parseAdoRepoUrl(profile.repoUrl);
      return new AdoPrManager({ orgUrl, project, repoName, pat: profile.adoPat, logger });
    } catch (err) {
      logger.warn(
        { err, profileName: profile.name },
        'Failed to parse ADO repo URL — skipping PR creation',
      );
      return null;
    }
  }
  if (profile.githubPat) {
    return new GitHubApiPrManager({ pat: profile.githubPat, logger });
  }
  return ghPrManager;
}

// Pending MCP ask_human requests — created before sessionManager so both can share the map
const pendingRequestsBySession = new Map<string, PendingRequests>();

sessionManager = createSessionManager({
  sessionRepo,
  escalationRepo,
  nudgeRepo,
  validationRepo,
  progressEventRepo,
  profileStore,
  eventBus,
  eventRepo,
  actionAuditRepo,
  containerManagerFactory,
  worktreeManager,
  runtimeRegistry,
  validationEngine,
  networkManager,
  prManagerFactory,
  actionEngine: actionRegistry,
  enqueueSession: (id) => sessionQueue.enqueue(id),
  mcpBaseUrl: `http://${process.env.AUTOPOD_CONTAINER_HOST ?? 'host.docker.internal'}:${PORT}`,
  daemonConfig: {
    mcpServers: JSON.parse(process.env.DAEMON_MCP_SERVERS ?? '[]'),
    claudeMdSections: JSON.parse(process.env.DAEMON_CLAUDE_MD_SECTIONS ?? '[]'),
  },
  pendingRequestsBySession,
  sessionTokenIssuer,
  memoryRepo,
  pendingOverrideRepo,
  getSecret: (ref: string) => process.env[ref],
  logger,
});

function makeActionEngine(profile: import('@autopod/shared').Profile) {
  return createActionEngine({
    registry: actionRegistry,
    auditRepo: actionAuditRepo,
    logger,
    getSecret: (ref: string) => {
      const envVal = process.env[ref];
      if (envVal) return envVal;
      if (ref === 'github-pat' || ref === 'GITHUB_TOKEN') return profile.githubPat ?? undefined;
      if (ref === 'ado-pat' || ref === 'ADO_PAT') return profile.adoPat ?? undefined;
      return undefined;
    },
  });
}

// Scheduled jobs
const scheduledJobRepo = createScheduledJobRepository(db);
const scheduledJobManager = createScheduledJobManager({
  scheduledJobRepo,
  sessionManager,
  eventBus,
  logger,
});
const scheduledJobScheduler = createScheduledJobScheduler(scheduledJobManager, logger);

// Session bridge for MCP escalation
const sessionBridge = createSessionBridge({
  sessionManager,
  sessionRepo,
  eventBus,
  progressEventRepo,
  escalationRepo,
  nudgeRepo,
  profileStore,
  memoryRepo,
  containerManagerFactory,
  makeActionEngine,
  pendingRequestsBySession,
  logger,
  hostBrowserRunner,
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

// Issue watcher (polls GitHub Issues / ADO Work Items for labeled issues)
import { createIssueWatcherRepository } from './issue-watcher/issue-watcher-repository.js';
import { createIssueWatcherService } from './issue-watcher/issue-watcher-service.js';

const issueWatcherRepo = createIssueWatcherRepository(db);
const ISSUE_WATCHER_POLL_INTERVAL = Number.parseInt(
  process.env.ISSUE_WATCHER_POLL_INTERVAL_MS ?? '60000',
  10,
);
const issueWatcherService = createIssueWatcherService({
  profileStore,
  sessionManager,
  eventBus,
  issueWatcherRepo,
  logger,
  pollIntervalMs: ISSUE_WATCHER_POLL_INTERVAL,
});
issueWatcherService.start();

// Server
const app = await createServer({
  authModule,
  sessionManager,
  profileStore,
  eventBus,
  eventRepo,
  sessionBridge,
  pendingRequestsBySession,
  containerManagerFactory,
  docker,
  db,
  sessionQueue,
  maxConcurrency: MAX_CONCURRENCY,
  imageBuilder,
  actionRegistry,
  sessionTokenIssuer,
  memoryRepo,
  pendingOverrideRepo,
  scheduledJobManager,
  issueWatcherRepo,
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

// Start scheduled job scheduler AFTER server is listening
scheduledJobScheduler.start();

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

// Reconcile local sessions (non-blocking — errors logged, not fatal)
{
  const { reconcileLocalSessions } = await import('./sessions/local-reconciler.js');
  reconcileLocalSessions({
    sessionRepo,
    eventBus,
    containerManager,
    enqueueSession: (id) => sessionQueue.enqueue(id),
    validationRepo,
    logger,
  })
    .then((result) => {
      if (result.recovered.length > 0) {
        logger.info({ recovered: result.recovered }, 'Local sessions recovered');
      }
      if (result.killed.length > 0) {
        logger.warn({ killed: result.killed }, 'Unrecoverable local sessions killed');
      }
    })
    .catch((err) => {
      logger.error({ err }, 'Local session reconciliation failed');
    });
}

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down...');

  // Stop accepting new requests
  await app.close();

  // Stop notifications and issue watcher
  notificationService.stop();
  issueWatcherService.stop();

  // Stop scheduled job scheduler
  scheduledJobScheduler.stop();

  // Drain session queue
  await sessionQueue.drain();

  // Close database
  db.close();

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
