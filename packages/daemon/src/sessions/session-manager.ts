import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PendingRequests } from '@autopod/escalation-mcp';
import type {
  AgentEvent,
  CreateSessionRequest,
  DaemonConfig,
  EscalationRequest,
  ExecutionTarget,
  HistoryQuery,
  InjectedMcpServer,
  NetworkPolicy,
  PrivateRegistry,
  Profile,
  Session,
  SessionStatus,
  ValidationFinding,
  ValidationOverride,
  ValidationOverridePayload,
} from '@autopod/shared';
import {
  AUTOPOD_INSTRUCTIONS_PATH,
  AutopodError,
  CONTAINER_HOME_DIR,
  DEFAULT_CONTAINER_MEMORY_GB,
  generateId,
  generateSessionId,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { ActionAuditRepository } from '../actions/audit-repository.js';
import type { SessionTokenIssuer } from '../crypto/session-tokens.js';
import { createHistoryExporter } from '../history/history-exporter.js';
import { generateHistoryInstructions } from '../history/instructions-generator.js';
import { getBaseImage } from '../images/dockerfile-generator.js';
import type {
  ContainerManager,
  PrManager,
  RuntimeRegistry,
  ValidationEngine,
  WorktreeManager,
} from '../interfaces/index.js';
import type { ProfileStore } from '../profiles/index.js';
import { buildProviderEnv, persistRefreshedCredentials } from '../providers/index.js';
import type { ProviderEnvResult } from '../providers/index.js';
import type { ClaudeRuntime } from '../runtimes/claude-runtime.js';
import { detectRecurringFindings, extractFindings } from '../validation/finding-fingerprint.js';
import { applyOverrides } from '../validation/override-applicator.js';
import { buildGitHubImageUrl, collectScreenshots } from '../validation/screenshot-collector.js';
import { readAcFile } from './ac-file-parser.js';
import { buildCorrectionMessage } from './correction-context.js';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventBus } from './event-bus.js';
import type { EventRepository } from './event-repository.js';
import { formatFeedback } from './feedback-formatter.js';
import { mergeClaudeMdSections, mergeMcpServers, mergeSkills } from './injection-merger.js';
import type { NudgeRepository } from './nudge-repository.js';
import type { ProgressEventRepository } from './progress-event-repository.js';
import {
  buildContinuationPrompt,
  buildRecoveryTask,
  buildReworkPrompt,
  buildReworkTask,
} from './recovery-context.js';
import {
  buildNuGetCredentialEnv,
  buildRegistryFiles,
  validateRegistryFiles,
} from './registry-injector.js';
import { resolveSections } from './section-resolver.js';
import type { SessionRepository, SessionStats, SessionUpdates } from './session-repository.js';
import { resolveSkills } from './skill-resolver.js';
import {
  canKill,
  canNudge,
  canPause,
  canReceiveMessage,
  isTerminalState,
  validateTransition,
} from './state-machine.js';
import { generateSystemInstructions } from './system-instructions-generator.js';
import type { ValidationRepository } from './validation-repository.js';

/** Allocate a random host port in range 10000–48999 for container port mapping.
 * Capped at 48999 to avoid the Windows/Hyper-V dynamic port reservation range (49152+). */
function allocateHostPort(): number {
  return 10_000 + Math.floor(Math.random() * 39_000);
}

/** Default container port for app servers (matches Dockerfile HEALTHCHECK). */
const CONTAINER_APP_PORT = 3000;

/** Auto-stop preview containers after this duration (default 10 minutes). */
const PREVIEW_AUTO_STOP_MS = 10 * 60 * 1000;

const execFileAsync = promisify(execFile);

/** Load a repo-specific code-review skill from standard locations in the worktree. */
async function loadCodeReviewSkill(
  worktreePath: string,
  log?: Logger,
): Promise<string | undefined> {
  const candidates = ['skills/code-review.md', '.claude/skills/code-review.md'];
  for (const relative of candidates) {
    const fullPath = path.join(worktreePath, relative);
    try {
      const content = await readFile(fullPath, 'utf-8');
      log?.info({ path: fullPath }, 'loaded repo-specific code-review skill');
      return content;
    } catch {
      // not found — try next
    }
  }
  return undefined;
}

/** Derive the bare repo path from an existing worktree via `git rev-parse --git-common-dir`. */
async function deriveBareRepoPath(worktreePath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
    cwd: worktreePath,
  });
  return path.resolve(worktreePath, stdout.trim());
}

/**
 * Parses a human's response to a validation_override escalation.
 * Supports:
 *   - "dismiss" / "dismiss all" → dismiss all findings
 *   - "dismiss 1,3" → dismiss specific findings by 1-based index
 *   - Any other text → treat as guidance for all findings
 */
function parseValidationOverrideResponse(
  message: string,
  findings: ValidationFinding[],
): ValidationOverride[] {
  const trimmed = message.trim().toLowerCase();
  const now = new Date().toISOString();

  // "dismiss" or "dismiss all" → dismiss everything
  if (trimmed === 'dismiss' || trimmed === 'dismiss all') {
    return findings.map((f) => ({
      findingId: f.id,
      description: f.description,
      action: 'dismiss' as const,
      reason: message.trim(),
      createdAt: now,
    }));
  }

  // "dismiss 1,2,3" → dismiss specific indices
  const dismissMatch = trimmed.match(/^dismiss\s+([\d,\s]+)$/);
  if (dismissMatch) {
    const indices = dismissMatch[1]!
      .split(/[,\s]+/)
      .map((s) => Number.parseInt(s, 10) - 1) // 1-based → 0-based
      .filter((i) => i >= 0 && i < findings.length);

    const indexSet = new Set(indices);
    return findings
      .filter((_, i) => indexSet.has(i))
      .map((f) => ({
        findingId: f.id,
        description: f.description,
        action: 'dismiss' as const,
        reason: message.trim(),
        createdAt: now,
      }));
  }

  // Anything else → guidance for all findings
  return findings.map((f) => ({
    findingId: f.id,
    description: f.description,
    action: 'guidance' as const,
    guidance: message.trim(),
    createdAt: now,
  }));
}

/** Merge new overrides into existing ones, deduplicating by findingId (latest wins). */
function mergeOverrides(
  existing: ValidationOverride[],
  incoming: ValidationOverride[],
): ValidationOverride[] {
  const map = new Map<string, ValidationOverride>();
  for (const o of existing) map.set(o.findingId, o);
  for (const o of incoming) map.set(o.findingId, o);
  return [...map.values()];
}

export interface ContainerManagerFactory {
  get(target: ExecutionTarget): ContainerManager;
}

export interface NetworkManager {
  buildNetworkConfig(
    policy: NetworkPolicy | null,
    mcpServers: InjectedMcpServer[],
    daemonGatewayIp: string,
    registries?: PrivateRegistry[],
  ): Promise<{ networkName: string; firewallScript: string } | null>;
  getGatewayIp(): Promise<string>;
}

export interface SessionManagerDependencies {
  sessionRepo: SessionRepository;
  escalationRepo: EscalationRepository;
  nudgeRepo: NudgeRepository;
  validationRepo?: ValidationRepository;
  progressEventRepo?: ProgressEventRepository;
  profileStore: ProfileStore;
  eventBus: EventBus;
  containerManagerFactory: ContainerManagerFactory;
  worktreeManager: WorktreeManager;
  runtimeRegistry: RuntimeRegistry;
  validationEngine: ValidationEngine;
  networkManager?: NetworkManager;
  /** Factory returning the appropriate PrManager for a given profile. Return null to skip PR creation. */
  prManagerFactory?: (profile: Profile) => PrManager | null;
  actionEngine?: {
    getAvailableActions: (
      policy: import('@autopod/shared').ActionPolicy,
    ) => import('@autopod/shared').ActionDefinition[];
  };
  actionAuditRepo?: ActionAuditRepository;
  eventRepo?: EventRepository;
  enqueueSession: (sessionId: string) => void;
  mcpBaseUrl: string;
  daemonConfig: Pick<DaemonConfig, 'mcpServers' | 'claudeMdSections'>;
  /** Pending MCP ask_human requests keyed by sessionId — used to resolve escalations */
  pendingRequestsBySession?: Map<string, PendingRequests>;
  /** Used to generate a session-scoped Bearer token injected into the container so it can
   * authenticate calls to the /mcp/:sessionId endpoint. Optional for backwards compat. */
  sessionTokenIssuer?: SessionTokenIssuer;
  /** Resolve environment variable or secret by name (e.g. AZURE_GRAPH_TOKEN). */
  getSecret: (ref: string) => string | undefined;
  logger: Logger;
}

export interface SessionManager {
  createSession(request: CreateSessionRequest, userId: string): Session;
  processSession(sessionId: string): Promise<void>;
  consumeAgentEvents(sessionId: string, events: AsyncIterable<AgentEvent>): Promise<void>;
  handleCompletion(sessionId: string): Promise<void>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  notifyEscalation(sessionId: string, escalation: EscalationRequest): void;
  touchHeartbeat(sessionId: string): void;
  approveSession(sessionId: string, options?: { squash?: boolean }): Promise<void>;
  rejectSession(sessionId: string, reason?: string): Promise<void>;
  approveAllValidated(): Promise<{ approved: string[] }>;
  killAllFailed(): Promise<{ killed: string[] }>;
  extendAttempts(sessionId: string, additionalAttempts: number): Promise<void>;
  pauseSession(sessionId: string): Promise<void>;
  nudgeSession(sessionId: string, message: string): void;
  killSession(sessionId: string): Promise<void>;
  completeSession(sessionId: string): Promise<{ pushError?: string }>;
  triggerValidation(sessionId: string, options?: { force?: boolean }): Promise<void>;
  /** Pull latest from remote branch and re-run validation without agent rework on failure.
   *  Used after human fixes via a linked workspace pod. */
  revalidateSession(sessionId: string): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }>;
  /** Create a linked workspace pod on the same branch as a failed worker session for human fixes. */
  fixManually(sessionId: string, userId: string): Promise<Session>;
  createHistoryWorkspace(profileName: string, userId: string, historyQuery: HistoryQuery): Session;
  deleteSession(sessionId: string): Promise<void>;
  startPreview(sessionId: string): Promise<{ previewUrl: string }>;
  stopPreview(sessionId: string): Promise<void>;
  getSession(sessionId: string): Session;
  listSessions(filters?: {
    profileName?: string;
    status?: SessionStatus;
    userId?: string;
  }): Session[];
  getSessionStats(filters?: { profileName?: string }): SessionStats;
  getValidationHistory(sessionId: string): import('./validation-repository.js').StoredValidation[];
  /**
   * Re-apply network policy to all running local containers using the given profile.
   * Called after a profile's networkPolicy is updated via the API.
   * Fire-and-forget safe — errors are logged but do not propagate.
   */
  refreshNetworkPolicy(profileName: string): Promise<void>;
}

