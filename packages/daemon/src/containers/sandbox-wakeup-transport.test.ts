import { AutopodError } from '@autopod/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TEST_WAKEUP_ID as ID,
  TEST_WAKEUP_KEY as KEY,
  createDelayedWakeupCredential,
  createSandboxWakeupFixture,
  createTestWakeupClient,
} from '../test-utils/sandbox-wakeup-helpers.js';

const state = (value: string) => new Response(JSON.stringify({ state: value }));
afterEach(() => vi.useRealTimers());

describe('durable sandbox wakeup transport', () => {
  it('refuses a pre-journal stopped resource without guessing a prior restore was rejected', async () => {
    const f = createSandboxWakeupFixture();
    const fetch = vi.fn(async () => state('Stopped'));
    const client = createTestWakeupClient(f.journal, fetch);
    await expect(client.resume(ID)).rejects.toMatchObject({
      code: 'SANDBOX_WAKEUP_LEGACY_UNVERIFIED',
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('refuses a mutating resume without a journal', async () => {
    const fetch = vi.fn(async () => state('Stopped'));
    await expect(createTestWakeupClient(undefined, fetch).resume(ID)).rejects.toMatchObject({
      code: 'SANDBOX_WAKEUP_JOURNAL_UNAVAILABLE',
    });
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(1);
  });
  it('observes Running after a lost POST response, never reposting', async () => {
    vi.useFakeTimers();
    const f = createSandboxWakeupFixture(true);
    let observed = 0;
    let posts = 0;
    const transport: {
      claim?: { id: string; dispatch_started_at: string | null };
      requestId?: string | null;
    } = {};
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts++;
        transport.claim = f.db
          .prepare('SELECT id,dispatch_started_at FROM sandbox_wakeup_intents')
          .get() as typeof transport.claim;
        transport.requestId = new Headers(init.headers).get('x-ms-client-request-id');
        throw new Error('Lost response after provider acceptance');
      }
      return state(observed++ === 0 ? 'Stopped' : 'Running');
    });
    const done = expect(
      createTestWakeupClient(f.journal, fetch).resume(ID),
    ).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    await done;
    expect(posts).toBe(1);
    expect(transport.claim?.dispatch_started_at).toEqual(expect.any(String));
    expect(transport.requestId).toBe(transport.claim?.id);
    expect(f.journal.retains(ID)).toBe(false);
  });
  it('fails fast for a retained operation across reopen without a second POST', async () => {
    vi.useFakeTimers();
    const f = createSandboxWakeupFixture(true, true);
    let posts = 0;
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts++;
        return new Response(null, { status: 202 });
      }
      return state('Stopped');
    });
    const first = expect(createTestWakeupClient(f.journal, fetch).resume(ID)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(50);
    await first;
    expect(f.journal.retains(ID)).toBe(true);
    const next = f.reopen();
    await expect(createTestWakeupClient(next, fetch).resume(ID)).rejects.toMatchObject({
      code: 'SANDBOX_WAKEUP_RECONCILIATION_REQUIRED',
      statusCode: 409,
    });
    expect(posts).toBe(1);
    expect(next.pendingSandboxIds()).toEqual([ID]);
  });
  it('refuses a second client while the original caller observes its admitted resume', async () => {
    vi.useFakeTimers();
    const f = createSandboxWakeupFixture(true);
    let posts = 0;
    let gets = 0;
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts++;
        return new Response(null, { status: 202 });
      }
      return state(++gets > 4 ? 'Running' : 'Stopped');
    });
    const done = Promise.allSettled([
      createTestWakeupClient(f.journal, fetch).resume(ID),
      createTestWakeupClient(f.journal, fetch).resume(ID),
    ]);
    await vi.runAllTimersAsync();
    expect(await done).toEqual([
      { status: 'fulfilled', value: undefined },
      {
        status: 'rejected',
        reason: expect.objectContaining({ code: 'SANDBOX_WAKEUP_RECONCILIATION_REQUIRED' }),
      },
    ]);
    expect(posts).toBe(1);
  });
  it('cannot borrow a Running baseline from a different provider namespace', async () => {
    const f = createSandboxWakeupFixture(true);
    const fetch = vi.fn(async () => state('Stopped'));
    await expect(
      createTestWakeupClient(f.journal, fetch, { resourceGroup: 'different' }).resume(ID),
    ).rejects.toMatchObject({ code: 'SANDBOX_WAKEUP_LEGACY_UNVERIFIED' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('revokes an unsent wake when ownership changes during token acquisition', async () => {
    vi.useFakeTimers();
    const f = createSandboxWakeupFixture(true);
    const auth = createDelayedWakeupCredential();
    let current = true;
    const fetch = vi.fn(async () => state('Stopped'));
    const client = createTestWakeupClient(f.journal, fetch, { credential: auth.credential });
    const done = expect(
      client.resume(ID, {
        assertCurrent: () => {
          if (!current) throw new AutopodError('Superseded', 'STALE_AGENT_CONTINUATION', 409);
        },
      }),
    ).rejects.toMatchObject({ code: 'STALE_AGENT_CONTINUATION' });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.journal.retains(ID)).toBe(true);
    current = false;
    auth.release();
    await done;
    expect(fetch).toHaveBeenCalledOnce();
    expect(f.journal.retains(ID)).toBe(false);
    expect(f.db.prepare('SELECT settled_by FROM sandbox_wakeup_intents').get()).toEqual({
      settled_by: 'dispatch-revoked',
    });
  });
  it('checks elapsed time before dispatch even when the deadline timer has not run', async () => {
    vi.useFakeTimers();
    const f = createSandboxWakeupFixture(true);
    let tokens = 0;
    const fetch = vi.fn(async () => state('Stopped'));
    const client = createTestWakeupClient(f.journal, fetch, {
      credential: {
        getToken: async () => {
          if (++tokens > 1) vi.setSystemTime(Date.now() + 1000);
          return { token: 'test-token' };
        },
      },
    });
    await expect(client.resume(ID)).rejects.toMatchObject({ code: 'SANDBOX_WAKEUP_TIMEOUT' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(f.journal.retains(ID)).toBe(false);
  });
  it('a timed-out token acquisition cannot dispatch late after its unsent claim was revoked', async () => {
    vi.useFakeTimers();
    const f = createSandboxWakeupFixture(true, true);
    const auth = createDelayedWakeupCredential();
    const fetch = vi.fn(async () => state('Stopped'));
    const client = createTestWakeupClient(f.journal, fetch, { credential: auth.credential });
    const done = expect(client.resume(ID)).rejects.toMatchObject({
      code: 'SANDBOX_WAKEUP_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(50);
    await done;
    const reopened = f.reopen();
    expect(reopened.retains(ID)).toBe(false);
    auth.release();
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('never accepts a late Running response as settlement after the observation deadline', async () => {
    vi.useFakeTimers();
    const f = createSandboxWakeupFixture(true, true);
    const original = f.journal.claim(KEY, ID);
    f.journal.beginDispatch(original.id);
    let release!: (value: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const done = expect(createTestWakeupClient(f.journal, fetch).resume(ID)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(50);
    await done;
    const reopened = f.reopen();
    release(state('Running'));
    await vi.runAllTimersAsync();
    expect(reopened.retains(ID)).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('blocks backend deletion while an admitted restore remains outcome-unknown', async () => {
    const f = createSandboxWakeupFixture(true);
    const original = f.journal.claim(KEY, ID);
    f.journal.beginDispatch(original.id);
    const fetch = vi.fn(async () => state('Stopped'));
    await expect(createTestWakeupClient(f.journal, fetch).destroy(ID)).rejects.toMatchObject({
      code: 'SANDBOX_WAKEUP_OUTCOME_UNVERIFIED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('a fresh Running observation establishes a baseline but does not fabricate an intent', async () => {
    const f = createSandboxWakeupFixture();
    let current = 'Running';
    const fetch = vi.fn(async () => state(current));
    const client = createTestWakeupClient(f.journal, fetch);
    expect(await client.getStatus(ID)).toBe('running');
    expect(f.journal.pendingSandboxIds()).toEqual([]);
    expect(f.db.prepare('SELECT count(*) AS n FROM sandbox_wakeup_baselines').get()).toEqual({
      n: 1,
    });
    current = 'Stopped';
    vi.useFakeTimers();
    const attempt = expect(client.resume(ID)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(50);
    await attempt;
    expect(f.journal.retains(ID)).toBe(true);
  });
});
