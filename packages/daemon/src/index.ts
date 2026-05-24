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
import { DockerSidecarManager } from './containers/sidecar-manager.js';
import { loadOrCreateKey } from './crypto/credentials-cipher.js';
import { createPodTokenIssuer } from './crypto/pod-tokens.js';
import { createDbBackupManager } from './db/backup.js';
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
import {
  createEscalationRepository,
  createEventBus,
  createEventRepository,
  createFixFeedbackRepository,
  createMemoryCandidateRepository,
  createMemoryCandidateRecorder,
  createMemoryRepository,
  createNudgeRepository,
  createPendingOverrideRepository,
  createPodManager,
  createPodQueue,
  createPodRepository,
  createProgressEventRepository,
  createQualityScoreRecorder,
  createQualityScoreRepository,
  createValidationRepository,
} from './pods/index.js';
import { createSessionBridge } from './pods/pod-bridge-impl.js';
import { ScreenshotRetention } from './pods/screenshot-retention.js';
import { createScreenshotStore, resolveDataDir } from './pods/screenshot-store.js';
import { createProfileStore } from './profiles/index.js';
import {
  ClaudeRuntime,
  CodexRuntime,
  CopilotRuntime,
  createRuntimeRegistry,
} from './runtimes/index.js';
import { createSafetyEventsRepository } from './safety/safety-events-repository.js';
import { createScheduledJobManager } from './scheduled-jobs/scheduled-job-manager.js';
import { createScheduledJobRepository } from './scheduled-jobs/scheduled-job-repository.js';
import { createScheduledJobScheduler } from './scheduled-jobs/scheduled-job-scheduler.js';
import { createModelManager, createRepoScanner, createScanRepository } from './security/index.js';
import { capLargeStrings } from './util/log-sanitizer.js';
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

// Fields to redact from all log records — covers common credential field names.
const LOG_REDACT_PATHS = [
  '*.token',
  '*.pat',
  '*.apiKey',
  '*.api_key',
  '*.password',
  '*.secret',
  '*.accessToken',
  '*.access_token',
  '*.refreshToken',
  '*.refresh_token',
  '*.authToken',
  '*.auth_token',
  '*.privateKey',
  '*.private_key',
  'token',
  'pat',
  'password',
  'secret',
];

const PINO_BASE_OPTIONS = {
  level: LOG_LEVEL,
  redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
  hooks: {
    logMethod(this: pino.Logger, args: Parameters<pino.LogFn>, method: pino.LogFn) {
      if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
        args[0] = capLargeStrings(args[0]) as object;
      }
      return method.apply(this, args);
    },
  },
};

// Logger — use pino-pretty as a direct stream (not a transport) to avoid worker-thread issues
const logger = IS_DEV
  ? pino(PINO_BASE_OPTIONS, buildPrettyStream({ colorize: true }))
  : pino(PINO_BASE_OPTIONS);

// Node's `fetch` (undici) calls `performance.mark()` per request for the
// Resource Timing API. Over a long-running daemon (PR polling, issue watcher,
// MCP proxy, action HTTP handlers) the global mark buffer fills up and Node
// emits MaxPerformanceEntryBufferExceededWarning. We don't read these entries,
// so it's safe to clear them periodically.
const perfClearTimer = setInterval(() => {
  performance.clearMarks();
  performance.clearMeasures();
}, 60_000);
perfClearTimer.unref();

// Database
const db = createDatabase(DB_PATH, logger);

// Migrations
const migrationsDir =
  [
    path.join(__dirname, 'db', 'migrations'),
    path.join(__dirname, '..', 'src', 'db', 'migrations'),
  ].find((dir) => fs.existsSync(dir)) ?? path.join(__dirname, '..', 'src', 'db', 'migrations');

runMigrations(db, migrationsDir, logger, DB_PATH);

