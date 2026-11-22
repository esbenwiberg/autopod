import { generateKeyPairSync } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { expect, it, onTestFinished, vi } from 'vitest';
import { digest, sha256 } from '../managed/canonical.js';
import { managedGit, managedGitBytes } from '../managed/source-git.js';
import { fixtureSigner } from '../test-utils/gate-signer.js';
import { combinedPolicyDigest, verifyGateReceipt } from './combined-attestation.js';
import { createParentEvaluatorClient } from './parent-evaluator-client.js';
import { createEvaluatorDispatchSigner } from './parent-evaluator-dispatch.js';
import { registerParentEvaluatorEndpoint } from './parent-evaluator-endpoint.js';
import { startParentEvaluatorService } from './parent-evaluator-service.js';
import { parentIntegrationGateDigest } from './parent-integration-qualified.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'evaluator-endpoint-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await managedGit(root, ['init', '--bare', repo]);
  const tree = (
    await managedGitBytes(repo, ['mktree'], undefined, [], {
      input: '',
      timeout: 5000,
      maxBuffer: 4096,
    })
  )
    .toString('ascii')
    .trim();
  const commitTree = (name: string, parents: string[]) =>
    managedGit(repo, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit-tree',
      tree,
      ...parents.flatMap((id) => ['-p', id]),
      '-m',
      name,
    ]);
  const predecessor = await commitTree('base', []);
  const left = await commitTree('left', [predecessor]);
  const right = await commitTree('right', [predecessor]);
  const commit = await commitTree('combined', [left, right]);
  await managedGit(repo, ['update-ref', '--no-deref', 'HEAD', commit]);
  const bundlePath = path.join(root, 'combined.bundle');
  await managedGit(repo, ['bundle', 'create', bundlePath, 'HEAD']);
  const bundle = await readFile(bundlePath);
  const checks = fixtureSigner('checks', 'test-checks', digest('test-checks/v1'));
  const review = fixtureSigner('independentReview', 'test-review', digest('test-review/v1'));
  const policy = {
    basePolicyDigest: digest('test-policy'),
    checks: checks.authority,
    independentReview: review.authority,
  };
  const lease = {
    run: 'a'.repeat(64),
    repository: 'fixture',
    predecessor,
    paths: ['sample/count.txt', 'sample/reason.txt'],
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  };
  const request = {
    subject: {
      run: lease.run,
      repository: lease.repository,
      predecessor,
      commit,
      tree,
      policyDigest: combinedPolicyDigest(policy),
    },
    inputs: [left, right].map((id, index) => ({
      requestKey: 'child-' + index,
      candidateDigest: digest(id),
      expectedTree: tree,
      scopeDigest: digest(lease.paths[index]),
    })),
    paths: lease.paths,
    bindingDigest: digest('test-binding'),
    bundleDigest: sha256(bundle),
  };
  const endpoint = async (
    role: 'checks' | 'independentReview',
    config: {
      allowed?: boolean;
      expired?: boolean;
      reject?: boolean;
      signerUnavailable?: boolean;
      dispatchPublicKey?: string;
    } = {},
  ) => {
    const stateDir = path.join(root, 'state-' + role);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const signer = role === 'checks' ? checks : review;
    const evaluate = vi.fn(
      async ({
        mirror,
        commit: imported,
        tree: importedTree,
      }: {
        mirror: string;
        commit: string;
        tree: string;
      }) => {
        expect(imported).toBe(commit);
        expect(importedTree).toBe(tree);
        expect(await managedGit(mirror, ['show', '-s', '--format=%P', imported])).toBe(
          left + ' ' + right,
        );
        return {
          status: config.reject ? ('failed' as const) : ('passed' as const),
          evidence: Buffer.from(role + ':' + importedTree),
        };
      },
    );
    const sign = vi.fn(async (statement: Parameters<typeof signer.attest>[0]) => {
      if (config.signerUnavailable) throw new Error('fixture signer unavailable');
      return signer.attest(statement);
    });
    const app = Fastify();
    registerParentEvaluatorEndpoint(app, {
      policy,
      role,
      lease: {
        ...lease,
        ...(config.dispatchPublicKey
          ? { dispatchPublicKey: config.dispatchPublicKey }
          : { inputDigest: parentIntegrationGateDigest(request) }),
        ...(config.expired ? { expiresAt: 1 } : {}),
      },
      stateDir,
      scratch: path.join(root, 'scratch-' + role),
      authorize: () => config.allowed !== false,
      ports: { evaluate, sign },
    });
    onTestFinished(async () => app.close());
    return { app, evaluate, sign, stateDir };
  };
  return { request, bundle, policy, endpoint, lease, root };
}

