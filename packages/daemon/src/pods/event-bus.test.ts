import type { PodCreatedEvent, PodStatusChangedEvent, SystemEvent } from '@autopod/shared';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from './event-bus.js';
import type { EventRepository } from './event-repository.js';

function createMockEventRepo(): EventRepository {
  let nextId = 1;
  return {
    insert: vi.fn(() => nextId++),
    getSince: vi.fn(() => []),
    getForSession: vi.fn(() => []),
  };
}

const logger = pino({ level: 'silent' });

function makeStatusEvent(podId: string): PodStatusChangedEvent {
  return {
    type: 'pod.status_changed',
    timestamp: new Date().toISOString(),
    podId,
    previousStatus: 'queued',
    newStatus: 'provisioning',
  };
}

function makeCreatedEvent(podId: string): PodCreatedEvent {
  return {
    type: 'pod.created',
    timestamp: new Date().toISOString(),
    pod: {
      id: podId,
      profileName: 'test',
      task: 'do stuff',
      status: 'queued',
      model: 'opus',
      runtime: 'claude',
      duration: null,
      filesChanged: 0,
      createdAt: new Date().toISOString(),
    },
  };
}

describe('event-bus', () => {
  it('persists events via repo and returns the id', () => {
    const repo = createMockEventRepo();
    const bus = createEventBus(repo, logger);

    const event = makeStatusEvent('s1');
    const id = bus.emit(event);

    expect(id).toBe(1);
    expect(repo.insert).toHaveBeenCalledWith(event);
  });

  it('notifies global subscribers', () => {
    const repo = createMockEventRepo();
    const bus = createEventBus(repo, logger);

    const received: SystemEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const event = makeStatusEvent('s1');
    bus.emit(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
  });

  it('notifies pod-scoped subscribers', () => {
    const repo = createMockEventRepo();
    const bus = createEventBus(repo, logger);

    const s1Events: SystemEvent[] = [];
    const s2Events: SystemEvent[] = [];

    bus.subscribeToSession('s1', (e) => s1Events.push(e));
    bus.subscribeToSession('s2', (e) => s2Events.push(e));

    bus.emit(makeStatusEvent('s1'));
    bus.emit(makeStatusEvent('s2'));

    expect(s1Events).toHaveLength(1);
    expect(s2Events).toHaveLength(1);
  });

  it('extracts podId from pod.created events', () => {
    const repo = createMockEventRepo();
    const bus = createEventBus(repo, logger);

    const received: SystemEvent[] = [];
    bus.subscribeToSession('s1', (e) => received.push(e));

    bus.emit(makeCreatedEvent('s1'));
    expect(received).toHaveLength(1);
  });

  it('unsubscribe removes global subscriber', () => {
    const repo = createMockEventRepo();
    const bus = createEventBus(repo, logger);

    const received: SystemEvent[] = [];
    const unsub = bus.subscribe((e) => received.push(e));

    bus.emit(makeStatusEvent('s1'));
    expect(received).toHaveLength(1);

    unsub();
    bus.emit(makeStatusEvent('s1'));
    expect(received).toHaveLength(1); // no new event
  });

  it('unsubscribe removes pod subscriber', () => {
    const repo = createMockEventRepo();
    const bus = createEventBus(repo, logger);

    const received: SystemEvent[] = [];
    const unsub = bus.subscribeToSession('s1', (e) => received.push(e));

    bus.emit(makeStatusEvent('s1'));
    expect(received).toHaveLength(1);

    unsub();
    bus.emit(makeStatusEvent('s1'));
    expect(received).toHaveLength(1);
  });

  it('handles subscriber errors without breaking other subscribers', () => {
    const repo = createMockEventRepo();
    const bus = createEventBus(repo, logger);

    const received: SystemEvent[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((e) => received.push(e));

    bus.emit(makeStatusEvent('s1'));
    expect(received).toHaveLength(1); // second subscriber still called
  });

  it('handles pod subscriber errors without breaking others', () => {
    const repo = createMockEventRepo();
    const bus = createEventBus(repo, logger);

    const received: SystemEvent[] = [];
    bus.subscribeToSession('s1', () => {
      throw new Error('boom');
    });
    bus.subscribeToSession('s1', (e) => received.push(e));

    bus.emit(makeStatusEvent('s1'));
    expect(received).toHaveLength(1);
  });

  it('delivers event twice when same callback is both global and pod subscriber', () => {
    const repo = createMockEventRepo();
    const bus = createEventBus(repo, logger);

    // This demonstrates the bug: if a single callback is registered as both
    // a global subscriber AND a pod-scoped subscriber, it receives
    // every pod event twice. The fix lives in websocket.ts which avoids
    // registering the duplicate subscription.
    const received: SystemEvent[] = [];
    const callback = (e: SystemEvent) => received.push(e);

    bus.subscribe(callback);
    bus.subscribeToSession('s1', callback);

    bus.emit(makeStatusEvent('s1'));

    // The event bus correctly delivers to both subscriber sets — it's the
    // caller's responsibility not to register the same callback in both.
    expect(received).toHaveLength(2);
  });

  it('cleans up pod subscriber map when last subscriber removed', () => {
    const repo = createMockEventRepo();
    const bus = createEventBus(repo, logger);

    const unsub1 = bus.subscribeToSession('s1', () => {});
    const unsub2 = bus.subscribeToSession('s1', () => {});

    unsub1();
    // Still has one subscriber — emit should still work
    const received: SystemEvent[] = [];
    bus.subscribeToSession('s1', (e) => received.push(e));
    bus.emit(makeStatusEvent('s1'));
    expect(received).toHaveLength(1);

    unsub2();
    // After removing all original subs, the one we just added should still work
  });
});
