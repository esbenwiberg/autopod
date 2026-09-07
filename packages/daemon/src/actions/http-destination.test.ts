import { type RequestListener, createServer } from 'node:http';
import type { ActionDefinition } from '@autopod/shared';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPublicUrl } from '../api/ssrf-guard.js';
import { createGenericHttpHandler } from './generic-http-handler.js';

const closes: Array<() => Promise<void>> = [];
async function serve(listener: RequestListener) {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  closes.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  return { url: `http://127.0.0.1:${address.port}`, port: address.port };
}
function action(
  url: string,
  auth: NonNullable<ActionDefinition['endpoint']>['auth'] = { type: 'none' },
  timeout = 1_000,
): ActionDefinition {
  return {
    name: 'destination_fixture',
    description: '',
    handler: 'http',
    group: 'http',
    params: {},
    response: { fields: ['ok'] },
    endpoint: { url, method: 'GET', auth, timeout },
  };
}
afterEach(async () => {
  await Promise.all(closes.splice(0).map((close) => close()));
});

describe('generic HTTP destination boundary', () => {
  it.each([
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[0:0:0:0:0:ffff:a9fe:a9fe]/',
  ])('blocks equivalent mapped private URL %s before DNS or transport', async (url) => {
    const resolver = vi.fn(async () => ['8.8.8.8']);
    expect((await assertPublicUrl(url, { resolver })).ok).toBe(false);
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each(['bearer', 'custom-header'] as const)(
    'never follows a redirect with %s credentials',
    async (type) => {
      const target = vi.fn<RequestListener>((_req, res) => res.end('{"ok":true}'));
      const destination = await serve(target);
      const origin = await serve((_req, res) => {
        res.writeHead(302, { Location: destination.url });
        res.end();
      });
      const handler = createGenericHttpHandler({
        logger: pino({ level: 'silent' }),
        getSecret: () => 'synthetic-only',
        ssrfGuard: async () => ({ ok: true, resolvedIps: ['127.0.0.1'] }),
      });
      const auth =
        type === 'bearer'
          ? { type, secret: '${KEY}' }
          : { type, name: 'X-Private-Key', value: '${KEY}' };
      await expect(handler.execute(action(origin.url, auth), {})).rejects.toThrow(/redirect/i);
      expect(target).not.toHaveBeenCalled();
    },
  );

  it('connects using the validated address without resolving the hostname again', async () => {
    let host: string | undefined;
    const origin = await serve((req, res) => {
      host = req.headers.host;
      res.end('{"ok":true}');
    });
    // Controlled DNS seam: .invalid cannot resolve through system DNS. The
    // approved fixture address must be used for the actual connection.
    const guard = vi.fn(async () => ({ ok: true, resolvedIps: ['127.0.0.1'] }));
    const handler = createGenericHttpHandler({
      logger: pino({ level: 'silent' }),
      getSecret: () => undefined,
      ssrfGuard: guard,
    });
    await expect(
      handler.execute(action(`http://pinned.invalid:${origin.port}`), {}),
    ).resolves.toEqual({ ok: true });
    expect(host).toBe(`pinned.invalid:${origin.port}`);
    expect(guard).toHaveBeenCalledTimes(1);
  });

  it('includes DNS validation in the action deadline and issues no late request', async () => {
    const target = vi.fn<RequestListener>((_req, res) => res.end('{"ok":true}'));
    const origin = await serve(target);
    const guard = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
      return { ok: true, resolvedIps: ['127.0.0.1'] };
    };
    const handler = createGenericHttpHandler({
      logger: pino({ level: 'silent' }),
      getSecret: () => undefined,
      ssrfGuard: guard,
    });
    await expect(handler.execute(action(origin.url, undefined, 60), {})).rejects.toThrow();
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(target).not.toHaveBeenCalled();
  });
});