const backupManager = createDbBackupManager(db, DB_PATH, logger, {
  intervalMs: process.env.AUTOPOD_BACKUP_INTERVAL_MS
    ? Number.parseInt(process.env.AUTOPOD_BACKUP_INTERVAL_MS, 10)
    : undefined,
  retain: process.env.AUTOPOD_BACKUP_RETAIN
    ? Number.parseInt(process.env.AUTOPOD_BACKUP_RETAIN, 10)
    : undefined,
});
backupManager.start();

const actionAuditRepo = createActionAuditRepository(db);
const actionRegistry = createActionRegistry(logger);
const safetyEventsRepo = createSafetyEventsRepository(db);

// Credentials encryption key (generated on first run, persisted at ~/.autopod/secrets.key)
const secretsKeyPath = path.join(os.homedir(), '.autopod', 'secrets.key');
const credentialsCipher = loadOrCreateKey(secretsKeyPath);

// Pod token issuer (HMAC-based, derived from secrets.key).
// Declared early so it can be passed to createPodManager for container authentication.
const sessionTokenIssuer = createPodTokenIssuer(secretsKeyPath);

// Repositories
const profileStore = createProfileStore(db, credentialsCipher);
const podRepo = createPodRepository(db);
const eventRepo = createEventRepository(db);
const escalationRepo = createEscalationRepository(db);
const nudgeRepo = createNudgeRepository(db);
const fixFeedbackRepo = createFixFeedbackRepository(db);
const validationRepo = createValidationRepository(db);
const progressEventRepo = createProgressEventRepository(db);
const memoryRepo = createMemoryRepository(db);
const memoryCandidateRepo = createMemoryCandidateRepository(db);
const pendingOverrideRepo = createPendingOverrideRepository(db);
const qualityScoreRepo = createQualityScoreRepository(db);
const scanRepo = createScanRepository(db);
// ML detectors are opt-in via env. Enable AUTOPOD_SECURITY_ML to load
// the prompt-injection and PII classifiers (ONNX, lazy-loaded). Disabled
// by default to keep daemon RAM low and avoid first-run model downloads.
const securityMlEnabled = process.env.AUTOPOD_SECURITY_ML === 'true';
const modelManager = securityMlEnabled ? createModelManager({ logger }) : undefined;
const repoScanner = createRepoScanner({ scanRepo, modelManager, logger });

// Event bus
const eventBus = createEventBus(eventRepo, logger);

// Auth module (dev stub — real Entra ID module plugs in for production)
//
// Dev auth requires AUTOPOD_ALLOW_DEV_AUTH=1 to be set explicitly.
// Without the flag, even NODE_ENV=development requests are rejected so
// that accidentally-started dev daemons don't become open relays.
//
// When enabled, a random token is generated on first run and written to
// ~/.autopod/dev-token (chmod 600). The CLI reads it automatically so
// `ap` commands work without `ap login`.
const ALLOW_DEV_AUTH = IS_DEV && process.env.AUTOPOD_ALLOW_DEV_AUTH === '1';

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

if (IS_DEV) {
  if (ALLOW_DEV_AUTH) {
    getOrCreateDevToken();
    logger.info({ path: path.join(os.homedir(), '.autopod', 'dev-token') }, 'Dev auth token path');
  } else {
    logger.warn(
      'Dev auth is disabled — set AUTOPOD_ALLOW_DEV_AUTH=1 to accept dev tokens. All API requests will be rejected.',
    );
  }
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
    if (!ALLOW_DEV_AUTH) {
      const { AuthError } = await import('@autopod/shared');
      throw new AuthError(
        IS_DEV
          ? 'Dev auth not enabled — set AUTOPOD_ALLOW_DEV_AUTH=1'
          : 'Auth module not configured',
      );
    }
    if (!token) {
      const { AuthError } = await import('@autopod/shared');
      throw new AuthError('Missing token');
    }
    return devPayload();
  },
  validateTokenSync(token: string) {
    if (!ALLOW_DEV_AUTH) {
      throw new Error(
        IS_DEV
          ? 'Dev auth not enabled — set AUTOPOD_ALLOW_DEV_AUTH=1'
          : 'Auth module not configured',
      );
    }
    if (!token) {
      throw new Error('Missing token');
    }
    return devPayload();
  },
};

