import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const daemonRequire = createRequire(new URL('../packages/daemon/package.json', import.meta.url));
const transformersRequire = createRequire(daemonRequire.resolve('@huggingface/transformers'));
const onnxRequire = createRequire(transformersRequire.resolve('onnxruntime-node'));
const agentPath = onnxRequire.resolve('global-agent');

// Use the installer's actual dependency resolution in isolated processes: bootstrap
// modifies global HTTP agents, so it must never affect the test runner itself.
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith('GLOBAL_AGENT_') &&
      !['NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS'].includes(key),
  ),
);
async function request(url, env = {}, reject = false) {
  const code = `
    require(${JSON.stringify(agentPath)}).bootstrap();
    const req = require(${JSON.stringify(url.startsWith('https:') ? 'https' : 'http')}).get(${JSON.stringify(url)}, res => {
      if (${reject}) throw new Error('untrusted TLS unexpectedly accepted');
      res.setEncoding('utf8'); res.on('data', part => process.stdout.write(part));
    });
    req.on('error', error => {
      if (${reject} && ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error.code)) {
        process.stdout.write('certificate rejected');
      } else { console.error(error); process.exitCode = 1; }
    });
  `;
  return (
    await run(process.execPath, ['-e', code], {
      env: { ...cleanEnv, ...env },
      timeout: 10000,
    })
  ).stdout;
}
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

test(
  'ONNX installer proxy remains compatible without vulnerable logging dependencies',
  { timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'autopod-proxy-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const key = join(directory, 'key.pem');
    const cert = join(directory, 'cert.pem');
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
    const sockets = new Set();
    const servers = [];
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    });
    const track = (server) => {
      servers.push(server);
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      return server;
    };
    const directPort = await listen(track(http.createServer((_req, res) => res.end('direct'))));
    const tlsPort = await listen(
      track(
        https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_req, res) =>
          res.end('verified download'),
        ),
      ),
    );
    const proxied = [];
    const tunnels = [];
    const proxy = track(
      http.createServer((req, res) => {
        proxied.push(req.url);
        res.end('proxy');
      }),
    );
    proxy.on('connect', (req, socket, head) => {
      tunnels.push(req.url);
      // Restrict this test proxy to its own loopback fixture.
      if (req.url !== `localhost:${tlsPort}`) {
        socket.destroy();
        return;
      }
      const upstream = net.connect(tlsPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    });
    const proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
    await t.test('actual installer bootstrap honors the supported skip flag', async () => {
      const installer = join(
        dirname(onnxRequire.resolve('onnxruntime-node/package.json')),
        'script/install.js',
      );
      await run(process.execPath, [installer], {
        env: { ...cleanEnv, ONNXRUNTIME_NODE_INSTALL: 'skip' },
        timeout: 10000,
      });
    });
    await t.test('HTTP proxy and NO_PROXY routing are preserved', async () => {
      assert.equal(
        await request('http://download.invalid/model.onnx', { GLOBAL_AGENT_HTTP_PROXY: proxyUrl }),
        'proxy',
      );
      assert.equal(
        await request(`http://127.0.0.1:${directPort}/`, {
          GLOBAL_AGENT_HTTP_PROXY: proxyUrl,
          GLOBAL_AGENT_NO_PROXY: '127.0.0.1',
        }),
        'direct',
      );
      assert.deepEqual(proxied, ['http://download.invalid/model.onnx']);
    });
    await t.test('HTTPS downloads tunnel through proxy and honor trusted CA', async () => {
      assert.equal(
        await request(`https://localhost:${tlsPort}/model.onnx`, {
          GLOBAL_AGENT_HTTPS_PROXY: proxyUrl,
          NODE_EXTRA_CA_CERTS: cert,
        }),
        'verified download',
      );
      assert.equal(tunnels.length, 1);
    });
    await t.test('HTTPS proxy cannot bypass certificate validation', async () => {
      assert.equal(
        await request(
          `https://localhost:${tlsPort}/model.onnx`,
          {
            GLOBAL_AGENT_HTTPS_PROXY: proxyUrl,
          },
          true,
        ),
        'certificate rejected',
      );
      assert.equal(tunnels.length, 2);
    });
  },
);
