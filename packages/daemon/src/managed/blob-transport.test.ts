import { ManagedIdentityCredential } from '@azure/identity';
import { describe, expect, it, vi } from 'vitest';
import { ManagedIdentityBlobTransport } from './artifact-store.js';

describe('managed identity Blob conditional create', () => {
  function transport(status: number, code: string, stored: string) {
    const credential = new ManagedIdentityCredential();
    vi.spyOn(credential, 'getToken').mockResolvedValue({
      token: 'synthetic-test-token',
      expiresOnTimestamp: 0,
    });
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, options) =>
        options?.method === 'PUT'
          ? new Response('', { status, headers: { 'x-ms-error-code': code } })
          : new Response(stored, { status: 200 }),
      );
    return {
      value: new ManagedIdentityBlobTransport(
        'https://fixture.blob.core.windows.net/private',
        credential,
        request,
      ),
      request,
    };
  }

  it.each([
    [409, 'BlobAlreadyExists'],
    [412, 'ConditionNotMet'],
  ] as const)(
    'accepts exact replay after Azure %s/%s only after reading the original bytes',
    async (status, code) => {
      const { value, request } = transport(status, code, 'frozen');
      await expect(
        value.putIfAbsent('artifact/bundle.tar.gz', Buffer.from('frozen')),
      ).resolves.toBeUndefined();
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ 'If-None-Match': '*' });
      expect(request.mock.calls[1]?.[1]?.method).toBe('GET');
    },
  );

  it.each([
    [409, 'BlobAlreadyExists'],
    [412, 'ConditionNotMet'],
  ] as const)('rejects conflicting bytes after Azure %s/%s', async (status, code) => {
    const { value } = transport(status, code, 'frozen');
    await expect(
      value.putIfAbsent('artifact/bundle.tar.gz', Buffer.from('different')),
    ).rejects.toThrow('artifact-immutable-conflict');
  });

  it.each(['LeaseAlreadyPresent', 'BlobImmutableDueToPolicy', ''])(
    'does not reinterpret unrelated 409/%s as an existing-object replay',
    async (code) => {
      const { value, request } = transport(409, code, 'frozen');
      await expect(
        value.putIfAbsent('artifact/bundle.tar.gz', Buffer.from('frozen')),
      ).rejects.toThrow('artifact-store-unavailable');
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
});
