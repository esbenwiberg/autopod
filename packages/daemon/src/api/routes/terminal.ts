import type { Pod } from '@autopod/shared';
import type Dockerode from 'dockerode';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { AuthModule } from '../../interfaces/index.js';
import type { ContainerManagerFactory, PodManager } from '../../pods/pod-manager.js';

/**
 * WebSocket terminal endpoint — interactive shell into running containers.
 *
 * WS /pods/:podId/terminal?token=<token>&cols=80&rows=24
 *
 * - Auth via token query param (same as /events)
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
    { websocket: true, config: { auth: false } },
    (socket: WebSocket, request) => {
      const { podId } = request.params as { podId: string };
      const url = new URL(request.url, 'http://localhost');
      const token = url.searchParams.get('token');
      const cols = Number.parseInt(url.searchParams.get('cols') ?? '80', 10);
      const rows = Number.parseInt(url.searchParams.get('rows') ?? '24', 10);

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

      // Get pod and container
      let pod: Pod;
      try {
        pod = podManager.getSession(podId);
      } catch {
        socket.close(4004, 'Pod not found');
        return;
      }

      if (!pod.containerId) {
        socket.close(4004, 'No container for pod');
        return;
      }

      if (
        pod.status !== 'running' &&
        pod.status !== 'paused' &&
        pod.status !== 'awaiting_input'
      ) {
        socket.close(4004, `Container not active (status: ${pod.status})`);
        return;
      }

      const containerId = pod.containerId;
      const container = docker.getContainer(containerId);

      // Evict any existing terminal connection for this pod — two tmux
      // clients on the same pod cause output duplication / feedback loops.
      const existing = activeTerminals.get(podId);
      if (existing) {
        request.log.info({ podId }, 'Evicting previous terminal connection');
        existing.close(4000, 'Superseded by new connection');
      }
      activeTerminals.set(podId, socket);

      // Create exec with TTY
      const startTerminal = async () => {
        try {
          // Use tmux if available — `new-pod -A -s main` creates or reattaches
          // to a persistent pod named "main". This means WebSocket reconnects
          // pick up right where the user left off instead of losing shell state.
          // Falls back to plain bash if tmux isn't installed.
          const exec = await container.exec({
            Cmd: [
              '/bin/sh',
              '-c',
              'command -v tmux >/dev/null 2>&1 && exec tmux new-pod -A -s main \\; set -g mouse on || exec /bin/bash -l',
            ],
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            Tty: true,
            Env: ['TERM=xterm-256color', `COLUMNS=${cols}`, `LINES=${rows}`],
            WorkingDir: '/workspace',
          });

          const stream = await exec.start({ hijack: true, stdin: true, Tty: true });

          // stdout → WebSocket (binary frames)
          stream.on('data', (chunk: Buffer) => {
            if (socket.readyState === socket.OPEN) {
              socket.send(chunk, { binary: true });
            }
          });

          stream.on('end', () => {
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

          stream.on('error', (err: Error) => {
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
              stream.write(text);
            } else {
              // Binary frame — raw stdin bytes
              stream.write(rawData);
            }
          });

          socket.on('close', () => {
            // Only remove tracking if WE are still the active connection —
            // a late close from an evicted socket must not remove the new one.
            if (activeTerminals.get(podId) === socket) {
              activeTerminals.delete(podId);
            }
            // Client disconnected — kill the exec stream
            try {
              const destroyable = stream as NodeJS.ReadWriteStream & { destroy?: () => void };
              if (typeof destroyable.destroy === 'function') {
                destroyable.destroy();
              }
            } catch {
              // Best effort cleanup
            }
          });

          socket.on('error', (err: Error) => {
            request.log.error({ err, podId }, 'Terminal WebSocket error');
          });

          request.log.info({ podId, containerId, cols, rows }, 'Terminal pod started');
        } catch (err) {
          request.log.error({ err, podId }, 'Failed to start terminal');
          socket.close(1011, 'Failed to start terminal');
        }
      };

      startTerminal();
    },
  );
}
