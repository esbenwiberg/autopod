import { packageFeedSchema } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { probePackageFeed } from './package-feed-probe.js';

const token = 'fixture-private-token';
const npm = packageFeedSchema.parse({ type: 'npm', url: 'https://packages.example.com/npm/' });
function fixture(responses: Response[]) {
  return {
    guard: vi.fn(async () => ({ ok: true as const, resolvedIps: ['8.8.8.8'] })),
    transport: vi.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error(`untrusted ${token}`);
      return response;
    }),
  };
}
describe('package feed authenticated read probe', () => {
  it('pins public DNS and proves npm identity only after anonymous rejection, without returning identity', async () => {
    const f = fixture([
      new Response('', { status: 401 }),
      Response.json({ username: 'private-user' }),
    ]);
    const result = await probePackageFeed(npm, token, f);
    expect(result.status).toBe('authenticated');
    expect(f.guard).toHaveBeenCalledTimes(2);
    expect(f.transport).toHaveBeenLastCalledWith(
      'https://packages.example.com/npm/-/whoami',
      expect.objectContaining({
        redirect: 'manual',
        headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
      }),
      ['8.8.8.8'],
    );
    expect(JSON.stringify(result)).not.toContain('private-user');
    expect(JSON.stringify(result)).not.toContain(token);
  });
  it('checks NuGet service index with Basic authentication', async () => {
    const feed = packageFeedSchema.parse({
      type: 'nuget',
      url: 'https://pkgs.dev.azure.com/org/_packaging/feed/nuget/v3/index.json',
    });
    const f = fixture([new Response('', { status: 401 }), Response.json({ resources: [] })]);
    expect((await probePackageFeed(feed, token, f)).status).toBe('authenticated');
    expect(f.transport).toHaveBeenLastCalledWith(
      feed.url,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from(`autopod:${token}`).toString('base64')}`,
        }),
      }),
      ['8.8.8.8'],
    );
  });
  it.each([200, 404, 302])(
    'does not send a PAT or claim validation when anonymous endpoint returns %s',
    async (status) => {
      const f = fixture([
        new Response('{}', { status, headers: { location: 'https://elsewhere.example.com' } }),
      ]);
      expect((await probePackageFeed(npm, token, f)).status).toBe('unverified');
      expect(f.transport).toHaveBeenCalledOnce();
      expect(JSON.stringify(f.transport.mock.calls)).not.toContain(token);
    },
  );
  it.each([
    [401, 'rejected'],
    [403, 'forbidden'],
    [302, 'unavailable'],
    [404, 'unverified'],
  ] as const)(
    'classifies authenticated HTTP %s without reflecting errors',
    async (status, expected) => {
      const f = fixture([
        new Response('', { status: 401 }),
        new Response(`error ${token}`, {
          status,
          headers: { location: 'https://elsewhere.example.com' },
        }),
      ]);
      const result = await probePackageFeed(npm, token, f);
      expect(result.status).toBe(expected);
      expect(JSON.stringify(result)).not.toContain(token);
      expect(f.transport).toHaveBeenCalledTimes(2);
    },
  );
  it('refuses a destination rejected by SSRF policy and redacts transport exceptions', async () => {
    const f = fixture([]);
    const result = await probePackageFeed(npm, token, {
      ...f,
      guard: async () => ({ ok: false, reason: 'private_ip' }),
    });
    expect(result.status).toBe('unavailable');
    expect(f.transport).not.toHaveBeenCalled();
    expect((await probePackageFeed(npm, token, f)).status).toBe('unavailable');
  });
  it('rejects oversized bodies and invalid identity response', async () => {
    for (const response of [
      new Response('a'.repeat(2 * 1024 * 1024 + 1)),
      Response.json({}),
      new Response('not json'),
    ]) {
      const result = await probePackageFeed(
        npm,
        token,
        fixture([new Response('', { status: 401 }), response]),
      );
      expect(result.status).not.toBe('authenticated');
      expect(JSON.stringify(result)).not.toContain(token);
    }
  });
  it('bounds a stalled network request by a single total deadline', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture([]);
      const pending = probePackageFeed(npm, token, {
        ...f,
        transport: () => new Promise<Response>(() => {}),
      });
      await vi.advanceTimersByTimeAsync(10_001);
      expect((await pending).status).toBe('unavailable');
    } finally {
      vi.useRealTimers();
    }
  });
});
