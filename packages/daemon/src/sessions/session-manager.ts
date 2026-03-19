import type { Logger } from 'pino';
import type {
  Session, CreateSessionRequest, SessionStatus, AgentEvent,
  DaemonConfig, ExecutionTarget,
} from '@autopod/shared';
import { generateId, AutopodError } from '@autopod/shared';
import type { ProfileStore } from '../profiles/index.js';
import type { ContainerManager, WorktreeManager, RuntimeRegistry, ValidationEngine } from '../interfaces/index.js';
import type { SessionRepository, SessionUpdates } from './session-repository.js';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventBus } from './event-bus.js';
import { validateTransition, isTerminalState, canReceiveMessage, canKill } from './state-machine.js';
import { generateClaudeMd } from './claude-md-generator.js';
import { formatFeedback } from './feedback-formatter.js';
import { buildCorrectionMessage } from './correction-context.js';
import { mergeMcpServers, mergeClaudeMdSections } from './injection-merger.js';
import { resolveSections } from './section-resolver.js';

export interface ContainerManagerFactory {
  get(target: ExecutionTarget): ContainerManager;
}

export interface SessionManagerDependencies {
  sessionRepo: SessionRepository;
  escalationRepo: EscalationRepository;
  profileStore: ProfileStore;
  eventBus: EventBus;
  containerManagerFactory: ContainerManagerFactory;
  worktreeManager: WorktreeManager;
  runtimeRegistry: RuntimeRegistry;
  validationEngine: ValidationEngine;
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
  approveSession(sessionId: string): Promise<void>;
  rejectSession(sessionId: string, reason?: string): Promise<void>;
  killSession(sessionId: string): Promise<void>;
  triggerValidation(sessionId: string): Promise<void>;
  getSession(sessionId: string): Session;
  listSessions(filters?: { profileName?: string; status?: SessionStatus; userId?: string }): Session[];
}

export function createSessionManager(deps: SessionManagerDependencies): SessionManager {
  const {
    sessionRepo, escalationRepo: _escalationRepo, profileStore, eventBus,
    containerManagerFactory, worktreeManager, runtimeRegistry, validationEngine,
    enqueueSession, mcpBaseUrl, daemonConfig, logger,
  } = deps;

  function transition(session: Session, to: SessionStatus, extraUpdates?: Partial<SessionUpdates>): Session {
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

        // Spawn container
        const containerId = await containerManager.spawn({
          image: profile.template,
          sessionId,
          env: { SESSION_ID: sessionId },
          volumes: [{ host: worktreePath, container: '/workspace' }],
        });

        session = transition(session, 'running', {
          containerId,
          worktreePath,
          previewUrl: 'http://localhost:3000', // placeholder
        });

        // Merge daemon + profile injections
        const mergedMcpServers = mergeMcpServers(daemonConfig.mcpServers, profile.mcpServers);
        const mergedSections = mergeClaudeMdSections(daemonConfig.claudeMdSections, profile.claudeMdSections);

        // Resolve dynamic sections (fetches URLs, respects token budgets)
        const resolvedSections = await resolveSections(mergedSections, logger);

        // Generate CLAUDE.md and write to container
        const mcpUrl = `${mcpBaseUrl}/mcp/${sessionId}`;
        const claudeMd = generateClaudeMd(profile, session, mcpUrl, {
          injectedSections: resolvedSections,
          injectedMcpServers: mergedMcpServers,
        });
        await containerManager.writeFile(containerId, '/workspace/CLAUDE.md', claudeMd);

        // Build MCP server list for runtime
        const mcpServers = [
          { name: 'escalation', url: mcpUrl },
          ...mergedMcpServers.map(s => ({ name: s.name, url: s.url, headers: s.headers })),
        ];


        // Build secret env for container exec (API keys injected at exec time, not container level)
        const secretEnv: Record<string, string> = { SESSION_ID: sessionId };
        if (session.runtime === 'claude' && process.env.ANTHROPIC_API_KEY) {
          secretEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
        }
        if (session.runtime === 'codex' && process.env.OPENAI_API_KEY) {
          secretEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
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
        } catch { /* swallow — best effort */ }
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

      const runtime = runtimeRegistry.get(session.runtime);
      const events = runtime.resume(sessionId, message, session.containerId!);
      await this.consumeAgentEvents(sessionId, events);
      await this.handleCompletion(sessionId);
    },

    async approveSession(sessionId: string): Promise<void> {
      const session = sessionRepo.getOrThrow(sessionId);
      const s1 = transition(session, 'approved');
      const s2 = transition(s1, 'merging');

      // Push the branch to origin
      if (session.worktreePath) {
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

      logger.info({ sessionId }, 'Session approved and completed');
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
      const runtime = runtimeRegistry.get(session.runtime);
      const events = runtime.resume(sessionId, rejectionMessage, session.containerId!);
      await this.consumeAgentEvents(sessionId, events);
      await this.handleCompletion(sessionId);

      logger.info({ sessionId, reason, previousStatus }, 'Session rejected, resuming agent with feedback');
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
          containerId: session.containerId!,
          previewUrl: session.previewUrl ?? 'http://localhost:3000',
          buildCommand: profile.buildCommand,
          startCommand: profile.startCommand,
          healthPath: profile.healthPath,
          healthTimeout: profile.healthTimeout,
          validationPages: profile.validationPages,
          attempt,
          task: session.task,
          diff: '', // would come from worktreeManager
        });

        sessionRepo.update(sessionId, { lastValidationResult: result });

        eventBus.emit({
          type: 'session.validation_completed',
          timestamp: new Date().toISOString(),
          sessionId,
          result,
        });

        const s2 = sessionRepo.getOrThrow(sessionId);
        if (result.overall === 'pass') {
          transition(s2, 'validated');
        } else if (attempt < profile.maxValidationAttempts) {
          // Build correction message with structured feedback for the agent
          const cm = containerManagerFactory.get(s2.executionTarget);
          const correctionMessage = await buildCorrectionMessage(
            s2, profile, result, cm,
          );

          // Transition back to running for retry
          transition(s2, 'running');

          // Resume the agent with correction feedback
          const runtime = runtimeRegistry.get(s2.runtime);
          const events = runtime.resume(sessionId, correctionMessage, s2.containerId!);
          await this.consumeAgentEvents(sessionId, events);
          await this.handleCompletion(sessionId);

          logger.info({
            sessionId,
            attempt,
            maxAttempts: profile.maxValidationAttempts,
          }, 'Retrying after validation failure');
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