it.skipIf(process.getuid?.() === 0)(
  'runs the standalone evaluator on a protected Unix socket only',
  async () => {
    const f = await fixture();
    const root = await realpath(f.root);
    const dirs = ['state', 'scratch', 'sock', 'creds'].map((name) => path.join(root, name));
    const [stateDir, scratch, socketDir, credentialsDir] = dirs as [string, string, string, string];
    for (const dir of dirs) await mkdir(dir, { mode: 0o700 });
    const socket = path.join(socketDir, 'verify.sock');
    const cfg = path.join(root, 'service.json');
    const recipe = path.join(root, 'recipe.mjs');
    const source = Buffer.from(
      'export async function evaluate({commit, tree}) { return { status: "passed", evidence: Buffer.from(commit + ":" + tree) } }',
    );
    const receipt = generateKeyPairSync('ed25519');
    const dispatch = generateKeyPairSync('ed25519');
    const policy = {
      ...f.policy,
      checks: {
        ...f.policy.checks,
        publicKey: receipt.publicKey.export({ format: 'jwk' }).x!,
        configurationDigest: sha256(source),
      },
    };
    const lease = {
      ...f.lease,
      dispatchPublicKey: dispatch.publicKey.export({ format: 'jwk' }).x!,
    };
    const request = {
      ...f.request,
      subject: { ...f.request.subject, policyDigest: combinedPolicyDigest(policy) },
    };
    await writeFile(recipe, 'export const evaluate = 1', { mode: 0o600 });
    await writeFile(
      cfg,
      JSON.stringify({ role: 'checks', policy, lease, stateDir, scratch, socket, recipe }),
      { mode: 0o600 },
    );
    await writeFile(
      path.join(credentialsDir, 'evaluator-receipt-key'),
      receipt.privateKey.export({ format: 'pem', type: 'pkcs8' }),
      { mode: 0o600 },
    );
    await expect(startParentEvaluatorService(cfg, credentialsDir)).rejects.toThrow(
      'recipe-mismatch',
    );
    await writeFile(recipe, source);
    const credential = path.join(credentialsDir, 'evaluator-receipt-key');
    await writeFile(credential, dispatch.privateKey.export({ format: 'pem', type: 'pkcs8' }));
    await expect(startParentEvaluatorService(cfg, credentialsDir)).rejects.toThrow(
      'receipt-key-mismatch',
    );
    await writeFile(credential, receipt.privateKey.export({ format: 'pem', type: 'pkcs8' }));
    await chmod(socketDir, 0o755);
    await expect(startParentEvaluatorService(cfg, credentialsDir)).rejects.toThrow(
      'directory-invalid',
    );
    await chmod(socketDir, 0o700);
    const server = await startParentEvaluatorService(cfg, credentialsDir);
    onTestFinished(() => server.close());
    expect(server.server.address()).toBe(socket);
    expect((await lstat(socket)).mode & 0o777).toBe(0o660);
    await expect(startParentEvaluatorService(cfg, credentialsDir)).rejects.toThrow('socket-exists');
    const input = parentIntegrationGateDigest(request);
    const authorize = createEvaluatorDispatchSigner(
      {
        checks: dispatch.privateKey,
        independentReview: generateKeyPairSync('ed25519').privateKey,
      },
      policy,
    );
    const body = JSON.stringify({
      request,
      bundle: f.bundle.toString('base64'),
      dispatch: authorize('checks', input),
    });
    const result = await new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const req = httpRequest(
          {
            socketPath: socket,
            path: '/verify',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body),
            },
          },
          (res) => {
            res.setEncoding('utf8');
            let data = '';
            res.on('data', (chunk) => {
              data += chunk;
            });
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
            res.on('error', reject);
          },
        );
        req.on('error', reject);
        req.setTimeout(3000, () => req.destroy(new Error('fixture timeout')));
        req.end(body);
      },
    );
    expect(result.status).toBe(200);
    expect(verifyGateReceipt(policy, 'checks', input, JSON.parse(result.body)).status).toBe(
      'passed',
    );
  },
);

