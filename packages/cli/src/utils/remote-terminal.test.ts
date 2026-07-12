import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import {
  type TerminalStdin,
  type TerminalStdout,
  type TerminalWebSocket,
  runRemoteTerminalSession,
} from './remote-terminal.js';

class FakeWebSocket extends EventEmitter implements TerminalWebSocket {
  readonly sent: Array<Buffer | string> = [];
  closed = false;

  send(data: Buffer | string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }
}

class FakeStdin extends EventEmitter implements TerminalStdin {
  isTTY = true;
  rawMode: boolean | undefined;
  paused = false;
  setRawMode = vi.fn((mode: boolean) => {
    this.rawMode = mode;
  });
  resume = vi.fn(() => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
}

class FakeStdout extends EventEmitter implements TerminalStdout {
  columns = 120;
  rows = 40;
  readonly written: Array<Buffer | string> = [];
  write = vi.fn((chunk: Buffer | string) => {
    this.written.push(chunk);
    return true;
  });
}

function createFixture() {
  const ws = new FakeWebSocket();
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const connect = vi.fn(async (_url: string, _headers: Record<string, string>) => ws);
  const client = {
    fetchToken: vi.fn(async () => 'test-token'),
    getWebSocketUrl: vi.fn((path: string) => `ws://daemon${path}`),
  } as unknown as AutopodClient;

  const done = runRemoteTerminalSession(client, 'pod-1234', { connect, stdin, stdout });
  return { ws, stdin, stdout, connect, client, done };
}

describe('runRemoteTerminalSession', () => {
  it('connects to the pod terminal route with dimensions and a bearer token', async () => {
    const { ws, connect, done } = createFixture();
    // Allow the async connect to complete before asserting.
    await vi.waitFor(() => expect(connect).toHaveBeenCalled());

    expect(connect).toHaveBeenCalledWith('ws://daemon/pods/pod-1234/terminal?cols=120&rows=40', {
      Authorization: 'Bearer test-token',
    });

    ws.emit('close', 1000, Buffer.from(''));
    await expect(done).resolves.toBe(0);
  });

  it('bridges stdin/stdout and sends resize control frames', async () => {
    const { ws, stdin, stdout, connect, done } = createFixture();
    await vi.waitFor(() => expect(connect).toHaveBeenCalled());

    ws.emit('open');
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(stdin.resume).toHaveBeenCalled();

    stdin.emit('data', Buffer.from('ls\r'));
    expect(ws.sent).toContainEqual(Buffer.from('ls\r'));

    stdout.columns = 100;
    stdout.rows = 30;
    stdout.emit('resize');
    expect(ws.sent).toContain(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));

    ws.emit('message', Buffer.from('remote-output'), true);
    expect(stdout.written).toContainEqual(Buffer.from('remote-output'));

    ws.emit('close', 1000, Buffer.from('exit:0'));
    await expect(done).resolves.toBe(0);
  });

  it('resolves with the exit code from the close reason and restores the terminal', async () => {
    const { ws, stdin, connect, done } = createFixture();
    await vi.waitFor(() => expect(connect).toHaveBeenCalled());

    ws.emit('open');
    ws.emit('close', 1000, Buffer.from('exit:7'));

    await expect(done).resolves.toBe(7);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.pause).toHaveBeenCalled();
  });

  it('resolves non-zero on an abnormal close', async () => {
    const { ws, connect, done } = createFixture();
    await vi.waitFor(() => expect(connect).toHaveBeenCalled());

    ws.emit('close', 4004, Buffer.from('Pod not found'));
    await expect(done).resolves.toBe(1);
  });

  it('stops forwarding stdin after the session ends', async () => {
    const { ws, stdin, connect, done } = createFixture();
    await vi.waitFor(() => expect(connect).toHaveBeenCalled());

    ws.emit('open');
    ws.emit('close', 1000, Buffer.from('exit:0'));
    await done;

    const sentBefore = ws.sent.length;
    stdin.emit('data', Buffer.from('should-not-send'));
    expect(ws.sent).toHaveLength(sentBefore);
  });
});
