import type { JwtPayload, Pod } from '@autopod/shared';
import type Dockerode from 'dockerode';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { AuthModule } from '../../interfaces/index.js';
import type { ContainerManagerFactory, PodManager } from '../../pods/pod-manager.js';
import { extractWebSocketBearerToken } from '../websocket-auth.js';

type TerminalStream = NodeJS.ReadWriteStream & { destroy?: () => void };

/**
 * WebSocket terminal endpoint — interactive shell into running containers.
 *
 * WS /pods/:podId/terminal?cols=80&rows=24
 *
 * - Auth via Authorization: Bearer or browser WebSocket subprotocol
 * - Creates Docker exec with Tty: true, AttachStdin: true
 * - Bidirectional binary frames for stdin/stdout
 * - JSON control frames for resize: { "type": "resize", "cols": N, "rows": N }
 * - Closes when exec exits or client disconnects
 */
export function terminalRoutes(
  app: FastifyInstance,
  podManager: PodManager,
  containerManagerFactory: ContainerManagerFactory,
  authModule: AuthModule,
  docker: Dockerode,
): void {
  // Track active terminal connections per pod. Multiple simultaneous tmux
  // clients cause duplicated/amplified output — "last writer wins" evicts the
  // old connection when a new one arrives (the new one is the reconnect).
  const activeTerminals = new Map<string, WebSocket>();

  app.get(
    '/pods/:podId/terminal',
    { websocket: true, config: { auth: false, rateLimit: false } },
    async (socket: WebSocket, request) => {
      const { podId } = request.params as { podId: string };
      const url = new URL(request.url, 'http://localhost');
      const token = extractWebSocketBearerToken(request);
      const cols = Number.parseInt(url.searchParams.get('cols') ?? '80', 10);
      const rows = Number.parseInt(url.searchParams.get('rows') ?? '24', 10);

      // Auth
      if (!token) {
        socket.close(4001, 'Missing token');
        return;
      }
      let user: JwtPayload;
      try {
        user = await authModule.validateToken(token);
      } catch {
        socket.close(4001, 'Invalid token');
        return;
      }

      // Get pod and container
      let pod: Pod;
      try {
        pod = podManager.getSession(podId);
      } catch {
        socket.close(4004, 'Pod not found');
        return;
      }

      if (!canAccessPodTerminal(user, pod)) {
        socket.close(4003, 'Forbidden');
        return;
      }

      if (!pod.containerId) {
        socket.close(4004, 'No container for pod');
        return;
      }

      if (pod.status !== 'running' && pod.status !== 'paused' && pod.status !== 'awaiting_input') {
        socket.close(4004, `Container not active (status: ${pod.status})`);
        return;
      }

      const containerId = pod.containerId;

      // Evict any existing terminal connection for this pod — two tmux
      // clients on the same pod cause output duplication / feedback loops.
      const existing = activeTerminals.get(podId);
      if (existing) {
        request.log.info({ podId }, 'Evicting previous terminal connection');
        existing.close(4000, 'Superseded by new connection');
      }
      activeTerminals.set(podId, socket);

      // Backend-specific teardown (Docker exec stream destroy / sandbox session
      // close), registered once the backend attaches.
      let closeBackend: (() => void) | undefined;
      let cleanedUp = false;
      const cleanupTerminal = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (activeTerminals.get(podId) === socket) {
          activeTerminals.delete(podId);
        }
        try {
          closeBackend?.();
        } catch {
          // Best effort cleanup
        }
      };

      socket.once('close', cleanupTerminal);
      socket.on('error', (err: Error) => {
        request.log.error({ err, podId }, 'Terminal WebSocket error');
      });

      const clampDimension = (value: number): number => Math.max(1, Math.min(value, 500));

      // Sandbox (non-local) pods have no Docker exec — proxy the terminal over
      // the container manager's TTY session (exec-stream WebSocket).
      if (pod.executionTarget !== 'local') {
        const cm = containerManagerFactory.get(pod.executionTarget);
        if (!cm.attachTerminal) {
          socket.close(
            4004,
            `Interactive terminal not supported for target ${pod.executionTarget}`,
          );
          cleanupTerminal();
          return;
        }
        try {
          const session = await cm.attachTerminal(containerId, { cols, rows });
          closeBackend = () => session.close();
          if (cleanedUp) {
            session.close();
            return;
          }

          session.onData((chunk) => {
            if (socket.readyState === socket.OPEN) socket.send(chunk, { binary: true });
          });
          session.onExit((exitCode) => {
            socket.close(1000, `exit:${exitCode}`);
          });
          session.onError((err) => {
            request.log.error({ err, podId }, 'Sandbox terminal session error');
            socket.close(1011, 'Stream error');
          });

          socket.on('message', (rawData: Buffer, isBinary: boolean) => {
            if (!isBinary) {
              const text = rawData.toString('utf8');
              try {
                const msg = JSON.parse(text);
                if (
                  msg.type === 'resize' &&
                  typeof msg.cols === 'number' &&
                  typeof msg.rows === 'number'
                ) {
                  session.resize(clampDimension(msg.cols), clampDimension(msg.rows));
                  return;
                }
              } catch {
                // Not JSON — treat as text input
              }
              session.write(Buffer.from(text, 'utf8'));
            } else {
              session.write(rawData);
            }
          });

          request.log.info(
            { podId, containerId, cols, rows, target: pod.executionTarget },
            'Sandbox terminal session started',
          );
        } catch (err) {
          request.log.error({ err, podId }, 'Failed to start sandbox terminal');
          cleanupTerminal();
          socket.close(1011, 'Failed to start terminal');
        }
        return;
      }

      const container = docker.getContainer(containerId);

      // Create exec with TTY
      const startTerminal = async () => {
        try {
          // Use tmux if available — `new-session -A -s main` creates or reattaches
          // to a persistent session named "main". This means WebSocket reconnects
          // pick up right where the user left off instead of losing shell state.
          // Falls back to plain bash if tmux isn't installed.
          const exec = await container.exec({
            Cmd: [
              '/bin/sh',
              '-c',
              'command -v tmux >/dev/null 2>&1 && exec tmux new-session -A -s main \\; set -g mouse on || exec /bin/bash -l',
            ],
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            Tty: true,
            Env: ['TERM=xterm-256color', `COLUMNS=${cols}`, `LINES=${rows}`],
            WorkingDir: '/workspace',
          });

          const startedStream = (await exec.start({
            hijack: true,
            stdin: true,
            Tty: true,
          })) as TerminalStream;
          closeBackend = () => startedStream.destroy?.();
          if (cleanedUp) {
            startedStream.destroy?.();
            return;
          }

          // stdout → WebSocket (binary frames)
          startedStream.on('data', (chunk: Buffer) => {
            if (socket.readyState === socket.OPEN) {
              socket.send(chunk, { binary: true });
            }
          });

          startedStream.on('end', () => {
            // Exec finished — close WebSocket with exit code
            exec
              .inspect()
              .then((info) => {
                const exitCode = info.ExitCode ?? 0;
                socket.close(1000, `exit:${exitCode}`);
              })
              .catch(() => {
                socket.close(1000, 'exit:0');
              });
          });

          startedStream.on('error', (err: Error) => {
            request.log.error({ err, podId }, 'Terminal stream error');
            socket.close(1011, 'Stream error');
          });

          // WebSocket → stdin
          // Note: the `ws` library delivers all messages as Buffer regardless of
          // frame type. The second parameter `isBinary` distinguishes text frames
          // (used for JSON control messages like resize) from binary frames (raw
          // stdin bytes). We must NOT use `typeof data === 'string'` — it's always
          // false with `ws`.
          socket.on('message', (rawData: Buffer, isBinary: boolean) => {
            if (!isBinary) {
              // Text frame — might be a JSON control message
              const text = rawData.toString('utf8');
              try {
                const msg = JSON.parse(text);
                if (
                  msg.type === 'resize' &&
                  typeof msg.cols === 'number' &&
                  typeof msg.rows === 'number'
                ) {
                  // Clamp to sane values — the desktop client can send bogus dimensions
                  // before layout settles (e.g. cols=-2 from a zero-frame TerminalView).
                  const w = Math.max(1, Math.min(msg.cols, 500));
                  const h = Math.max(1, Math.min(msg.rows, 500));
                  exec.resize({ h, w }).catch((err: Error) => {
                    request.log.warn({ err, podId }, 'Terminal resize failed');
                  });
                  return;
                }
              } catch {
                // Not JSON — treat as text input
              }
              startedStream.write(text);
            } else {
              // Binary frame — raw stdin bytes
              startedStream.write(rawData);
            }
          });

          request.log.info({ podId, containerId, cols, rows }, 'Terminal pod started');
        } catch (err) {
          request.log.error({ err, podId }, 'Failed to start terminal');
          cleanupTerminal();
          socket.close(1011, 'Failed to start terminal');
        }
      };

      startTerminal();
    },
  );
}

function canAccessPodTerminal(user: JwtPayload, pod: Pod): boolean {
  return pod.userId === user.oid || user.roles.includes('admin') || user.roles.includes('operator');
}
