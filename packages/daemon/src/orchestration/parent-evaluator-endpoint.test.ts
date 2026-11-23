import { generateKeyPairSync } from 'node:crypto';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { expect, it, onTestFinished, vi } from 'vitest';
import { digest, sha256 } from '../managed/canonical.js';
import { managedGit, managedGitBytes } from '../managed/source-git.js';
import { fixtureSigner } from '../test-utils/gate-signer.js';
import { exportAnchoredDelegationBundle } from './anchored-delegation-source.js';
import { combinedPolicyDigest, verifyGateReceipt } from './combined-attestation.js';
import { createParentEvaluatorClient } from './parent-evaluator-client.js';
import { createEvaluatorDispatchSigner } from './parent-evaluator-dispatch.js';
import { registerParentEvaluatorEndpoint } from './parent-evaluator-endpoint.js';
import { type EvaluatorEnrollment, enrollParentEvaluators } from './parent-evaluator-enrollment.js';
import { readinessDigest, requireEvaluatorReadiness } from './parent-evaluator-readiness.js';
import { startParentEvaluatorService } from './parent-evaluator-service.js';
import { parentIntegrationGateDigest } from './parent-integration-qualified.js';
import {
  createParentReviewBroker,
  nativeBrokerReviewer,
  nativeReviewConfigurationDigest,
} from './parent-review-broker.js';

