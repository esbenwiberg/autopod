import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TEST_WAKEUP_ID as ID,
  TEST_WAKEUP_KEY as KEY,
  createSandboxWakeupFixture,
  createTestWakeupClient,
} from '../test-utils/sandbox-wakeup-helpers.js';

const state = (value: string) =>
  new Response(JSON.stringify({ state: value, labels: { podId: 'recovery-pod' } }));
afterEach(() => vi.useRealTimers());

describe('retained sandbox wakeup recovery evidence', () => {
  it('allows a resume response slower than the GET deadline within its separate response budget', async () => {
    vi.useFakeTimers();
    const f = createSandboxWakeupFixture(true);
    let posts = 0;
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts++;
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response(null, { status: 202 })), 20_000);
          init.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }
      return state(posts ? 'Running' : 'Stopped');
    });
    const done = expect(
      createTestWakeupClient(f.journal, fetch, { resumeTimeoutMs: 145_000 }).resume(ID),
    ).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    await done;
    expect(posts).toBe(1);
    expect(f.journal.listForPod('recovery-pod')[0]).toMatchObject({
      settledBy: 'observed-running',
      evidence: [{ kind: 'response', status: 202, diagnostics: {} }],
    });
  });

  it('persists a timed-out POST classification and fails a later attempt after just one fresh GET', async () => {
    vi.useFakeTimers();
    const f = createSandboxWakeupFixture(true, true);
    let posts = 0;
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.method !== 'POST') return state('Stopped');
      posts++;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });
    const first = expect(
      createTestWakeupClient(f.journal, fetch, {
        resumeTimeoutMs: 100,
        resumeRequestTimeoutMs: 15,
      }).resume(ID),
    ).rejects.toMatchObject({ code: 'SANDBOX_WAKEUP_RECONCILIATION_REQUIRED' });
    await vi.advanceTimersByTimeAsync(100);
    await first;
    const next = f.reopen();
    const retained = next.listForPod('recovery-pod')[0];
    expect(retained).toMatchObject({
      endedAt: null,
      evidence: [{ kind: 'transport-error', errorCode: 'AZURE_SANDBOX_TIMEOUT' }],
    });
    fetch.mockClear();
    await expect(createTestWakeupClient(next, fetch).resume(ID)).rejects.toMatchObject({
      code: 'SANDBOX_WAKEUP_RECONCILIATION_REQUIRED',
      message: expect.stringContaining(retained?.id ?? 'missing'),
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(posts).toBe(1);
    expect(next.retains(ID)).toBe(true);
  });

  it('records and settles a 429 atomically, honors backoff, and observes stopped before readmission', async () => {
    vi.useFakeTimers();
    const f = createSandboxWakeupFixture(true);
    let posts = 0;
    const events: string[] = [];
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      events.push(init?.method ?? 'GET');
      if (init?.method === 'POST') {
        if (++posts === 1)
          return new Response(null, {
            status: 429,
            headers: { 'retry-after': '1', 'x-ms-request-id': 'provider-rejection' },
          });
        return new Response(null, { status: 202 });
      }
      return state(posts === 2 ? 'Running' : 'Stopped');
    });
    const done = expect(
      createTestWakeupClient(f.journal, fetch, { resumeTimeoutMs: 5_000 }).resume(ID),
    ).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(999);
    expect(posts).toBe(1);
    expect(f.journal.retains(ID)).toBe(false);
    await vi.runAllTimersAsync();
    await done;
    expect(events).toEqual(['GET', 'POST', 'GET', 'POST', 'GET']);
    const rejected = f.journal
      .listForPod('recovery-pod')
      .find((r) => r.settledBy === 'rate-limited');
    expect(rejected).toMatchObject({
      evidence: [{ status: 429, diagnostics: { 'x-ms-request-id': 'provider-rejection' } }],
    });
  });

  it('bounds persistent rate-limit rejection without leaving a false unknown operation', async () => {
    vi.useFakeTimers();
    const f = createSandboxWakeupFixture(true);
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) =>
      init?.method === 'POST' ? new Response(null, { status: 429 }) : state('Stopped'),
    );
    const done = expect(
      createTestWakeupClient(f.journal, fetch, {
        resumeTimeoutMs: 5_000,
        retry: { maxAttempts: 2, maxDelayMs: 0 },
      }).resume(ID),
    ).rejects.toMatchObject({ code: 'SANDBOX_WAKEUP_RATE_LIMITED', statusCode: 429 });
    await vi.runAllTimersAsync();
    await done;
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
    expect(f.journal.retains(ID)).toBe(false);
  });

  it('settles a retained unknown only after a fresh Running observation without another POST', async () => {
    const f = createSandboxWakeupFixture(true, true);
    const intent = f.journal.claim(KEY, ID, 'recovery-pod');
    f.journal.beginDispatch(intent.id);
    const next = f.reopen();
    const fetch = vi.fn(async () => state('Running'));
    await createTestWakeupClient(next, fetch).resume(ID);
    expect(fetch).toHaveBeenCalledOnce();
    expect(next.retains(ID)).toBe(false);
    expect(next.listForPod('recovery-pod')[0]?.settledBy).toBe('observed-running');
  });

  it.each(['deadline', 'ownership'] as const)(
    'cannot settle a retained request from a 429 response after %s changed',
    async (changed) => {
      vi.useFakeTimers();
      const f = createSandboxWakeupFixture(true);
      let current = true;
      let respond!: (response: Response) => void;
      const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if (init?.method !== 'POST') return state('Stopped');
        return new Promise<Response>((resolve) => {
          respond = resolve;
        });
      });
      const done = expect(
        createTestWakeupClient(f.journal, fetch).resume(ID, {
          assertCurrent: () => {
            if (!current) throw new Error('Superseded owner');
          },
        }),
      ).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(1);
      if (changed === 'deadline') {
        await vi.advanceTimersByTimeAsync(49);
        await done;
      } else {
        current = false;
      }
      respond(new Response(null, { status: 429 }));
      await vi.runAllTimersAsync();
      await done;
      expect(f.journal.retains(ID)).toBe(true);
      expect(f.journal.listForPod('recovery-pod')[0]?.evidence.some((e) => e.status === 429)).toBe(
        false,
      );
      expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    },
  );

  it('does not classify unrelated conflicts as rejected resumes', async () => {
    vi.useFakeTimers();
    const f = createSandboxWakeupFixture(true);
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) =>
      init?.method === 'POST'
        ? new Response(JSON.stringify({ title: 'OtherConflict' }), { status: 409 })
        : state('Stopped'),
    );
    await expect(createTestWakeupClient(f.journal, fetch).resume(ID)).rejects.toMatchObject({
      code: 'SANDBOX_WAKEUP_CONFLICT',
    });
    expect(f.journal.retains(ID)).toBe(true);
    expect(f.journal.listForPod('recovery-pod')[0]?.evidence[0]?.status).toBe(409);
  });
});
