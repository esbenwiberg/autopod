import { describe, expect, it, vi } from 'vitest';
import { createServiceCredentialBoundary } from './service-credential-boundary.js';

describe('service credential enrollment boundary', () => {
  it.each([
    'ghp_sourcefixture',
    'a'.repeat(40),
    'Z'.repeat(52),
    Buffer.from('user:daemon-delivery-fixture').toString('base64'),
    `Bearer ${Buffer.from(JSON.stringify({ aud: '499b84ac-1321-427f-aa17-267ca6975798' })).toString('base64url')}`,
  ])(
    'rejects source credential representations without sending them to any provider',
    async (value) => {
      const check = createServiceCredentialBoundary(async () => ['daemon-delivery-fixture']);
      await expect(
        check(value, ['mcp-env'], ['https://service.example.test']),
      ).rejects.toMatchObject({ code: 'SOURCE_CREDENTIAL_FORBIDDEN' });
    },
  );
  it('requires an explicit service origin and current source-credential checks', async () => {
    const source = vi.fn(async () => [] as string[]);
    const check = createServiceCredentialBoundary(source);
    await expect(check('service-fixture', ['build-env'], [])).rejects.toMatchObject({
      code: 'CONFIG_CREDENTIAL_SCOPE',
    });
    await expect(
      check('service-fixture', ['registry-read'], ['https://dev.azure.com']),
    ).rejects.toMatchObject({ code: 'SOURCE_CREDENTIAL_FORBIDDEN' });
    expect(source).not.toHaveBeenCalled();
    await expect(
      check('service-fixture', ['mcp-http'], ['https://mcp.example.test']),
    ).resolves.toBeUndefined();
    source.mockResolvedValueOnce(['service-fixture']);
    await expect(
      check('service-fixture', ['mcp-http'], ['https://mcp.example.test']),
    ).rejects.toMatchObject({ code: 'SOURCE_CREDENTIAL_FORBIDDEN' });
    source.mockRejectedValueOnce(new Error('Source authentication unavailable'));
    await expect(
      check('service-fixture', ['mcp-http'], ['https://mcp.example.test']),
    ).rejects.toThrow('unavailable');
  });
});
