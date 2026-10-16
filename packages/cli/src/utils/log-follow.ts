import type { EventEmitter } from 'node:events';
import { AuthError } from '@autopod/shared';
import type { RawData } from 'ws';

interface FollowSocket extends Pick<EventEmitter, 'on' | 'removeListener'> {
  send(data: string, callback: (error?: Error) => void): void;
  terminate(): void;
}

/** Own one read-only subscription until its socket closes. The first cause wins. */
export function followLogs(
  socket: FollowSocket,
  podId: string,
  callbacks: { onOpen: () => void; onEvent: (event: { type: string }) => void },
  signals: Pick<EventEmitter, 'on' | 'removeListener'> = process,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // undefined is still following, null is intentional cancellation.
    let outcome: Error | null | undefined;
    let settled = false;

    function stop(error: Error | null) {
      if (outcome !== undefined || settled) return;
      outcome = error;
      // Unlike close(), terminate() cannot wait on an uncooperative peer. While
      // CONNECTING it emits error asynchronously, so keep handlers until close.
      socket.terminate();
    }

    function onError(error: Error) {
      stop(new Error(`WebSocket error: ${error.message}`));
    }

    function onOpen() {
      if (outcome !== undefined) return;
      try {
        socket.send(JSON.stringify({ type: 'subscribe', podId }), (error) => {
          if (error) onError(error);
        });
        if (outcome === undefined) callbacks.onOpen();
      } catch (error) {
        stop(error instanceof Error ? error : new Error('Log stream subscription failed.'));
      }
    }

    function onMessage(data: RawData) {
      if (outcome !== undefined) return;
      let event: { type: string };
      try {
        event = JSON.parse(data.toString()) as { type: string };
        if (event.type === 'error') {
          stop(new Error('Log stream subscription failed.'));
          return;
        }
        if (['subscribed', 'unsubscribed', 'subscribed_all'].includes(event.type)) return;
        callbacks.onEvent(event);
      } catch {
        // Keep the existing tolerance of malformed/unsupported log messages.
      }
    }

    function onInterrupt() {
      stop(null);
    }

    function onClose(code: number) {
      if (settled) return;
      settled = true;
      if (outcome === undefined) {
        outcome =
          code === 4001
            ? new AuthError('Log stream authentication failed.')
            : new Error(
                `Log stream disconnected (code ${code}).\nRun ap logs ${podId} --follow to reconnect.`,
              );
      }
      socket.removeListener('open', onOpen);
      socket.removeListener('message', onMessage);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      signals.removeListener('SIGINT', onInterrupt);
      if (outcome) reject(outcome);
      else resolve();
    }

    socket.on('open', onOpen);
    socket.on('message', onMessage);
    socket.on('error', onError);
    socket.on('close', onClose);
    signals.on('SIGINT', onInterrupt);
  });
}
