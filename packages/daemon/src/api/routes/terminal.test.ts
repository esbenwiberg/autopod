import type { JwtPayload, Pod } from '@autopod/shared';
import type Dockerode from 'dockerode';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { ContainerManager, TerminalSession } from '../../interfaces/container-manager.js';
import type { AuthModule } from '../../interfaces/index.js';
import type { ContainerManagerFactory, PodManager } from '../../pods/pod-manager.js';
import { terminalRoutes } from './terminal.js';

type TerminalHandler = (socket: WebSocket, request: FastifyRequest) => Promise<void>;

const testUser = {
  oid: 'user-1',
  preferred_username: 'tester',
  name: 'Test User',
  roles: ['admin'],
  aud: 'autopod',
  iss: 'autopod-test',
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
} as unknown as JwtPayload;

function makePod(overrides: Partial<Pod> = {}): Pod {
  return {
    id: 'pod-1',
    profileName: 'sandbox-profile',
    task: 'Inspect sandbox',
    status: 'running',
    model: 'opus',
    runtime: 'claude',
    executionTarget: 'sandbox',
    branch: 'autopod/pod-1',
    userId: 'user-1',
    containerId: 'sandbox-1',
    worktreePath: '/tmp/worktree/pod-1',
    options: { agentMode: 'auto', output: 'pr', validate: true },
    ...overrides,
  } as Pod;
}

/** A mock WebSocket that captures registered listeners so tests can drive frames. */
function makeSocket() {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const socket = {
    OPEN: 1,
    readyState: 1,
    close: vi.fn(),
    send: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
      return socket;
    }),
    once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
      return socket;
    }),
  } as unknown as WebSocket;
  const emit = (event: string, ...args: unknown[]) => {
    for (const cb of listeners.get(event) ?? []) cb(...args);
  };
  return { socket, emit };
}

/** A fake TerminalSession that captures listeners and records writes/resizes. */
function makeFakeSession() {
  let dataCb: ((chunk: Buffer) => void) | undefined;
  let exitCb: ((code: number) => void) | undefined;
  let errorCb: ((err: Error) => void) | undefined;
  const writes: Buffer[] = [];
  const resizes: [number, number][] = [];
  const close = vi.fn();
  const session: TerminalSession = {
    onData: (cb) => {
      dataCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    onError: (cb) => {
      errorCb = cb;
    },
    write: (data) => {
      writes.push(data);
    },
    resize: (cols, rows) => {
      resizes.push([cols, rows]);
    },
    close,
  };
  return {
    session,
    writes,
    resizes,
    close,
    emitData: (chunk: Buffer) => dataCb?.(chunk),
    emitExit: (code: number) => exitCb?.(code),
    emitError: (err: Error) => errorCb?.(err),
  };
}

function makeRequest(): FastifyRequest {
  return {
    params: { podId: 'pod-1' },
    url: '/pods/pod-1/terminal?cols=80&rows=24',
    headers: { authorization: 'Bearer test-token' },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as FastifyRequest;
}

function registerHandler(
  podManager: PodManager,
  factory: ContainerManagerFactory,
  authModule: AuthModule,
  docker: Dockerode,
): TerminalHandler {
  let handler: TerminalHandler | undefined;
  const app = {
    get: vi.fn((_path: string, _opts: unknown, registered: TerminalHandler) => {
      handler = registered;
    }),
  } as unknown as FastifyInstance;
  terminalRoutes(app, podManager, factory, authModule, docker);
  if (!handler) throw new Error('terminal route was not registered');
  return handler;
}

describe('terminalRoutes', () => {
  it('wires sandbox terminal sessions through the container manager (no Docker)', async () => {
    const fake = makeFakeSession();
    const attachTerminal = vi.fn(async () => fake.session);
    const cm = { attachTerminal } as unknown as ContainerManager;
    const factory = { get: vi.fn(() => cm) } as unknown as ContainerManagerFactory;

    const podManager = { getSession: vi.fn(() => makePod()) } as unknown as PodManager;
    const authModule = { validateToken: vi.fn(async () => testUser) } as unknown as AuthModule;
    const docker = { getContainer: vi.fn() } as unknown as Dockerode;

    const handler = registerHandler(podManager, factory, authModule, docker);
    const { socket, emit } = makeSocket();

    await handler(socket, makeRequest());

    expect(docker.getContainer).not.toHaveBeenCalled();
    expect(factory.get).toHaveBeenCalledWith('sandbox');
    expect(attachTerminal).toHaveBeenCalledWith('sandbox-1', { cols: 80, rows: 24 });

    // Output flows session → socket (binary).
    fake.emitData(Buffer.from('hello'));
    expect(socket.send).toHaveBeenCalledWith(Buffer.from('hello'), { binary: true });

    // Binary input flows socket → session.write.
    emit('message', Buffer.from('ls\n'), true);
    expect(fake.writes).toContainEqual(Buffer.from('ls\n'));

    // A JSON resize control frame maps to session.resize (clamped), not written.
    emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 120, rows: 40 })), false);
    expect(fake.resizes).toContainEqual([120, 40]);

    // A resize with out-of-range dims is clamped.
    emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 9999, rows: -3 })), false);
    expect(fake.resizes).toContainEqual([500, 1]);

    // Shell exit closes the socket with the exit code.
    fake.emitExit(7);
    expect(socket.close).toHaveBeenCalledWith(1000, 'exit:7');
  });

  it('rejects sandbox terminals when the manager has no interactive support', async () => {
    const cm = {} as unknown as ContainerManager; // no attachTerminal
    const factory = { get: vi.fn(() => cm) } as unknown as ContainerManagerFactory;
    const podManager = { getSession: vi.fn(() => makePod()) } as unknown as PodManager;
    const authModule = { validateToken: vi.fn(async () => testUser) } as unknown as AuthModule;
    const docker = { getContainer: vi.fn() } as unknown as Dockerode;

    const handler = registerHandler(podManager, factory, authModule, docker);
    const { socket } = makeSocket();

    await handler(socket, makeRequest());

    expect(docker.getContainer).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(
      4004,
      expect.stringContaining('Interactive terminal not supported'),
    );
  });

  it('rejects non-owner non-operator terminal sessions before touching Docker', async () => {
    const podManager = {
      getSession: vi.fn(() =>
        makePod({ executionTarget: 'local', containerId: 'container-1', userId: 'user-2' }),
      ),
    } as unknown as PodManager;
    const authModule = {
      validateToken: vi.fn(async () => ({ ...testUser, roles: ['viewer'] })),
    } as unknown as AuthModule;
    const docker = { getContainer: vi.fn() } as unknown as Dockerode;

    const handler = registerHandler(
      podManager,
      {} as unknown as ContainerManagerFactory,
      authModule,
      docker,
    );
    const { socket } = makeSocket();

    await handler(socket, makeRequest());

    expect(docker.getContainer).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(4003, 'Forbidden');
  });
});
