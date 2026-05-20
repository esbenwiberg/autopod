import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, AuthRequiredError, apiFetch } from './api.js';
import { STORAGE_KEY } from './token.js';

describe('apiFetch', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.location.hash = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('injects Bearer token from localStorage', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'secret');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await apiFetch<{ ok: boolean }>('/pods');

    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer secret');
  });

  it('returns parsed JSON for 2xx responses', async () => {
    window.localStorage.setItem(STORAGE_KEY, 't');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([{ id: 'pod-1' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const out = await apiFetch<Array<{ id: string }>>('/pods');
    expect(out).toEqual([{ id: 'pod-1' }]);
  });

  it('on 401, clears the token, navigates to /scan-again, and throws AuthRequiredError', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'stale');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));

    await expect(apiFetch('/pods')).rejects.toBeInstanceOf(AuthRequiredError);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(window.location.hash).toBe('#/scan-again');
  });

  it('throws ApiError with status for other non-2xx responses', async () => {
    window.localStorage.setItem(STORAGE_KEY, 't');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));

    await expect(apiFetch('/pods')).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
    });
  });

  it('sets Content-Type: application/json when a body is supplied', async () => {
    window.localStorage.setItem(STORAGE_KEY, 't');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    await apiFetch('/pods/x/message', { method: 'POST', body: JSON.stringify({ message: 'hi' }) });

    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('returns undefined for 204 No Content', async () => {
    window.localStorage.setItem(STORAGE_KEY, 't');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    const out = await apiFetch('/pods/x/kill', { method: 'POST' });
    expect(out).toBeUndefined();
  });
});

// Sanity check on the exported classes so `instanceof` works for callers.
describe('error classes', () => {
  it('AuthRequiredError extends Error', () => {
    const e = new AuthRequiredError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('AuthRequiredError');
  });
  it('ApiError carries a status code', () => {
    const e = new ApiError(404, 'nope');
    expect(e.status).toBe(404);
  });
});
