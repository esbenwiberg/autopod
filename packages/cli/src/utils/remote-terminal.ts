import type { AutopodClient } from '../api/client.js';

/**
 * Interactive terminal session proxied through the daemon's
 * `WS /pods/:podId/terminal` route — the attach path for pods whose container
 * does not run on the local Docker host (Azure Sandboxes). The daemon bridges
 * the socket to the backend TTY (`ContainerManager.attachTerminal`).
 *
 * Wire protocol (mirrors the daemon terminal route):
 * - binary frames        → raw TTY bytes in both directions
 * - text frame (JSON)    → control messages; only `{type:'resize',cols,rows}` today
 * - close reason `exit:N`→ remote shell exit code
 */

/** Minimal surface of a `ws` WebSocket used by the session (injectable for tests). */
export interface TerminalWebSocket {
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  send(data: Buffer | string): void;
  close(): void;
}

export interface TerminalStdin extends NodeJS.EventEmitter {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface TerminalStdout extends NodeJS.EventEmitter {
  columns?: number;
  rows?: number;
  write(chunk: Buffer | string): unknown;
}

export interface RemoteTerminalDeps {
  connect?: (url: string, headers: Record<string, string>) => Promise<TerminalWebSocket>;
  stdin?: TerminalStdin;
  stdout?: TerminalStdout;
}

async function connectWithWs(
  url: string,
  headers: Record<string, string>,
): Promise<TerminalWebSocket> {
  const WebSocket = (await import('ws')).default;
  return new WebSocket(url, { headers }) as unknown as TerminalWebSocket;
}

/**
 * Attach the current terminal to a pod through the daemon. Resolves with the
 * remote shell's exit code (0 on clean detach).
 */
export async function runRemoteTerminalSession(
  client: AutopodClient,
  podId: string,
  deps: RemoteTerminalDeps = {},
): Promise<number> {
  const connect = deps.connect ?? connectWithWs;
  const stdin = deps.stdin ?? (process.stdin as TerminalStdin);
  const stdout = deps.stdout ?? (process.stdout as TerminalStdout);

  const cols = stdout.columns || 80;
  const rows = stdout.rows || 24;
  const token = await client.fetchToken();
  const url = client.getWebSocketUrl(`/pods/${podId}/terminal?cols=${cols}&rows=${rows}`);
  const ws = await connect(url, { Authorization: `Bearer ${token}` });

  return new Promise<number>((resolve) => {
    let settled = false;
    let cleanedUp = false;

    const onStdinData = (chunk: Buffer) => {
      ws.send(chunk);
    };
    const onResize = () => {
      ws.send(
        JSON.stringify({ type: 'resize', cols: stdout.columns || 80, rows: stdout.rows || 24 }),
      );
    };

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      stdin.removeListener('data', onStdinData);
      stdout.removeListener('resize', onResize);
      if (stdin.isTTY) {
        stdin.setRawMode?.(false);
        stdout.write('\x1b[?2004l');
      }
      stdin.pause();
    };

    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(exitCode);
    };

    ws.on('open', () => {
      if (stdin.isTTY) {
        stdin.setRawMode?.(true);
        // Bracketed paste keeps multi-line pastes atomic for the remote shell.
        stdout.write('\x1b[?2004h');
      }
      stdin.resume();
      stdin.on('data', onStdinData);
      stdout.on('resize', onResize);
    });

    ws.on('message', (data) => {
      stdout.write(data);
    });

    ws.on('close', (code, reason) => {
      const reasonText = reason.toString('utf8');
      const exitMatch = /^exit:(\d+)$/.exec(reasonText);
      if (exitMatch?.[1]) {
        settle(Number.parseInt(exitMatch[1], 10));
        return;
      }
      if (code === 1000) {
        settle(0);
        return;
      }
      if (reasonText) {
        process.stderr.write(`\nTerminal closed: ${reasonText}\n`);
      }
      settle(1);
    });

    ws.on('error', (err) => {
      process.stderr.write(`\nTerminal connection error: ${err.message}\n`);
      cleanup();
      // Let the subsequent 'close' event settle the exit code; if it never
      // fires (connect-time failure), settle now.
      setImmediate(() => settle(1));
    });
  });
}
