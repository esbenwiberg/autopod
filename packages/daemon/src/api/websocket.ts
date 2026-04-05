import type { SystemEvent } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { AuthModule } from '../interfaces/index.js';
import type { EventBus, EventRepository } from '../sessions/index.js';

interface WsClient {
  ws: WebSocket;
  userId: string;
  subscriptions: Set<string>; // session IDs or '*' for all
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

        if (msg.type === 'subscribe' && msg.sessionId) {
          // Only register a session-scoped subscription if the client doesn't already
          // have a global subscription — otherwise the same event gets delivered twice
          // (once via global, once via session-scoped).
          if (!client.subscriptions.has('*')) {
            const unsub = eventBus.subscribeToSession(msg.sessionId, sendEvent);
            client.unsubscribers.set(msg.sessionId, unsub);
          }
          client.subscriptions.add(msg.sessionId);
          socket.send(JSON.stringify({ type: 'subscribed', sessionId: msg.sessionId }));
        } else if (msg.type === 'unsubscribe' && msg.sessionId) {
          const unsub = client.unsubscribers.get(msg.sessionId);
          if (unsub) unsub();
          client.subscriptions.delete(msg.sessionId);
          client.unsubscribers.delete(msg.sessionId);
          socket.send(JSON.stringify({ type: 'unsubscribed', sessionId: msg.sessionId }));
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
