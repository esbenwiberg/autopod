import type { PendingRequests } from '@autopod/escalation-mcp';
import type {
  AgentEvent,
  CreateSessionRequest,
  DaemonConfig,
  EscalationRequest,
  ExecutionTarget,
  InjectedMcpServer,
  NetworkPolicy,
  Profile,
  Session,
  SessionStatus,
} from '@autopod/shared';
import { AutopodError, generateId } from '@autopod/shared';
import type { Logger } from 'pino';
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
import { buildGitHubImageUrl, collectScreenshots } from '../validation/screenshot-collector.js';
import { generateSystemInstructions } from './system-instructions-generator.js';
import { buildCorrectionMessage } from './correction-context.js';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventBus } from './event-bus.js';
import { formatFeedback } from './feedback-formatter.js';
import { mergeClaudeMdSections, mergeMcpServers } from './injection-merger.js';
import type { NudgeRepository } from './nudge-repository.js';
import { resolveSections } from './section-resolver.js';
import type { SessionRepository, SessionStats, SessionUpdates } from './session-repository.js';
import {
  canKill,
  canNudge,
  canPause,
  canReceiveMessage,
  isTerminalState,
  validateTransition,
} from './state-machine.js';

/** Allocate a random host port in range 10000–48999 for container port mapping.
 * Capped at 48999 to avoid the Windows/Hyper-V dynamic port reservation range (49152+). */
function allocateHostPort(): number {
  return 10_000 + Math.floor(Math.random() * 39_000);
}

/** Default container port for app servers (matches Dockerfile HEALTHCHECK). */
const CONTAINER_APP_PORT = 3000;

export interface ContainerManagerFactory {
  get(target: ExecutionTarget): ContainerManager;
}

export interface NetworkManager {
  buildNetworkConfig(
    policy: NetworkPolicy | null,
    mcpServers: InjectedMcpServer[],
    daemonGatewayIp: string,
  ): Promise<{ networkName: string; firewallScript: string } | null>;
  getGatewayIp(): Promise<string>;
}

export interface SessionManagerDependencies {
  sessionRepo: SessionRepository;
  escalationRepo: EscalationRepository;
  nudgeRepo: NudgeRepository;
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
  enqueueSession: (sessionId: string) => void;
  mcpBaseUrl: string;
  daemonConfig: Pick<DaemonConfig, 'mcpServers' | 'claudeMdSections'>;
  /** Pending MCP ask_human requests keyed by sessionId — used to resolve escalations */
  pendingRequestsBySession?: Map<string, PendingRequests>;
  logger: Logger;
}

export interface SessionManager {
  createSession(request: CreateSessionRequest, userId: string): Session;
  processSession(sessionId: string): Promise<void>;
  consumeAgentEvents(sessionId: string, events: AsyncIterable<AgentEvent>): Promise<void>;
  handleCompletion(sessionId: string): Promise<void>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  notifyEscalation(sessionId: string, escalation: EscalationRequest): void;
  approveSession(sessionId: string, options?: { squash?: boolean }): Promise<void>;
  rejectSession(sessionId: string, reason?: string): Promise<void>;
  approveAllValidated(): Promise<{ approved: string[] }>;
  killAllFailed(): Promise<{ killed: string[] }>;
  pauseSession(sessionId: string): Promise<void>;
  nudgeSession(sessionId: string, message: string): void;
  killSession(sessionId: string): Promise<void>;
  triggerValidation(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  getSession(sessionId: string): Session;
  listSessions(filters?: {
    profileName?: string;
    status?: SessionStatus;
    userId?: string;
  }): Session[];
  getSessionStats(filters?: { profileName?: string }): SessionStats;
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
  } = deps;

