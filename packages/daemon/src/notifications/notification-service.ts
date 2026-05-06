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
  ScreenshotRef,
  SystemEvent,
  ValidationCompletedEvent,
  ValidationResult,
} from '@autopod/shared';
import { sanitize } from '@autopod/shared';
import type { Logger } from 'pino';
import type { EventBus } from '../pods/event-bus.js';
import type { ScreenshotStore } from '../pods/screenshot-store.js';
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

/** Pick a human-readable reason string for a failed validation. Walks the
 * pipeline in execution order and picks the first failing phase, falling back
 * to the task reviewer's reasoning, then a generic label. */
function pickFailureReason(result: ValidationResult): string {
  if (result.lint?.status === 'fail') return 'Lint failed';
  if (result.sast?.status === 'fail') return 'Security scan failed';
  if (result.smoke.build.status === 'fail') return 'Build failed';
  if (result.test?.status === 'fail') return 'Tests failed';
  if (result.smoke.health.status === 'fail') return 'Health check failed';
  if (result.smoke.pages.some((p) => p.status === 'fail')) return 'Page checks failed';
  if (result.acValidation?.status === 'fail') return 'Acceptance criteria failed';
  if (result.taskReview?.status === 'fail') {
    return result.taskReview.reasoning?.trim() || 'Task review failed';
  }
  return 'Validation failed';
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
  /** Screenshot store — when provided, smoke screenshots are read from disk and embedded in Teams cards */
  screenshotStore?: ScreenshotStore;
}): NotificationService {
  const {
    eventBus,
    config,
    teamsAdapter,
    rateLimiter,
    sessionLookup,
    logger,
    contentProcessing,
    screenshotStore,
  } = deps;

  /** Sanitize a string for notification display (strip PII) */
  function sanitizeText(text: string): string {
    if (!contentProcessing?.sanitization) return text;
    return sanitize(text, contentProcessing.sanitization);
  }

  /**
   * Read a screenshot from the store and return its base64 string.
   * Returns null on ENOENT (retention-pruned) and logs a warning.
   * Other errors are re-thrown.
   */
  async function readScreenshotBase64(ref: ScreenshotRef): Promise<string | null> {
    if (!screenshotStore) return null;
    try {
      const buf = await screenshotStore.read(ref);
      return buf.toString('base64');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.warn(
          { podId: ref.podId, source: ref.source, filename: ref.filename },
          'Screenshot missing from disk (retention-pruned?) — omitting from Teams card',
        );
        return null;
      }
      throw err;
    }
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

      // Read smoke screenshots from disk and base64-encode for the Teams card.
      // Fails-soft: missing files are skipped (logged), notification still fires.
      const screenshots: Array<{ pagePath: string; base64: string }> = [];
      for (const page of event.result.smoke.pages) {
        if (!page.screenshot) continue;
        const base64 = await readScreenshotBase64(page.screenshot);
        if (base64 !== null) {
          screenshots.push({ pagePath: page.path, base64 });
        }
      }

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

      const reason = pickFailureReason(event.result);

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