const worktreeManager = new LocalWorktreeManager({ logger });

const MOCK_DOCKER = process.env.AUTOPOD_MOCK_DOCKER === 'true';

// Docker is required for real pods — all agent work runs inside containers.
// Enable AUTOPOD_MOCK_DOCKER to skip Docker entirely (API/health-check dev mode).
const Dockerode = (await import('dockerode')).default;
type DockerodeInstance = InstanceType<typeof Dockerode>;

let docker: DockerodeInstance | undefined;
let containerManager: ContainerManager;
let networkManager: DockerNetworkManager | undefined;
// Spawns companion sidecars (e.g. Dagger engine) on the pod's isolated
// network. Only wired when real Docker is available — mock mode skips
// sidecars entirely and the pod manager surfaces MISCONFIGURED_DAEMON if a
// pod requests one, which is the correct behaviour in that mode.
let sidecarManager: DockerSidecarManager | undefined;

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
  // Warn if the Docker engine's memory ceiling can't back the worst-case
  // concurrent pod load. Per-container memory limits set by autopod are fake
  // headroom if the VM doesn't actually have that much RAM — the kernel OOM
  // killer fires first (most visible on Docker Desktop's small Linux VM).
  try {
    const info = await d.info();
    const memTotalBytes =
      typeof (info as { MemTotal?: unknown }).MemTotal === 'number'
        ? ((info as { MemTotal: number }).MemTotal as number)
        : undefined;
    if (memTotalBytes && memTotalBytes > 0) {
      const { DEFAULT_CONTAINER_MEMORY_GB } = await import('@autopod/shared');
      const worstCaseBytes = DEFAULT_CONTAINER_MEMORY_GB * MAX_CONCURRENCY * 1024 ** 3;
      const memTotalGb = (memTotalBytes / 1024 ** 3).toFixed(2);
      if (memTotalBytes < worstCaseBytes) {
        logger.warn(
          {
            dockerMemTotalGb: Number(memTotalGb),
            defaultContainerMemoryGb: DEFAULT_CONTAINER_MEMORY_GB,
            maxConcurrency: MAX_CONCURRENCY,
            worstCaseGb: DEFAULT_CONTAINER_MEMORY_GB * MAX_CONCURRENCY,
          },
          'Docker engine memory is undersized for configured concurrency — heavy builds may be OOM-killed. Raise Docker Desktop Settings → Resources → Memory, lower MAX_CONCURRENCY, or set profile.containerMemoryGb on memory-light profiles.',
        );
      } else {
        logger.info(
          {
            dockerMemTotalGb: Number(memTotalGb),
            worstCaseGb: DEFAULT_CONTAINER_MEMORY_GB * MAX_CONCURRENCY,
          },
          'Docker engine memory budget OK',
        );
      }
    }
  } catch (err) {
    logger.debug({ err }, 'docker.info() failed — skipping memory headroom check');
  }
  docker = d;
  containerManager = new DockerContainerManager({ docker: d, logger });
  networkManager = new DockerNetworkManager({ docker: d, logger });
  sidecarManager = new DockerSidecarManager({ docker: d, logger });
}

// Surface sidecar wiring in startup output so a missing manager is obvious
// from the first line of log, not only when a pod tries to use one.
if (sidecarManager) {
  logger.info('SidecarManager: configured (Docker)');
} else {
  logger.warn(
    'SidecarManager: disabled (mock mode). Pods that set requireSidecars will fail with MISCONFIGURED_DAEMON.',
  );
}

let imageBuilder: import('./images/index.js').ImageBuilder | undefined;
if (docker) {
  const { ImageBuilder } = await import('./images/image-builder.js');
  let acr: import('./images/acr-client.js').AcrClient | null = null;
  if (ACR_REGISTRY_URL) {
    const { AcrClient } = await import('./images/acr-client.js');
    acr = new AcrClient({ registryUrl: ACR_REGISTRY_URL }, docker);
  }
  imageBuilder = new ImageBuilder({ docker, acr, profileStore });
  logger.info(
    { acrRegistry: ACR_REGISTRY_URL ?? null, mode: acr ? 'acr-push' : 'local-only' },
    'Image warming enabled',
  );
}

