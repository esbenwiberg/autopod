import type { SystemEvent } from '@autopod/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEY } from './token.js';
import { WsClient } from './ws-client.js';

/**
 * Minimal in-test mock of the WebSocket interface. Captures sent frames and
 * exposes triggers for open / message / close so the reconnect + replay logic
 * can be exercised deterministically.
 */
function lastSocket(): MockSocket {
  const s = MockSocket.instances.at(-1);
  if (!s) throw new Error('expected a mock socket to have been created');
  return s;
}

class MockSocket {
  static instances: MockSocket[] = [];
  readyState = 0;
  url: string;
  protocols: string | string[] | undefined;
  sent: string[] = [];
  listeners = new Map<string, ((ev: unknown) => void)[]>();

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    MockSocket.instances.push(this);
  }
  addEventListener(name: string, fn: (ev: unknown) => void): void {
    const arr = this.listeners.get(name) ?? [];
    arr.push(fn);
    this.listeners.set(name, arr);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.trigger('close', {});
  }
  trigger(name: string, ev: unknown): void {
    for (const fn of this.listeners.get(name) ?? []) fn(ev);
  }
  triggerMessage(payload: unknown): void {
    this.trigger('message', { data: JSON.stringify(payload) } as MessageEvent);
  }
}

describe('WsClient', () => {
  beforeEach(() => {
    MockSocket.instances = [];
    window.localStorage.setItem(STORAGE_KEY, 'tok');
    vi.useFakeTimers();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it('connects, sends subscribe_all on open, and surfaces domain events to onEvent', () => {
    const events: SystemEvent[] = [];
    const client = new WsClient({ onEvent: (e) => events.push(e) });
    client.start();

    const socket = lastSocket();
    expect(socket.url).toContain('/events');
    expect(socket.url).not.toContain('token=');
    expect(socket.protocols).toEqual(['autopod', 'autopod.bearer.dG9r']);

    socket.trigger('open', {});
    expect(socket.sent).toContain(JSON.stringify({ type: 'subscribe_all' }));

    socket.triggerMessage({
      type: 'pod.status_changed',
      timestamp: 't',
      podId: 'p1',
      previousStatus: 'queued',
      newStatus: 'running',
      _eventId: 7,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'pod.status_changed', podId: 'p1' });
    // `_eventId` is stripped from the surfaced event
    expect((events[0] as unknown as Record<string, unknown>)._eventId).toBeUndefined();
  });

  it('ignores control frames (subscribed_all / replay_complete / error)', () => {
    const events: SystemEvent[] = [];
    const client = new WsClient({ onEvent: (e) => events.push(e) });
    client.start();
    const socket = lastSocket();
    socket.trigger('open', {});

    socket.triggerMessage({ type: 'subscribed_all' });
    socket.triggerMessage({ type: 'replay_complete', lastEventId: 0 });
    socket.triggerMessage({ type: 'error', message: 'oops' });

    expect(events).toHaveLength(0);
  });

  it('fires onReplayTruncated when the server signals overflow', () => {
    const truncated = vi.fn();
    const client = new WsClient({ onEvent: () => undefined, onReplayTruncated: truncated });
    client.start();
    const socket = lastSocket();
    socket.trigger('open', {});

    socket.triggerMessage({ type: 'replay_truncated', resumeFromEventId: 100, reason: 'cap' });
    expect(truncated).toHaveBeenCalledTimes(1);
  });

  it('reconnects with exponential backoff and replays from the last seen event id', () => {
    const client = new WsClient({ onEvent: () => undefined });
    client.start();

    const first = lastSocket();
    first.trigger('open', {});
    first.triggerMessage({
      type: 'pod.status_changed',
      timestamp: 't',
      podId: 'p1',
      previousStatus: 'queued',
      newStatus: 'running',
      _eventId: 42,
    });
    first.close();

    vi.advanceTimersByTime(1000);
    const second = MockSocket.instances[1];
    expect(second).toBeDefined();
    second?.trigger('open', {});
    expect(second?.sent[0]).toBe(JSON.stringify({ type: 'replay', lastEventId: 42 }));
    expect(second?.sent[1]).toBe(JSON.stringify({ type: 'subscribe_all' }));
  });

  it('reports connection state changes', () => {
    const states: boolean[] = [];
    const client = new WsClient({
      onEvent: () => undefined,
      onConnectionChange: (c) => states.push(c),
    });
    client.start();
    const socket = lastSocket();
    socket.trigger('open', {});
    socket.close();

    expect(states).toEqual([true, false]);
  });

  it('stop() prevents reconnect', () => {
    const client = new WsClient({ onEvent: () => undefined });
    client.start();
    const socket = lastSocket();
    socket.trigger('open', {});
    client.stop();
    vi.advanceTimersByTime(60_000);
    expect(MockSocket.instances).toHaveLength(1);
  });

  it('does not connect when no token is stored', () => {
    window.localStorage.clear();
    const client = new WsClient({ onEvent: () => undefined });
    client.start();
    expect(MockSocket.instances).toHaveLength(0);
  });
});
