import type { ProcessContentConfig, SystemEvent } from '@autopod/shared';
import { processContentDeep } from '@autopod/shared';
import type { Logger } from 'pino';
import type { EventRepository } from './event-repository.js';

export type EventSubscriber = (event: SystemEvent) => void;

export interface EventBus {
  emit(event: SystemEvent): number; // returns event id
  subscribe(subscriber: EventSubscriber): () => void; // returns unsubscribe fn
  subscribeToSession(sessionId: string, subscriber: EventSubscriber): () => void;
}

export interface EventBusOptions {
  /** Content processing config for sanitizing event payloads before broadcast */
  contentProcessing?: ProcessContentConfig;
}

export function createEventBus(
  eventRepo: EventRepository,
  logger: Logger,
  options?: EventBusOptions,
): EventBus {
  const globalSubscribers = new Set<EventSubscriber>();
  const sessionSubscribers = new Map<string, Set<EventSubscriber>>();

  function getSessionId(event: SystemEvent): string | null {
    if ('sessionId' in event) return event.sessionId;
    if ('session' in event && event.session) return (event.session as { id: string }).id;
    return null;
  }

  return {
    emit(event: SystemEvent): number {
      // Persist first (raw event — audit trail gets the unmodified version)
      const id = eventRepo.insert(event);

      // Sanitize event payload before broadcasting to subscribers
      // This prevents PII/injection content from leaking via WebSocket broadcasts
      const sanitizedEvent = options?.contentProcessing
        ? (processContentDeep(event, options.contentProcessing).result as SystemEvent)
        : event;

      // Tag with persisted event ID so WebSocket clients can track for replay
      (sanitizedEvent as SystemEvent & { _eventId?: number })._eventId = id;

      // Broadcast to global subscribers
      for (const sub of globalSubscribers) {
        try {
          sub(sanitizedEvent);
        } catch (err) {
          logger.error({ err }, 'Event subscriber error');
        }
      }

      // Broadcast to session-scoped subscribers
      const sessionId = getSessionId(event);
      if (sessionId) {
        const subs = sessionSubscribers.get(sessionId);
        if (subs) {
          for (const sub of subs) {
            try {
              sub(sanitizedEvent);
            } catch (err) {
              logger.error({ err }, 'Session subscriber error');
            }
          }
        }
      }

      return id;
    },

    subscribe(subscriber: EventSubscriber): () => void {
      globalSubscribers.add(subscriber);
      return () => {
        globalSubscribers.delete(subscriber);
      };
    },

    subscribeToSession(sessionId: string, subscriber: EventSubscriber): () => void {
      if (!sessionSubscribers.has(sessionId)) {
        sessionSubscribers.set(sessionId, new Set());
      }
      sessionSubscribers.get(sessionId)?.add(subscriber);
      return () => {
        const subs = sessionSubscribers.get(sessionId);
        if (subs) {
          subs.delete(subscriber);
          if (subs.size === 0) sessionSubscribers.delete(sessionId);
        }
      };
    },
  };
}
