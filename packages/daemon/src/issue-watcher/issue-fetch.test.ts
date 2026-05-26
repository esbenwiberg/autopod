import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IssueProviderRequestError,
  fetchIssueProvider,
  isIssueProviderAuthError,
  isTransientIssueProviderError,
  issueProviderHttpError,
} from './issue-fetch.js';

describe('fetchIssueProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries retryable provider responses once', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        body: { cancel },
      })
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchIssueProvider(
      'https://dev.azure.com/org/project/_apis/wit/wiql',
      { method: 'POST' },
      { provider: 'ado', operation: 'WIQL', retryDelayMs: 0 },
    );

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not retry auth failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchIssueProvider(
      'https://dev.azure.com/org/project/_apis/wit/wiql',
      { method: 'POST' },
      { provider: 'ado', operation: 'WIQL', retryDelayMs: 0 },
    );

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('wraps network failures after retrying', async () => {
    const timeout = Object.assign(new Error('fetch failed'), { code: 'ETIMEDOUT' });
    const fetchMock = vi.fn().mockRejectedValue(timeout);
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchIssueProvider(
        'https://dev.azure.com/org/project/_apis/wit/wiql',
        { method: 'POST' },
        { provider: 'ado', operation: 'WIQL', retryDelayMs: 0 },
      ),
    ).rejects.toBeInstanceOf(IssueProviderRequestError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('classifies transient and auth provider errors', () => {
    const transient = issueProviderHttpError(
      'ado',
      'WIQL',
      { status: 503, statusText: 'Service Unavailable' } as Response,
      'ADO WIQL failed: 503 Service Unavailable',
    );
    const auth = issueProviderHttpError(
      'ado',
      'WIQL',
      { status: 401, statusText: 'Unauthorized' } as Response,
      'ADO WIQL failed: 401 Unauthorized',
    );

    expect(isTransientIssueProviderError(transient)).toBe(true);
    expect(isIssueProviderAuthError(transient)).toBe(false);
    expect(isTransientIssueProviderError(auth)).toBe(false);
    expect(isIssueProviderAuthError(auth)).toBe(true);
  });
});
