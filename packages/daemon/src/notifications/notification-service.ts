import type { Logger } from 'pino';
import type {
  SystemEvent,
  NotificationType,
  SessionValidatedNotification,
  SessionFailedNotification,
  SessionNeedsInputNotification,
  SessionErrorNotification,
  ValidationCompletedEvent,
  EscalationCreatedEvent,
  SessionStatusChangedEvent,
  Session,
} from '@autopod/shared';
import type { EventBus } from '../sessions/event-bus.js';
import type { NotificationConfig } from './types.js';
import type { TeamsAdapter } from './teams-adapter.js';
import type { RateLimiter } from './rate-limiter.js';
import { buildValidatedCard, buildFailedCard, buildNeedsInputCard, buildErrorCard } from './card-builder.js';

export interface SessionLookup {
  getSession(sessionId: string): Session;
}

export interface NotificationService {
  start(): void;
  stop(): void;
}

export function createNotificationService(deps: {
  eventBus: EventBus;
  config: NotificationConfig;
  teamsAdapter: TeamsAdapter;
  rateLimiter: RateLimiter;
  sessionLookup: SessionLookup;
  logger: Logger;
}): NotificationService {
  const { eventBus, config, teamsAdapter, rateLimiter, sessionLookup, logger } = deps;
  const unsubscribers: Array<() => void> = [];

  function isEventEnabled(type: NotificationType, profileName: string): boolean {
    const teamsConfig = config.teams;
    if (!teamsConfig) return false;

    // Check profile override
    const override = teamsConfig.profileOverrides?.[profileName];
    if (override) {
      if (!override.enabled) return false;
      if (override.events) return override.events.includes(type);
    }

    return teamsConfig.enabledEvents.includes(type);
  }

  function canSendForSession(sessionId: string, notificationType: NotificationType, profileName: string): boolean {
    if (!isEventEnabled(notificationType, profileName)) {
      logger.debug({ sessionId, notificationType }, 'Notification type not enabled');
      return false;
    }

    const rateCheck = rateLimiter.canSend(sessionId);
    if (!rateCheck.allowed) {
      logger.debug({ sessionId, reason: rateCheck.reason }, 'Rate limited');
      return false;
    }

    return true;
  }

  function getSessionSafe(sessionId: string): Session | null {
    try {
      return sessionLookup.getSession(sessionId);
    } catch {
      logger.warn({ sessionId }, 'Could not look up session for notification');
      return null;
    }
  }

  async function handleValidationCompleted(event: ValidationCompletedEvent): Promise<void> {
    const session = getSessionSafe(event.sessionId);
    if (!session) return;

    if (event.result.overall === 'pass') {
      const notificationType: NotificationType = 'session_validated';
      if (!canSendForSession(event.sessionId, notificationType, session.profileName)) return;

      const notification: SessionValidatedNotification = {
        type: notificationType,
        sessionId: session.id,
        profileName: session.profileName,
        task: session.task,
        timestamp: event.timestamp,
        previewUrl: session.previewUrl,
        filesChanged: session.filesChanged,
        linesAdded: session.linesAdded,
        linesRemoved: session.linesRemoved,
        duration: event.result.duration,
      };

      const card = buildValidatedCard(notification);
      rateLimiter.recordSent(event.sessionId);
      await teamsAdapter.send(card);
    } else {
      const notificationType: NotificationType = 'session_failed';
      if (!canSendForSession(event.sessionId, notificationType, session.profileName)) return;

      const reason = event.result.taskReview?.reasoning
        ?? event.result.smoke.build.status === 'fail' ? 'Build failed'
        : event.result.smoke.health.status === 'fail' ? 'Health check failed'
        : 'Validation failed';

      const notification: SessionFailedNotification = {
        type: notificationType,
        sessionId: session.id,
        profileName: session.profileName,
        task: session.task,
        timestamp: event.timestamp,
        reason,
        validationResult: event.result,
        screenshotUrl: null,
      };

      const card = buildFailedCard(notification);
      rateLimiter.recordSent(event.sessionId);
      await teamsAdapter.send(card);
    }
  }

  async function handleEscalationCreated(event: EscalationCreatedEvent): Promise<void> {
    // Only notify for human-relevant escalations, not AI-to-AI
    if (event.escalation.type === 'ask_ai') return;

    const session = getSessionSafe(event.sessionId);
    if (!session) return;

    const notificationType: NotificationType = 'session_needs_input';
    if (!canSendForSession(event.sessionId, notificationType, session.profileName)) return;

    const notification: SessionNeedsInputNotification = {
      type: notificationType,
      sessionId: session.id,
      profileName: session.profileName,
      task: session.task,
      timestamp: event.timestamp,
      escalation: event.escalation,
    };

    const card = buildNeedsInputCard(notification);
    rateLimiter.recordSent(event.sessionId);
    await teamsAdapter.send(card);
  }

  async function handleStatusChanged(event: SessionStatusChangedEvent): Promise<void> {
    if (event.newStatus !== 'failed') return;

    const session = getSessionSafe(event.sessionId);
    if (!session) return;

    const notificationType: NotificationType = 'session_error';
    if (!canSendForSession(event.sessionId, notificationType, session.profileName)) return;

    const notification: SessionErrorNotification = {
      type: notificationType,
      sessionId: session.id,
      profileName: session.profileName,
      task: session.task,
      timestamp: event.timestamp,
      error: 'Session entered failed state',
      fatal: true,
    };

    const card = buildErrorCard(notification);
    rateLimiter.recordSent(event.sessionId);
    await teamsAdapter.send(card);
  }

  function handleEvent(event: SystemEvent): void {
    // Fire-and-forget: wrap all sends in try/catch
    const promise = (async () => {
      switch (event.type) {
        case 'session.validation_completed':
          await handleValidationCompleted(event);
          break;
        case 'session.escalation_created':
          await handleEscalationCreated(event);
          break;
        case 'session.status_changed':
          await handleStatusChanged(event);
          break;
        // session.completed could be handled here if needed
        default:
          break;
      }
    })();

    promise.catch((err) => {
      logger.warn({ err, eventType: event.type }, 'Notification handler failed');
    });
  }

  return {
    start(): void {
      if (!config.teams) {
        logger.info('No Teams notification config — notifications disabled');
        return;
      }

      const unsub = eventBus.subscribe(handleEvent);
      unsubscribers.push(unsub);
      logger.info(
        { enabledEvents: config.teams.enabledEvents },
        'Notification service started',
      );
    },

    stop(): void {
      for (const unsub of unsubscribers) {
        unsub();
      }
      unsubscribers.length = 0;
      logger.info('Notification service stopped');
    },
  };
}
