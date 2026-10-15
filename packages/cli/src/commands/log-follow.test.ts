import { access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { FIXTURE_TOKEN, createCliFixture } from '../test-utils/cli-executable.js';

const podId = 'fixture-pod';
const args = ['logs', podId, '--follow'];
const banner = 'Following pod fixture-… (Ctrl+C to stop)\n\n';
const disconnect = (code: number) =>
  `Error: Log stream disconnected (code ${code}).\nRun ap logs ${podId} --follow to reconnect.\n`;

function activity(event: object) {
  return JSON.stringify({ type: 'pod.agent_activity', podId, event });
}

async function dispose(fixture: Awaited<ReturnType<typeof createCliFixture>>) {
  await fixture.dispose();
  expect(fixture.childrenClosed).toBe(true);
  expect(fixture.listening).toBe(false);
  expect(fixture.socketCount).toBe(0);
  expect(fixture.websocketCount).toBe(0);
  await expect(access(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('built CLI log following', () => {
  it('retains received worker errors and reports an abnormal remote close as failure', async () => {
    const fixture = await createCliFixture({ websocket: 'accept' });
    try {
      const child = fixture.start(args);
      const peer = await fixture.waitForSubscription(child);
      expect(fixture.requests).toEqual([
        { method: 'GET', url: '/events', authorization: `Bearer ${FIXTURE_TOKEN}` },
      ]);
      expect(fixture.subscriptions).toEqual([{ type: 'subscribe', podId }]);
      peer.socket.send(activity({ type: 'reasoning', text: 'Hidden reasoning' }));
      peer.socket.send(activity({ type: 'error', message: 'Worker diagnostic', fatal: false }));
      await child.waitForStdout('[error] Worker diagnostic');
      peer.socket.terminate();
      const result = await child.result;
      expect(result).toEqual({
        code: 1,
        signal: null,
        failure: null,
        cancelled: false,
        stdout: `${banner} [error] Worker diagnostic\n`,
        stderr: disconnect(1006),
      });
      await peer.closed;
      expect(fixture.websocketCount).toBe(0);
    } finally {
      await dispose(fixture);
    }
  }, 30_000);

  it.each([
    { code: 1000, exit: 1, stderr: disconnect(1000) },
    { code: 4001, exit: 2, stderr: 'Error: Log stream authentication failed.\nTry: ap login\n' },
  ])(
    'reports remote close $code with exit $exit',
    async ({ code, exit, stderr }) => {
      const fixture = await createCliFixture({ websocket: 'accept' });
      try {
        const child = fixture.start(args);
        const peer = await fixture.waitForSubscription(child);
        peer.socket.close(code, 'Untrusted server reason must not be printed');
        expect(await child.result).toEqual({
          code: exit,
          signal: null,
          failure: null,
          cancelled: false,
          stdout: banner,
          stderr,
        });
        await peer.closed;
        expect(fixture.websocketCount).toBe(0);
      } finally {
        await dispose(fixture);
      }
    },
    30_000,
  );

  it('fails a top-level protocol error and releases a peer that does not close itself', async () => {
    const fixture = await createCliFixture({ websocket: 'accept' });
    try {
      const child = fixture.start(args);
      const peer = await fixture.waitForSubscription(child);
      peer.socket.send(JSON.stringify({ type: 'error', message: 'Untrusted protocol message' }));
      expect(await child.result).toEqual({
        code: 1,
        signal: null,
        failure: null,
        cancelled: false,
        stdout: banner,
        stderr: 'Error: Log stream subscription failed.\n',
      });
      await peer.closed;
      expect(fixture.websocketCount).toBe(0);
    } finally {
      await dispose(fixture);
    }
  }, 30_000);

  // Windows child.kill('SIGINT') forcibly terminates, unlike a POSIX Ctrl+C.
  it.skipIf(process.platform === 'win32')(
    'stops the pod logs alias with SIGINT and preserves reasoning/follow over build',
    async () => {
      const fixture = await createCliFixture({ websocket: 'accept' });
      try {
        const child = fixture.start(['pod', ...args, '--show-reasoning', '--build']);
        const peer = await fixture.waitForSubscription(child);
        peer.socket.send(activity({ type: 'reasoning', text: 'Visible reasoning' }));
        await child.waitForStdout('[reasoning] Visible reasoning');
        expect(child.signal('SIGINT')).toBe(true);
        expect(await child.result).toEqual({
          code: 0,
          signal: null,
          failure: null,
          cancelled: false,
          stdout: `${banner} [reasoning] Visible reasoning\n`,
          stderr: '',
        });
        await peer.closed;
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.subscriptions).toEqual([{ type: 'subscribe', podId }]);
        expect(fixture.websocketCount).toBe(0);
      } finally {
        await dispose(fixture);
      }
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'stops during a held upgrade without an unhandled socket error',
    async () => {
      const fixture = await createCliFixture({ websocket: 'hold' });
      try {
        const child = fixture.start(args);
        expect(await fixture.waitForRequest(child)).toEqual({
          method: 'GET',
          url: '/events',
          authorization: `Bearer ${FIXTURE_TOKEN}`,
        });
        expect(child.signal('SIGINT')).toBe(true);
        expect(await child.result).toEqual({
          code: 0,
          signal: null,
          failure: null,
          cancelled: false,
          stdout: '',
          stderr: '',
        });
        expect(fixture.subscriptions).toEqual([]);
      } finally {
        await dispose(fixture);
      }
    },
    30_000,
  );

  it('reports an HTTP handshake failure once with generic exit one', async () => {
    const fixture = await createCliFixture({ websocket: 'reject' });
    try {
      const child = fixture.start(args);
      expect(await child.result).toEqual({
        code: 1,
        signal: null,
        failure: null,
        cancelled: false,
        stdout: '',
        stderr: 'Error: WebSocket error: Unexpected server response: 403\n',
      });
      expect(fixture.subscriptions).toEqual([]);
    } finally {
      await dispose(fixture);
    }
  }, 30_000);
});
