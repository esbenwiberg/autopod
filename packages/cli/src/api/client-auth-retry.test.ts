import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutopodClient } from './client.js';

const mockFetch = vi.fn();
vi.mock('undici', () => ({ fetch: (...args: unknown[]) => mockFetch(...args) }));

describe('AutopodClient 401 response ownership', () => {
  let client: AutopodClient;
  const getToken = vi.fn().mockResolvedValue('test-token');

  beforeEach(() => {
    vi.clearAllMocks();
    client = new AutopodClient({ baseUrl: 'http://localhost:3100', getToken });
  });

  it('awaits rejected-body cancellation before refreshing or replaying a mutation', async () => {
    const order: string[] = [];
    let releaseCancellation: () => void = () => {};
    const cancellation = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    let cancellationStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      cancellationStarted = resolve;
    });
    const rejected = new Response(
      new ReadableStream({
        cancel: () => {
          order.push('cancel');
          cancellationStarted();
          return cancellation.then(() => {
            order.push('released');
          });
        },
      }),
      { status: 401 },
    );
    getToken
      .mockImplementationOnce(async () => {
        order.push('initial token');
        return 'old-token';
      })
      .mockImplementationOnce(async () => {
        order.push('refresh');
        return 'new-token';
      });
    mockFetch
      .mockImplementationOnce(async () => {
        order.push('request');
        return rejected;
      })
      .mockImplementationOnce(async () => {
        order.push('retry');
        return new Response(null, { status: 204 });
      });
    const pending = client.sendMessage('fixture-pod', 'same message');
    try {
      await started;
      expect(order).toEqual(['initial token', 'request', 'cancel']);
      expect(getToken).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally {
      releaseCancellation();
      await pending;
    }
    expect(order).toEqual(['initial token', 'request', 'cancel', 'released', 'refresh', 'retry']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    for (const [index, token] of ['old-token', 'new-token'].entries()) {
      expect(mockFetch.mock.calls[index]).toEqual([
        'http://localhost:3100/pods/fixture-pod/message',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ message: 'same message' }),
        },
      ]);
    }
  });

  it.each(['absent', 'closed', 'errored', 'cancel rejects'] as const)(
    'preserves the retry when the rejected body is %s',
    async (state) => {
      const body =
        state === 'absent'
          ? null
          : new ReadableStream({
              start: (controller) => {
                if (state === 'closed') controller.close();
                if (state === 'errored') controller.error(new Error('body stream failed'));
              },
              cancel: () => {
                if (state === 'cancel rejects') return Promise.reject(new Error('cancel failed'));
              },
            });
      mockFetch
        .mockResolvedValueOnce(new Response(body, { status: 401 }))
        .mockResolvedValueOnce(
          new Response('[]', { headers: { 'content-type': 'application/json' } }),
        );
      await expect(client.listSessions()).resolves.toEqual([]);
      expect(getToken).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    },
  );

  it('releases the rejected body even when refreshing the token fails', async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel: () => {
          cancelled = true;
        },
      }),
      { status: 401 },
    );
    mockFetch.mockResolvedValueOnce(response);
    getToken.mockResolvedValueOnce('old-token').mockImplementationOnce(async () => {
      expect(cancelled).toBe(true);
      throw new Error('refresh unavailable');
    });
    await expect(client.listSessions()).rejects.toMatchObject({
      code: 'AUTH_ERROR',
      message: 'Token refresh failed. Try: ap login',
    });
    expect(cancelled).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('maps a second 401 to the existing auth error without a third request', async () => {
    let cancelled = false;
    mockFetch
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            cancel: () => {
              cancelled = true;
            },
          }),
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Still unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      );
    await expect(client.listSessions()).rejects.toMatchObject({
      code: 'AUTH_ERROR',
      message: 'Still unauthorized',
    });
    expect(cancelled).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenCalledTimes(2);
  });
});
