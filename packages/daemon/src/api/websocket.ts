import type { SystemEvent } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { AuthModule } from '../interfaces/index.js';
import type { EventBus, EventRepository } from '../pods/index.js';

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
          const events = eventRepo.getSince(msg.lastEventId);
          for (const stored of events) {
            socket.send(JSON.stringify({ ...stored.payload, _eventId: stored.id }));
          }
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