const runtimeRegistry = createRuntimeRegistry([
  new ClaudeRuntime(logger, containerManager),
  new CodexRuntime(logger, containerManager, podRepo),
  new CopilotRuntime(logger, containerManager),
]);
const hostBrowserRunner = createHostBrowserRunner(logger);
const screenshotStore = createScreenshotStore(resolveDataDir());
const validationEngine = createLocalValidationEngine(
  containerManager,
  logger,
  hostBrowserRunner,
  screenshotStore,
);

const retentionDays = Number.parseInt(process.env.AUTOPOD_SCREENSHOT_RETENTION_DAYS ?? '30', 10);
if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
  throw new Error('AUTOPOD_SCREENSHOT_RETENTION_DAYS must be a positive integer');
}
const screenshotRetention = new ScreenshotRetention({
  retentionDays,
  sweepIntervalMs: 60 * 60 * 1000, // 1 hour — not configurable via env (YAGNI)
  podRepository: podRepo,
  screenshotStore,
  logger: logger.child({ component: 'screenshot-retention' }),
});

// Pod queue + manager (circular dep resolved via closure)
// biome-ignore lint/style/useConst: assigned after podQueue to break circular dependency
let podManager: ReturnType<typeof createPodManager>;

const podQueue = createPodQueue(
  MAX_CONCURRENCY,
  async (podId) => {
    await podManager.processPod(podId);
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
    if (!profile.repoUrl) {
      logger.warn(
        { profileName: profile.name },
        'ADO pr provider configured but repoUrl is missing — skipping PR creation',
      );
      return null;
    }
    try {
      const { orgUrl, project, repoName } = parseAdoRepoUrl(profile.repoUrl);
      return new AdoPrManager({
        orgUrl,
        project,
        repoName,
        pat: profile.adoPat,
        logger,
        screenshotStore,
      });
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

// Pending MCP ask_human requests — created before podManager so both can share the map
const pendingRequestsByPod = new Map<string, PendingRequests>();

podManager = createPodManager({
  podRepo,
  escalationRepo,
  nudgeRepo,
  fixFeedbackRepo,
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
  sidecarManager,
  prManagerFactory,
  actionEngine: actionRegistry,
  enqueueSession: (id) => podQueue.enqueue(id),
  clearStuckQueueEntry: (id) => podQueue.clearStuckEntry(id),
  mcpBaseUrl: `http://${process.env.AUTOPOD_CONTAINER_HOST ?? 'host.docker.internal'}:${PORT}`,
  daemonConfig: {
    mcpServers: JSON.parse(process.env.DAEMON_MCP_SERVERS ?? '[]'),
    claudeMdSections: JSON.parse(process.env.DAEMON_CLAUDE_MD_SECTIONS ?? '[]'),
    skills: JSON.parse(process.env.DAEMON_SKILLS ?? '[]'),
  },
  pendingRequestsByPod,
  sessionTokenIssuer,
  memoryRepo,
  pendingOverrideRepo,
  getSecret: (ref: string) => process.env[ref],
  repoScanner,
  scanRepo,
  screenshotStore,
  hostScreenshotDir: (podId) => hostBrowserRunner.screenshotDir(podId),
  safetyEventsRepo,
  logger,
});

function makeActionEngine(profile: import('@autopod/shared').Profile) {
  return createActionEngine({
    registry: actionRegistry,
    auditRepo: actionAuditRepo,
    safetyEventsRepo,
    logger,
    podRepo,
    profileStore,
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
  podManager,
  eventBus,
  logger,
});
const scheduledJobScheduler = createScheduledJobScheduler(scheduledJobManager, logger);

// Pod bridge for MCP escalation
const podBridge = createSessionBridge({
  podManager,
  podRepo,
  eventBus,
  progressEventRepo,
  escalationRepo,
  nudgeRepo,
  profileStore,
  memoryRepo,
  containerManagerFactory,
  makeActionEngine,
  pendingRequestsByPod,
  logger,
  hostBrowserRunner,
  worktreeManager,
  screenshotStore,
});

// Notifications (opt-in via TEAMS_WEBHOOK_URL)
const notificationConfig: NotificationConfig = TEAMS_WEBHOOK_URL
  ? {
      teams: {
        webhookUrl: TEAMS_WEBHOOK_URL,
        enabledEvents: ['pod_validated', 'pod_failed', 'pod_needs_input', 'pod_error'],
      },
    }
  : {};

const notificationService = createNotificationService({
  eventBus,
  config: notificationConfig,
  teamsAdapter: createTeamsAdapter(TEAMS_WEBHOOK_URL ?? '', logger),
  rateLimiter: createRateLimiter(),
  sessionLookup: podManager,
  logger,
  screenshotStore,
});
notificationService.start();

// Quality-score recorder: writes one pod_quality_scores row per pod on terminal state.
const qualityScoreRecorder = createQualityScoreRecorder({
  eventBus,
  podRepo,
  eventRepo,
  escalationRepo,
  qualityScoreRepo,
  validationRepo,
  logger,
});
qualityScoreRecorder.start();

// Memory candidate recorder: background LLM extraction of durable lessons from
// agent pod outcomes. Fail-soft — never affects pod lifecycle.
const memoryCandidateRecorder = createMemoryCandidateRecorder({
  eventBus,
  podRepo,
  profileStore,
  candidateRepo: memoryCandidateRepo,
  memoryRepo,
  eventRepo,
  escalationRepo,
  validationRepo,
  logger,
});
memoryCandidateRecorder.start();

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
  podManager,
  eventBus,
  issueWatcherRepo,
  safetyEventsRepo,
  logger,
  pollIntervalMs: ISSUE_WATCHER_POLL_INTERVAL,
});
issueWatcherService.start();

// Server
const app = await createServer({
  authModule,
  podManager,
  profileStore,
  worktreeManager,
  eventBus,
  eventRepo,
  podRepo,
  escalationRepo,
  qualityScoreRepo,
  validationRepo,
  podBridge,
  pendingRequestsByPod,
  containerManagerFactory,
  docker,
  db,
  podQueue,
  maxConcurrency: MAX_CONCURRENCY,
  imageBuilder,
  actionRegistry,
  sessionTokenIssuer,
  memoryRepo,
  pendingOverrideRepo,
  scheduledJobManager,
  safetyEventsRepo,
  issueWatcherRepo,
  screenshotStore,
  logLevel: LOG_LEVEL,
  prettyLog: IS_DEV,
  onShutdown: () => void shutdown('API'),
  modelManager,
  securityMlEnabled,
});

// Start listening
try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info({ port: PORT, host: HOST }, 'Autopod daemon started');
} catch (err) {
  app.log.fatal(err, 'Failed to start daemon');
  process.exit(1);
}

// Background warmup of ML detectors so /health reports a real status and the
// first scan doesn't pay the model-load cost. Errors are already logged inside
// model-manager; we just emit a single line summary on completion so an
// operator who didn't read the warn lines still sees what loaded.
if (securityMlEnabled && modelManager) {
  void Promise.allSettled([
    modelManager.getInjectionClassifier(),
    modelManager.getPiiClassifier(),
  ]).then(() => {
    const status = modelManager.getStatus();
    const degraded = status.injection === 'failed' || status.pii === 'failed';
    if (degraded) {
      logger.error(
        { detectors: status },
        'Security ML degraded — at least one classifier failed to load. Coverage is reduced.',
      );
    } else {
      logger.info({ detectors: status }, 'Security ML detectors loaded');
    }
  });
}

// Start screenshot retention sweeper — runs immediately then hourly
screenshotRetention.start();

// Start scheduled job scheduler AFTER server is listening
scheduledJobScheduler.start();

// Reconcile ACI pods after startup (non-blocking — errors are logged, not fatal)
if (aciContainerManager) {
  const { reconcileAciSessions } = await import('./pods/reconciler.js');
  reconcileAciSessions({
    podRepo,
    eventBus,
    aciContainerManager,
    onReconnected: async (podId, _containerId) => {
      // Re-trigger completion handling for reconnected pods
      await podManager.handleCompletion(podId);
    },
    logger,
  }).catch((err) => {
    logger.error({ err }, 'ACI pod reconciliation failed');
  });
}

// Reconcile local pods. Must complete BEFORE rehydrateDependentSessions runs:
// rehydrate enqueues queued series-dep pods, processPod synchronously transitions
// them queued→provisioning, and reconcile then iterates `provisioning` status
// and kills any pod whose worktree doesn't exist yet — exactly the state a
// freshly-enqueued pod is in for the first few milliseconds. Awaiting here
// drains reconcile fully before rehydrate touches the queue.
try {
  const { reconcileLocalSessions } = await import('./pods/local-reconciler.js');
  const result = await reconcileLocalSessions({
    podRepo,
    eventBus,
    containerManager,
    enqueueSession: (id) => podQueue.enqueue(id),
    validationRepo,
    logger,
  });
  if (result.recovered.length > 0) {
    logger.info({ recovered: result.recovered }, 'Local pods recovered');
  }
  if (result.killed.length > 0) {
    logger.warn({ killed: result.killed }, 'Unrecoverable local pods killed');
  }
} catch (err) {
  logger.error({ err }, 'Local pod reconciliation failed');
}

// Prune orphan pod networks and sidecars left behind by a previous crashed run.
// Runs after pod reconciliation so the active pod ID set reflects the true state.
{
  const activePodIds = new Set(podRepo.listNonTerminalPodIds());
  if (networkManager) {
    networkManager
      .reconcileOrphanNetworks(activePodIds)
      .then((pruned) => {
        if (pruned > 0) logger.info({ pruned }, 'Startup: pruned orphan pod networks');
      })
      .catch((err) => {
        logger.error({ err }, 'Network orphan reconciliation failed');
      });
  }
  if (sidecarManager) {
    sidecarManager
      .reconcileOrphans(activePodIds)
      .then((reaped) => {
        if (reaped > 0) logger.info({ reaped }, 'Startup: reaped orphan sidecars');
      })
      .catch((err) => {
        logger.error({ err }, 'Sidecar orphan reconciliation failed');
      });
  }
}

// Re-trigger any queued series pods whose parents are already done (e.g. after
// a daemon restart or after the approveSession bug that omitted this call).
podManager.rehydrateDependentSessions();

// Watchdog: auto-fail running pods whose agent stream went silent so the
// concurrency slot frees up. Threshold via AUTOPOD_STUCK_RUNNING_THRESHOLD_MS.
podManager.startStuckPodWatchdog();

// Sleep detector: publishes host.resumed events when the daemon's event loop
// resumes after a long process suspension (laptop sleep). Drives wake-recovery
// in pod-manager (brief 02). Threshold via AUTOPOD_SLEEP_DETECT_THRESHOLD_MS.
const { startSleepDetector } = await import('./pods/sleep-detector.js');
const stopSleepDetector = startSleepDetector(eventBus, logger);

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down...');

  // Stop accepting new requests
  await app.close();

  // Stop notifications, quality recorder, memory recorder, issue watcher, and screenshot retention
  notificationService.stop();
  qualityScoreRecorder.stop();
  memoryCandidateRecorder.stop();
  issueWatcherService.stop();
  screenshotRetention.stop();

  // Stop scheduled job scheduler
  scheduledJobScheduler.stop();

  // Stop perf-mark cleaner
  clearInterval(perfClearTimer);

  // Stop the stuck-pod watchdog and sleep detector
  podManager.stopStuckPodWatchdog();
  stopSleepDetector();

  // Drain pod queue
  await podQueue.drain();

  // Stop backup manager (must precede db.close)
  backupManager.stop();

  // Close database
  db.close();

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
