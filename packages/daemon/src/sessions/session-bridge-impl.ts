import type { SessionBridge } from '@autopod/escalation-mcp';
import type { PendingRequests } from '@autopod/escalation-mcp';
import type {
  ActionDefinition,
  ActionResponse,
  EscalationRequest,
  EscalationResponse,
  Profile,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { ActionEngine } from '../actions/action-engine.js';
import type { ProfileStore } from '../profiles/index.js';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventBus } from './event-bus.js';
import type { NudgeRepository } from './nudge-repository.js';
import type { ProgressEventRepository } from './progress-event-repository.js';
import type { ContainerManagerFactory, SessionManager } from './session-manager.js';
import type { SessionRepository } from './session-repository.js';

export interface SessionBridgeDependencies {
  sessionManager: SessionManager;
  sessionRepo: SessionRepository;
  eventBus: EventBus;
  progressEventRepo?: ProgressEventRepository;
  escalationRepo: EscalationRepository;
  nudgeRepo: NudgeRepository;
  profileStore: ProfileStore;
  makeActionEngine?: (profile: Profile) => ActionEngine;
  containerManagerFactory: ContainerManagerFactory;
  pendingRequestsBySession: Map<string, PendingRequests>;
  logger: Logger;
}

export function createSessionBridge(deps: SessionBridgeDependencies): SessionBridge {
  const {
    sessionManager,
    sessionRepo,
    eventBus,
    progressEventRepo,
    escalationRepo,
    nudgeRepo,
    profileStore,
    makeActionEngine,
    containerManagerFactory,
    pendingRequestsBySession: _pendingRequestsBySession,
    logger,
  } = deps;

  return {
    createEscalation(escalation: EscalationRequest): void {
      sessionManager.touchHeartbeat(escalation.sessionId);
      escalationRepo.insert(escalation);
      logger.info(
        { escalationId: escalation.id, sessionId: escalation.sessionId, type: escalation.type },
        'Escalation created',
      );
      // Transition session to awaiting_input so the TUI shows the pending question/approval
      if (
        escalation.type === 'ask_human' ||
        escalation.type === 'report_blocker' ||
        escalation.type === 'action_approval'
      ) {
        sessionManager.notifyEscalation(escalation.sessionId, escalation);
      }
    },

    resolveEscalation(escalationId: string, response: EscalationResponse): void {
      escalationRepo.update(escalationId, response);
      logger.info({ escalationId }, 'Escalation resolved');
    },

    getAiEscalationCount(sessionId: string): number {
      return escalationRepo.countBySessionAndType(sessionId, 'ask_ai');
    },

    getMaxAiCalls(sessionId: string): number {
      const session = sessionManager.getSession(sessionId);
      const profile = profileStore.get(session.profileName);
      return profile.escalation.askAi.maxCalls;
    },

    getAutoPauseThreshold(sessionId: string): number {
      const session = sessionManager.getSession(sessionId);
      const profile = profileStore.get(session.profileName);
      return profile.escalation.autoPauseAfter;
    },

    getHumanResponseTimeout(sessionId: string): number {
      const session = sessionManager.getSession(sessionId);
      const profile = profileStore.get(session.profileName);
      return profile.escalation.humanResponseTimeout;
    },

    getReviewerModel(sessionId: string): string {
      const session = sessionManager.getSession(sessionId);
      const profile = profileStore.get(session.profileName);
      return profile.escalation.askAi.model;
    },

    async callReviewerModel(
      sessionId: string,
      question: string,
      context?: string,
    ): Promise<string> {
      const model = this.getReviewerModel(sessionId);
      const prompt = context ? `Context:\n${context}\n\nQuestion:\n${question}` : question;

      logger.info({ sessionId, model, question: question.slice(0, 100) }, 'Calling reviewer model');

      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);

        const { stdout } = await execFileAsync(
          'claude',
          ['-p', prompt, '--model', model, '--output-format', 'text'],
          { timeout: 60_000 },
        );

        return stdout.trim();
      } catch (err) {
        logger.error({ err, sessionId }, 'Reviewer model call failed');
        return `AI review failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },

    incrementEscalationCount(sessionId: string): void {
      const session = sessionManager.getSession(sessionId);
      // The session manager tracks escalation count via session updates
      // This is a no-op here since the session manager handles it via consumeAgentEvents
      logger.debug(
        { sessionId, currentCount: session.escalationCount },
        'Escalation count incremented',
      );
    },

    reportPlan(sessionId: string, summary: string, steps: string[]): void {
      sessionManager.touchHeartbeat(sessionId);
      logger.info({ sessionId, summary, stepCount: steps.length }, 'Agent reported plan');
      sessionRepo.update(sessionId, { plan: { summary, steps } });
      eventBus.emit({
        type: 'session.agent_activity',
        timestamp: new Date().toISOString(),
        sessionId,
        event: { type: 'plan', summary, steps, timestamp: new Date().toISOString() },
      });
    },

    reportProgress(
      sessionId: string,
      phase: string,
      description: string,
      currentPhase: number,
      totalPhases: number,
    ): void {
      sessionManager.touchHeartbeat(sessionId);
      logger.info({ sessionId, phase, currentPhase, totalPhases }, 'Agent reported progress');
      sessionRepo.update(sessionId, {
        progress: { phase, description, currentPhase, totalPhases },
      });
      progressEventRepo?.insert(sessionId, phase, description, currentPhase, totalPhases);
      eventBus.emit({
        type: 'session.agent_activity',
        timestamp: new Date().toISOString(),
        sessionId,
        event: {
          type: 'progress',
          phase,
          description,
          currentPhase,
          totalPhases,
          timestamp: new Date().toISOString(),
        },
      });
    },

    reportTaskSummary(
      sessionId: string,
      actualSummary: string,
      deviations: Array<{ step: string; planned: string; actual: string; reason: string }>,
    ): void {
      sessionManager.touchHeartbeat(sessionId);
      logger.info(
        {
          sessionId,
          deviationCount: deviations.length,
          actualSummary: actualSummary.slice(0, 100),
        },
        'Agent reported task summary',
      );
      sessionRepo.update(sessionId, {
        taskSummary: { actualSummary, deviations },
      });
      eventBus.emit({
        type: 'session.agent_activity',
        timestamp: new Date().toISOString(),
        sessionId,
        event: {
          type: 'task_summary',
          actualSummary,
          deviations,
          timestamp: new Date().toISOString(),
        },
      });
    },

    consumeMessages(sessionId: string): { hasMessage: boolean; message?: string } {
      sessionManager.touchHeartbeat(sessionId);
      return nudgeRepo.consumeNext(sessionId);
    },

    actionRequiresApproval(sessionId: string, actionName: string): boolean {
      const session = sessionManager.getSession(sessionId);
      const profile = profileStore.get(session.profileName);
      if (!profile.actionPolicy) return false;
      const override = (profile.actionPolicy.actionOverrides ?? []).find(
        (o) => o.action === actionName,
      );
      return override?.requiresApproval ?? false;
    },

    async executeAction(
      sessionId: string,
      actionName: string,
      params: Record<string, unknown>,
      options?: { skipApprovalCheck?: boolean },
    ): Promise<ActionResponse> {
      const session = sessionManager.getSession(sessionId);
      const profile = profileStore.get(session.profileName);

      if (!makeActionEngine) {
        return {
          success: false,
          error: 'Action engine not configured',
          sanitized: false,
          quarantined: false,
        };
      }

      if (!profile.actionPolicy) {
        return {
          success: false,
          error: 'No action policy configured for this profile',
          sanitized: false,
          quarantined: false,
        };
      }

      const actionEngine = makeActionEngine(profile);
      logger.info({ sessionId, actionName }, 'Executing action via bridge');
      sessionManager.touchHeartbeat(sessionId);
      return actionEngine.execute(
        { sessionId, actionName, params, skipApprovalCheck: options?.skipApprovalCheck },
        profile.actionPolicy,
      );
    },

    getAvailableActions(sessionId: string): ActionDefinition[] {
      if (!makeActionEngine) return [];

      const session = sessionManager.getSession(sessionId);
      const profile = profileStore.get(session.profileName);

      if (!profile.actionPolicy) return [];
      return makeActionEngine(profile).getAvailableActions(profile.actionPolicy);
    },

    async writeFileInContainer(sessionId: string, path: string, content: string): Promise<void> {
      sessionManager.touchHeartbeat(sessionId);
      const session = sessionManager.getSession(sessionId);
      if (!session.containerId) {
        throw new Error(`Session ${sessionId} has no container`);
      }
      const cm = containerManagerFactory.get(session.executionTarget);
      await cm.writeFile(session.containerId, path, content);
    },

    async execInContainer(
      sessionId: string,
      command: string[],
      options?: { cwd?: string; timeout?: number },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      sessionManager.touchHeartbeat(sessionId);
      const session = sessionManager.getSession(sessionId);
      if (!session.containerId) {
        throw new Error(`Session ${sessionId} has no container`);
      }
      const cm = containerManagerFactory.get(session.executionTarget);
      return cm.execInContainer(session.containerId, command, options);
    },

    getLinkedSessionId(sessionId: string): string | null {
      const session = sessionManager.getSession(sessionId);
      return session.linkedSessionId;
    },

    async revalidateLinkedSession(
      linkedSessionId: string,
    ): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }> {
      logger.info({ linkedSessionId }, 'Triggering revalidation of linked worker session');
      return sessionManager.revalidateSession(linkedSessionId);
    },
  };
}
