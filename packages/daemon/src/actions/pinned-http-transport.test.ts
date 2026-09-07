import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionDefinition } from '@autopod/shared';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGenericHttpHandler } from './generic-http-handler.js';
import { createPinnedHttpTransport } from './pinned-http-transport.js';

describe('pinned action HTTPS trust and hostname verification', () => {
  let directory: string;
  let certificate: string;
  let port: number;
  let server: ReturnType<typeof createServer>;
  const requests: string[] = [];

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'autopod-action-tls-'));
    const config = join(directory, 'cert.cnf');
    writeFileSync(
      config,
      '[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=pinned.invalid\n[extensions]\nsubjectAltName=DNS:pinned.invalid\nbasicConstraints=critical,CA:TRUE\n',
    );
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-config',
        config,
        '-keyout',
        join(directory, 'key.pem'),
        '-out',
        join(directory, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    certificate = readFileSync(join(directory, 'cert.pem'), 'utf8');
    server = createServer(
      { key: readFileSync(join(directory, 'key.pem')), cert: certificate },
      (req, res) => {
        requests.push(req.headers.host ?? '');
        res.end('{"ok":true}');
      },
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No TLS fixture port');
    port = address.port;
  });

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function execute(hostname: string, trustFixture: boolean) {
    const handler = createGenericHttpHandler({
      logger: pino({ level: 'silent' }),
      getSecret: () => undefined,
      ssrfGuard: async () => ({ ok: true, resolvedIps: ['127.0.0.1'] }),
      httpTransport: createPinnedHttpTransport(trustFixture ? { ca: certificate } : {}),
    });
    const action: ActionDefinition = {
      name: 'tls_fixture',
      description: '',
      group: 'http',
      handler: 'http',
      params: {},
      endpoint: { url: `https://${hostname}:${port}`, method: 'GET', timeout: 1_000 },
      response: { fields: ['ok'] },
    };
    return handler.execute(action, {});
  }

  it('uses the pinned address while preserving Host and trusted certificate matching', async () => {
    await expect(execute('pinned.invalid', true)).resolves.toEqual({ ok: true });
    expect(requests).toContain(`pinned.invalid:${port}`);
  });

  it('rejects an untrusted certificate before sending an HTTP request', async () => {
    const before = requests.length;
    await expect(execute('pinned.invalid', false)).rejects.toThrow(/certificate/i);
    expect(requests).toHaveLength(before);
  });

  it('rejects a hostname mismatch even when the issuing certificate is trusted', async () => {
    const before = requests.length;
    await expect(execute('wrong.invalid', true)).rejects.toThrow(/hostname|altnames/i);
    expect(requests).toHaveLength(before);
  });
});
