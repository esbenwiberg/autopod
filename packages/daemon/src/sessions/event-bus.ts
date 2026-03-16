import type { SystemEvent } from '@autopod/shared';
import type { EventRepository } from './event-repository.js';
import type { Logger } from 'pino';

export type EventSubscriber = (event: SystemEvent) => void;

export interface EventBus {
  emit(event: SystemEvent): number; // returns event id
  subscribe(subscriber: EventSubscriber): () => void; // returns unsubscribe fn
  subscribeToSession(sessionId: string, subscriber: EventSubscriber): () => void;
}

export function createEventBus(eventRepo: EventRepository, logger: Logger): EventBus {
  const globalSubscribers = new Set<EventSubscriber>();
  const sessionSubscribers = new Map<string, Set<EventSubscriber>>();

  function getSessionId(event: SystemEvent): string | null {
    if ('sessionId' in event) return event.sessionId;
    if ('session' in event && event.session) return (event.session as { id: string }).id;
    return null;
  }

  return {
    emit(event: SystemEvent): number {
      // Persist first
      const id = eventRepo.insert(event);

      // Broadcast to global subscribers
      for (const sub of globalSubscribers) {
        try { sub(event); } catch (err) { logger.error({ err }, 'Event subscriber error'); }
      }

      // Broadcast to session-scoped subscribers
      const sessionId = getSessionId(event);
      if (sessionId) {
        const subs = sessionSubscribers.get(sessionId);
        if (subs) {
          for (const sub of subs) {
            try { sub(event); } catch (err) { logger.error({ err }, 'Session subscriber error'); }
          }
        }
      }

      return id;
    },

    subscribe(subscriber: EventSubscriber): () => void {
      globalSubscribers.add(subscriber);
      return () => { globalSubscribers.delete(subscriber); };
    },

    subscribeToSession(sessionId: string, subscriber: EventSubscriber): () => void {
      if (!sessionSubscribers.has(sessionId)) {
        sessionSubscribers.set(sessionId, new Set());
      }
      sessionSubscribers.get(sessionId)!.add(subscriber);
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
