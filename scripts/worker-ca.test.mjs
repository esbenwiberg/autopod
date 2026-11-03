import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Node reads extra CA roots at process startup. Use real isolated children so
// this check never changes the test runner's trust or disables verification.
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !['NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS'].includes(key),
  ),
);

test('worker Node trust adds managed roots without accepting untrusted TLS', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'autopod-worker-ca-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = join(directory, 'key.pem');
  const cert = join(directory, 'cert.pem');
  const unrelated = join(directory, 'unrelated.pem');
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost',
    '-keyout',
    key,
    '-out',
    cert,
  ]);
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=unrelated',
    '-keyout',
    join(directory, 'unrelated.key'),
    '-out',
    unrelated,
  ]);
  // Model the system bundle: additional managed roots, not a server-only CA override.
  const bundle = join(directory, 'managed-roots.pem');
  await writeFile(bundle, `${readFileSync(unrelated)}\n${readFileSync(cert)}`);
  const sockets = new Set();
  const server = https.createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (_request, response) => response.end('verified'),
  );
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  async function request(host, extraCa) {
    const code = `
      const request = require('node:https').get(${JSON.stringify(`https://${host}:${port}/`)}, response => {
        response.setEncoding('utf8');
        response.on('data', part => process.stdout.write(part));
      });
      request.on('error', error => process.stdout.write(error.code));
    `;
    const { stdout } = await run(process.execPath, ['-e', code], {
      env: { ...cleanEnv, ...(extraCa ? { NODE_EXTRA_CA_CERTS: extraCa } : {}) },
      timeout: 10_000,
    });
    return stdout;
  }
  assert.equal(await request('localhost', bundle), 'verified');
  assert.match(
    await request('localhost'),
    /^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)$/,
  );
  assert.match(
    await request('localhost', unrelated),
    /^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)$/,
  );
  assert.equal(await request('127.0.0.1', bundle), 'ERR_TLS_CERT_ALTNAME_INVALID');
});
