import type { JwtPayload, Pod } from '@autopod/shared';
import type Dockerode from 'dockerode';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
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
    containerId: 'sandbox-1',
    worktreePath: '/tmp/worktree/pod-1',
    options: { agentMode: 'auto', output: 'pr', validate: true },
    ...overrides,
  } as Pod;
}

describe('terminalRoutes', () => {
  it('rejects sandbox terminal sessions before touching Docker', async () => {
    let handler: TerminalHandler | undefined;
    const app = {
      get: vi.fn((_path: string, _opts: unknown, registered: TerminalHandler) => {
        handler = registered;
      }),
    } as unknown as FastifyInstance;
    const podManager = {
      getSession: vi.fn(() => makePod()),
    } as unknown as PodManager;
    const authModule = {
      validateToken: vi.fn(async () => testUser),
    } as unknown as AuthModule;
    const docker = {
      getContainer: vi.fn(),
    } as unknown as Dockerode;

    terminalRoutes(app, podManager, {} as unknown as ContainerManagerFactory, authModule, docker);

    if (!handler) throw new Error('terminal route was not registered');

    const socket = {
      close: vi.fn(),
    } as unknown as WebSocket;
    const request = {
      params: { podId: 'pod-1' },
      url: '/pods/pod-1/terminal?cols=80&rows=24',
      headers: { authorization: 'Bearer test-token' },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as FastifyRequest;

    await handler(socket, request);

    expect(docker.getContainer).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(
      4004,
      expect.stringContaining('Sandbox interactive terminal is unsupported'),
    );
  });
});
