import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { type ServerResponse, createServer } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const executable = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const OUTPUT_LIMIT = 64 * 1024;
const WATCHDOG_MS = 10_000;
export const FIXTURE_TOKEN = 'cli-executable-fixture-only';

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  failure: string | null;
  cancelled: boolean;
}

function startProcess(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let failure: string | null = null;
  let cancelled = false;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  const stdoutWaiters = new Set<() => void>();

  // Resolve only after both pipes close. Keep failures as data so request-barrier
  // tests cannot cause an unhandled rejection before they await the outcome.
  const result = new Promise<ProcessResult>((resolve) => {
    child.once('error', (error) => {
      failure = `Child process failed: ${error.message}`;
    });
    child.once('close', (code, signal) => {
      closed = true;
      clearTimeout(timer);
      timer = undefined;
      resolve({
        code,
        signal,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        failure,
        cancelled,
      });
    });
    const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const previous = stream === 'stdout' ? stdout : stderr;
      if (previous.length + chunk.length > OUTPUT_LIMIT) {
        failure ??= `${stream} exceeded the fixture output limit`;
        child.kill('SIGKILL');
        return;
      }
      if (stream === 'stdout') {
        stdout = Buffer.concat([previous, chunk]);
        for (const check of stdoutWaiters) check();
      } else stderr = Buffer.concat([previous, chunk]);
    };
    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
    timer = setTimeout(() => {
      failure ??= 'Fixture watchdog expired; this is not a CLI request timeout';
      child.kill('SIGKILL');
    }, WATCHDOG_MS);
  });

  return {
    result,
    signal(signal: NodeJS.Signals) {
      assert(!closed, 'Cannot signal a closed child');
      return child.kill(signal);
    },
    async waitForStdout(text: string) {
      let check: () => void = () => {};
      const received = new Promise<void>((resolve) => {
        check = () => {
          if (stdout.toString('utf8').includes(text)) resolve();
        };
        stdoutWaiters.add(check);
        check();
      });
      try {
        await Promise.race([
          received,
          result.then((outcome) => {
            throw new Error(
              `CLI closed before stdout contained ${text}: ${JSON.stringify(outcome)}`,
            );
          }),
        ]);
      } finally {
        stdoutWaiters.delete(check);
      }
    },
    get pid() {
      return child.pid;
    },
    get closed() {
      return closed;
    },
    get timerActive() {
      return timer !== undefined;
    },
    async dispose() {
      if (!closed) {
        cancelled = true;
        child.kill('SIGKILL');
      }
      await result;
    },
  };
}

export type FixtureProcess = ReturnType<typeof startProcess>;

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
}

