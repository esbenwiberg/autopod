import type { SessionBridge } from '@autopod/escalation-mcp';
import type { EscalationRequest, EscalationResponse } from '@autopod/shared';
import type { PendingRequests } from '@autopod/escalation-mcp';
import type { SessionManager } from './session-manager.js';
import type { EscalationRepository } from './escalation-repository.js';
import type { ProfileStore } from '../profiles/index.js';
import type { Logger } from 'pino';

export interface SessionBridgeDependencies {
  sessionManager: SessionManager;
  escalationRepo: EscalationRepository;
  profileStore: ProfileStore;
  pendingRequestsBySession: Map<string, PendingRequests>;
  logger: Logger;
}

export function createSessionBridge(deps: SessionBridgeDependencies): SessionBridge {
  const { sessionManager, escalationRepo, profileStore, pendingRequestsBySession, logger } = deps;

  return {
    createEscalation(escalation: EscalationRequest): void {
      escalationRepo.insert(escalation);
      logger.info({ escalationId: escalation.id, sessionId: escalation.sessionId, type: escalation.type }, 'Escalation created');
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

    async callReviewerModel(sessionId: string, question: string, context?: string): Promise<string> {
      const model = this.getReviewerModel(sessionId);
      const prompt = context ? `Context:\n${context}\n\nQuestion:\n${question}` : question;

      logger.info({ sessionId, model, question: question.slice(0, 100) }, 'Calling reviewer model');

      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);

        const { stdout } = await execFileAsync('claude', [
          '-p', prompt,
          '--model', model,
          '--output-format', 'text',
        ], { timeout: 60_000 });

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
      logger.debug({ sessionId, currentCount: session.escalationCount }, 'Escalation count incremented');
    },
  };
}