async function fixture(unexpectedCombinedPath = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'evaluator-endpoint-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await managedGit(root, ['init', '--bare', repo]);
  const treeFor = async (input: string) =>
    (
      await managedGitBytes(repo, ['mktree'], undefined, [], {
        input,
        timeout: 5000,
        maxBuffer: 4096,
      })
    )
      .toString('ascii')
      .trim();
  const one = await managedGit(repo, ['hash-object', '-w', '--', '/dev/null']);
  const countRow = `100644 blob ${one}\tcount.txt\n`;
  const reasonRow = `100644 blob ${one}\treason.txt\n`;
  const sampleTree = async (files: string, extra = '') =>
    treeFor(`040000 tree ${await treeFor(files)}\tsample\n${extra}`);
  const tree = await sampleTree(
    countRow + reasonRow,
    unexpectedCombinedPath ? `100644 blob ${one}\textra.txt\n` : '',
  );
  const commitTree = (name: string, parents: string[], tree: string) =>
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
  const predecessor = await commitTree('base', [], await treeFor(''));
  const left = await commitTree('left', [predecessor], await sampleTree(countRow));
  const right = await commitTree('right', [predecessor], await sampleTree(reasonRow));
  const commit = await commitTree('combined', [left, right], tree);
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
      enrollment?: { dispatchPublicKey: string; leaseSeconds?: number };
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
      ...(config.enrollment
        ? {
            enrollment: {
              repository: lease.repository,
              paths: lease.paths,
              dispatchPublicKey: config.enrollment.dispatchPublicKey,
              leaseSeconds: config.enrollment.leaseSeconds ?? 600,
            },
          }
        : {
            lease: {
              ...lease,
              ...(config.dispatchPublicKey
                ? { dispatchPublicKey: config.dispatchPublicKey }
                : { inputDigest: parentIntegrationGateDigest(request) }),
              ...(config.expired ? { expiresAt: 1 } : {}),
            },
          }),
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

it.skipIf(process.getuid?.() === 0).each(['fixed', 'automatic', 'anchored', 'native'] as const)(
  'runs the %s standalone evaluator on a protected Unix socket only',
  async (mode) => {
    const f = await fixture();
    const root = await realpath(f.root);
    const dirs = ['state', 'scratch', 'sock', 'creds'].map((name) => path.join(root, name));
    const [stateDir, scratch, socketDir, credentialsDir] = dirs as [string, string, string, string];
    for (const dir of dirs) await mkdir(dir, { mode: 0o700 });
    const socket = path.join(socketDir, 'verify.sock');
    const cfg = path.join(root, 'service.json');
    const recipe = path.join(root, 'recipe.mjs');
    const native = mode === 'native';
    const role = native ? 'independentReview' : 'checks';
    const brokerDir = native
      ? await mkdtemp(path.join(await realpath('/tmp'), 'ap-review-'))
      : root;
    if (native) onTestFinished(() => rm(brokerDir, { recursive: true, force: true }));
    const reviewBrokerSocket = path.join(brokerDir, 'review.sock');
    const source = Buffer.from(
      'export async function evaluate({commit, tree}) { return { status: "passed", evidence: Buffer.from(commit + ":" + tree) } }',
    );
    const receipt = generateKeyPairSync('ed25519');
    const dispatch = generateKeyPairSync('ed25519');
    const policy = {
      ...f.policy,
      [role]: {
        ...f.policy[role],
        publicKey: receipt.publicKey.export({ format: 'jwk' }).x!,
        configurationDigest: native
          ? nativeReviewConfigurationDigest(reviewBrokerSocket)
          : sha256(source),
      },
    };
    const lease = {
      ...f.lease,
      dispatchPublicKey: dispatch.publicKey.export({ format: 'jwk' }).x!,
    };
    const resultTransport = mode === 'anchored' || native ? ('anchored/v1' as const) : undefined;
    const request = {
      ...f.request,
      subject: { ...f.request.subject, policyDigest: combinedPolicyDigest(policy) },
      ...(resultTransport ? { resultTransport } : {}),
    };
    const publishedMirror = path.join(root, 'published.git');
    let bundle = f.bundle;
    if (resultTransport) {
      const repo = path.join(root, 'repo');
      await managedGit(root, ['init', '--bare', '-b', 'main', publishedMirror]);
      await managedGit(publishedMirror, [
        'fetch',
        '--no-tags',
        '--',
        repo,
        lease.predecessor + ':refs/heads/main',
      ]);
      const predecessorTree = await managedGit(publishedMirror, ['rev-parse', 'HEAD^{tree}']);
      bundle = await exportAnchoredDelegationBundle(repo, { ...request.subject, predecessorTree });
      request.bundleDigest = sha256(bundle);
    }
    const enrollment = {
      repository: lease.repository,
      paths: lease.paths,
      dispatchPublicKey: lease.dispatchPublicKey,
      leaseSeconds: 600,
    };
    const leaseConfig =
      mode === 'fixed'
        ? { lease }
        : { enrollment, ...(resultTransport ? { publishedMirror } : {}) };
    await writeFile(recipe, 'export const evaluate = 1', { mode: 0o600 });
    await writeFile(
      cfg,
      JSON.stringify({
        role,
        policy,
        ...leaseConfig,
        stateDir,
        scratch,
        socket,
        ...(native ? { reviewBrokerSocket } : { recipe }),
      }),
      { mode: 0o600 },
    );
    await writeFile(
      path.join(credentialsDir, 'evaluator-receipt-key'),
      receipt.privateKey.export({ format: 'pem', type: 'pkcs8' }),
      { mode: 0o600 },
    );
    if (!native)
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
    const keys = {
      checks: generateKeyPairSync('ed25519').privateKey,
      independentReview: generateKeyPairSync('ed25519').privateKey,
    };
    keys[role] = dispatch.privateKey;
    const authorize = createEvaluatorDispatchSigner(keys, policy);
    const post = (body: string) =>
      new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
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
      });
    const urls = {
      checks: 'https://checks.fixture.example/verify',
      independentReview: 'https://review.fixture.example/verify',
    };
    const dispatched: typeof fetch = async (url, init) => {
      if (url !== urls[role]) throw new Error('second role not configured in this fixture');
      const result = await post(String(init?.body));
      return new Response(result.body, {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      });
    };
    if (native) {
      const { run, repository, predecessor, paths } = lease;
      const enrollment = {
        run,
        repository,
        predecessor,
        paths,
        basePolicyDigest: policy.basePolicyDigest,
        resultTransport,
      };
      const id = digest([
        'autopod.evaluator-enrollment/v1',
        enrollment,
        combinedPolicyDigest(policy),
      ]);
      expect(
        (await post(JSON.stringify({ enrollment, dispatch: authorize(role, id) }))).status,
      ).toBe(200);
    } else if (mode !== 'fixed') {
      await expect(
        enrollParentEvaluators(
          urls,
          dispatched,
          authorize,
          {
            run: lease.run,
            repository: lease.repository,
            predecessor: lease.predecessor,
            paths: lease.paths,
            basePolicyDigest: policy.basePolicyDigest,
            ...(resultTransport ? { resultTransport } : {}),
          },
          policy,
        ),
      ).rejects.toThrow('second role not configured');
    }
    const payload = JSON.stringify({
      request,
      bundle: bundle.toString('base64'),
      dispatch: authorize(role, input),
    });
    const select = {
      run: request.subject.run,
      inputDigest: input,
      commit: request.subject.commit,
      tree: request.subject.tree,
    };
    const evaluate = vi.fn(async () => ({
      status: 'passed' as const,
      evidence: Buffer.from(select.tree),
    }));
    let result: Awaited<ReturnType<typeof post>>;
    if (native) {
      const readiness = {
        run: lease.run,
        repository: lease.repository,
        predecessor: lease.predecessor,
        paths: lease.paths,
        policyDigest: request.subject.policyDigest,
      };
      const readinessPayload = JSON.stringify({
        readiness,
        dispatch: authorize(role, readinessDigest(readiness)),
      });
      expect((await post(readinessPayload)).status).toBe(503);
      const gid = process.getgid!();
      await chown(brokerDir, process.getuid!(), gid);
      const broker = createParentReviewBroker({ socket: reviewBrokerSocket, groupId: gid });
      await expect(broker.open()).rejects.toThrow('directory-refused');
      await chmod(brokerDir, 0o2750);
      await broker.open();
      onTestFinished(() => broker.close());
      expect((await post(readinessPayload)).status).toBe(200);
      const nativePort = nativeBrokerReviewer(reviewBrokerSocket);
      const direct = { ...select, mirror: root, predecessor: lease.predecessor };
      await expect(nativePort.evaluate(direct)).rejects.toThrow('unavailable');
      result = await broker.withDispatch(select, evaluate, async () => {
        await expect(nativePort.evaluate({ ...direct, tree: 'a'.repeat(40) })).rejects.toThrow(
          'unavailable',
        );
        await expect(
          nativePort.evaluate({ ...direct, inputDigest: digest('another input') }),
        ).rejects.toThrow('unavailable');
        expect(evaluate).not.toHaveBeenCalled();
        const outcome = await post(payload);
        await expect(nativePort.evaluate(direct)).rejects.toThrow('unavailable');
        return outcome;
      });
      expect(evaluate).toHaveBeenCalledTimes(1);
      await expect(nativePort.evaluate(direct)).rejects.toThrow('unavailable');
      expect((await post(payload)).status).toBe(409);
    } else result = await post(payload);
    expect(result.status).toBe(200);
    expect(verifyGateReceipt(policy, role, input, JSON.parse(result.body)).status).toBe('passed');
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
  const transport: typeof fetch = (url, init) =>
    fetch((url === urls.checks ? checkAddress : reviewAddress) + '/verify', init);
  const { run, repository, predecessor, policyDigest } = f.request.subject;
  const readiness = { run, repository, predecessor, policyDigest, paths: f.request.paths };
  expect(
    (
      await verify({
        readiness,
        dispatch: authorize('independentReview', readinessDigest(readiness)),
      })
    ).statusCode,
  ).toBe(403);
  await expect(
    requireEvaluatorReadiness(urls, transport, authorize, {
      ...readiness,
      repository: 'unrelated',
    }),
  ).rejects.toThrow();
  await requireEvaluatorReadiness(urls, transport, authorize, readiness);
  expect(checks.evaluate).not.toHaveBeenCalled();
  expect(review.evaluate).not.toHaveBeenCalled();
  const client = createParentEvaluatorClient(urls, f.policy, transport, authorize);
  for (const role of ['checks', 'independentReview'] as const) {
    const receipt = await client[role](f.request, f.bundle);
    expect(verifyGateReceipt(f.policy, role, input, receipt).receipt).toEqual(receipt);
  }
  await expect(requireEvaluatorReadiness(urls, transport, authorize, readiness)).rejects.toThrow();
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

it('automatically enrolls two fresh Tasks with separate role keys and retains both leases and claims after restart', async () => {
  const f = await fixture();
  const c = generateKeyPairSync('ed25519');
  const r = generateKeyPairSync('ed25519');
  const pins = {
    checks: c.publicKey.export({ format: 'jwk' }).x!,
    independentReview: r.publicKey.export({ format: 'jwk' }).x!,
  };
  const roles = ['checks', 'independentReview'] as const;
  const urls = {
    checks: 'https://checks.fixture.example/verify',
    independentReview: 'https://review.fixture.example/verify',
  };
  const start = () =>
    Promise.all(
      roles.map((role) => f.endpoint(role, { enrollment: { dispatchPublicKey: pins[role] } })),
    );
  let evaluators = await start();
  const transport: typeof fetch = async (url, init) => {
    const target = evaluators[url === urls.checks ? 0 : 1]!;
    const result = await target.app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: String(init?.body),
    });
    return new Response(result.body, {
      status: result.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  };
  const select = (run: string, basePolicyDigest: string) => {
    const { repository, predecessor, paths } = f.lease;
    const enrollment = { run, repository, predecessor, paths, basePolicyDigest };
    const policy = { ...f.policy, basePolicyDigest };
    const subject = { ...f.request.subject, run, policyDigest: combinedPolicyDigest(policy) };
    const readiness = { run, repository, predecessor, paths, policyDigest: subject.policyDigest };
    const request = { ...f.request, subject };
    const authorize = createEvaluatorDispatchSigner(
      { checks: c.privateKey, independentReview: r.privateKey },
      policy,
    );
    return {
      enroll: (change: Partial<EvaluatorEnrollment> = {}, send = transport) =>
        enrollParentEvaluators(urls, send, authorize, { ...enrollment, ...change }, policy),
      ready: () => requireEvaluatorReadiness(urls, transport, authorize, readiness),
      request,
      client: createParentEvaluatorClient(urls, policy, transport, authorize),
      policy,
    };
  };
  const a = select(f.lease.run, digest('task-one'));
  const b = select('b'.repeat(64), digest('task-two'));
  const wrongRole: typeof fetch = async (url, init) =>
    transport(url === urls.checks ? urls.independentReview : urls.checks, init);
  await expect(a.enroll({}, wrongRole)).rejects.toThrow('unavailable');
  await expect(a.ready()).rejects.toThrow('not-ready');
  await expect(a.client.checks(a.request, f.bundle)).rejects.toThrow('unavailable');
  await expect(a.enroll({ repository: 'other' })).rejects.toThrow('unavailable');
  await expect(a.enroll({ paths: ['sample/count.txt'] })).rejects.toThrow('unavailable');
  await Promise.all([a.enroll(), a.enroll()]);
  await expect(
    b.enroll({}, (url, init) =>
      url === urls.independentReview
        ? Promise.resolve(new Response(null, { status: 503 }))
        : transport(url, init),
    ),
  ).rejects.toThrow('unavailable');
  await expect(b.ready()).rejects.toThrow('not-ready');
  await expect(a.enroll({ predecessor: 'd'.repeat(40) })).rejects.toThrow('unavailable');
  await expect(select(f.lease.run, digest('substituted-policy')).enroll()).rejects.toThrow(
    'unavailable',
  );
  for (const evaluator of evaluators) expect(evaluator.evaluate).not.toHaveBeenCalled();
  const first = await a.client.checks(a.request, f.bundle);
  expect(
    verifyGateReceipt(a.policy, 'checks', parentIntegrationGateDigest(a.request), first).receipt,
  ).toEqual(first);
  for (const evaluator of evaluators) await evaluator.app.close();
  evaluators = await start();
  await b.enroll();
  await b.ready();
  await expect(a.enroll()).rejects.toThrow('unavailable');
  await expect(a.client.checks(a.request, f.bundle)).rejects.toThrow('unavailable');
  for (const [task, role] of [
    [a, 'independentReview'],
    [b, 'checks'],
    [b, 'independentReview'],
  ] as const) {
    const receipt = await task.client[role](task.request, f.bundle);
    expect(
      verifyGateReceipt(task.policy, role, parentIntegrationGateDigest(task.request), receipt)
        .receipt,
    ).toEqual(receipt);
  }
  expect(evaluators[0]!.evaluate).toHaveBeenCalledTimes(1);
  expect(evaluators[1]!.evaluate).toHaveBeenCalledTimes(2);
  const unused = select('c'.repeat(64), digest('expires-unused'));
  await unused.enroll();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 601_000);
  try {
    await expect(unused.enroll()).rejects.toThrow('unavailable');
    await expect(unused.client.checks(unused.request, f.bundle)).rejects.toThrow('unavailable');
    expect(evaluators[0]!.evaluate).toHaveBeenCalledTimes(1);
  } finally {
    clock.mockRestore();
  }
});

