import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  finalizationReceipt,
  finalizationRequest,
  finalizationView,
} from '../test-utils/retained-finalization.js';
import { AutopodClient, DaemonUnreachableError } from './client.js';

const mockFetch = vi.fn();
vi.mock('undici', () => ({ fetch: (...args: unknown[]) => mockFetch(...args) }));
const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('retained finalization transport', () => {
  const getToken = vi.fn();
  let client: AutopodClient;
  beforeEach(() => {
    vi.resetAllMocks();
    getToken.mockResolvedValue('test-token');
    client = new AutopodClient({ baseUrl: 'https://daemon.invalid', getToken });
  });

  it('GETs the encoded dedicated route and preserves the view without mutation', async () => {
    const view = finalizationView();
    mockFetch.mockResolvedValueOnce(jsonResponse(view));
    await expect(client.inspectRetainedFinalization('pod/id')).resolves.toEqual(view);
    expect(mockFetch).toHaveBeenCalledExactlyOnceWith(
      'https://daemon.invalid/pods/pod%2Fid/retained-finalization',
      { method: 'GET', headers: { Authorization: 'Bearer test-token' }, body: undefined },
    );
  });

  it.each(['stop-retain', 'complete-merged'] as const)(
    'POSTs only the exact %s request and preserves pending',
    async (mode) => {
      const request = { ...finalizationRequest(), mode };
      const receipt = { ...finalizationReceipt('pending', request), podId: 'pod/id' };
      mockFetch.mockResolvedValueOnce(jsonResponse(receipt, 202));
      await expect(client.finalizeRetained('pod/id', request)).resolves.toEqual(receipt);
      expect(mockFetch).toHaveBeenCalledExactlyOnceWith(
        'https://daemon.invalid/pods/pod%2Fid/retained-finalization',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
          body: JSON.stringify(request),
        },
      );
    },
  );

  it.each([401, 403, 404, 409, 422, 500, 503])(
    'surfaces HTTP %i without automatic retry or fallback',
    async (status) => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ message: 'Finalization refused' }, status));
      await expect(
        client.finalizeRetained('retained-pod', finalizationRequest()),
      ).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(getToken).toHaveBeenCalledTimes(1);
    },
  );

  it('retains daemon refusal details', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ message: 'Source ownership drifted', code: 'STALE_BINDING' }, 409),
    );
    await expect(
      client.finalizeRetained('retained-pod', finalizationRequest()),
    ).rejects.toMatchObject({
      message: 'Source ownership drifted',
      code: 'STALE_BINDING',
    });
  });

  it('snapshots the selection before authentication awaits', async () => {
    const request = finalizationRequest();
    const original = { ...request };
    getToken.mockImplementationOnce(async () => {
      request.expectedBinding = 'b'.repeat(64);
      request.requestKey = 'replacement-key';
      return 'test-token';
    });
    mockFetch.mockResolvedValueOnce(jsonResponse(finalizationReceipt()));
    await client.finalizeRetained('retained-pod', request);
    expect(mockFetch.mock.calls[0]?.[1].body).toBe(JSON.stringify(original));
  });

  it('does not retry uncertain network outcomes; manual replay sends an identical body', async () => {
    const request = finalizationRequest();
    mockFetch.mockRejectedValueOnce(new Error('Connection lost'));
    await expect(client.finalizeRetained('retained-pod', request)).rejects.toBeInstanceOf(
      DaemonUnreachableError,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    mockFetch.mockResolvedValueOnce(jsonResponse(finalizationReceipt('finalized')));
    await expect(client.finalizeRetained('retained-pod', request)).resolves.toEqual(
      finalizationReceipt('finalized'),
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0]).toEqual(mockFetch.mock.calls[1]);
  });

  it.each([
    ['pod', { podId: 'another-pod' }],
    ['state', { state: 'unknown' }],
    ['retention', { resourcesRetained: false }],
    ['timestamp', { finalizedAt: null }],
    ...(['requestKey', 'expectedGeneration', 'expectedBinding', 'mode', 'reason'] as const).map(
      (key) => [key, { request: { ...finalizationRequest(), [key]: 'different' } }],
    ),
  ])(
    'rejects an uncorrelated or unsupported %s receipt without replay',
    async (_field, changes) => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ...finalizationReceipt('finalized'), ...(changes as object) }),
      );
      await expect(client.finalizeRetained('retained-pod', finalizationRequest())).rejects.toThrow(
        'Unconfirmed finalization response',
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    },
  );

  it('does not retry an unreadable response after submission', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('truncated JSON', {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(client.finalizeRetained('retained-pod', finalizationRequest())).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
