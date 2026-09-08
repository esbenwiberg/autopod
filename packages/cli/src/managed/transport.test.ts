import { expect, it, vi } from 'vitest';
import { managedRequest } from './transport.js';
const binding = {
  endpoint: 'https://daemon.test',
  issuer: 'https://issuer/tenant/',
  audience: 'api://autopod',
  objectId: 'owner',
};
const token = (override = {}) =>
  `header.${Buffer.from(JSON.stringify({ iss: binding.issuer, aud: binding.audience, oid: binding.objectId, exp: Date.now() / 1000 + 60, ...override })).toString('base64url')}.fixture`;
it('uses one pinned endpoint with bearer auth, redirects disabled and a bounded response', async () => {
  const fetcher = vi.fn(async () => new Response('{"enabled":false}'));
  const result = await managedRequest(
    binding,
    binding.endpoint,
    token(),
    { method: 'GET', path: '/managed/health' },
    fetcher,
  );
  expect(result).toEqual({ body: { enabled: false } });
  expect(fetcher).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      redirect: 'error',
      headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Bearer /) }),
    }),
  );
});
it('rejects account, issuer, audience, expiry, target and traversal mismatches before any request', async () => {
  const fetcher = vi.fn();
  for (const override of [
    { oid: 'other' },
    { iss: 'https://other/' },
    { aud: 'other' },
    { exp: 0 },
  ])
    await expect(
      managedRequest(
        binding,
        binding.endpoint,
        token(override),
        { method: 'GET', path: '/managed/health' },
        fetcher,
      ),
    ).rejects.toThrow();
  for (const path of [
    '//other/managed',
    '/managed/../pods',
    '/managed/%2e%2e/pods',
    '/native',
    '/managed/health?token=secret',
  ])
    await expect(
      managedRequest(binding, binding.endpoint, token(), { method: 'GET', path }, fetcher),
    ).rejects.toThrow();
  await expect(
    managedRequest(
      binding,
      'https://other',
      token(),
      { method: 'GET', path: '/managed/health' },
      fetcher,
    ),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('does not retry uncertain mutation or emit error bodies; bounds downloads and supports cursors', async () => {
  const failed = vi.fn(async () => new Response('secret', { status: 401 }));
  await expect(
    managedRequest(
      binding,
      binding.endpoint,
      token(),
      { method: 'POST', path: '/managed/pods', body: {} },
      failed,
    ),
  ).rejects.toThrow('managed-request-unavailable');
  expect(failed).toHaveBeenCalledTimes(1);
  await expect(
    managedRequest(
      binding,
      binding.endpoint,
      token(),
      { method: 'GET', path: '/managed/health', maximumBytes: 2 },
      async () => new Response('long'),
    ),
  ).rejects.toThrow('too-large');
  expect(
    await managedRequest(
      binding,
      binding.endpoint,
      token(),
      { method: 'GET', path: '/managed/pods/id/candidate/bundle', binary: true, maximumBytes: 10 },
      async () => new Response('bytes'),
    ),
  ).toEqual({ base64: Buffer.from('bytes').toString('base64') });
  expect(
    await managedRequest(
      binding,
      binding.endpoint,
      token(),
      { method: 'GET', path: '/managed/pods/id/events?cursor=2' },
      async () => new Response('{}'),
    ),
  ).toEqual({ body: {} });
});