it('rejects an extra path in the real combined tree even with correctly signed enrolled metadata', async () => {
  const f = await fixture(true);
  const c = generateKeyPairSync('ed25519');
  const r = generateKeyPairSync('ed25519');
  const authorize = createEvaluatorDispatchSigner(
    { checks: c.privateKey, independentReview: r.privateKey },
    f.policy,
  );
  const urls = {
    checks: 'https://checks.fixture.example/verify',
    independentReview: 'https://review.fixture.example/verify',
  };
  const checks = await f.endpoint('checks', {
    enrollment: { dispatchPublicKey: c.publicKey.export({ format: 'jwk' }).x! },
  });
  const review = await f.endpoint('independentReview', {
    enrollment: { dispatchPublicKey: r.publicKey.export({ format: 'jwk' }).x! },
  });
  const transport: typeof fetch = async (url, init) => {
    const endpoint = url === urls.checks ? checks : review;
    const result = await endpoint.app.inject({
      method: 'POST',
      url: '/verify',
      headers: { 'content-type': 'application/json' },
      payload: String(init?.body),
    });
    return new Response(result.body, { status: result.statusCode });
  };
  const { run, repository, predecessor, paths } = f.lease;
  await enrollParentEvaluators(
    urls,
    transport,
    authorize,
    { run, repository, predecessor, paths, basePolicyDigest: f.policy.basePolicyDigest },
    f.policy,
  );
  const input = parentIntegrationGateDigest(f.request);
  for (const role of ['checks', 'independentReview'] as const) {
    const result = await transport(urls[role], {
      body: JSON.stringify({
        request: f.request,
        bundle: f.bundle.toString('base64'),
        dispatch: authorize(role, input),
      }),
    });
    expect(result.status).toBe(422);
  }
  for (const endpoint of [checks, review]) {
    expect(endpoint.evaluate).not.toHaveBeenCalled();
    expect(endpoint.sign).not.toHaveBeenCalled();
  }
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
