import type { FastifyInstance } from 'fastify';
import type Dockerode from 'dockerode';
import type { WebSocket } from 'ws';
import type { AuthModule } from '../../interfaces/index.js';
import type { ContainerManagerFactory, SessionManager } from '../../sessions/session-manager.js';

/**
 * WebSocket terminal endpoint — interactive shell into running containers.
 *
 * WS /sessions/:sessionId/terminal?token=<token>&cols=80&rows=24
 *
 * - Auth via token query param (same as /events)
 * - Creates Docker exec with Tty: true, AttachStdin: true
 * - Bidirectional binary frames for stdin/stdout
 * - JSON control frames for resize: { "type": "resize", "cols": N, "rows": N }
 * - Closes when exec exits or client disconnects
 */
export function terminalRoutes(
  app: FastifyInstance,
  sessionManager: SessionManager,
  containerManagerFactory: ContainerManagerFactory,
  authModule: AuthModule,
  docker: Dockerode,
): void {
  app.get(
    '/sessions/:sessionId/terminal',
    { websocket: true, config: { auth: false } },
    (socket: WebSocket, request) => {
      const { sessionId } = request.params as { sessionId: string };
      const url = new URL(request.url, 'http://localhost');
      const token = url.searchParams.get('token');
      const cols = parseInt(url.searchParams.get('cols') ?? '80', 10);
      const rows = parseInt(url.searchParams.get('rows') ?? '24', 10);

      // Auth
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

      // Get session and container
      let session;
      try {
        session = sessionManager.getSession(sessionId);
      } catch {
        socket.close(4004, 'Session not found');
        return;
      }

      if (!session.containerId) {
        socket.close(4004, 'No container for session');
        return;
      }

      if (session.status !== 'running' && session.status !== 'paused' && session.status !== 'awaiting_input') {
        socket.close(4004, `Container not active (status: ${session.status})`);
        return;
      }

      const containerId = session.containerId;
      const container = docker.getContainer(containerId);

      // Create exec with TTY
      const startTerminal = async () => {
        try {
          const exec = await container.exec({
            Cmd: ['/bin/bash', '-l'],
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            Tty: true,
            Env: [`TERM=xterm-256color`, `COLUMNS=${cols}`, `LINES=${rows}`],
            WorkingDir: '/workspace',
          });

          const stream = await exec.start({
            hijack: true,
            stdin: true,
            Tty: true,
          } as any);

          // stdout → WebSocket (binary frames)
          stream.on('data', (chunk: Buffer) => {
            if (socket.readyState === socket.OPEN) {
              socket.send(chunk);
            }
          });

          stream.on('end', () => {
            // Exec finished — close WebSocket with exit code
            exec.inspect().then((info) => {
              const exitCode = info.ExitCode ?? 0;
              socket.close(1000, `exit:${exitCode}`);
            }).catch(() => {
              socket.close(1000, 'exit:0');
            });
          });

          stream.on('error', (err: Error) => {
            request.log.error({ err, sessionId }, 'Terminal stream error');
            socket.close(1011, 'Stream error');
          });

          // WebSocket → stdin
          socket.on('message', (data: Buffer | string) => {
            if (typeof data === 'string') {
              // Try to parse as JSON control message
              try {
                const msg = JSON.parse(data);
                if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
                  // Resize the TTY
                  exec.resize({ h: msg.rows, w: msg.cols }).catch((err: Error) => {
                    request.log.warn({ err, sessionId }, 'Terminal resize failed');
                  });
                  return;
                }
              } catch {
                // Not JSON — treat as text input
              }
              stream.write(data);
            } else {
              // Binary frame — raw stdin bytes
              stream.write(data);
            }
          });

          socket.on('close', () => {
            // Client disconnected — kill the exec stream
            try {
              if ('destroy' in stream && typeof (stream as any).destroy === 'function') {
                (stream as any).destroy();
              }
            } catch {
              // Best effort cleanup
            }
          });

          socket.on('error', (err: Error) => {
            request.log.error({ err, sessionId }, 'Terminal WebSocket error');
          });

          request.log.info({ sessionId, containerId, cols, rows }, 'Terminal session started');
        } catch (err) {
          request.log.error({ err, sessionId }, 'Failed to start terminal');
          socket.close(1011, 'Failed to start terminal');
        }
      };

      startTerminal();
    },
  );
}
