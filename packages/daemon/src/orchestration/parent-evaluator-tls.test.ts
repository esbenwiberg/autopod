import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  createParentEvaluatorTlsFetch,
  loadParentEvaluatorTlsFetch,
} from './parent-evaluator-tls.js';

const endpoints = {
  checks: 'https://checks.trial.internal/verify',
  independentReview: 'https://review.trial.internal/verify',
};
const post = { method: 'POST', body: '{"fixture":true}' };

async function fixture() {
  const dir = await mkdtemp(path.join(await realpath(tmpdir()), 'evaluator-mtls-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const openssl = (...args: string[]) =>
    execFileSync('openssl', args, { cwd: dir, timeout: 3000, stdio: 'pipe' });

  const role = async (name: string) => {
    const host = new URL(name === 'checks' ? endpoints.checks : endpoints.independentReview)
      .hostname;
    const cn = 'fixture-' + name;
    openssl(
      'req',
      '-x509',
      '-nodes',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-pkeyopt',
      'ec_param_enc:named_curve',
      '-sha256',
      '-days',
      '1',
      '-subj',
      '/CN=' + cn,
      '-keyout',
      cn + '.key',
      '-out',
      cn + '.pem',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign',
    );
    const leaf = async (purpose: 'server' | 'client', hostname = host, suffix = '') => {
      const id = name + '-' + purpose + suffix;
      openssl(
        'req',
        '-new',
        '-nodes',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-pkeyopt',
        'ec_param_enc:named_curve',
        '-subj',
        '/CN=' + (purpose === 'server' ? hostname : id),
        '-keyout',
        id + '.key',
        '-out',
        id + '.csr',
      );
      await writeFile(
        path.join(dir, id + '.ext'),
        'extendedKeyUsage=' +
          purpose +
          'Auth\n' +
          (purpose === 'server' ? 'subjectAltName=DNS:' + hostname + '\n' : ''),
      );
      openssl(
        'x509',
        '-req',
        '-sha256',
        '-days',
        '1',
        '-in',
        id + '.csr',
        '-CA',
        cn + '.pem',
        '-CAkey',
        cn + '.key',
        '-CAcreateserial',
        '-extfile',
        id + '.ext',
        '-out',
        id + '.pem',
      );
      return {
        ca: await readFile(path.join(dir, cn + '.pem')),
        cert: await readFile(path.join(dir, id + '.pem')),
        key: await readFile(path.join(dir, id + '.key')),
      };
    };
    return {
      server: await leaf('server'),
      client: await leaf('client'),
      wrongName: await leaf('server', 'wrong.trial.internal', '-wrong-name'),
    };
  };
  const checks = await role('checks'),
    review = await role('review');

  const open = async (material: typeof checks.server) => {
    let outcome = 'ok';
    const received = vi.fn();
    const server = createServer(
      { ...material, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' },
      (req, res) => {
        received(req.url, (req.socket as TLSSocket).getPeerCertificate().subject.CN);
        req.resume();
        if (outcome === 'redirect') {
          res.writeHead(302, { location: endpoints.independentReview });
          res.end();
        } else if (outcome === 'hang') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{');
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(outcome === 'large' ? 'x'.repeat(2049) : '{}');
        }
      },
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    onTestFinished(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    return {
      port: (server.address() as AddressInfo).port,
      received,
      reply: (mode: string) => {
        outcome = mode;
      },
    };
  };
  const material = { checks: checks.client, independentReview: review.client };
  return { dir, checks, review, open, material };
}

it('uses separate private trust and client identities, without redirects or fallback', async () => {
  const f = await fixture();
  const checks = await f.open(f.checks.server),
    review = await f.open(f.review.server);
  let checkPort = checks.port;
  const dial: typeof request = ((
    url: URL,
    options: object,
    handler: Parameters<typeof request>[2],
  ) =>
    request(
      url,
      {
        ...options,
        hostname: '127.0.0.1',
        port: url.hostname.startsWith('checks.') ? checkPort : review.port,
      },
      handler,
    )) as typeof request;
  const send = createParentEvaluatorTlsFetch(endpoints, f.material, dial);
  await expect(send(endpoints.checks, post).then((r) => r.json())).resolves.toEqual({});
  await expect(send(endpoints.independentReview, post).then((r) => r.json())).resolves.toEqual({});
  expect(checks.received.mock.calls).toEqual([['/verify', 'checks-client']]);
  expect(review.received.mock.calls).toEqual([['/verify', 'review-client']]);
  await expect(send(endpoints.checks + '/alternate', post)).rejects.toThrow('request-refused');

  const wrongName = await f.open(f.checks.wrongName);
  checkPort = wrongName.port;
  await expect(send(endpoints.checks, post)).rejects.toThrow('response-unavailable');
  expect(wrongName.received).not.toHaveBeenCalled();
  checkPort = review.port;
  await expect(send(endpoints.checks, post)).rejects.toThrow('response-unavailable');
  expect(review.received).toHaveBeenCalledTimes(1);

  checkPort = checks.port;
  const wrongClient = createParentEvaluatorTlsFetch(
    endpoints,
    {
      checks: { ...f.review.client, ca: f.checks.client.ca },
      independentReview: { ...f.checks.client, ca: f.review.client.ca },
    },
    dial,
  );
  await expect(wrongClient(endpoints.checks, post)).rejects.toThrow('response-unavailable');
  expect(checks.received).toHaveBeenCalledTimes(1);

  checks.reply('redirect');
  await expect(send(endpoints.checks, post)).rejects.toThrow('response-unavailable');
  expect(checks.received).toHaveBeenCalledTimes(2);
  expect(review.received).toHaveBeenCalledTimes(1);
  checks.reply('large');
  await expect(send(endpoints.checks, post)).rejects.toThrow('response-bound');
  expect(checks.received).toHaveBeenCalledTimes(3);
  checks.reply('hang');
  await expect(
    send(endpoints.checks, { ...post, signal: AbortSignal.timeout(500) }),
  ).rejects.toThrow('response-unavailable');
  expect(checks.received).toHaveBeenCalledTimes(4);
}, 15_000);

it('requires both protected credential sets and refuses shared roots or identities', async () => {
  const f = await fixture();
  expect(() =>
    createParentEvaluatorTlsFetch(endpoints, {
      ...f.material,
      independentReview: { ...f.review.client, ca: f.checks.client.ca },
    }),
  ).toThrow('must-be-separate');
  expect(() =>
    createParentEvaluatorTlsFetch(endpoints, {
      ...f.material,
      independentReview: { ...f.checks.client, ca: f.review.client.ca },
    }),
  ).toThrow('must-be-separate');
  await expect(loadParentEvaluatorTlsFetch(endpoints, f.dir)).rejects.toThrow(
    'credentials-required',
  );
  for (const [role, m] of [
    ['checks', f.checks.client],
    ['review', f.review.client],
  ] as const)
    for (const k of ['ca', 'cert', 'key'] as const)
      await writeFile(path.join(f.dir, 'autopod-parent-evaluator-' + role + '-tls-' + k), m[k], {
        mode: 0o600,
      });
  await expect(loadParentEvaluatorTlsFetch(endpoints, f.dir)).resolves.toBeTypeOf('function');
  await chmod(f.dir, 0o770);
  await expect(loadParentEvaluatorTlsFetch(endpoints, f.dir)).rejects.toThrow(
    'credentials-required',
  );
  await chmod(f.dir, 0o700);
  await chmod(path.join(f.dir, 'autopod-parent-evaluator-review-tls-key'), 0o644);
  await expect(loadParentEvaluatorTlsFetch(endpoints, f.dir)).rejects.toThrow(
    'credentials-required',
  );
}, 10_000);
