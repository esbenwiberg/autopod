import type {
  EscalationCreatedEvent,
  NotificationType,
  Pod,
  PodErrorNotification,
  PodFailedNotification,
  PodNeedsInputNotification,
  PodStatusChangedEvent,
  PodValidatedNotification,
  ProcessContentConfig,
  SystemEvent,
  ValidationCompletedEvent,
} from '@autopod/shared';
import { sanitize } from '@autopod/shared';
import type { Logger } from 'pino';
import type { EventBus } from '../pods/event-bus.js';
import {
  buildErrorCard,
  buildFailedCard,
  buildNeedsInputCard,
  buildValidatedCard,
} from './card-builder.js';
import type { RateLimiter } from './rate-limiter.js';
import type { TeamsAdapter } from './teams-adapter.js';
import type { NotificationConfig } from './types.js';

export interface SessionLookup {
  getSession(podId: string): Pod;
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
  /** Content processing config — sanitizes notification payloads (task descriptions, escalation content) */
  contentProcessing?: ProcessContentConfig;
}): NotificationService {
  const { eventBus, config, teamsAdapter, rateLimiter, sessionLookup, logger, contentProcessing } =
    deps;

  /** Sanitize a string for notification display (strip PII) */
  function sanitizeText(text: string): string {
    if (!contentProcessing?.sanitization) return text;
    return sanitize(text, contentProcessing.sanitization);
  }
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

  function canSendForSession(
    podId: string,
    notificationType: NotificationType,
    profileName: string,
  ): boolean {
    if (!isEventEnabled(notificationType, profileName)) {
      logger.debug({ podId, notificationType }, 'Notification type not enabled');
      return false;
    }

    const rateCheck = rateLimiter.canSend(podId);
    if (!rateCheck.allowed) {
      logger.debug({ podId, reason: rateCheck.reason }, 'Rate limited');
      return false;
    }

    return true;
  }

  function getSessionSafe(podId: string): Pod | null {
    try {
      return sessionLookup.getSession(podId);
    } catch {
      logger.warn({ podId }, 'Could not look up pod for notification');
      return null;
    }
  }

  async function handleValidationCompleted(event: ValidationCompletedEvent): Promise<void> {
    const pod = getSessionSafe(event.podId);
    if (!pod) return;

    if (event.result.overall === 'pass') {
      const notificationType: NotificationType = 'pod_validated';
      if (!canSendForSession(event.podId, notificationType, pod.profileName)) return;

      // Extract screenshots from page results for Teams card
      const screenshots = event.result.smoke.pages
        .filter((p) => p.screenshotBase64)
        .map((p) => ({ pagePath: p.path, base64: p.screenshotBase64 ?? '' }));

      const notification: PodValidatedNotification = {
        type: notificationType,
        podId: pod.id,
        profileName: pod.profileName,
        task: sanitizeText(pod.task),
        timestamp: event.timestamp,
        previewUrl: pod.previewUrl,
        prUrl: pod.prUrl,
        screenshots,
        filesChanged: pod.filesChanged,
        linesAdded: pod.linesAdded,
        linesRemoved: pod.linesRemoved,
        duration: event.result.duration,
      };

      const card = buildValidatedCard(notification);
      rateLimiter.recordSent(event.podId);
      await teamsAdapter.send(card);
    } else {
      const notificationType: NotificationType = 'pod_failed';
      if (!canSendForSession(event.podId, notificationType, pod.profileName)) return;

      const reason =
        (event.result.taskReview?.reasoning ?? event.result.smoke.build.status === 'fail')
          ? 'Build failed'
          : event.result.smoke.health.status === 'fail'
            ? 'Health check failed'
            : 'Validation failed';

      const notification: PodFailedNotification = {
        type: notificationType,
        podId: pod.id,
        profileName: pod.profileName,
        task: sanitizeText(pod.task),
        timestamp: event.timestamp,
        reason: sanitizeText(reason),
        validationResult: event.result,
        screenshotUrl: null,
      };

      const card = buildFailedCard(notification);
      rateLimiter.recordSent(event.podId);
      await teamsAdapter.send(card);
    }
  }

  async function handleEscalationCreated(event: EscalationCreatedEvent): Promise<void> {
    // Only notify for human-relevant escalations, not AI-to-AI
    if (event.escalation.type === 'ask_ai') return;

    const pod = getSessionSafe(event.podId);
    if (!pod) return;

    const notificationType: NotificationType = 'pod_needs_input';
    if (!canSendForSession(event.podId, notificationType, pod.profileName)) return;

    const notification: PodNeedsInputNotification = {
      type: notificationType,
      podId: pod.id,
      profileName: pod.profileName,
      task: sanitizeText(pod.task),
      timestamp: event.timestamp,
      escalation: event.escalation,
    };

    const card = buildNeedsInputCard(notification);
    rateLimiter.recordSent(event.podId);
    await teamsAdapter.send(card);
  }

  async function handleStatusChanged(event: PodStatusChangedEvent): Promise<void> {
    if (event.newStatus !== 'failed' && event.newStatus !== 'review_required') return;

    const pod = getSessionSafe(event.podId);
    if (!pod) return;

    const notificationType: NotificationType = 'pod_error';
    if (!canSendForSession(event.podId, notificationType, pod.profileName)) return;

    const notification: PodErrorNotification = {
      type: notificationType,
      podId: pod.id,
      profileName: pod.profileName,
      task: sanitizeText(pod.task),
      timestamp: event.timestamp,
      error: 'Pod entered failed state',
      fatal: true,
    };

    const card = buildErrorCard(notification);
    rateLimiter.recordSent(event.podId);
    await teamsAdapter.send(card);
  }

  function handleEvent(event: SystemEvent): void {
    // Fire-and-forget: wrap all sends in try/catch
    const promise = (async () => {
      switch (event.type) {
        case 'pod.validation_completed':
          await handleValidationCompleted(event);
          break;
        case 'pod.escalation_created':
          await handleEscalationCreated(event);
          break;
        case 'pod.status_changed':
          await handleStatusChanged(event);
          break;
        // pod.completed could be handled here if needed
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
      logger.info({ enabledEvents: config.teams.enabledEvents }, 'Notification service started');
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