export function createSessionManager(deps: SessionManagerDependencies): SessionManager {
  const {
    sessionRepo,
    escalationRepo: _escalationRepo,
    nudgeRepo,
    profileStore,
    eventBus,
    containerManagerFactory,
    worktreeManager,
    runtimeRegistry,
    validationEngine,
    networkManager,
    prManagerFactory,
    enqueueSession,
    mcpBaseUrl,
    daemonConfig,
    logger,
    validationRepo,
    progressEventRepo,
  } = deps;

  /** Active auto-stop timers for preview containers, keyed by sessionId. */
  const previewTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Active commit polling intervals, keyed by sessionId. */
  const commitPollers = new Map<string, ReturnType<typeof setInterval>>();

  const COMMIT_POLL_INTERVAL_MS = 60_000;

  /** Active merge polling intervals, keyed by sessionId. */
  const mergePollers = new Map<string, ReturnType<typeof setInterval>>();

  const MERGE_POLL_INTERVAL_MS = 60_000;

  /** Start polling PR merge status for a session in merge_pending state. */
  function startMergePolling(sessionId: string): void {
    stopMergePolling(sessionId);

    const poll = async () => {
      try {
        const session = sessionRepo.getOrThrow(sessionId);
        if (session.status !== 'merge_pending') {
          stopMergePolling(sessionId);
          return;
        }

        if (!session.prUrl) {
          stopMergePolling(sessionId);
          return;
        }

        const profile = profileStore.get(session.profileName);
        const prManager = prManagerFactory ? prManagerFactory(profile) : null;
        if (!prManager) {
          stopMergePolling(sessionId);
          return;
        }

        const status = await prManager.getPrStatus({
          prUrl: session.prUrl,
          worktreePath: session.worktreePath ?? undefined,
        });

        if (status.merged) {
          emitActivityStatus(sessionId, 'PR merged successfully');
          transition(session, 'complete', {
            completedAt: new Date().toISOString(),
            mergeBlockReason: null,
          });

          eventBus.emit({
            type: 'session.completed',
            timestamp: new Date().toISOString(),
            sessionId,
            finalStatus: 'complete',
            summary: {
              id: sessionId,
              profileName: session.profileName,
              task: session.task,
              status: 'complete',
              model: session.model,
              runtime: session.runtime,
              duration: session.startedAt
                ? Date.now() - new Date(session.startedAt).getTime()
                : null,
              filesChanged: session.filesChanged,
              createdAt: session.createdAt,
            },
          });

          logger.info(
            { sessionId, prUrl: session.prUrl },
            'Merge polling: PR merged — session complete',
          );
          stopMergePolling(sessionId);
          return;
        }

        if (!status.open) {
          emitActivityStatus(
            sessionId,
            `PR closed without merging: ${status.blockReason ?? 'unknown reason'}`,
          );
          transition(session, 'failed', { mergeBlockReason: status.blockReason });
          logger.warn(
            { sessionId, prUrl: session.prUrl, reason: status.blockReason },
            'Merge polling: PR closed — session failed',
          );
          stopMergePolling(sessionId);
          return;
        }

        // Still pending — update block reason if it changed
        if (status.blockReason !== session.mergeBlockReason) {
          sessionRepo.update(sessionId, { mergeBlockReason: status.blockReason });
          emitActivityStatus(sessionId, `Merge pending: ${status.blockReason}`);
        }
      } catch (err) {
        logger.debug({ err, sessionId }, 'Merge polling failed, skipping cycle');
      }
    };

    // Run first poll immediately
    poll();
    const interval = setInterval(poll, MERGE_POLL_INTERVAL_MS);
    interval.unref();
    mergePollers.set(sessionId, interval);
  }

  /** Stop merge polling for a session. */
  function stopMergePolling(sessionId: string): void {
    const interval = mergePollers.get(sessionId);
    if (interval) {
      clearInterval(interval);
      mergePollers.delete(sessionId);
    }
  }

  /** Resume merge polling for any sessions left in merge_pending state (e.g. after daemon restart). */
  function resumeMergePolling(): void {
    const pendingSessions = sessionRepo.list({ status: 'merge_pending' as SessionStatus });
    for (const session of pendingSessions) {
      logger.info(
        { sessionId: session.id, prUrl: session.prUrl },
        'Resuming merge polling after restart',
      );
      startMergePolling(session.id);
    }
  }

  // Resume merge polling on startup
  resumeMergePolling();

  /** Start polling git commit count inside a running container. */
  function startCommitPolling(sessionId: string): void {
    stopCommitPolling(sessionId);

    /** Capture the starting HEAD SHA so we only count commits the agent makes. */
    const captureStartSha = async () => {
      try {
        const session = sessionRepo.getOrThrow(sessionId);
        if (session.startCommitSha || !session.containerId) return;
        const cm = containerManagerFactory.get(session.executionTarget);
        const shaResult = await cm.execInContainer(
          session.containerId,
          ['git', 'rev-parse', 'HEAD'],
          { cwd: '/workspace', timeout: 5_000 },
        );
        if (shaResult.exitCode === 0 && shaResult.stdout.trim()) {
          sessionRepo.update(sessionId, { startCommitSha: shaResult.stdout.trim() });
        }
      } catch {
        logger.debug({ sessionId }, 'Failed to capture start commit SHA');
      }
    };

    const poll = async () => {
      try {
        const session = sessionRepo.getOrThrow(sessionId);
        if (!session.containerId || session.status !== 'running') {
          stopCommitPolling(sessionId);
          return;
        }
        // Use startCommitSha if available; fall back to baseBranch for old sessions
        const exclusionRef = session.startCommitSha ?? session.baseBranch ?? 'main';
        const cm = containerManagerFactory.get(session.executionTarget);
        const [countResult, timeResult] = await Promise.all([
          cm.execInContainer(
            session.containerId,
            ['git', 'rev-list', '--count', 'HEAD', `^${exclusionRef}`],
            { cwd: '/workspace', timeout: 5_000 },
          ),
          cm.execInContainer(session.containerId, ['git', 'log', '-1', '--format=%cI'], {
            cwd: '/workspace',
            timeout: 5_000,
          }),
        ]);
        const commitCount = Number.parseInt(countResult.stdout.trim(), 10) || 0;
        const lastCommitAt = timeResult.exitCode === 0 ? timeResult.stdout.trim() : null;
        sessionRepo.update(sessionId, { commitCount, lastCommitAt });
      } catch {
        // Silently skip — container may be busy or gone
        logger.debug({ sessionId }, 'Commit polling failed, skipping cycle');
      }
    };
    // Capture starting SHA first, then run first poll immediately
    captureStartSha().then(() => poll());
    const interval = setInterval(poll, COMMIT_POLL_INTERVAL_MS);
    interval.unref();
    commitPollers.set(sessionId, interval);
  }

  /** Stop commit polling for a session. */
  function stopCommitPolling(sessionId: string): void {
    const interval = commitPollers.get(sessionId);
    if (interval) {
      clearInterval(interval);
      commitPollers.delete(sessionId);
    }
  }

  /** Cancel and remove an auto-stop timer for a session if one exists. */
  function clearPreviewTimer(sessionId: string): void {
    const timer = previewTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      previewTimers.delete(sessionId);
    }
  }

  /** Schedule an auto-stop timer that will stop the container after PREVIEW_AUTO_STOP_MS. */
  function schedulePreviewAutoStop(
    sessionId: string,
    containerId: string,
    target: import('@autopod/shared').ExecutionTarget,
  ): void {
    clearPreviewTimer(sessionId);
    const timer = setTimeout(async () => {
      previewTimers.delete(sessionId);
      try {
        const cm = containerManagerFactory.get(target);
        await cm.stop(containerId);
        logger.info({ sessionId, containerId }, 'Preview auto-stopped after timeout');
      } catch (err) {
        logger.warn({ err, sessionId }, 'Failed to auto-stop preview container');
      }
    }, PREVIEW_AUTO_STOP_MS);
    // Unref so the timer doesn't prevent process exit
    timer.unref();
    previewTimers.set(sessionId, timer);
  }

  /**
   * Build provider env for resume calls.
   * Needed because OAuth tokens may have been rotated since the initial spawn.
   *
   * Before refreshing via the OAuth endpoint, we attempt to recover the latest
   * credentials directly from the container filesystem — Claude Code writes
   * rotated tokens there, and our post-exec persistence may have silently failed.
   */
  async function getResumeEnv(session: Session): Promise<Record<string, string> | undefined> {
    const profile = profileStore.get(session.profileName);
    const provider = profile.modelProvider;
    // Only MAX provider needs fresh env on resume (token rotation)
    if (provider !== 'max') return undefined;

    // Recover latest tokens from the container before we try to refresh.
    // The container is the source of truth — Claude Code rotates tokens during use
    // and writes them to ~/.claude/.credentials.json. If our earlier persistence
    // missed the update, the profile store has a stale (already-invalidated) refresh
    // token and the OAuth refresh will fail with invalid_grant.
    if (session.containerId) {
      try {
        await persistRefreshedCredentials(
          session.containerId,
          containerManagerFactory.get(session.executionTarget),
          profileStore,
          session.profileName,
          logger,
        );
      } catch (err) {
        logger.warn(
          { err, sessionId: session.id },
          'Could not recover credentials from container before resume — will try profile store',
        );
      }
    }

    const result = await buildProviderEnv(profile, session.id, logger);
    // Also re-write credential files to container in case tokens were rotated
    if (result.containerFiles.length > 0 && session.containerId) {
      const cm = containerManagerFactory.get(session.executionTarget);
      for (const file of result.containerFiles) {
        await cm.writeFile(session.containerId, file.path, file.content);
      }
    }
    return { SESSION_ID: session.id, ...result.env };
  }

  function touchHeartbeat(sessionId: string): void {
    try {
      sessionRepo.update(sessionId, { lastHeartbeatAt: new Date().toISOString() });
    } catch {
      // Best-effort — don't crash on heartbeat failures
    }
  }

  /**
   * Copy workspace changes from container back to the host worktree (bind mount).
   * The worktree is bind-mounted at /mnt/worktree while the agent works on the
   * container's native /workspace (overlayfs) — this avoids VirtioFS getcwd() bugs
   * on Docker Desktop for Mac. We sync back before any host-side git operations.
   */
  async function syncWorkspaceBack(containerId: string, cm: ContainerManager): Promise<void> {
    await cm.execInContainer(
      containerId,
      [
        'sh',
        '-c',
        'find /mnt/worktree -mindepth 1 -maxdepth 1 -exec rm -rf {} + && cp -a /workspace/. /mnt/worktree/',
      ],
      { timeout: 120_000 },
    );
  }

  function emitActivityStatus(sessionId: string, message: string): void {
    eventBus.emit({
      type: 'session.agent_activity',
      timestamp: new Date().toISOString(),
      sessionId,
      event: { type: 'status', timestamp: new Date().toISOString(), message },
    });
  }

  function transition(
    session: Session,
    to: SessionStatus,
    extraUpdates?: Partial<SessionUpdates>,
  ): Session {
    validateTransition(session.id, session.status, to);
    const previousStatus = session.status;
    const updates: SessionUpdates = { status: to, ...extraUpdates };
    sessionRepo.update(session.id, updates);
    eventBus.emit({
      type: 'session.status_changed',
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      previousStatus,
      newStatus: to,
    });
    return sessionRepo.getOrThrow(session.id);
  }

  return {
    createSession(request: CreateSessionRequest, userId: string): Session {
      const profile = profileStore.get(request.profileName);
      const model = request.model ?? profile.defaultModel;
      const runtime = request.runtime ?? profile.defaultRuntime;
      const executionTarget = request.executionTarget ?? profile.executionTarget;
      const skipValidation = request.skipValidation ?? false;
      const outputMode = request.outputMode ?? profile.outputMode ?? 'pr';

      // deny-all network policy blocks all outbound — incompatible with cloud-backed runtimes
      if (
        outputMode !== 'workspace' &&
        profile.networkPolicy?.enabled &&
        profile.networkPolicy?.mode === 'deny-all'
      ) {
        throw new AutopodError(
          `Network policy 'deny-all' blocks all outbound traffic, but runtime '${runtime}' requires API access. Use 'restricted' mode instead — the default allowlist includes the model API.`,
          'INVALID_CONFIGURATION',
          400,
        );
      }

      let id: string;
      for (let attempt = 0; attempt < 10; attempt++) {
        id = generateSessionId();
        const branch = request.branch ?? `autopod/${id}`;
        try {
          sessionRepo.insert({
            id,
            profileName: request.profileName,
            task: request.task,
            status: 'queued',
            model,
            runtime,
            executionTarget,
            branch,
            userId,
            maxValidationAttempts: profile.maxValidationAttempts,
            skipValidation,
            acceptanceCriteria: request.acceptanceCriteria ?? null,
            outputMode: request.outputMode ?? profile.outputMode ?? 'pr',
            baseBranch: request.baseBranch ?? null,
            acFrom: request.acFrom ?? null,
            linkedSessionId: request.linkedSessionId ?? null,
            pimGroups: request.pimGroups ?? null,
          });
          break;
        } catch (err: unknown) {
          if (
            err instanceof Error &&
            err.message.includes('UNIQUE constraint failed') &&
            attempt < 9
          ) {
            continue;
          }
          throw err;
        }
      }
      id = id!;

      const session = sessionRepo.getOrThrow(id);

      eventBus.emit({
        type: 'session.created',
        timestamp: new Date().toISOString(),
        session: {
          id: session.id,
          profileName: session.profileName,
          task: session.task,
          status: session.status,
          model: session.model,
          runtime: session.runtime,
          duration: null,
          filesChanged: session.filesChanged,
          createdAt: session.createdAt,
        },
      });

      enqueueSession(id);
      logger.info({ sessionId: id, profile: request.profileName }, 'Session created');
      return session;
    },

    createHistoryWorkspace(
      profileName: string,
      userId: string,
      historyQuery: HistoryQuery,
    ): Session {
      // Encode query params into the task field with a [history] prefix
      const queryJson = JSON.stringify(historyQuery);
      const task = `[history] History analysis workspace | ${queryJson}`;
      return this.createSession(
        {
          profileName,
          task,
          outputMode: 'workspace',
          skipValidation: true,
        },
        userId,
      );
    },

    async processSession(sessionId: string): Promise<void> {
      let session = sessionRepo.getOrThrow(sessionId);
      const profile = profileStore.get(session.profileName);

      function emitStatus(message: string): void {
        emitActivityStatus(sessionId, message);
      }

      try {
        // Detect recovery mode before any provisioning work
        const isRecovery = !!session.recoveryWorktreePath;
        const isRework = isRecovery && !!session.reworkReason;

        // Transition to provisioning
        session = transition(session, 'provisioning', { startedAt: new Date().toISOString() });

        // Recovery mode: reuse existing worktree instead of creating new one
        let worktreePath: string;
        let bareRepoPath: string;

        // Validate recovery worktree is still a usable git directory.
        // It may have been cleaned up by another session's kill (e.g. shared worktree path).
        let recoveryViable = false;
        if (isRecovery && session.recoveryWorktreePath) {
          try {
            await access(path.join(session.recoveryWorktreePath, '.git'));
            recoveryViable = true;
          } catch {
            logger.warn(
              { sessionId, worktreePath: session.recoveryWorktreePath },
              'Recovery worktree missing or not a git directory — falling back to fresh worktree',
            );
            sessionRepo.update(sessionId, { recoveryWorktreePath: null });
          }
        }

        if (recoveryViable && session.recoveryWorktreePath) {
          worktreePath = session.recoveryWorktreePath;
          bareRepoPath = await deriveBareRepoPath(worktreePath);
          // Clear recovery flag now that we've captured the path
          sessionRepo.update(sessionId, { recoveryWorktreePath: null });
          emitStatus('Recovering session — reusing existing worktree…');
          logger.info({ sessionId, worktreePath }, 'Recovery mode: reusing worktree');
        } else {
          // Normal path: create worktree
          emitStatus('Creating worktree…');
          const result = await worktreeManager.create({
            repoUrl: profile.repoUrl,
            branch: session.branch,
            baseBranch: session.baseBranch ?? profile.defaultBranch,
            pat: profile.adoPat ?? profile.githubPat ?? undefined,
          });
          worktreePath = result.worktreePath;
          bareRepoPath = result.bareRepoPath;
        }

        // If acFrom is set, read acceptance criteria from the worktree
        if (session.acFrom) {
          const criteria = await readAcFile(worktreePath, session.acFrom);
          sessionRepo.update(sessionId, { acceptanceCriteria: criteria });
          session = sessionRepo.getOrThrow(sessionId);
          logger.info(
            { sessionId, acFrom: session.acFrom, count: criteria.length },
            'Loaded acceptance criteria from file',
          );
        }

        // Select container manager based on execution target
        const containerManager = containerManagerFactory.get(session.executionTarget);

        // Compute network isolation config (Docker only, opt-in via profile)
        let networkName: string | undefined;
        let firewallScript: string | undefined;
        if (
          networkManager &&
          session.executionTarget === 'local' &&
          profile.networkPolicy?.enabled
        ) {
          const mergedServers = mergeMcpServers(daemonConfig.mcpServers, profile.mcpServers);
          const gatewayIp = await networkManager.getGatewayIp();
          const netConfig = await networkManager.buildNetworkConfig(
            profile.networkPolicy,
            mergedServers,
            gatewayIp,
            profile.privateRegistries,
          );
          if (netConfig) {
            networkName = netConfig.networkName;
            firewallScript = netConfig.firewallScript;
          }
        }

        // Allocate a host port for the container's app server
        const hostPort = allocateHostPort();

        // Spawn container with port mapping so daemon + user can reach the app
        emitStatus(`Spawning container (${profile.template})…`);

        // For .NET templates, cap MSBuild node count to half the available CPUs
        // (min 2, max 4) to prevent dozens of MSBuild workers from exhausting memory.
        const isDotnet = profile.template.startsWith('dotnet');

        // Resolve registry PAT early — needed for both container env vars and config files.
        // Fall back to adoPat when registryPat isn't set — they're usually the same
        // PAT for ADO-hosted feeds, and requiring both is a footgun.
        const effectiveRegistryPat = profile.registryPat ?? profile.adoPat ?? null;

        const containerEnv: Record<string, string> = {
          SESSION_ID: sessionId,
          PORT: String(CONTAINER_APP_PORT),
          HOST: '0.0.0.0', // bind to all interfaces inside container for Docker port forwarding
          ...(isDotnet
            ? {
                MSBUILDNODECOUNT: '4',
                // Disable MSBuild's TerminalLogger — it crashes with ArgumentOutOfRangeException
                // when terminal dimensions are unavailable (non-TTY exec contexts).
                MSBUILDTERMINALLOGGER: 'false',
              }
            : {}),
          // NuGet credential provider env — auth handled via env var, not config files
          ...buildNuGetCredentialEnv(profile.privateRegistries, effectiveRegistryPat),
        };

        const containerId = await containerManager.spawn({
          image: getBaseImage(profile.template),
          sessionId,
          env: containerEnv,
          ports: [{ container: CONTAINER_APP_PORT, host: hostPort }],
          volumes: [
            { host: worktreePath, container: '/mnt/worktree' },
            { host: bareRepoPath, container: bareRepoPath },
          ],
          networkName,
          firewallScript,
          memoryBytes:
            (profile.containerMemoryGb ?? DEFAULT_CONTAINER_MEMORY_GB) * 1024 * 1024 * 1024,
        });

        // Copy worktree content from bind mount to container's native filesystem.
        // VirtioFS bind mounts break getcwd() on Docker Desktop for Mac — overlayfs does not.
        emitStatus('Populating workspace…');
        await containerManager.execInContainer(
          containerId,
          ['cp', '-a', '/mnt/worktree/.', '/workspace/'],
          { timeout: 120_000 },
        );

        const previewUrl = `http://127.0.0.1:${hostPort}`;
        session = transition(session, 'running', {
          containerId,
          worktreePath,
          previewUrl,
        });

        // Resolve and write skills for all session types (including workspace)
        const mergedSkills = mergeSkills(daemonConfig.skills ?? [], profile.skills ?? []);
        let resolvedSkillNames: string[] = [];
        if (mergedSkills.length > 0) {
          emitStatus('Resolving skills…');
          const resolvedSkills = await resolveSkills(mergedSkills, logger);
          const skillsDir = `${CONTAINER_HOME_DIR}/.claude/commands`;
          for (const skill of resolvedSkills) {
            await containerManager.writeFile(
              containerId,
              `${skillsDir}/${skill.name}.md`,
              skill.content,
            );
          }
          resolvedSkillNames = resolvedSkills.map((s) => s.name);
          if (resolvedSkills.length > 0) {
            logger.info(
              { sessionId, count: resolvedSkills.length, names: resolvedSkillNames },
              'Skills written to container',
            );
          }
        }

        // Write private registry config files (.npmrc / NuGet.config) to user-level
        // paths inside the container. Runs for ALL session types including workspace pods.
        // NuGet configs are sources-only — auth is via credential provider env var above.
        const registryFiles = buildRegistryFiles(profile.privateRegistries, effectiveRegistryPat);
        for (const file of registryFiles) {
          await containerManager.writeFile(containerId, file.path, file.content);
          logger.info(
            { sessionId, path: file.path, bytes: file.content.length },
            'Wrote registry config file to container',
          );
        }

        // Workspace sessions: container stays alive, no agent/validation/PR
        if (session.outputMode === 'workspace') {
          // Capture starting HEAD so the diff endpoint only shows workspace changes,
          // not the entire branch history since it diverged from main.
          try {
            const shaResult = await containerManager.execInContainer(
              containerId,
              ['git', 'rev-parse', 'HEAD'],
              { cwd: '/workspace', timeout: 5_000 },
            );
            if (shaResult.exitCode === 0 && shaResult.stdout.trim()) {
              sessionRepo.update(sessionId, { startCommitSha: shaResult.stdout.trim() });
            }
          } catch {
            logger.debug({ sessionId }, 'Failed to capture workspace start commit SHA');
          }
          // History workspace: export session data into the container
          if (session.task.startsWith('[history]')) {
            try {
              emitStatus('Exporting history data…');
              const queryMatch = session.task.match(/\| (.+)$/);
              const historyQuery: HistoryQuery = queryMatch
                ? (JSON.parse(queryMatch[1]) as HistoryQuery)
                : {};

              const exporter = createHistoryExporter({
                sessionRepo,
                validationRepo: validationRepo!,
                escalationRepo: _escalationRepo,
                eventRepo: deps.eventRepo!,
                progressEventRepo: progressEventRepo!,
                actionAuditRepo: deps.actionAuditRepo,
              });

              const { dbBuffer, summary, analysisGuide, stats } = exporter.export(historyQuery);

              // Create /history directory
              await containerManager.execInContainer(containerId, ['mkdir', '-p', '/history'], {
                timeout: 5_000,
              });

              await containerManager.writeFile(containerId, '/history/history.db', dbBuffer);
              await containerManager.writeFile(containerId, '/history/summary.md', summary);
              await containerManager.writeFile(
                containerId,
                '/history/analysis-guide.md',
                analysisGuide,
              );

              const instructions = generateHistoryInstructions(stats);
              await containerManager.writeFile(containerId, '/workspace/CLAUDE.md', instructions);

              logger.info(
                { sessionId, exportedSessions: stats.totalSessions },
                'History data exported to workspace container',
              );
            } catch (err) {
              logger.error({ err, sessionId }, 'Failed to export history data');
            }
          }

          // Activate PIM groups for this workspace session
          if (session.pimGroups?.length && session.userId) {
            const { createPimClient } = await import('../actions/handlers/azure-pim-handler.js');
            const pimClient = createPimClient(deps.getSecret, logger);
            for (const group of session.pimGroups) {
              try {
                await pimClient.activate(
                  group.groupId,
                  session.userId,
                  group.duration ?? 'PT8H',
                  group.justification ?? `Workspace pod ${sessionId}`,
                );
                logger.info({ sessionId, groupId: group.groupId }, 'PIM group activated');
              } catch (err) {
                logger.warn(
                  { err, sessionId, groupId: group.groupId },
                  'PIM activation failed — continuing',
                );
              }
            }
          }

          logger.info({ sessionId }, 'Workspace session running — awaiting manual attach');
          return;
        }

        // Merge daemon + profile injections
        const mergedMcpServers = mergeMcpServers(daemonConfig.mcpServers, profile.mcpServers);
        const mergedSections = mergeClaudeMdSections(
          daemonConfig.claudeMdSections,
          profile.claudeMdSections,
        );

        // Rewrite injected MCP server URLs to route through daemon proxy
        // Agent sees proxy URLs, daemon handles auth injection + PII stripping
        const proxiedMcpServers = mergedMcpServers.map((s) => ({
          ...s,
          url: `${mcpBaseUrl}/mcp-proxy/${encodeURIComponent(s.name)}/${sessionId}`,
          // Don't expose auth headers to agent — proxy injects them
          headers: undefined,
        }));

        // Resolve available actions from profile's action policy
        const availableActions = profile.actionPolicy
          ? (deps.actionEngine?.getAvailableActions(profile.actionPolicy) ?? [])
          : [];

        // Resolve dynamic sections (fetches URLs, respects token budgets)
        if (mergedSections.some((s) => s.fetch)) {
          emitStatus('Fetching dynamic CLAUDE.md sections…');
        }
        const resolvedSections = await resolveSections(mergedSections, logger);

        // Generate system instructions and deliver based on runtime
        const mcpUrl = `${mcpBaseUrl}/mcp/${sessionId}`;

        const systemInstructions = generateSystemInstructions(profile, session, mcpUrl, {
          injectedSections: resolvedSections,
          injectedMcpServers: proxiedMcpServers,
          availableActions,
          injectedSkills: mergedSkills.filter((s) => resolvedSkillNames.includes(s.name)),
        });

        // Write system instructions to a path outside /workspace so the repo's own
        // CLAUDE.md / copilot-instructions.md is never overwritten.
        // Claude CLI reads this via --append-system-prompt-file; Copilot via customInstructions.
        emitStatus('Writing system instructions to container…');
        await containerManager.writeFile(
          containerId,
          AUTOPOD_INSTRUCTIONS_PATH,
          systemInstructions,
        );

        // Generate a session-scoped token so the container can authenticate its MCP calls.
        // The token is passed as Authorization: Bearer on the escalation MCP server config
        // and verified by the /mcp/:sessionId route handler.
        const mcpSessionToken = deps.sessionTokenIssuer?.generate(sessionId);
        const escalationHeaders = mcpSessionToken
          ? { Authorization: `Bearer ${mcpSessionToken}` }
          : undefined;

        // Build MCP server list for runtime
        const mcpServers = [
          { name: 'escalation', url: mcpUrl, headers: escalationHeaders },
          ...proxiedMcpServers.map((s) => ({ name: s.name, url: s.url, headers: s.headers })),
        ];

        // Build provider-aware env (API keys, OAuth creds, Foundry config)
        emitStatus('Building provider credentials…');
        const providerResult = await buildProviderEnv(profile, sessionId, logger);
        const secretEnv: Record<string, string> = {
          SESSION_ID: sessionId,
          ...providerResult.env,
        };

        // Codex runtime uses its own key from daemon env
        if (session.runtime === 'codex' && process.env.OPENAI_API_KEY) {
          secretEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
        }

        // Write provider credential files to container (e.g., OAuth .credentials.json for MAX)
        for (const file of providerResult.containerFiles) {
          await containerManager.writeFile(containerId, file.path, file.content);
          logger.info(
            { sessionId, path: file.path, bytes: file.content.length },
            'Wrote provider credential file to container',
          );
        }

        // Verify credential files are readable by the container user
        if (providerResult.containerFiles.length > 0) {
          const verifyResult = await containerManager.execInContainer(containerId, [
            'sh',
            '-c',
            providerResult.containerFiles.map((f) => `ls -la ${f.path}`).join(' && '),
          ]);
          logger.info(
            { sessionId, stdout: verifyResult.stdout.trim(), stderr: verifyResult.stderr.trim() },
            'Credential file verification',
          );
        }

        // Early validation: verify registry configs are parseable before agent starts
        if (registryFiles.length > 0) {
          try {
            await validateRegistryFiles(containerManager, containerId, registryFiles);
            logger.info({ sessionId }, 'Registry config validation passed');
          } catch (regErr) {
            logger.error(
              { sessionId, err: regErr },
              'Registry config validation failed — session will likely fail at build time',
            );
            emitActivityStatus(
              sessionId,
              `⚠ Registry config check failed: ${(regErr as Error).message}`,
            );
          }
        }

        // Start the agent — recovery mode uses resume for Claude, fresh spawn for others
        emitStatus('Spawning agent…');
        const runtime = runtimeRegistry.get(session.runtime);
        let events: AsyncIterable<AgentEvent>;

        // For Copilot, defensively merge the repo's own instructions (if any) with ours.
        // We can't be sure Copilot CLI reads both $COPILOT_HOME/copilot-instructions.md
        // and .github/copilot-instructions.md, so prepend the repo's file to be safe.
        let copilotInstructions: string | undefined;
        if (session.runtime === 'copilot') {
          copilotInstructions = systemInstructions;
          try {
            const repoInstructions = await containerManager.readFile(
              containerId,
              '/workspace/.github/copilot-instructions.md',
            );
            if (repoInstructions.trim()) {
              copilotInstructions = `${repoInstructions}\n\n---\n\n${systemInstructions}`;
              logger.info(
                { sessionId },
                'Merged repo copilot-instructions.md with autopod system instructions',
              );
            }
          } catch {
            // No repo-level copilot instructions — use ours as-is
          }
        }

        if (isRework) {
          // Rework: always a fresh spawn with rework-specific framing.
          // claudeSessionId was already cleared by triggerValidation so we never
          // resume a stale/broken session context.
          emitStatus('Reworking session…');
          const reworkTask = await buildReworkTask(session, worktreePath, session.reworkReason!);
          events = runtime.spawn({
            sessionId,
            task: reworkTask,
            model: session.model,
            workDir: '/workspace',
            containerId,
            customInstructions: copilotInstructions,
            env: secretEnv,
            mcpServers,
          });

          // Clear rework reason now that it's been consumed (one-shot)
          sessionRepo.update(sessionId, { reworkReason: null });
        } else if (isRecovery && session.runtime === 'claude' && session.claudeSessionId) {
          // Crash recovery: attempt Claude --resume with persisted session ID
          emitStatus('Resuming Claude session…');

          // Rehydrate the in-memory session ID map so resume() can find it
          if ('setClaudeSessionId' in runtime) {
            (runtime as ClaudeRuntime).setClaudeSessionId(sessionId, session.claudeSessionId);
          }

          const continuationPrompt = await buildContinuationPrompt(session, worktreePath);

          try {
            events = runtime.resume(sessionId, continuationPrompt, containerId, secretEnv);
          } catch (err) {
            logger.warn({ err, sessionId }, 'Claude --resume failed, falling back to fresh spawn');
            const recoveryTask = await buildRecoveryTask(session, worktreePath);
            events = runtime.spawn({
              sessionId,
              task: recoveryTask,
              model: session.model,
              workDir: '/workspace',
              containerId,
              customInstructions: copilotInstructions,
              env: secretEnv,
              mcpServers,
            });
          }
        } else if (isRecovery) {
          // Non-Claude runtime or no claudeSessionId — fresh spawn with recovery context
          const recoveryTask = await buildRecoveryTask(session, worktreePath);
          events = runtime.spawn({
            sessionId,
            task: recoveryTask,
            model: session.model,
            workDir: '/workspace',
            containerId,
            customInstructions: copilotInstructions,
            env: secretEnv,
            mcpServers,
          });
        } else {
          // Normal path
          events = runtime.spawn({
            sessionId,
            task: session.task,
            model: session.model,
            workDir: '/workspace',
            containerId,
            customInstructions: copilotInstructions,
            env: secretEnv,
            mcpServers,
          });
        }

        await this.consumeAgentEvents(sessionId, events);

        // Persist rotated OAuth credentials if provider requires it (MAX/PRO token rotation)
        if (providerResult.requiresPostExecPersistence) {
          try {
            await persistRefreshedCredentials(
              containerId,
              containerManager,
              profileStore,
              session.profileName,
              logger,
            );
          } catch (err) {
            logger.warn(
              { err, sessionId },
              'Failed to persist refreshed credentials — session still succeeded',
            );
          }
        }

        await this.handleCompletion(sessionId);
      } catch (err) {
        logger.error({ err, sessionId }, 'Session processing error');
        // Try to transition to failed if possible
        try {
          session = sessionRepo.getOrThrow(sessionId);
          if (!isTerminalState(session.status)) {
            if (canKill(session.status)) {
              transition(session, 'killing');
              session = sessionRepo.getOrThrow(sessionId);
              transition(session, 'killed', { completedAt: new Date().toISOString() });
            }
          }
        } catch {
          /* swallow — best effort */
        }
      }
    },

    async consumeAgentEvents(sessionId: string, events: AsyncIterable<AgentEvent>): Promise<void> {
      startCommitPolling(sessionId);
      try {
        for await (const event of events) {
          eventBus.emit({
            type: 'session.agent_activity',
            timestamp: event.timestamp,
            sessionId,
            event,
          });

          if (event.type === 'escalation') {
            const session = sessionRepo.getOrThrow(sessionId);
            if (session.status === 'running') {
              const escalationPayload = event.payload.payload;
              const escalationSummary =
                'question' in escalationPayload
                  ? escalationPayload.question
                  : 'description' in escalationPayload
                    ? escalationPayload.description
                    : 'Agent requested input';
              emitActivityStatus(
                sessionId,
                `Waiting for human input [${event.escalationType}]: ${escalationSummary}`,
              );
              transition(session, 'awaiting_input', {
                pendingEscalation: event.payload,
                escalationCount: session.escalationCount + 1,
              });
            }
          } else if (event.type === 'plan') {
            sessionRepo.update(sessionId, {
              plan: { summary: event.summary, steps: event.steps },
            });
          } else if (event.type === 'progress') {
            sessionRepo.update(sessionId, {
              progress: {
                phase: event.phase,
                description: event.description,
                currentPhase: event.currentPhase,
                totalPhases: event.totalPhases,
              },
            });
            progressEventRepo?.insert(
              sessionId,
              event.phase,
              event.description,
              event.currentPhase,
              event.totalPhases,
            );
          } else if (event.type === 'task_summary') {
            sessionRepo.update(sessionId, {
              taskSummary: {
                actualSummary: event.actualSummary,
                deviations: event.deviations,
              },
            });
          } else if (
            event.type === 'status' &&
            event.message.includes('Claude session initialized')
          ) {
            // Persist claude session ID to DB for pause/resume survival across daemon restarts
            const match = event.message.match(/\(([^)]+)\)$/);
            if (match?.[1]) {
              sessionRepo.update(sessionId, { claudeSessionId: match[1] });
            }
          } else if (event.type === 'complete' && event.totalInputTokens) {
            sessionRepo.update(sessionId, {
              inputTokens: event.totalInputTokens,
              outputTokens: event.totalOutputTokens ?? 0,
              costUsd: event.costUsd ?? 0,
            });
          } else if (event.type === 'error' && event.fatal) {
            const session = sessionRepo.getOrThrow(sessionId);
            if (session.status === 'running') {
              emitActivityStatus(sessionId, `Agent failed: ${event.message}`);
              transition(session, 'failed', { completedAt: new Date().toISOString() });
            }
            break;
          } else if (event.type === 'tool_use' || event.type === 'file_change') {
            touchHeartbeat(sessionId);
          }
        }
      } finally {
        stopCommitPolling(sessionId);
      }
    },

    async handleCompletion(sessionId: string): Promise<void> {
      const session = sessionRepo.getOrThrow(sessionId);
      // Bail out if session is already past the running stage (could happen when
      // processSession's spawn unblocks after sendMessage already drove completion)
      if (
        isTerminalState(session.status) ||
        session.status === 'killing' ||
        session.status === 'validating' ||
        session.status === 'validated' ||
        session.status === 'failed' ||
        session.status === 'review_required'
      ) {
        return;
      }

      // Sync workspace back to host worktree before any host-side git reads
      let syncSucceeded = true;
      if (session.containerId && session.worktreePath) {
        try {
          const cm = containerManagerFactory.get(session.executionTarget);
          await syncWorkspaceBack(session.containerId, cm);
        } catch (err) {
          syncSucceeded = false;
          logger.warn({ err, sessionId }, 'Failed to sync workspace back to host');
        }
      }

      // Auto-commit any uncommitted changes the agent left behind, then get diff stats.
      // When sync failed, block all deletions (threshold=0) to prevent committing a
      // partially-synced worktree that looks like mass file deletions.
      if (session.worktreePath) {
        try {
          const committed = await worktreeManager.commitPendingChanges(
            session.worktreePath,
            'chore: auto-commit uncommitted agent changes',
            { maxDeletions: syncSucceeded ? 100 : 0 },
          );
          if (committed) {
            logger.info({ sessionId }, 'Auto-committed uncommitted agent changes');
          }
        } catch (err) {
          logger.error({ err, sessionId }, 'Auto-commit blocked by deletion safety guard');
        }

        try {
          const profile = profileStore.get(session.profileName);
          const stats = await worktreeManager.getDiffStats(
            session.worktreePath,
            profile.defaultBranch,
            session.startCommitSha ?? undefined,
          );
          sessionRepo.update(sessionId, {
            filesChanged: stats.filesChanged,
            linesAdded: stats.linesAdded,
            linesRemoved: stats.linesRemoved,
          });
        } catch (err) {
          logger.warn({ err, sessionId }, 'Failed to get diff stats');
        }
      }

      // Skip validation if requested or if agent made no changes
      const refreshed = sessionRepo.getOrThrow(sessionId);
      const noChanges = Boolean(session.worktreePath) && refreshed.filesChanged === 0;
      if (refreshed.skipValidation || noChanges) {
        if (noChanges) {
          logger.info({ sessionId }, 'Skipping validation — no files changed');
          emitActivityStatus(sessionId, 'No files changed — skipping validation');
        }
        transition(refreshed, 'validating');
        const s2 = sessionRepo.getOrThrow(sessionId);
        transition(s2, 'validated');
        return;
      }

      // Trigger validation
      await this.triggerValidation(sessionId);
    },

    async sendMessage(sessionId: string, message: string): Promise<void> {
      const session = sessionRepo.getOrThrow(sessionId);
      if (!canReceiveMessage(session.status)) {
        throw new AutopodError(
          `Session ${sessionId} is not awaiting input (status: ${session.status})`,
          'INVALID_STATE',
          409,
        );
      }

      // ── Validation override responses ─────────────────────────────────
      if (session.pendingEscalation?.type === 'validation_override') {
        const payload = session.pendingEscalation.payload as ValidationOverridePayload;
        const overrides = parseValidationOverrideResponse(message, payload.findings);

        // Resolve the escalation in the DB
        escalationRepo.update(session.pendingEscalation.id, {
          respondedAt: new Date().toISOString(),
          respondedBy: 'human',
          response: message,
        });

        // Merge new overrides into existing session overrides
        const existingOverrides = session.validationOverrides ?? [];
        const mergedOverrides = mergeOverrides(existingOverrides, overrides);
        sessionRepo.update(sessionId, {
          validationOverrides: mergedOverrides,
          pendingEscalation: null,
        });

        const hasGuidance = overrides.some((o) => o.action === 'guidance');

        if (!hasGuidance) {
          // All dismissed — re-run validation with overrides (doesn't burn an attempt)
          emitActivityStatus(sessionId, 'Overrides stored — re-running validation…');
          transition(session, 'running');
          await this.triggerValidation(sessionId);
        } else {
          // Guidance provided — resume agent with human's instructions
          const guidanceText = overrides
            .filter((o) => o.action === 'guidance' && o.guidance)
            .map((o) => `- ${o.description}: ${o.guidance}`)
            .join('\n');

          const correctionMessage = [
            '## Human Reviewer Guidance',
            '',
            'The human reviewer provided the following instructions for recurring findings:',
            '',
            guidanceText,
            '',
            'Please address these items and try again.',
          ].join('\n');

          emitActivityStatus(sessionId, 'Resuming agent with human guidance…');
          transition(session, 'running');

          try {
            const resumeEnv = await getResumeEnv(session);
            const runtime = runtimeRegistry.get(session.runtime);
            if (!session.containerId) throw new Error(`Session ${sessionId} has no container`);
            const events = runtime.resume(
              sessionId,
              correctionMessage,
              session.containerId,
              resumeEnv,
            );
            await this.consumeAgentEvents(sessionId, events);
            await this.handleCompletion(sessionId);
          } catch (err) {
            logger.error({ err, sessionId }, 'Failed to resume agent after override guidance');
            const s = sessionRepo.getOrThrow(sessionId);
            if (!isTerminalState(s.status)) {
              transition(s, 'failed');
            }
            throw err;
          }
        }

        logger.info(
          { sessionId, overrideCount: overrides.length, hasGuidance },
          'Validation override response processed',
        );
        return;
      }

      // ── Normal escalation responses ───────────────────────────────────
      emitActivityStatus(sessionId, 'Human replied — resuming agent…');
      transition(session, 'running', { pendingEscalation: null });

      // If the session was blocked on an ask_human MCP call, resolve the pending request.
      // The container's agent event stream is still active — no need to call runtime.resume().
      const pendingForSession = deps.pendingRequestsBySession?.get(sessionId);
      if (pendingForSession && session.pendingEscalation?.id) {
        const resolved = pendingForSession.resolve(session.pendingEscalation.id, message);
        if (resolved) {
          // The MCP ask_human call has been unblocked — processSession's consumeAgentEvents
          // loop will continue picking up events from the still-running container.
          return;
        }
      }

      emitActivityStatus(sessionId, 'Resuming agent with message…');
      try {
        const resumeEnv = await getResumeEnv(session);
        const runtime = runtimeRegistry.get(session.runtime);
        if (!session.containerId) throw new Error(`Session ${sessionId} has no container`);
        const events = runtime.resume(sessionId, message, session.containerId, resumeEnv);
        await this.consumeAgentEvents(sessionId, events);
        await this.handleCompletion(sessionId);
      } catch (err) {
        logger.error({ err, sessionId }, 'Failed to resume agent after message');
        const s = sessionRepo.getOrThrow(sessionId);
        if (!isTerminalState(s.status)) {
          transition(s, 'failed');
          emitActivityStatus(
            sessionId,
            `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        throw err;
      }
    },

    async approveSession(sessionId: string, options?: { squash?: boolean }): Promise<void> {
      const session = sessionRepo.getOrThrow(sessionId);
      emitActivityStatus(sessionId, 'Approved — merging changes…');
      const s1 = transition(session, 'approved');
      const s2 = transition(s1, 'merging');

      // Merge the PR if one was created, otherwise fall back to branch push
      const approveProfile = profileStore.get(session.profileName);
      const prManager = prManagerFactory ? prManagerFactory(approveProfile) : null;
      if (session.prUrl && prManager && session.worktreePath) {
        emitActivityStatus(sessionId, `Merging PR: ${session.prUrl}`);
        try {
          const mergeResult = await prManager.mergePr({
            worktreePath: session.worktreePath,
            prUrl: session.prUrl,
            squash: options?.squash,
          });

          if (mergeResult.merged) {
            emitActivityStatus(sessionId, 'PR merged successfully');
          } else {
            // Merge didn't complete immediately — enter merge_pending state
            const initialStatus = await prManager.getPrStatus({
              prUrl: session.prUrl,
              worktreePath: session.worktreePath,
            });
            const blockReason = initialStatus.blockReason ?? 'Waiting for merge conditions';
            emitActivityStatus(sessionId, `Merge pending: ${blockReason}`);
            transition(s2, 'merge_pending', { mergeBlockReason: blockReason });
            startMergePolling(sessionId);
            logger.info(
              {
                sessionId,
                prUrl: session.prUrl,
                blockReason,
                autoMerge: mergeResult.autoMergeScheduled,
              },
              'Session approved — merge pending',
            );
            return;
          }
        } catch (err) {
          logger.error({ err, sessionId, prUrl: session.prUrl }, 'Failed to merge PR');
          // Merge command failed — check if the PR is blocked by checks/reviews
          try {
            const fallbackStatus = await prManager.getPrStatus({
              prUrl: session.prUrl,
              worktreePath: session.worktreePath,
            });
            if (fallbackStatus.open && !fallbackStatus.merged) {
              const blockReason =
                fallbackStatus.blockReason ?? 'Merge failed — waiting for conditions';
              emitActivityStatus(sessionId, `Merge pending: ${blockReason}`);
              transition(s2, 'merge_pending', { mergeBlockReason: blockReason });
              startMergePolling(sessionId);
              logger.info(
                { sessionId, prUrl: session.prUrl, blockReason },
                'Merge failed but PR is open — entering merge_pending',
              );
              return;
            }
          } catch (statusErr) {
            logger.warn(
              { err: statusErr, sessionId },
              'Failed to check PR status after merge failure',
            );
          }
          emitActivityStatus(sessionId, 'PR merge failed — session still completing');
        }
      } else if (session.worktreePath) {
        // Fallback: push branch directly (no PR was created)
        emitActivityStatus(sessionId, 'Pushing branch…');
        try {
          const profile = profileStore.get(session.profileName);
          await worktreeManager.mergeBranch({
            worktreePath: session.worktreePath,
            targetBranch: profile.defaultBranch,
          });
          emitActivityStatus(sessionId, 'Branch pushed successfully');
        } catch (err) {
          logger.error({ err, sessionId }, 'Failed to push branch during approval');
          emitActivityStatus(sessionId, 'Branch push failed — session still completing');
        }
      }

      emitActivityStatus(sessionId, 'Session complete');
      transition(s2, 'complete', { completedAt: new Date().toISOString() });

      eventBus.emit({
        type: 'session.completed',
        timestamp: new Date().toISOString(),
        sessionId,
        finalStatus: 'complete',
        summary: {
          id: sessionId,
          profileName: session.profileName,
          task: session.task,
          status: 'complete',
          model: session.model,
          runtime: session.runtime,
          duration: session.startedAt ? Date.now() - new Date(session.startedAt).getTime() : null,
          filesChanged: session.filesChanged,
          createdAt: session.createdAt,
        },
      });

      logger.info({ sessionId, prUrl: session.prUrl }, 'Session approved and completed');
    },

    async rejectSession(sessionId: string, reason?: string): Promise<void> {
      const session = sessionRepo.getOrThrow(sessionId);
      const previousStatus = session.status as 'validated' | 'failed' | 'review_required';

      emitActivityStatus(
        sessionId,
        reason ? `Rejected by human: ${reason}` : 'Rejected by human — resuming agent…',
      );

      // Reset validation attempts — human is giving a fresh chance
      sessionRepo.update(sessionId, {
        validationAttempts: 0,
        lastValidationResult: null,
      });

      // Build rejection feedback message for the agent
      const rejectionMessage = formatFeedback({
        type: 'human_rejection',
        feedback: reason ?? 'Changes rejected. Please try again.',
        task: session.task,
        previousStatus,
        attempt: 0,
        maxAttempts: session.maxValidationAttempts,
      });

      // Transition to running
      transition(session, 'running');

      try {
        if (!session.containerId) throw new Error(`Session ${sessionId} has no container`);

        // Container is stopped post-validation — restart it before resuming the agent
        const cm = containerManagerFactory.get(session.executionTarget);
        await cm.start(session.containerId);
        logger.info(
          { sessionId, containerId: session.containerId },
          'Container restarted for rejection retry',
        );

        // Resume agent with rejection feedback
        const resumeEnv = await getResumeEnv(session);
        const runtime = runtimeRegistry.get(session.runtime);
        const events = runtime.resume(sessionId, rejectionMessage, session.containerId, resumeEnv);
        await this.consumeAgentEvents(sessionId, events);
        await this.handleCompletion(sessionId);
      } catch (err) {
        // Roll back to failed — don't leave the session stuck in 'running' with no agent
        logger.error({ err, sessionId }, 'Failed to resume agent after rejection');
        const s = sessionRepo.getOrThrow(sessionId);
        if (!isTerminalState(s.status)) {
          transition(s, 'failed');
          emitActivityStatus(
            sessionId,
            `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        throw err;
      }

      logger.info(
        { sessionId, reason, previousStatus },
        'Session rejected, resuming agent with feedback',
      );
    },

    async pauseSession(sessionId: string): Promise<void> {
      const session = sessionRepo.getOrThrow(sessionId);
      if (!canPause(session.status)) {
        throw new AutopodError(
          `Cannot pause session ${sessionId} in status ${session.status}`,
          'INVALID_STATE',
          409,
        );
      }

      emitActivityStatus(sessionId, 'Pausing session…');
      // Suspend the runtime (kills stream but preserves session ID)
      const runtime = runtimeRegistry.get(session.runtime);
      await runtime.suspend(sessionId);

      transition(session, 'paused');
      emitActivityStatus(sessionId, 'Session paused — use [t] tell or [u] nudge to resume');
      logger.info({ sessionId }, 'Session paused');
    },

    nudgeSession(sessionId: string, message: string): void {
      const session = sessionRepo.getOrThrow(sessionId);
      if (!canNudge(session.status)) {
        throw new AutopodError(
          `Cannot nudge session ${sessionId} in status ${session.status}`,
          'INVALID_STATE',
          409,
        );
      }

      nudgeRepo.queue(sessionId, message);
      emitActivityStatus(sessionId, `Nudge queued: ${message}`);
      logger.info({ sessionId }, 'Nudge message queued');
    },

    async killSession(sessionId: string): Promise<void> {
      clearPreviewTimer(sessionId);
      stopMergePolling(sessionId);
      const session = sessionRepo.getOrThrow(sessionId);
      if (!canKill(session.status)) {
        throw new AutopodError(
          `Cannot kill session ${sessionId} in status ${session.status}`,
          'INVALID_STATE',
          409,
        );
      }

      emitActivityStatus(sessionId, 'Killing session…');
      transition(session, 'killing');

      // Run cleanup with a timeout so a hung Docker stop or git cleanup
      // can never leave the session stuck in 'killing' forever.
      const KILL_TIMEOUT_MS = 30_000;
      const cleanup = async () => {
        // Kill container
        if (session.containerId) {
          try {
            const cm = containerManagerFactory.get(session.executionTarget);
            await cm.kill(session.containerId);
          } catch (err) {
            logger.warn({ err, sessionId }, 'Failed to kill container');
          }
        }

        // Abort runtime
        try {
          const runtime = runtimeRegistry.get(session.runtime);
          await runtime.abort(sessionId);
        } catch (err) {
          logger.warn({ err, sessionId }, 'Failed to abort runtime');
        }

        // Cleanup worktree
        if (session.worktreePath) {
          try {
            await worktreeManager.cleanup(session.worktreePath);
          } catch (err) {
            logger.warn({ err, sessionId }, 'Failed to cleanup worktree');
          }
        }
      };

      await Promise.race([
        cleanup(),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            logger.warn({ sessionId }, 'Kill cleanup timed out — forcing killed');
            resolve();
          }, KILL_TIMEOUT_MS),
        ),
      ]);

      const killingSession = sessionRepo.getOrThrow(sessionId);
      transition(killingSession, 'killed', { completedAt: new Date().toISOString() });

      eventBus.emit({
        type: 'session.completed',
        timestamp: new Date().toISOString(),
        sessionId,
        finalStatus: 'killed',
        summary: {
          id: sessionId,
          profileName: session.profileName,
          task: session.task,
          status: 'killed',
          model: session.model,
          runtime: session.runtime,
          duration: session.startedAt ? Date.now() - new Date(session.startedAt).getTime() : null,
          filesChanged: session.filesChanged,
          createdAt: session.createdAt,
        },
      });

      logger.info({ sessionId }, 'Session killed');
    },

    async completeSession(sessionId: string): Promise<{ pushError?: string }> {
      const session = sessionRepo.getOrThrow(sessionId);

      if (session.outputMode !== 'workspace') {
        throw new AutopodError(
          'Only workspace sessions can be completed via this endpoint',
          'INVALID_OUTPUT_MODE',
          400,
        );
      }

      if (session.status !== 'running') {
        throw new AutopodError(
          `Cannot complete session in status '${session.status}' — must be 'running'`,
          'INVALID_STATE',
          409,
        );
      }

      // Sync workspace changes back to host worktree before pushing
      let workspaceSyncOk = true;
      if (session.containerId && session.worktreePath) {
        try {
          const cm = containerManagerFactory.get(session.executionTarget);
          await syncWorkspaceBack(session.containerId, cm);
        } catch (err) {
          workspaceSyncOk = false;
          logger.warn({ err, sessionId }, 'Failed to sync workspace before push');
        }
      }

      // Push the branch to origin before completing, then clean up the worktree.
      // Only remove the worktree if push succeeds — don't lose uncommitted work.
      let pushError: string | undefined;
      if (session.worktreePath) {
        try {
          // Pre-commit with tight deletion guard when sync failed, so mergeBranch
          // doesn't blindly commit a partially-synced worktree.
          if (!workspaceSyncOk) {
            await worktreeManager.commitPendingChanges(
              session.worktreePath,
              'chore: auto-commit uncommitted changes before merge',
              { maxDeletions: 0 },
            );
          }
          // mergeBranch auto-commits any remaining uncommitted changes before pushing
          await worktreeManager.mergeBranch({
            worktreePath: session.worktreePath,
            targetBranch: session.branch ?? 'HEAD',
          });
          logger.info({ sessionId, branch: session.branch }, 'Workspace branch pushed to origin');
          // Safe to clean up — work is in origin
          try {
            await worktreeManager.cleanup(session.worktreePath);
            logger.info({ sessionId }, 'Workspace worktree cleaned up');
          } catch (err) {
            logger.warn({ err, sessionId }, 'Failed to cleanup workspace worktree');
          }
        } catch (err) {
          pushError = err instanceof Error ? err.message : String(err);
          logger.warn(
            { err, sessionId },
            'Failed to push workspace branch — completing anyway, worktree preserved',
          );
        }
      }

      emitActivityStatus(sessionId, 'Session complete');
      transition(session, 'complete', { completedAt: new Date().toISOString() });

      // Deactivate PIM groups on session completion
      if (session.pimGroups?.length && session.userId) {
        try {
          const { createPimClient } = await import('../actions/handlers/azure-pim-handler.js');
          const pimClient = createPimClient(deps.getSecret, logger);
          for (const group of session.pimGroups) {
            try {
              await pimClient.deactivate(group.groupId, session.userId);
              logger.info({ sessionId, groupId: group.groupId }, 'PIM group deactivated');
            } catch (err) {
              logger.warn(
                { err, sessionId, groupId: group.groupId },
                'PIM deactivation failed — continuing',
              );
            }
          }
        } catch (err) {
          logger.warn({ err, sessionId }, 'Failed to load PIM client for deactivation');
        }
      }

      eventBus.emit({
        type: 'session.completed',
        timestamp: new Date().toISOString(),
        sessionId,
        finalStatus: 'complete',
        summary: {
          id: sessionId,
          profileName: session.profileName,
          task: session.task,
          status: 'complete',
          model: session.model,
          runtime: session.runtime,
          duration: session.startedAt ? Date.now() - new Date(session.startedAt).getTime() : null,
          filesChanged: session.filesChanged,
          createdAt: session.createdAt,
        },
      });

      // Auto-revalidate linked worker session if this workspace was a fix
      if (session.linkedSessionId && !pushError) {
        try {
          const linked = sessionRepo.getOrThrow(session.linkedSessionId);
          if (linked.status === 'failed' || linked.status === 'review_required') {
            logger.info(
              { workspaceId: sessionId, workerId: session.linkedSessionId },
              'Workspace completed — auto-revalidating linked worker',
            );
            emitActivityStatus(
              session.linkedSessionId,
              `Linked workspace ${sessionId} completed — pulling changes and revalidating…`,
            );
            // Fire and forget — don't block workspace completion on revalidation
            this.revalidateSession(session.linkedSessionId).catch((err) => {
              logger.warn(
                { err, workspaceId: sessionId, workerId: session.linkedSessionId },
                'Auto-revalidation of linked worker failed',
              );
            });
          }
        } catch (err) {
          logger.warn(
            { err, sessionId, linkedSessionId: session.linkedSessionId },
            'Failed to check linked session for auto-revalidation',
          );
        }
      }

      logger.info({ sessionId, pushError }, 'Workspace session completed');
      return { pushError };
    },

    async triggerValidation(sessionId: string, options?: { force?: boolean }): Promise<void> {
      const session = sessionRepo.getOrThrow(sessionId);
      const force = options?.force ?? false;

      // When force-reworking from a terminal state, re-provision the session from scratch
      // instead of trying to restart a potentially stale container. Docker Desktop's VirtioFS
      // mounts can break after long idle periods, making the old container unreachable.
      const fromTerminal =
        session.status === 'failed' ||
        session.status === 'review_required' ||
        session.status === 'killed' ||
        session.status === 'validated';
      if (force && fromTerminal && session.worktreePath) {
        emitActivityStatus(sessionId, 'Re-provisioning session with fresh container…');

        // Kill the old container (best-effort — it may already be dead)
        if (session.containerId) {
          try {
            const cm = containerManagerFactory.get(session.executionTarget);
            await cm.kill(session.containerId);
          } catch {
            // Container may already be removed — that's fine
          }
        }

        // Re-queue through processSession with recovery worktree.
        // Clear claudeSessionId so the agent gets a fresh spawn instead of resuming
        // a stale/broken session context. Set reworkReason so processSession builds
        // a rework-specific prompt instead of the generic "you were interrupted" recovery prompt.
        const reworkReason =
          session.status === 'failed'
            ? 'Your previous attempt failed. Review what went wrong and try again.'
            : session.status === 'review_required'
              ? 'Your previous attempt exhausted its validation attempts. Review what went wrong and try again with extended attempts.'
              : session.status === 'killed'
                ? 'Your previous session was killed. Start the task fresh.'
                : 'Your previous work needs revision. Review and improve it.';
        sessionRepo.update(sessionId, {
          validationAttempts: 0,
          lastValidationResult: null,
          containerId: null,
          claudeSessionId: null,
          recoveryWorktreePath: session.worktreePath,
          reworkReason,
        });
        transition(session, 'queued');
        enqueueSession(sessionId);

        logger.info(
          { sessionId, worktreePath: session.worktreePath, reworkReason },
          'Rework: re-queued with fresh container provisioning',
        );
        return;
      }

      const profile = profileStore.get(session.profileName);

      // Reset attempt counter when re-validating from a terminal/failed/validated state
      if (fromTerminal) {
        sessionRepo.update(sessionId, { validationAttempts: 0 });
      }

      const s1 = transition(session, 'validating');
      const attempt = (fromTerminal ? 0 : s1.validationAttempts) + 1;
      sessionRepo.update(sessionId, { validationAttempts: attempt });

      eventBus.emit({
        type: 'session.validation_started',
        timestamp: new Date().toISOString(),
        sessionId,
        attempt,
      });

      emitActivityStatus(sessionId, `Starting validation (attempt ${attempt})…`);

      try {
        if (!session.containerId) {
          throw new Error(`Session ${sessionId} has no container — cannot validate`);
        }

        // Restart the container if it was stopped (e.g. after max attempts exhausted)
        if (force) {
          const cm = containerManagerFactory.get(session.executionTarget);
          await cm.start(session.containerId);
        }

        // Sync workspace back before reading diff/commit log from host worktree
        if (session.worktreePath) {
          try {
            const cm = containerManagerFactory.get(session.executionTarget);
            await syncWorkspaceBack(session.containerId, cm);
          } catch (err) {
            logger.warn({ err, sessionId }, 'Failed to sync workspace before validation');
          }
        }

        // Get the actual diff and commit log for AI task review.
        // Scope to agent's commits using startCommitSha so prior branch history is excluded.
        const [diff, commitLog] = session.worktreePath
          ? await Promise.all([
              worktreeManager.getDiff(
                session.worktreePath,
                profile.defaultBranch,
                undefined,
                session.startCommitSha ?? undefined,
              ),
              worktreeManager.getCommitLog(
                session.worktreePath,
                profile.defaultBranch,
                undefined,
                session.startCommitSha ?? undefined,
              ),
            ])
          : ['', ''];

        // Try to load a repo-specific code-review skill from the worktree
        const codeReviewSkill = session.worktreePath
          ? await loadCodeReviewSkill(session.worktreePath, logger)
          : undefined;

        const validationConfig = {
          sessionId,
          containerId: session.containerId,
          previewUrl: session.previewUrl ?? `http://127.0.0.1:${CONTAINER_APP_PORT}`,
          containerBaseUrl: `http://127.0.0.1:${CONTAINER_APP_PORT}`,
          buildCommand: profile.buildCommand,
          startCommand: profile.startCommand,
          healthPath: profile.healthPath,
          healthTimeout: profile.healthTimeout,
          smokePages: profile.smokePages,
          attempt,
          task: session.task,
          diff,
          testCommand: profile.testCommand,
          buildTimeout: profile.buildTimeout * 1_000,
          testTimeout: profile.testTimeout * 1_000,
          reviewerModel: profile.escalation.askAi.model || profile.defaultModel || 'sonnet',
          acceptanceCriteria: session.acceptanceCriteria ?? undefined,
          codeReviewSkill,
          commitLog: commitLog || undefined,
          plan: session.plan ?? undefined,
          taskSummary: session.taskSummary ?? undefined,
          worktreePath: session.worktreePath ?? undefined,
          startCommitSha: session.startCommitSha ?? undefined,
          overrides: session.validationOverrides ?? undefined,
        };

        let result: Awaited<ReturnType<typeof validationEngine.validate>>;
        try {
          result = await validationEngine.validate(validationConfig, (phase) =>
            emitActivityStatus(sessionId, phase),
          );
        } catch (validateErr) {
          // Treat unexpected validation errors as a failed result so retry logic still applies
          logger.error(
            { err: validateErr, sessionId, attempt },
            'Validation engine threw unexpectedly',
          );
          result = {
            sessionId,
            attempt,
            timestamp: new Date().toISOString(),
            overall: 'fail',
            smoke: {
              status: 'fail',
              build: { status: 'fail', output: String(validateErr), duration: 0 },
              health: { status: 'fail', url: '', responseCode: null, duration: 0 },
              pages: [],
            },
            taskReview: null,
            duration: 0,
          };
        }

        // Sync workspace after validation — screenshots and build artifacts are now in /workspace
        if (session.worktreePath) {
          try {
            const cm = containerManagerFactory.get(session.executionTarget);
            await syncWorkspaceBack(session.containerId, cm);
          } catch (err) {
            logger.warn({ err, sessionId }, 'Failed to sync workspace after validation');
          }
        }

        // Collect screenshots from the host worktree
        if (session.worktreePath && result.smoke.pages.length > 0) {
          try {
            const screenshots = await collectScreenshots(session.worktreePath, result.smoke.pages);
            // Enrich page results with base64 data for Teams notifications
            for (const ss of screenshots) {
              const page = result.smoke.pages.find((p) => p.path === ss.pagePath);
              if (page) {
                page.screenshotBase64 = ss.base64;
              }
            }
            logger.info(
              { sessionId, count: screenshots.length },
              'Collected validation screenshots',
            );
          } catch (err) {
            logger.warn({ err, sessionId }, 'Failed to collect screenshots');
          }
        }

        sessionRepo.update(sessionId, { lastValidationResult: result });

        // Persist every attempt to validation history
        validationRepo?.insert(sessionId, attempt, result);

        eventBus.emit({
          type: 'session.validation_completed',
          timestamp: new Date().toISOString(),
          sessionId,
          result,
        });

        const s2 = sessionRepo.getOrThrow(sessionId);

        // Session may have been killed while validation was running — bail out
        if (isTerminalState(s2.status) || s2.status === 'killing') {
          logger.info(
            { sessionId, status: s2.status },
            'Session killed during validation, skipping post-validation',
          );
          return;
        }

        // Emit detailed validation result
        const buildStatus = result.smoke.build.status;
        const healthStatus = result.smoke.health.status;
        const acStatus = result.acValidation?.status ?? 'skip';
        const reviewStatus = result.taskReview?.status ?? 'skip';
        emitActivityStatus(
          sessionId,
          `Validation ${result.overall} — build: ${buildStatus}, health: ${healthStatus}, ac: ${acStatus}, review: ${reviewStatus}`,
        );

        // Surface review feedback so the user can see why it failed
        if (result.taskReview && result.taskReview.status !== 'pass') {
          if (result.taskReview.reasoning) {
            emitActivityStatus(sessionId, `Review: ${result.taskReview.reasoning}`);
          }
          for (const issue of result.taskReview.issues) {
            emitActivityStatus(sessionId, `  → ${issue}`);
          }
        }

        // ── Validation overrides: apply existing dismissals, detect recurring findings ──
        let effectiveResult = result;
        if (s2.validationOverrides && s2.validationOverrides.length > 0) {
          effectiveResult = applyOverrides(result, s2.validationOverrides);
          if (effectiveResult.overall !== result.overall) {
            logger.info(
              {
                sessionId,
                originalOverall: result.overall,
                patchedOverall: effectiveResult.overall,
              },
              'Validation overrides changed overall result',
            );
            emitActivityStatus(sessionId, 'Human overrides applied — re-evaluated result');
          }
        }

        // Detect recurring findings and auto-hoist / escalate to human
        if (effectiveResult.overall === 'fail' && attempt >= 2) {
          const previousValidations = validationRepo?.getForSession(sessionId);
          const previousResult = previousValidations
            ?.filter((v) => v.attempt < attempt)
            ?.sort((a, b) => b.attempt - a.attempt)?.[0]?.result;

          if (previousResult) {
            const currentFindings = extractFindings(effectiveResult);
            const previousFindings = extractFindings(previousResult);
            const recurring = detectRecurringFindings(currentFindings, previousFindings);

            if (recurring.length > 0) {
              logger.info(
                { sessionId, recurringCount: recurring.length, attempt },
                'Recurring validation findings detected',
              );
              emitActivityStatus(
                sessionId,
                `${recurring.length} recurring finding(s) detected — auto-hoisting to deeper review tier`,
              );

              // Auto-hoist: re-run task review at Tier 2+ (deep) to get a second opinion.
              // Only re-runs the AI review, not build/health/smoke (those are objective).
              let hoistedResult: typeof effectiveResult | null = null;
              try {
                hoistedResult = await validationEngine.validate(
                  { ...validationConfig, reviewDepth: 'deep' },
                  (phase) => emitActivityStatus(sessionId, phase),
                );
                if (s2.validationOverrides && s2.validationOverrides.length > 0) {
                  hoistedResult = applyOverrides(hoistedResult, s2.validationOverrides);
                }
              } catch (err) {
                logger.warn({ err, sessionId }, 'Auto-hoist deeper review failed');
              }

              if (hoistedResult && hoistedResult.overall === 'pass') {
                // Deeper review resolved the false positives — use the hoisted result
                effectiveResult = hoistedResult;
                emitActivityStatus(
                  sessionId,
                  'Deeper review tier passed — overriding Tier 1 result',
                );
                logger.info({ sessionId }, 'Auto-hoist resolved recurring findings');
                // Update stored result with the hoisted one
                sessionRepo.update(sessionId, { lastValidationResult: hoistedResult });
                validationRepo?.insert(sessionId, attempt, hoistedResult);
              } else {
                // Deeper review still flags same findings — escalate to human
                const hoistedFindings = hoistedResult
                  ? extractFindings(hoistedResult)
                  : currentFindings;
                const stillRecurring = detectRecurringFindings(hoistedFindings, previousFindings);

                if (stillRecurring.length > 0) {
                  emitActivityStatus(
                    sessionId,
                    `Deeper review still flagged ${stillRecurring.length} recurring finding(s) — escalating to human`,
                  );

                  const escalation: EscalationRequest = {
                    id: generateId(12),
                    sessionId,
                    type: 'validation_override',
                    timestamp: new Date().toISOString(),
                    payload: {
                      findings: stillRecurring,
                      attempt,
                      maxAttempts: s2.maxValidationAttempts,
                    },
                    response: null,
                  };

                  escalationRepo.insert(escalation);
                  sessionRepo.update(sessionId, {
                    pendingEscalation: escalation,
                    escalationCount: s2.escalationCount + 1,
                  });
                  transition(s2, 'awaiting_input');

                  logger.info(
                    { sessionId, escalationId: escalation.id, findingCount: stillRecurring.length },
                    'Validation override escalation created — waiting for human',
                  );
                  return; // Wait for human response via sendMessage()
                }
                // No recurring after hoist — fall through to normal retry/fail path
              }
            }
          }
        }

        if (effectiveResult.overall === 'pass') {
          emitActivityStatus(sessionId, `Validation passed (attempt ${attempt})`);
          // Push branch and create PR before transitioning to validated
          let prUrl: string | null = null;
          const prManager = prManagerFactory ? prManagerFactory(profile) : null;
          if (prManager && s2.worktreePath) {
            // Commit screenshots to the branch so they're visible in the PR
            try {
              await worktreeManager.commitFiles(
                s2.worktreePath,
                ['.autopod/screenshots'],
                'chore: add validation screenshots',
              );
            } catch (err) {
              logger.warn({ err, sessionId }, 'Failed to commit screenshots');
            }

            // Push branch so `gh pr create --head` can reference it
            try {
              await worktreeManager.mergeBranch({
                worktreePath: s2.worktreePath,
                targetBranch: profile.defaultBranch,
              });
            } catch (err) {
              logger.warn({ err, sessionId }, 'Failed to push branch for PR');
            }

            // Re-compute diff stats now that auto-commit has run
            try {
              const stats = await worktreeManager.getDiffStats(
                s2.worktreePath,
                profile.defaultBranch,
                s2.startCommitSha ?? undefined,
              );
              sessionRepo.update(sessionId, {
                filesChanged: stats.filesChanged,
                linesAdded: stats.linesAdded,
                linesRemoved: stats.linesRemoved,
              });
            } catch (err) {
              logger.warn({ err, sessionId }, 'Failed to recompute diff stats after merge');
            }

            // Build screenshot URLs for the PR body
            const screenshotRefs = result.smoke.pages
              .filter((p) => p.screenshotPath)
              .map((p) => ({
                pagePath: p.path,
                imageUrl: buildGitHubImageUrl(
                  profile.repoUrl,
                  s2.branch,
                  p.screenshotPath.replace(/^\/workspace\//, ''),
                ),
              }));

            try {
              emitActivityStatus(sessionId, 'Creating PR…');
              const s3 = sessionRepo.getOrThrow(sessionId);
              prUrl = await prManager.createPr({
                worktreePath: s2.worktreePath,
                repoUrl: profile.repoUrl,
                branch: s2.branch,
                baseBranch: profile.defaultBranch,
                sessionId,
                task: s2.task,
                profileName: s2.profileName,
                validationResult: result,
                filesChanged: s3.filesChanged,
                linesAdded: s3.linesAdded,
                linesRemoved: s3.linesRemoved,
                previewUrl: s2.previewUrl,
                screenshots: screenshotRefs,
                taskSummary: s3.taskSummary ?? undefined,
              });
              if (prUrl) {
                emitActivityStatus(sessionId, `PR created: ${prUrl}`);
              }
            } catch (err) {
              logger.warn({ err, sessionId }, 'Failed to create PR — session still validated');
              emitActivityStatus(sessionId, 'PR creation failed — session still validated');
            }
          }

          sessionRepo.update(sessionId, { lastCorrectionMessage: null });
          transition(s2, 'validated', { prUrl });

          // Stop the container (not remove) so it can be restarted for preview
          if (s2.containerId) {
            try {
              const cm = containerManagerFactory.get(s2.executionTarget);
              await cm.stop(s2.containerId);
              logger.info({ sessionId }, 'Container stopped post-validation');
            } catch (err) {
              logger.warn({ err, sessionId }, 'Failed to stop container post-validation');
            }
          }
        } else if (force || attempt < s2.maxValidationAttempts) {
          emitActivityStatus(
            sessionId,
            `Validation failed (attempt ${attempt}/${s2.maxValidationAttempts}) — retrying`,
          );
          // Build correction message with structured feedback for the agent
          emitActivityStatus(sessionId, 'Sending validation feedback to agent…');
          const cm = containerManagerFactory.get(s2.executionTarget);
          const correctionMessage = await buildCorrectionMessage(s2, profile, result, cm);
          sessionRepo.update(sessionId, { lastCorrectionMessage: correctionMessage });

          // Transition back to running for retry
          transition(s2, 'running');

          // Resume the agent with correction feedback
          emitActivityStatus(sessionId, 'Agent working on fixes…');
          const resumeEnv = await getResumeEnv(s2);
          const runtime = runtimeRegistry.get(s2.runtime);
          if (!s2.containerId) throw new Error(`Session ${sessionId} has no container`);
          const events = runtime.resume(sessionId, correctionMessage, s2.containerId, resumeEnv);
          await this.consumeAgentEvents(sessionId, events);
          emitActivityStatus(sessionId, 'Agent finished applying fixes');
          await this.handleCompletion(sessionId);

          logger.info(
            {
              sessionId,
              attempt,
              maxAttempts: s2.maxValidationAttempts,
            },
            'Retrying after validation failure',
          );
        } else {
          emitActivityStatus(
            sessionId,
            `Validation failed — max attempts (${s2.maxValidationAttempts}) exhausted, needs review`,
          );
          transition(s2, 'review_required');

          // Stop the container (not remove) so it can be restarted for preview
          if (s2.containerId) {
            try {
              const cm = containerManagerFactory.get(s2.executionTarget);
              await cm.stop(s2.containerId);
              logger.info({ sessionId }, 'Container stopped after max validation attempts');
            } catch (stopErr) {
              logger.warn({ err: stopErr, sessionId }, 'Failed to stop container post-validation');
            }
          }
        }
      } catch (err) {
        logger.error({ err, sessionId }, 'Validation error');
        const s2 = sessionRepo.getOrThrow(sessionId);
        transition(s2, 'failed');

        // Stop the container (not remove) so it can be restarted for preview
        if (s2.containerId) {
          try {
            const cm = containerManagerFactory.get(s2.executionTarget);
            await cm.stop(s2.containerId);
          } catch (stopErr) {
            logger.warn({ err: stopErr, sessionId }, 'Failed to stop container post-validation');
          }
        }
      }
    },

    async revalidateSession(
      sessionId: string,
    ): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }> {
      const session = sessionRepo.getOrThrow(sessionId);
      if (session.status !== 'failed' && session.status !== 'review_required') {
        throw new AutopodError(
          `Cannot revalidate session ${sessionId} in status ${session.status} — only failed or review_required sessions can be revalidated`,
          'INVALID_STATE',
          409,
        );
      }
      if (!session.worktreePath) {
        throw new AutopodError(
          `Session ${sessionId} has no worktree — cannot pull latest`,
          'INVALID_STATE',
          400,
        );
      }

      // Pull latest from remote branch (human may have pushed fixes)
      emitActivityStatus(sessionId, 'Pulling latest changes from remote branch…');
      const { newCommits } = await worktreeManager.pullBranch(session.worktreePath);

      if (!newCommits) {
        logger.info({ sessionId }, 'No new commits on branch — skipping revalidation');
        emitActivityStatus(sessionId, 'No new commits found — nothing to revalidate');
        return { newCommits: false, result: 'fail' };
      }

      logger.info({ sessionId }, 'New commits found — running revalidation');
      emitActivityStatus(sessionId, 'New commits detected — starting revalidation…');

      // Reset validation attempts for the fresh human-driven validation
      sessionRepo.update(sessionId, { validationAttempts: 0 });

      // Transition to validating
      transition(session, 'validating');

      // Re-run validation (force=true restarts container, but we don't want agent retry on failure)
      const profile = profileStore.get(session.profileName);
      const attempt = 1;
      sessionRepo.update(sessionId, { validationAttempts: attempt });

      emitActivityStatus(sessionId, 'Starting revalidation (human fix)…');

      try {
        if (!session.containerId) {
          throw new Error(`Session ${sessionId} has no container — cannot validate`);
        }

        // Restart the container with updated worktree
        const cm = containerManagerFactory.get(session.executionTarget);
        await cm.start(session.containerId);

        const [diff, commitLog] = session.worktreePath
          ? await Promise.all([
              worktreeManager.getDiff(
                session.worktreePath,
                profile.defaultBranch,
                undefined,
                session.startCommitSha ?? undefined,
              ),
              worktreeManager.getCommitLog(
                session.worktreePath,
                profile.defaultBranch,
                undefined,
                session.startCommitSha ?? undefined,
              ),
            ])
          : ['', ''];

        const codeReviewSkill = session.worktreePath
          ? await loadCodeReviewSkill(session.worktreePath, logger)
          : undefined;

        let result: Awaited<ReturnType<typeof validationEngine.validate>>;
        try {
          result = await validationEngine.validate(
            {
              sessionId,
              containerId: session.containerId,
              previewUrl: session.previewUrl ?? `http://127.0.0.1:${CONTAINER_APP_PORT}`,
              containerBaseUrl: `http://127.0.0.1:${CONTAINER_APP_PORT}`,
              buildCommand: profile.buildCommand,
              startCommand: profile.startCommand,
              healthPath: profile.healthPath,
              healthTimeout: profile.healthTimeout,
              smokePages: profile.smokePages,
              attempt,
              task: session.task,
              diff,
              testCommand: profile.testCommand,
              buildTimeout: profile.buildTimeout * 1_000,
              testTimeout: profile.testTimeout * 1_000,
              reviewerModel: profile.escalation.askAi.model || profile.defaultModel || 'sonnet',
              acceptanceCriteria: session.acceptanceCriteria ?? undefined,
              codeReviewSkill,
              commitLog: commitLog || undefined,
              plan: session.plan ?? undefined,
              taskSummary: session.taskSummary ?? undefined,
              worktreePath: session.worktreePath ?? undefined,
              startCommitSha: session.startCommitSha ?? undefined,
            },
            (phase) => emitActivityStatus(sessionId, phase),
          );
        } catch (validateErr) {
          logger.error({ err: validateErr, sessionId }, 'Revalidation engine threw unexpectedly');
          result = {
            sessionId,
            attempt,
            timestamp: new Date().toISOString(),
            overall: 'fail',
            smoke: {
              status: 'fail',
              build: { status: 'fail', output: String(validateErr), duration: 0 },
              health: { status: 'fail', url: '', responseCode: null, duration: 0 },
              pages: [],
            },
            taskReview: null,
            duration: 0,
          };
        }

        sessionRepo.update(sessionId, { lastValidationResult: result });
        validationRepo?.insert(sessionId, attempt, result);

        eventBus.emit({
          type: 'session.validation_completed',
          timestamp: new Date().toISOString(),
          sessionId,
          result,
        });

        const s2 = sessionRepo.getOrThrow(sessionId);

        if (isTerminalState(s2.status) || s2.status === 'killing') {
          return { newCommits: true, result: 'fail' };
        }

        if (result.overall === 'pass') {
          emitActivityStatus(sessionId, 'Revalidation passed — human fix worked!');

          // Push branch and create PR (same as triggerValidation pass path)
          let prUrl: string | null = null;
          const prManager = prManagerFactory ? prManagerFactory(profile) : null;
          if (prManager && s2.worktreePath) {
            try {
              await worktreeManager.commitFiles(
                s2.worktreePath,
                ['.autopod/screenshots'],
                'chore: add validation screenshots',
              );
            } catch (err) {
              logger.warn({ err, sessionId }, 'Failed to commit screenshots');
            }

            try {
              await worktreeManager.mergeBranch({
                worktreePath: s2.worktreePath,
                targetBranch: profile.defaultBranch,
              });
            } catch (err) {
              logger.warn({ err, sessionId }, 'Failed to push branch for PR');
            }

            try {
              const stats = await worktreeManager.getDiffStats(
                s2.worktreePath,
                profile.defaultBranch,
                s2.startCommitSha ?? undefined,
              );
              sessionRepo.update(sessionId, {
                filesChanged: stats.filesChanged,
                linesAdded: stats.linesAdded,
                linesRemoved: stats.linesRemoved,
              });
            } catch (err) {
              logger.warn({ err, sessionId }, 'Failed to recompute diff stats');
            }

            try {
              emitActivityStatus(sessionId, 'Creating PR…');
              const s3 = sessionRepo.getOrThrow(sessionId);
              prUrl = await prManager.createPr({
                worktreePath: s2.worktreePath,
                repoUrl: profile.repoUrl,
                branch: s2.branch,
                baseBranch: profile.defaultBranch,
                sessionId,
                task: s2.task,
                profileName: s2.profileName,
                validationResult: result,
                filesChanged: s3.filesChanged,
                linesAdded: s3.linesAdded,
                linesRemoved: s3.linesRemoved,
                previewUrl: s2.previewUrl,
                screenshots: [],
                taskSummary: s3.taskSummary ?? undefined,
              });
              if (prUrl) emitActivityStatus(sessionId, `PR created: ${prUrl}`);
            } catch (err) {
              logger.warn({ err, sessionId }, 'Failed to create PR — session still validated');
              emitActivityStatus(sessionId, 'PR creation failed — session still validated');
            }
          }

          transition(s2, 'validated', { prUrl });

          // Stop the container
          if (s2.containerId) {
            try {
              const cm2 = containerManagerFactory.get(s2.executionTarget);
              await cm2.stop(s2.containerId);
            } catch (err) {
              logger.warn({ err, sessionId }, 'Failed to stop container post-revalidation');
            }
          }

          return { newCommits: true, result: 'pass' };
        }

        // Validation failed — stay in failed state, no agent rework
        const buildStatus2 = result.smoke.build.status;
        const healthStatus2 = result.smoke.health.status;
        const acStatus2 = result.acValidation?.status ?? 'skip';
        const reviewStatus2 = result.taskReview?.status ?? 'skip';
        emitActivityStatus(
          sessionId,
          `Revalidation fail — build: ${buildStatus2}, health: ${healthStatus2}, ac: ${acStatus2}, review: ${reviewStatus2}`,
        );
        if (result.taskReview && result.taskReview.status !== 'pass') {
          if (result.taskReview.reasoning) {
            emitActivityStatus(sessionId, `Review: ${result.taskReview.reasoning}`);
          }
          for (const issue of result.taskReview.issues) {
            emitActivityStatus(sessionId, `  → ${issue}`);
          }
        }
        emitActivityStatus(sessionId, 'Revalidation failed — human fix did not resolve all issues');
        transition(s2, 'failed');

        if (s2.containerId) {
          try {
            const cm2 = containerManagerFactory.get(s2.executionTarget);
            await cm2.stop(s2.containerId);
          } catch (err) {
            logger.warn({ err, sessionId }, 'Failed to stop container post-revalidation');
          }
        }

        return { newCommits: true, result: 'fail' };
      } catch (err) {
        logger.error({ err, sessionId }, 'Revalidation error');
        const s2 = sessionRepo.getOrThrow(sessionId);
        transition(s2, 'failed');
        return { newCommits: true, result: 'fail' };
      }
    },

    fixManually(sessionId: string, userId: string): Promise<Session> {
      const worker = sessionRepo.getOrThrow(sessionId);
      if (
        worker.status !== 'failed' &&
        worker.status !== 'review_required' &&
        worker.status !== 'validated'
      ) {
        throw new AutopodError(
          `Cannot fix session ${sessionId} in status ${worker.status} — only failed, review_required, or validated sessions`,
          'INVALID_STATE',
          409,
        );
      }

      // Create a workspace session on the same branch, linked to the failed worker
      const workspace = this.createSession(
        {
          profileName: worker.profileName,
          task: `Human fix for failed session ${worker.id}: ${worker.task}`,
          branch: worker.branch,
          outputMode: 'workspace',
          baseBranch: worker.baseBranch ?? undefined,
          linkedSessionId: worker.id,
        },
        userId,
      );

      logger.info(
        { workerId: sessionId, workspaceId: workspace.id },
        'Created linked workspace for human fix',
      );
      emitActivityStatus(sessionId, `Human fix workspace created: ${workspace.id}`);

      return workspace;
    },

    notifyEscalation(sessionId: string, escalation: EscalationRequest): void {
      const session = sessionRepo.getOrThrow(sessionId);
      if (session.status === 'running') {
        transition(session, 'awaiting_input', {
          pendingEscalation: escalation,
          escalationCount: session.escalationCount + 1,
        });
      }
    },

    touchHeartbeat,

    async deleteSession(sessionId: string): Promise<void> {
      clearPreviewTimer(sessionId);
      const session = sessionRepo.getOrThrow(sessionId);
      const deletable =
        isTerminalState(session.status) ||
        session.status === 'failed' ||
        session.status === 'review_required' ||
        session.status === 'killing';
      if (!deletable) {
        throw new AutopodError(
          `Cannot delete session ${sessionId} in status ${session.status} — kill it first`,
          'INVALID_STATE',
          409,
        );
      }

      // Clean up container if still present
      if (session.containerId) {
        try {
          const cm = containerManagerFactory.get(session.executionTarget);
          await cm.kill(session.containerId);
        } catch (err) {
          logger.warn({ err, sessionId }, 'Failed to kill container during delete');
        }
      }

      // Clean up worktree if still present
      if (session.worktreePath) {
        try {
          await worktreeManager.cleanup(session.worktreePath);
        } catch (err) {
          logger.warn({ err, sessionId }, 'Failed to cleanup worktree during delete');
        }
      }

      sessionRepo.delete(sessionId);
      logger.info({ sessionId }, 'Session deleted');
    },

    async startPreview(sessionId: string): Promise<{ previewUrl: string }> {
      const session = sessionRepo.getOrThrow(sessionId);

      if (!session.containerId) {
        throw new AutopodError(
          `Session ${sessionId} has no container — cannot start preview`,
          'INVALID_STATE',
          409,
        );
      }

      if (!session.previewUrl) {
        throw new AutopodError(`Session ${sessionId} has no preview URL`, 'INVALID_STATE', 409);
      }

      const cm = containerManagerFactory.get(session.executionTarget);
      const status = await cm.getStatus(session.containerId);

      if (status === 'running') {
        // Already running — idempotent, just reset the auto-stop timer
        schedulePreviewAutoStop(sessionId, session.containerId, session.executionTarget);
        return { previewUrl: session.previewUrl };
      }

      if (status === 'unknown') {
        throw new AutopodError(
          `Container for session ${sessionId} has been removed — cannot start preview`,
          'INVALID_STATE',
          409,
        );
      }

      // Container is stopped — start it
      await cm.start(session.containerId);

      // Re-run the start command and wait for health check
      const profile = profileStore.get(session.profileName);
      if (profile.startCommand) {
        cm.execInContainer(session.containerId, ['sh', '-c', `${profile.startCommand} &`], {
          cwd: '/workspace',
        }).catch((err) => {
          logger.warn(
            { err, sessionId },
            'Preview start command errored (may be expected for long-running processes)',
          );
        });

        // Poll for health
        const healthUrl = session.previewUrl + profile.healthPath;
        const timeoutMs = (profile.healthTimeout ?? 30) * 1_000;
        const pollIntervalMs = 2_000;
        const start = Date.now();

        while (Date.now() - start < timeoutMs) {
          try {
            const response = await fetch(healthUrl, {
              signal: AbortSignal.timeout(5_000),
            });
            if (response.status === 200) {
              logger.info({ sessionId, healthUrl }, 'Preview health check passed');
              break;
            }
          } catch {
            // Health check not ready yet
          }
          const remaining = timeoutMs - (Date.now() - start);
          if (remaining > 0) {
            await new Promise<void>((r) => setTimeout(r, Math.min(pollIntervalMs, remaining)));
          }
        }
      }

      schedulePreviewAutoStop(sessionId, session.containerId, session.executionTarget);
      logger.info({ sessionId, previewUrl: session.previewUrl }, 'Preview started');
      return { previewUrl: session.previewUrl };
    },

    async stopPreview(sessionId: string): Promise<void> {
      clearPreviewTimer(sessionId);
      const session = sessionRepo.getOrThrow(sessionId);

      if (!session.containerId) {
        throw new AutopodError(
          `Session ${sessionId} has no container — cannot stop preview`,
          'INVALID_STATE',
          409,
        );
      }

      const cm = containerManagerFactory.get(session.executionTarget);
      await cm.stop(session.containerId);
      logger.info({ sessionId }, 'Preview stopped');
    },

    getSession(sessionId: string): Session {
      return sessionRepo.getOrThrow(sessionId);
    },

    listSessions(filters?) {
      return sessionRepo.list(filters);
    },

    getSessionStats(filters?) {
      return sessionRepo.getStats(filters);
    },

    getValidationHistory(sessionId: string) {
      // Verify session exists
      sessionRepo.getOrThrow(sessionId);
      return validationRepo?.getForSession(sessionId) ?? [];
    },

    async approveAllValidated(): Promise<{ approved: string[] }> {
      const validated = sessionRepo.list({ status: 'validated' });
      const approved: string[] = [];
      for (const session of validated) {
        try {
          await this.approveSession(session.id);
          approved.push(session.id);
        } catch (err) {
          logger.warn({ err, sessionId: session.id }, 'Failed to approve session in bulk');
        }
      }
      return { approved };
    },

    async killAllFailed(): Promise<{ killed: string[] }> {
      const failed = sessionRepo.list({ status: 'failed' });
      const killed: string[] = [];
      for (const session of failed) {
        try {
          await this.killSession(session.id);
          killed.push(session.id);
        } catch (err) {
          logger.warn({ err, sessionId: session.id }, 'Failed to kill session in bulk');
        }
      }
      return { killed };
    },

    async extendAttempts(sessionId: string, additionalAttempts: number): Promise<void> {
      const session = sessionRepo.getOrThrow(sessionId);
      if (session.status !== 'review_required') {
        throw new AutopodError(
          `Cannot extend attempts for session ${sessionId} in status ${session.status} — only review_required sessions`,
          'INVALID_STATE',
          409,
        );
      }
      const newMax = session.maxValidationAttempts + additionalAttempts;
      if (newMax > 10) {
        throw new AutopodError(
          `Cannot exceed 10 total validation attempts (current: ${session.maxValidationAttempts}, requested: +${additionalAttempts})`,
          'VALIDATION_ERROR',
          400,
        );
      }
      sessionRepo.update(sessionId, { maxValidationAttempts: newMax });
      logger.info(
        { sessionId, oldMax: session.maxValidationAttempts, newMax, additionalAttempts },
        'Extended validation attempts',
      );
      emitActivityStatus(
        sessionId,
        `Validation attempts extended to ${newMax} — resuming validation`,
      );
      await this.triggerValidation(sessionId);
    },

    async refreshNetworkPolicy(profileName: string): Promise<void> {
      if (!networkManager) return;

      const profile = profileStore.get(profileName);
      if (!profile.networkPolicy?.enabled) return;

      const runningSessions = sessionRepo
        .list({ status: 'running' })
        .filter(
          (s) =>
            s.profileName === profileName && s.executionTarget === 'local' && s.containerId != null,
        );

      if (runningSessions.length === 0) return;

      const mergedServers = mergeMcpServers(daemonConfig.mcpServers, profile.mcpServers);
      const gatewayIp = await networkManager.getGatewayIp();
      const netConfig = await networkManager.buildNetworkConfig(
        profile.networkPolicy,
        mergedServers,
        gatewayIp,
        profile.privateRegistries,
      );
      if (!netConfig) return;

      const cm = containerManagerFactory.get('local');
      await Promise.all(
        runningSessions.map(async (session) => {
          try {
            await cm.refreshFirewall(session.containerId!, netConfig.firewallScript);
            logger.info(
              { sessionId: session.id, profileName },
              'Network policy refreshed on running container',
            );
          } catch (err) {
            logger.warn(
              { err, sessionId: session.id, profileName },
              'Failed to refresh network policy on running container',
            );
          }
        }),
      );
    },
  };
}
