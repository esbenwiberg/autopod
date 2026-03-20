import type {
  AgentEvent,
  CreateSessionRequest,
  DaemonConfig,
  ExecutionTarget,
  InjectedMcpServer,
  NetworkPolicy,
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
import { generateClaudeMd } from './claude-md-generator.js';
import { buildCorrectionMessage } from './correction-context.js';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventBus } from './event-bus.js';
import { formatFeedback } from './feedback-formatter.js';
import { mergeClaudeMdSections, mergeMcpServers } from './injection-merger.js';
import type { NudgeRepository } from './nudge-repository.js';
import { resolveSections } from './section-resolver.js';
import type { SessionRepository, SessionUpdates } from './session-repository.js';
import {
  canKill,
  canNudge,
  canPause,
  canReceiveMessage,
  isTerminalState,
  validateTransition,
} from './state-machine.js';

/** Allocate a random host port in range 10000–59999 for container port mapping. */
function allocateHostPort(): number {
  return 10_000 + Math.floor(Math.random() * 50_000);
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
  prManager?: PrManager;
  actionEngine?: {
    getAvailableActions: (
      policy: import('@autopod/shared').ActionPolicy,
    ) => import('@autopod/shared').ActionDefinition[];
  };
  enqueueSession: (sessionId: string) => void;
  mcpBaseUrl: string;
  daemonConfig: Pick<DaemonConfig, 'mcpServers' | 'claudeMdSections'>;
  logger: Logger;
}

export interface SessionManager {
  createSession(request: CreateSessionRequest, userId: string): Session;
  processSession(sessionId: string): Promise<void>;
  consumeAgentEvents(sessionId: string, events: AsyncIterable<AgentEvent>): Promise<void>;
  handleCompletion(sessionId: string): Promise<void>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  approveSession(sessionId: string, options?: { squash?: boolean }): Promise<void>;
  rejectSession(sessionId: string, reason?: string): Promise<void>;
  pauseSession(sessionId: string): Promise<void>;
  nudgeSession(sessionId: string, message: string): void;
  killSession(sessionId: string): Promise<void>;
  triggerValidation(sessionId: string): Promise<void>;
  getSession(sessionId: string): Session;
  listSessions(filters?: {
    profileName?: string;
    status?: SessionStatus;
    userId?: string;
  }): Session[];
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
    prManager,
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

      try {
        // Transition to provisioning
        session = transition(session, 'provisioning', { startedAt: new Date().toISOString() });

        // Create worktree
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
        const resolvedSections = await resolveSections(mergedSections, logger);

        // Generate CLAUDE.md and write to container
        const mcpUrl = `${mcpBaseUrl}/mcp/${sessionId}`;
        const claudeMd = generateClaudeMd(profile, session, mcpUrl, {
          injectedSections: resolvedSections,
          injectedMcpServers: proxiedMcpServers,
          availableActions,
        });
        await containerManager.writeFile(containerId, '/workspace/CLAUDE.md', claudeMd);

        // Build MCP server list for runtime
        const mcpServers = [
          { name: 'escalation', url: mcpUrl },
          ...proxiedMcpServers.map((s) => ({ name: s.name, url: s.url, headers: s.headers })),
        ];

        // Build provider-aware env (API keys, OAuth creds, Foundry config)
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
        }

        // Start the agent inside the container
        const runtime = runtimeRegistry.get(session.runtime);
        const events = runtime.spawn({
          sessionId,
          task: session.task,
          model: session.model,
          workDir: '/workspace',
          containerId,
          customInstructions: profile.customInstructions ?? undefined,
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
      if (isTerminalState(session.status)) return;

      // Get diff stats
      if (session.worktreePath) {
        try {
          const stats = await worktreeManager.getDiffStats(session.worktreePath);
          sessionRepo.update(sessionId, {
            filesChanged: stats.filesChanged,
            linesAdded: stats.linesAdded,
            linesRemoved: stats.linesRemoved,
          });
        } catch (err) {
          logger.warn({ err, sessionId }, 'Failed to get diff stats');
        }
      }

      // Skip validation if requested
      if (session.skipValidation) {
        transition(session, 'validating');
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

      transition(session, 'running', { pendingEscalation: null });

      const resumeEnv = await getResumeEnv(session);
      const runtime = runtimeRegistry.get(session.runtime);
      if (!session.containerId) throw new Error(`Session ${sessionId} has no container`);
      const events = runtime.resume(sessionId, message, session.containerId, resumeEnv);
      await this.consumeAgentEvents(sessionId, events);
      await this.handleCompletion(sessionId);
    },

    async approveSession(sessionId: string, options?: { squash?: boolean }): Promise<void> {
      const session = sessionRepo.getOrThrow(sessionId);
      const s1 = transition(session, 'approved');
      const s2 = transition(s1, 'merging');

      // Merge the PR if one was created, otherwise fall back to branch push
      if (session.prUrl && prManager && session.worktreePath) {
        try {
          await prManager.mergePr({
            worktreePath: session.worktreePath,
            prUrl: session.prUrl,
            squash: options?.squash,
          });
        } catch (err) {
          logger.error({ err, sessionId, prUrl: session.prUrl }, 'Failed to merge PR');
          // Don't block completion — merge is best-effort
        }
      } else if (session.worktreePath) {
        // Fallback: push branch directly (no PR was created)
        try {
          const profile = profileStore.get(session.profileName);
          await worktreeManager.mergeBranch({
            worktreePath: session.worktreePath,
            targetBranch: profile.defaultBranch,
          });
        } catch (err) {
          logger.error({ err, sessionId }, 'Failed to push branch during approval');
          // Don't block completion — branch push is best-effort
        }
      }

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

      // Suspend the runtime (kills stream but preserves session ID)
      const runtime = runtimeRegistry.get(session.runtime);
      await runtime.suspend(sessionId);

      transition(session, 'paused');
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

      transition(session, 'killing');

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

      try {
        const result = await validationEngine.validate({
          sessionId,
          containerId: session.containerId ?? '',
          previewUrl: session.previewUrl ?? `http://localhost:${CONTAINER_APP_PORT}`,
          buildCommand: profile.buildCommand,
          startCommand: profile.startCommand,
          healthPath: profile.healthPath,
          healthTimeout: profile.healthTimeout,
          validationPages: profile.validationPages,
          attempt,
          task: session.task,
          diff: '', // would come from worktreeManager
        });

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
        if (result.overall === 'pass') {
          // Push branch and create PR before transitioning to validated
          let prUrl: string | null = null;
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
              prUrl = await prManager.createPr({
                worktreePath: s2.worktreePath,
                branch: s2.branch,
                baseBranch: profile.defaultBranch,
                sessionId,
                task: s2.task,
                profileName: s2.profileName,
                validationResult: result,
                filesChanged: s2.filesChanged,
                linesAdded: s2.linesAdded,
                linesRemoved: s2.linesRemoved,
                previewUrl: s2.previewUrl,
                screenshots: screenshotRefs,
              });
            } catch (err) {
              logger.warn({ err, sessionId }, 'Failed to create PR — session still validated');
            }
          }

          transition(s2, 'validated', { prUrl });
        } else if (attempt < profile.maxValidationAttempts) {
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
          transition(s2, 'failed');
        }
      } catch (err) {
        logger.error({ err, sessionId }, 'Validation error');
        const s2 = sessionRepo.getOrThrow(sessionId);
        transition(s2, 'failed');
      }
    },

    getSession(sessionId: string): Session {
      return sessionRepo.getOrThrow(sessionId);
    },

    listSessions(filters?) {
      return sessionRepo.list(filters);
    },
  };
}
