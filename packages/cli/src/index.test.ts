import { access } from 'node:fs/promises';
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
