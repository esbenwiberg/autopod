import type { FastifyInstance } from 'fastify';
import type { AuthModule } from '../interfaces/index.js';
import type { SessionManager } from '../sessions/index.js';

/**
 * WebSocket terminal endpoint: GET /sessions/:sessionId/terminal
 *
 * Protocol (binary-safe duplex):
 *   Client → Server:
 *     - Binary frame: raw stdin bytes
 *     - Text frame:   JSON control message
 *       { type: 'resize', cols: number, rows: number }
 *
 *   Server → Client:
 *     - Binary frame: raw terminal output (stdout+stderr merged via TTY)
 *     - Text frame:   JSON control message
 *       { type: 'ready' }
 *       { type: 'exit', code: number }
 *       { type: 'error', message: string }
 */
export function terminalHandler(
  app: FastifyInstance,
  authModule: AuthModule,
  sessionManager: SessionManager,
): void {
  app.get(
    '/sessions/:sessionId/terminal',
    { websocket: true, config: { auth: false } },
    (socket, request) => {
      const { sessionId } = request.params as { sessionId: string };

      // Auth via query param (same pattern as /events)
      const url = new URL(request.url, 'http://localhost');
      const token = url.searchParams.get('token');

      if (!token) {
        socket.close(4001, 'Missing token');
        return;
      }

      try {
        authModule.validateTokenSync(token);
      } catch {
        socket.close(4001, 'Invalid token');
        return;
      }

      const initialCols = Number(url.searchParams.get('cols') ?? 80);
      const initialRows = Number(url.searchParams.get('rows') ?? 24);

      // Open terminal asynchronously
      sessionManager
        .openTerminal(sessionId, { cols: initialCols, rows: initialRows })
        .then((tty) => {
          if (socket.readyState !== socket.OPEN) {
            tty.kill().catch(() => {});
            return;
          }

          socket.send(JSON.stringify({ type: 'ready' }));

          // Forward container output → WebSocket (binary frames)
          tty.output.on('data', (chunk: Buffer) => {
            if (socket.readyState === socket.OPEN) {
              socket.send(chunk);
            }
          });

          tty.output.on('end', () => {
            tty.exitCode
              .then((code) => {
                if (socket.readyState === socket.OPEN) {
                  socket.send(JSON.stringify({ type: 'exit', code }));
                  socket.close(1000, 'Process exited');
                }
              })
              .catch(() => {});
          });

          tty.output.on('error', () => {
            if (socket.readyState === socket.OPEN) {
              socket.close(1011, 'Stream error');
            }
          });

          // Forward WebSocket → container stdin / resize
          socket.on('message', (data: Buffer, isBinary: boolean) => {
            if (isBinary) {
              tty.write(data);
            } else {
              try {
                const msg = JSON.parse(data.toString()) as {
                  type: string;
                  cols?: number;
                  rows?: number;
                };
                if (msg.type === 'resize' && msg.cols && msg.rows) {
                  tty.resize(msg.cols, msg.rows).catch(() => {});
                }
              } catch {
                // Ignore malformed text frames
              }
            }
          });

          socket.on('close', () => {
            tty.kill().catch(() => {});
          });

          socket.on('error', () => {
            tty.kill().catch(() => {});
          });
        })
        .catch((err: unknown) => {
          request.log.warn({ err, sessionId }, 'Failed to open terminal');
          if (socket.readyState === socket.OPEN) {
            const message = err instanceof Error ? err.message : 'Failed to open terminal';
            socket.send(JSON.stringify({ type: 'error', message }));
            socket.close(1011, 'Terminal error');
          }
        });
    },
  );
}