it('returns distinct signed receipts for the same verified input over real loopback HTTP', async () => {
  const f = await fixture();
  const checks = await f.endpoint('checks');
  const review = await f.endpoint('independentReview');
  const a = await checks.app.listen({ host: '127.0.0.1', port: 0 });
  const b = await review.app.listen({ host: '127.0.0.1', port: 0 });
  const urls = {
    checks: 'https://checks.fixture.example/verify',
    independentReview: 'https://review.fixture.example/verify',
  };
  // TLS termination and ingress authentication are deliberately outside the app.
  const client = createParentEvaluatorClient(urls, f.policy, (input, init) => {
    expect([urls.checks, urls.independentReview]).toContain(input);
    return fetch((input === urls.checks ? a : b) + '/verify', init);
  });
  const input = parentIntegrationGateDigest(f.request);
  const first = await client.checks(f.request, f.bundle);
  const second = await client.independentReview(f.request, f.bundle);
  expect(verifyGateReceipt(f.policy, 'checks', input, first).receipt).toEqual(first);
  expect(verifyGateReceipt(f.policy, 'independentReview', input, second).receipt).toEqual(second);
  expect(first.signature).not.toBe(second.signature);
  expect(checks.evaluate).toHaveBeenCalledTimes(1);
  expect(review.evaluate).toHaveBeenCalledTimes(1);
  expect(
    (await readFile(path.join(checks.stateDir, 'checks-' + f.lease.run + '.claim'), 'utf8')).trim(),
  ).toBe(input);
  const reopened = await f.endpoint('checks');
  const duplicate = await reopened.app.inject({
    method: 'POST',
    url: '/verify',
    payload: {
      request: f.request,
      bundle: f.bundle.toString('base64'),
    },
  });
  expect(duplicate.statusCode).toBe(409);
  expect(reopened.evaluate).not.toHaveBeenCalled();
});

it('authorizes an unknown-at-enrollment integration on loopback with a separate role-bound dispatch key', async () => {
  const f = await fixture();
  const c = generateKeyPairSync('ed25519');
  const r = generateKeyPairSync('ed25519');
  const pin = c.publicKey.export({ format: 'jwk' }).x!;
  const authorize = createEvaluatorDispatchSigner(
    {
      checks: c.privateKey,
      independentReview: r.privateKey,
    },
    f.policy,
  );
  const checks = await f.endpoint('checks', { dispatchPublicKey: pin });
  const review = await f.endpoint('independentReview', {
    dispatchPublicKey: r.publicKey.export({ format: 'jwk' }).x!,
  });
  const input = parentIntegrationGateDigest(f.request);
  const payload = { request: f.request, bundle: f.bundle.toString('base64') };
  const proof = authorize('checks', input);
  const verify = (body: object) =>
    checks.app.inject({ method: 'POST', url: '/verify', payload: body });
  for (const changed of [
    payload,
    { ...payload, dispatch: authorize('independentReview', input) },
    { ...payload, dispatch: { ...proof, expiresAt: 1 } },
    { ...payload, dispatch: { ...proof, expiresAt: proof.expiresAt + 1 } },
    { ...payload, dispatch: proof, request: { ...f.request, bindingDigest: digest('other pair') } },
  ]) {
    expect((await verify(changed)).statusCode).toBe(403);
  }
  expect(checks.evaluate).not.toHaveBeenCalled();
  const checkAddress = await checks.app.listen({ host: '127.0.0.1', port: 0 });
  const reviewAddress = await review.app.listen({ host: '127.0.0.1', port: 0 });
  const urls = {
    checks: 'https://checks.fixture.example/verify',
    independentReview: 'https://review.fixture.example/verify',
  };
  const client = createParentEvaluatorClient(
    urls,
    f.policy,
    (url, init) => fetch((url === urls.checks ? checkAddress : reviewAddress) + '/verify', init),
    authorize,
  );
  for (const role of ['checks', 'independentReview'] as const) {
    const receipt = await client[role](f.request, f.bundle);
    expect(verifyGateReceipt(f.policy, role, input, receipt).receipt).toEqual(receipt);
  }
  const restarted = await f.endpoint('checks', { dispatchPublicKey: pin });
  expect(
    (
      await restarted.app.inject({
        method: 'POST',
        url: '/verify',
        payload: { ...payload, dispatch: authorize('checks', input) },
      })
    ).statusCode,
  ).toBe(409);
  expect(restarted.evaluate).not.toHaveBeenCalled();
});

