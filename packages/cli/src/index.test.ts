import { access } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { FIXTURE_TOKEN, createCliFixture } from './test-utils/cli-executable.js';

const args = ['ls', '--compact', '--json', '--limit', '1'];
const expectedRequest = {
  method: 'GET',
  url: '/pods?limit=1&compact=true',
  authorization: `Bearer ${FIXTURE_TOKEN}`,
};

async function expectDisposed(fixture: Awaited<ReturnType<typeof createCliFixture>>) {
  expect(fixture.childrenClosed).toBe(true);
  expect(fixture.listening).toBe(false);
  expect(fixture.socketCount).toBe(0);
  await expect(access(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('built CLI executable', () => {
  it('releases an unfinished 401 response before completing the authenticated retry', async () => {
    let firstResponse: ServerResponse | undefined;
    let resolveFirstClosed: () => void = () => {};
    const firstClosed = new Promise<void>((resolve) => {
      resolveFirstClosed = resolve;
    });
    let resolveRetryReceived: () => void = () => {};
    const retryReceived = new Promise<void>((resolve) => {
      resolveRetryReceived = resolve;
    });
    let rejectedStreamClosed = false;
    const fixture = await createCliFixture({
      respond: (response, requestNumber) => {
        response.setHeader('content-type', 'application/json');
        if (requestNumber === 1) {
          firstResponse = response;
          response.once('close', () => {
            rejectedStreamClosed = true;
            resolveFirstClosed();
          });
          response.writeHead(401);
          response.write('{"message":"unfinished authentication rejection');
          return;
        }
        resolveRetryReceived();
        // Success cannot be produced by process-exit cleanup: the child needs
        // this response to finish, and it waits for the rejected stream to close.
        void firstClosed.then(() => {
          if (!response.destroyed) response.end('[]');
        });
      },
    });
    try {
      const child = fixture.start(args);
      await Promise.race([
        retryReceived,
        child.result.then((result) => {
          throw new Error(`CLI closed before retry: ${JSON.stringify(result)}`);
        }),
      ]);
      const result = await child.result;
      expect(result.failure).toBeNull();
      expect(result.cancelled).toBe(false);
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      expect(JSON.parse(result.stdout)).toEqual([]);
      expect(result.stderr).not.toContain('Error:');
      expect(rejectedStreamClosed).toBe(true);
      expect(firstResponse?.writableEnded).toBe(false);
      expect(fixture.requests).toEqual([expectedRequest, expectedRequest]);
    } finally {
      await fixture.dispose();
      if (firstResponse) await firstClosed;
      await expectDisposed(fixture);
    }
  }, 30_000);

  it('loads private config/auth and emits only the compact list JSON with exit zero', async () => {
    const pods = [
      {
        id: 'fixture-pod',
        profileName: 'fixture',
        status: 'complete',
        title: 'Executable boundary',
        startedAt: null,
        completedAt: null,
      },
    ];
    const fixture = await createCliFixture({ body: pods });
    try {
      const child = fixture.start(args);
      expect(child.pid).toBeDefined();
      expect(child.pid).not.toBe(process.pid);
      const result = await child.result;
      expect(result.failure).toBeNull();
      expect(result.cancelled).toBe(false);
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      expect(JSON.parse(result.stdout)).toEqual(pods);
      expect(fixture.requests).toEqual([expectedRequest]);
    } finally {
      await fixture.dispose();
    }
    await expectDisposed(fixture);
  }, 30_000);

  it('reports the API denial through the real stderr handler and exit code two', async () => {
    const fixture = await createCliFixture({
      status: 403,
      body: { code: 'FORBIDDEN', message: 'Fixture denies pod listing' },
    });
    try {
      const result = await fixture.start(args).result;
      expect(result.failure).toBeNull();
      expect(result.cancelled).toBe(false);
      expect(result.code).toBe(2);
      expect(result.signal).toBeNull();
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Error: Fixture denies pod listing');
      expect(result.stderr).toContain('You do not have permission for this action.');
      expect(fixture.requests).toEqual([expectedRequest]);
    } finally {
      await fixture.dispose();
    }
    await expectDisposed(fixture);
  }, 30_000);

  it('reaps a stalled child and removes its sockets, timers and private tree on cleanup', async () => {
    const fixture = await createCliFixture({ hold: true });
    try {
      const child = fixture.start(args);
      expect(await fixture.waitForRequest(child)).toEqual(expectedRequest);
      expect(child.closed).toBe(false);
      expect(child.timerActive).toBe(true);
      expect(fixture.socketCount).toBeGreaterThan(0);
      await fixture.dispose();
      const result = await child.result;
      expect(result.cancelled).toBe(true);
      expect(result.failure).toBeNull();
      expect(result.code).not.toBe(0);
      expect(fixture.requests).toEqual([expectedRequest]);
      await expectDisposed(fixture);
      // Repeated teardown is harmless and cannot target a newly reused PID.
      await fixture.dispose();
      await expectDisposed(fixture);
    } finally {
      await fixture.dispose();
    }
  }, 30_000);
});
