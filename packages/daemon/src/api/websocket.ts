import type { SystemEvent } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { AuthModule } from '../interfaces/index.js';
import type { EventBus, EventRepository } from '../pods/index.js';

// Replay is paged so a long-disconnected client can't block the daemon's event
// loop. Each page yields back to the loop via setImmediate; the hard cap stops
// runaway replays from clients that are days behind — they refetch via REST.
const REPLAY_PAGE_SIZE = 500;
const REPLAY_MAX_EVENTS = 10_000;

/** Minimal socket surface needed by the replay path — keeps the helper testable. */
export interface ReplaySocket {
  readyState: number;
  OPEN: number;
  send(data: string): void;
}

export interface ReplayOptions {
  pageSize?: number;
  maxEvents?: number;
}

export async function replayEvents(
  socket: ReplaySocket,
  eventRepo: EventRepository,
  lastEventId: number,
  options: ReplayOptions = {},
): Promise<void> {
  const pageSize = options.pageSize ?? REPLAY_PAGE_SIZE;
  const maxEvents = options.maxEvents ?? REPLAY_MAX_EVENTS;
  let cursor = lastEventId;
  let totalSent = 0;

  while (totalSent < maxEvents) {
    if (socket.readyState !== socket.OPEN) return;
    const remaining = maxEvents - totalSent;
    const page = eventRepo.getSince(cursor, Math.min(pageSize, remaining));
    if (page.length === 0) break;
    for (const stored of page) {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify({ ...stored.payload, _eventId: stored.id }));
    }
    const last = page[page.length - 1];
    if (!last) break;
    cursor = last.id;
    totalSent += page.length;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  if (socket.readyState !== socket.OPEN) return;

  // If we hit the cap and there may be more on disk, signal the client to
  // resync via REST instead of incremental replay.
  const moreAvailable = totalSent >= maxEvents && eventRepo.getSince(cursor, 1).length > 0;
  if (moreAvailable) {
    socket.send(
      JSON.stringify({
        type: 'replay_truncated',
        resumeFromEventId: cursor,
        reason: 'too_many_events',
      }),
    );
  } else {
    socket.send(JSON.stringify({ type: 'replay_complete', lastEventId: cursor }));
  }
}

interface WsClient {
  ws: WebSocket;
  userId: string;
  subscriptions: Set<string>; // pod IDs or '*' for all
  unsubscribers: Map<string, () => void>;
}

export function websocketHandler(
  app: FastifyInstance,
  authModule: AuthModule,
  eventBus: EventBus,
  eventRepo: EventRepository,
): void {
  const clients = new Set<WsClient>();

  app.get('/events', { websocket: true, config: { auth: false } }, (socket, request) => {
    // Auth via query param
    const url = new URL(request.url, 'http://localhost');
    const token = url.searchParams.get('token');

    if (!token) {
      socket.close(4001, 'Missing token');
      return;
    }

    let userId: string;
    try {
      const payload = authModule.validateTokenSync(token);
      userId = payload.oid;
    } catch {
      socket.close(4001, 'Invalid token');
      return;
    }

    const client: WsClient = {
      ws: socket,
      userId,
      subscriptions: new Set(),
      unsubscribers: new Map(),
    };
    clients.add(client);

    // Heartbeat
    const heartbeat = setInterval(() => {
      if (socket.readyState === socket.OPEN) {
        socket.ping();
      }
    }, 30_000);

    function sendEvent(event: SystemEvent) {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    }

    socket.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'subscribe' && msg.podId) {
          // Only register a pod-scoped subscription if the client doesn't already
          // have a global subscription — otherwise the same event gets delivered twice
          // (once via global, once via pod-scoped).
          if (!client.subscriptions.has('*')) {
            const unsub = eventBus.subscribeToSession(msg.podId, sendEvent);
            client.unsubscribers.set(msg.podId, unsub);
          }
          client.subscriptions.add(msg.podId);
          socket.send(JSON.stringify({ type: 'subscribed', podId: msg.podId }));
        } else if (msg.type === 'unsubscribe' && msg.podId) {
          const unsub = client.unsubscribers.get(msg.podId);
          if (unsub) unsub();
          client.subscriptions.delete(msg.podId);
          client.unsubscribers.delete(msg.podId);
          socket.send(JSON.stringify({ type: 'unsubscribed', podId: msg.podId }));
        } else if (msg.type === 'subscribe_all') {
          const unsub = eventBus.subscribe(sendEvent);
          client.subscriptions.add('*');
          client.unsubscribers.set('*', unsub);
          socket.send(JSON.stringify({ type: 'subscribed_all' }));
        } else if (msg.type === 'replay' && typeof msg.lastEventId === 'number') {
          replayEvents(socket, eventRepo, msg.lastEventId).catch((err) => {
            request.log.warn({ err }, 'Replay failed');
          });
        } else if (!['subscribe', 'unsubscribe', 'subscribe_all', 'replay'].includes(msg.type)) {
          request.log.warn({ msgType: msg.type }, 'Unknown WS message type');
          socket.send(
            JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }),
          );
        }
      } catch (err) {
        request.log.warn({ err }, 'Invalid WS message');
      }
    });

    socket.on('close', () => {
      clearInterval(heartbeat);
      for (const unsub of client.unsubscribers.values()) unsub();
      clients.delete(client);
    });

    socket.on('error', (err) => {
      request.log.error({ err }, 'WebSocket error');
    });
  });
}