it('fails closed for unauthenticated, expired, changed or oversized input without evaluating', async () => {
  const f = await fixture();
  const payload = { request: f.request, bundle: f.bundle.toString('base64') };
  const denied = await f.endpoint('checks', { allowed: false });
  const expired = await f.endpoint('independentReview', { expired: true });
  expect((await denied.app.inject({ method: 'POST', url: '/verify', payload })).statusCode).toBe(
    404,
  );
  expect((await expired.app.inject({ method: 'POST', url: '/verify', payload })).statusCode).toBe(
    410,
  );
  const endpoint = await f.endpoint('checks');
  for (const [body, status] of [
    [{ ...payload, bundle: Buffer.from('changed').toString('base64') }, 400],
    [{ ...payload, bundle: 'A'.repeat(3 * 1024 * 1024) }, 413],
    [{ ...payload, request: { ...f.request, paths: ['other'] } }, 403],
    [{ ...payload, request: { ...f.request, bindingDigest: digest('substitute') } }, 403],
    [
      {
        ...payload,
        request: { ...f.request, subject: { ...f.request.subject, run: 'b'.repeat(64) } },
      },
      403,
    ],
  ] as const) {
    expect(
      (await endpoint.app.inject({ method: 'POST', url: '/verify', payload: body })).statusCode,
    ).toBe(status);
  }
  for (const app of [denied, expired, endpoint]) {
    expect(app.evaluate).not.toHaveBeenCalled();
    expect(app.sign).not.toHaveBeenCalled();
  }
});

it('admits at most one concurrent attempt and never converts a rejected decision to a pass', async () => {
  const f = await fixture();
  const endpoint = await f.endpoint('checks', { reject: true });
  const request = () =>
    endpoint.app.inject({
      method: 'POST',
      url: '/verify',
      payload: { request: f.request, bundle: f.bundle.toString('base64') },
    });
  const results = await Promise.all([request(), request()]);
  expect(results.map((result) => result.statusCode).sort()).toEqual([409, 422]);
  expect(endpoint.evaluate).toHaveBeenCalledTimes(1);
  expect(endpoint.sign).not.toHaveBeenCalled();
  expect((await request()).statusCode).toBe(409);
});

it('records an operational failure as unavailable, without a receipt or another attempt', async () => {
  const f = await fixture();
  const endpoint = await f.endpoint('checks', { signerUnavailable: true });
  const request = () =>
    endpoint.app.inject({
      method: 'POST',
      url: '/verify',
      payload: { request: f.request, bundle: f.bundle.toString('base64') },
    });
  const result = await request();
  expect(result.statusCode).toBe(503);
  expect(result.json()).toEqual({ code: 'evaluator-outcome-unavailable' });
  expect((await request()).statusCode).toBe(409);
  expect(endpoint.sign).toHaveBeenCalledTimes(1);
});