/** Package-local proof peer, never a daemon or a provider-backed integration. */
export async function createCliFixture(reply: {
  status?: number;
  body?: unknown;
  hold?: boolean;
  websocket?: 'accept' | 'hold' | 'reject';
  respond?: (response: ServerResponse, requestNumber: number) => void;
}) {
  await access(executable).catch(() => {
    throw new Error('Build @autopod/cli and its dependencies before executable tests');
  });
  const root = await mkdtemp(join(tmpdir(), 'autopod-cli-executable-'));
  const home = join(root, 'home');
  const temporary = join(root, 'tmp');
  const cwd = join(root, 'cwd');
  const children = new Set<FixtureProcess>();
  const sockets = new Set<Socket>();
  const requests: RecordedRequest[] = [];
  const subscriptions: unknown[] = [];
  const websocketServer = new WebSocketServer({ noServer: true });
  let resolveSubscription: (peer: {
    socket: import('ws').WebSocket;
    closed: Promise<void>;
  }) => void = () => {};
  const firstSubscription = new Promise<Parameters<typeof resolveSubscription>[0]>((resolve) => {
    resolveSubscription = resolve;
  });
  let resolveRequest: (request: RecordedRequest) => void = () => {};
  const firstRequest = new Promise<RecordedRequest>((resolve) => {
    resolveRequest = resolve;
  });
  const server = createServer((request, response) => {
    const recorded = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    };
    requests.push(recorded);
    resolveRequest(recorded);
    if (reply.respond) {
      reply.respond(response, requests.length);
      return;
    }
    if (reply.hold) return;
    response.statusCode = reply.status ?? 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(reply.body));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    const recorded = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    };
    requests.push(recorded);
    resolveRequest(recorded);
    if (reply.websocket === 'hold') return;
    if (reply.websocket !== 'accept') {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (peer) => {
      const closed = new Promise<void>((resolve) => peer.once('close', resolve));
      peer.on('error', () => {}); // The fixture owns abrupt transport shutdowns.
      peer.on('message', (data) => {
        subscriptions.push(JSON.parse(data.toString()));
        resolveSubscription({ socket: peer, closed });
      });
    });
  });
  let disposal: Promise<void> | undefined;
  function dispose(): Promise<void> {
    disposal ??= (async () => {
      try {
        await Promise.all([...children].map((child) => child.dispose()));
      } finally {
        for (const peer of websocketServer.clients) peer.terminate();
        const websocketClosure = new Promise<void>((resolve, reject) => {
          websocketServer.close((error) => (error ? reject(error) : resolve()));
        });
        const socketClosures = [...sockets].map(
          (socket) => new Promise<void>((resolve) => socket.once('close', resolve)),
        );
        for (const socket of sockets) socket.destroy();
        try {
          if (server.listening) {
            await new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            });
          }
          await Promise.all(socketClosures);
          await websocketClosure;
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    })();
    return disposal;
  }

  try {
    await Promise.all([home, temporary, cwd].map((path) => mkdir(path)));
    // This object is passed only to owned children; the test process environment
    // and the operator's home/configuration are never modified or inherited.
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
      NO_COLOR: '1',
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    const probe = startProcess(
      [
        '-e',
        "const os = require('node:os'); console.log(JSON.stringify({home: os.homedir(), tmp: os.tmpdir(), cwd: process.cwd(), node: process.execPath}));",
      ],
      cwd,
      env,
    );
    children.add(probe);
    const probeResult = await probe.result;
    assert.equal(probeResult.failure, null);
    assert.equal(probeResult.code, 0);
    assert.equal(probeResult.signal, null);
    const observed = JSON.parse(probeResult.stdout) as {
      home: string;
      tmp: string;
      cwd: string;
      node: string;
    };
    for (const [actual, expected] of [
      [observed.home, home],
      [observed.tmp, temporary],
      [observed.cwd, cwd],
      [observed.node, process.execPath],
    ] as const) {
      assert.equal(await realpath(actual), await realpath(expected));
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    assert(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    const config = join(home, '.autopod');
    await mkdir(config, { mode: 0o700 });
    await writeFile(join(config, 'config.yaml'), JSON.stringify({ daemon: url }), { mode: 0o600 });
    await writeFile(join(config, 'dev-token'), FIXTURE_TOKEN, { mode: 0o600 });

    return {
      root,
      url,
      requests,
      subscriptions,
      observed,
      dispose,
      start(args: string[]) {
        assert(!disposal, 'Cannot launch a child after fixture disposal');
        const child = startProcess([executable, ...args], cwd, env);
        children.add(child);
        return child;
      },
      waitForRequest(child: FixtureProcess) {
        return Promise.race([
          firstRequest,
          child.result.then((result) => {
            throw new Error(`CLI closed before the request barrier: ${JSON.stringify(result)}`);
          }),
        ]);
      },
      waitForSubscription(child: FixtureProcess) {
        return Promise.race([
          firstSubscription,
          child.result.then((result) => {
            throw new Error(`CLI closed before subscribing: ${JSON.stringify(result)}`);
          }),
        ]);
      },
      get websocketCount() {
        return websocketServer.clients.size;
      },
      get listening() {
        return server.listening;
      },
      get socketCount() {
        return sockets.size;
      },
      get childrenClosed() {
        return [...children].every((child) => child.closed && !child.timerActive);
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