  /**
   * Build provider env for resume calls.
   * Needed because OAuth tokens may have been rotated since the initial spawn.
   */
  async function getResumeEnv(session: Session): Promise<Record<string, string> | undefined> {
    const profile = profileStore.get(session.profileName);
    const provider = profile.modelProvider;
    // Only MAX provider needs fresh env on resume (token rotation)
    if (provider !== 'max') return undefined;
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
      const id = generateId();
      const branch = request.branch ?? `autopod/${id}`;
      const model = request.model ?? profile.defaultModel;
      const runtime = request.runtime ?? profile.defaultRuntime;
      const executionTarget = request.executionTarget ?? profile.executionTarget;
      const skipValidation = request.skipValidation ?? false;

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
      });

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

    async processSession(sessionId: string): Promise<void> {
      let session = sessionRepo.getOrThrow(sessionId);
      const profile = profileStore.get(session.profileName);

      function emitStatus(message: string): void {
        emitActivityStatus(sessionId, message);
      }

      try {
        // Transition to provisioning
        session = transition(session, 'provisioning', { startedAt: new Date().toISOString() });

        // Create worktree
        emitStatus('Creating worktree…');
        const worktreePath = await worktreeManager.create({
          repoUrl: profile.repoUrl,
          branch: session.branch,
          baseBranch: profile.defaultBranch,
        });

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
        const containerId = await containerManager.spawn({
          image: profile.template,
          sessionId,
          env: { SESSION_ID: sessionId, PORT: String(CONTAINER_APP_PORT) },
          ports: [{ container: CONTAINER_APP_PORT, host: hostPort }],
          volumes: [{ host: worktreePath, container: '/workspace' }],
          networkName,
          firewallScript,
        });

        const previewUrl = `http://localhost:${hostPort}`;
        session = transition(session, 'running', {
          containerId,
          worktreePath,
          previewUrl,
        });

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
        });

        // Claude reads CLAUDE.md from the workspace; Copilot reads copilot-instructions.md
        // (passed via customInstructions in SpawnConfig — written by the runtime)
        if (session.runtime === 'claude') {
          emitStatus('Writing CLAUDE.md to container…');
          await containerManager.writeFile(containerId, '/workspace/CLAUDE.md', systemInstructions);
        }

        // Build MCP server list for runtime
        const mcpServers = [
          { name: 'escalation', url: mcpUrl },
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

        // Start the agent inside the container
        emitStatus('Spawning agent…');
        const runtime = runtimeRegistry.get(session.runtime);
        const events = runtime.spawn({
          sessionId,
          task: session.task,
          model: session.model,
          workDir: '/workspace',
          containerId,
          customInstructions: session.runtime === 'copilot' ? systemInstructions : undefined,
          env: secretEnv,
          mcpServers,
        });

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
        } else if (
          event.type === 'status' &&
          event.message.includes('Claude session initialized')
        ) {
          // Persist claude session ID to DB for pause/resume survival across daemon restarts
          const match = event.message.match(/\(([^)]+)\)$/);
          if (match?.[1]) {
            sessionRepo.update(sessionId, { claudeSessionId: match[1] });
          }
        }
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
        session.status === 'failed'
      ) {
        return;
      }

      // Get diff stats (compare branch against base to catch committed changes)
      if (session.worktreePath) {
        try {
          const profile = profileStore.get(session.profileName);
          const stats = await worktreeManager.getDiffStats(
            session.worktreePath,
            profile.defaultBranch,
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
      const resumeEnv = await getResumeEnv(session);
      const runtime = runtimeRegistry.get(session.runtime);
      if (!session.containerId) throw new Error(`Session ${sessionId} has no container`);
      const events = runtime.resume(sessionId, message, session.containerId, resumeEnv);
      await this.consumeAgentEvents(sessionId, events);
      await this.handleCompletion(sessionId);
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
          await prManager.mergePr({
            worktreePath: session.worktreePath,
            prUrl: session.prUrl,
            squash: options?.squash,
          });
          emitActivityStatus(sessionId, 'PR merged successfully');
        } catch (err) {
          logger.error({ err, sessionId, prUrl: session.prUrl }, 'Failed to merge PR');
          emitActivityStatus(sessionId, 'PR merge failed — session still completing');
          // Don't block completion — merge is best-effort
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
          // Don't block completion — branch push is best-effort
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
      const previousStatus = session.status as 'validated' | 'failed';

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

      // Resume agent with rejection feedback
      const resumeEnv = await getResumeEnv(session);
      const runtime = runtimeRegistry.get(session.runtime);
      if (!session.containerId) throw new Error(`Session ${sessionId} has no container`);
      const events = runtime.resume(sessionId, rejectionMessage, session.containerId, resumeEnv);
      await this.consumeAgentEvents(sessionId, events);
      await this.handleCompletion(sessionId);

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

    async triggerValidation(sessionId: string): Promise<void> {
      const session = sessionRepo.getOrThrow(sessionId);
      const profile = profileStore.get(session.profileName);

      const s1 = transition(session, 'validating');
      const attempt = s1.validationAttempts + 1;
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

        // Get the actual diff for AI task review
        const diff = session.worktreePath
          ? await worktreeManager.getDiff(session.worktreePath, profile.defaultBranch)
          : '';

        let result: Awaited<ReturnType<typeof validationEngine.validate>>;
        try {
          result = await validationEngine.validate({
            sessionId,
            containerId: session.containerId,
            previewUrl: session.previewUrl ?? `http://localhost:${CONTAINER_APP_PORT}`,
            buildCommand: profile.buildCommand,
            startCommand: profile.startCommand,
            healthPath: profile.healthPath,
            healthTimeout: profile.healthTimeout,
            smokePages: profile.smokePages,
            attempt,
            task: session.task,
            diff,
            testCommand: profile.testCommand,
            reviewerModel: profile.escalation.askAi.model,
          });
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

        // Collect screenshots from the host worktree (volume-mounted from container)
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
        const reviewStatus = result.taskReview?.status ?? 'skip';
        emitActivityStatus(
          sessionId,
          `Validation ${result.overall} — build: ${buildStatus}, health: ${healthStatus}, review: ${reviewStatus}`,
        );

        if (result.overall === 'pass') {
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
              });
              if (prUrl) {
                emitActivityStatus(sessionId, `PR created: ${prUrl}`);
              }
            } catch (err) {
              logger.warn({ err, sessionId }, 'Failed to create PR — session still validated');
              emitActivityStatus(sessionId, 'PR creation failed — session still validated');
            }
          }

          transition(s2, 'validated', { prUrl });
        } else if (attempt < profile.maxValidationAttempts) {
          emitActivityStatus(
            sessionId,
            `Validation failed (attempt ${attempt}/${profile.maxValidationAttempts}) — retrying`,
          );
          // Build correction message with structured feedback for the agent
          const cm = containerManagerFactory.get(s2.executionTarget);
          const correctionMessage = await buildCorrectionMessage(s2, profile, result, cm);

          // Transition back to running for retry
          transition(s2, 'running');

          // Resume the agent with correction feedback
          const resumeEnv = await getResumeEnv(s2);
          const runtime = runtimeRegistry.get(s2.runtime);
          if (!s2.containerId) throw new Error(`Session ${sessionId} has no container`);
          const events = runtime.resume(sessionId, correctionMessage, s2.containerId, resumeEnv);
          await this.consumeAgentEvents(sessionId, events);
          await this.handleCompletion(sessionId);

          logger.info(
            {
              sessionId,
              attempt,
              maxAttempts: profile.maxValidationAttempts,
            },
            'Retrying after validation failure',
          );
        } else {
          emitActivityStatus(
            sessionId,
            `Validation failed — max attempts (${profile.maxValidationAttempts}) exhausted`,
          );
          transition(s2, 'failed');
        }
      } catch (err) {
        logger.error({ err, sessionId }, 'Validation error');
        const s2 = sessionRepo.getOrThrow(sessionId);
        transition(s2, 'failed');
      }
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

    async deleteSession(sessionId: string): Promise<void> {
      const session = sessionRepo.getOrThrow(sessionId);
      const deletable =
        isTerminalState(session.status) ||
        session.status === 'failed' ||
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

    getSession(sessionId: string): Session {
      return sessionRepo.getOrThrow(sessionId);
    },

    listSessions(filters?) {
      return sessionRepo.list(filters);
    },

    getSessionStats(filters?) {
      return sessionRepo.getStats(filters);
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
  };
}
