import { chmod, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { digest } from '../managed/canonical.js';
import { fixtureSigner } from '../test-utils/gate-signer.js';
import type { GateStatement } from './combined-attestation.js';
import { assertReceiptSocket, createParentReceiptSigner } from './parent-receipt-socket.js';

it.each([
  'ok',
  'wrong key',
  'redirect',
  'large',
  'lost reply',
])('bounds the one-shot signer request: %s', async (mode) => {
  const root = await realpath(
    await mkdtemp(process.platform === 'darwin' ? '/private/tmp/ap-rs-' : '/tmp/ap-rs-'),
  );
  const dirname = path.join(root, 'authority');
  await mkdir(dirname, { mode: 0o750 });
  const socket = path.join(dirname, 'receipt.sock');
  const checks = fixtureSigner('checks', 'checker', digest('check configuration'));
  const other = fixtureSigner('checks', 'checker', checks.authority.configurationDigest);
  const review = fixtureSigner('independentReview', 'reviewer', digest('review configuration'));
  const policy = {
    checks: checks.authority,
    independentReview: review.authority,
    basePolicyDigest: digest('base'),
  };
  const statement: GateStatement = {
    role: 'checks',
    identity: checks.authority.identity,
    configurationDigest: checks.authority.configurationDigest,
    status: 'passed',
    inputDigest: digest('exact tree'),
    evidenceDigest: digest('evidence'),
  };
  const receives = vi.fn();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(part);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    receives(req.method, req.url, request);
    if (mode === 'lost reply') return req.socket.destroy();
    res.setHeader('content-type', 'application/json');
    if (mode === 'redirect') {
      res.statusCode = 302;
      res.setHeader('location', 'http://127.0.0.1:1/');
      return res.end('{}');
    }
    const signer = mode === 'wrong key' ? other : checks;
    res.end(mode === 'large' ? 'x'.repeat(4097) : JSON.stringify(signer.attest(request)));
  });
  onTestFinished(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  await chmod(socket, 0o660);
  const endpoint = { socket, uid: process.getuid!() };
  await expect(assertReceiptSocket(endpoint, endpoint.uid)).rejects.toThrow('socket-refused');
  // Same OS account is strictly forbidden by production boot. Exercise only
  // the wire protocol against fixture keys here, with an injected probe.
  const probe = vi.fn(async () => {});
  const sign = createParentReceiptSigner(policy, 'checks', endpoint, probe);
  await expect(sign({ ...statement, role: 'independentReview' })).rejects.toThrow(
    'request-refused',
  );
  if (mode === 'ok') await expect(sign(statement)).resolves.toEqual(checks.attest(statement));
  else await expect(sign(statement)).rejects.toThrow();
  await expect(sign(statement)).rejects.toThrow('request-refused');
  expect(probe).toHaveBeenCalledOnce();
  expect(receives).toHaveBeenCalledExactlyOnceWith('POST', '/v1/parent-receipt', statement);
});
