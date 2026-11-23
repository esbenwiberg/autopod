import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { digest } from '../managed/canonical.js';
import {
  createEvaluatorDispatchSigner,
  createEvaluatorDispatchVerifier,
  readEvaluatorDispatchKeys,
} from './parent-evaluator-dispatch.js';

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, pin: publicKey.export({ format: 'jwk' }).x! };
};
const checks = pair(),
  review = pair();
const policy = {
  basePolicyDigest: digest('base'),
  checks: { identity: 'checks', configurationDigest: digest('checks'), publicKey: checks.pin },
  independentReview: {
    identity: 'review',
    configurationDigest: digest('review'),
    publicKey: review.pin,
  },
};

it('rejects shared receipt/dispatch keys, stale and future authorization, and non-Ed25519 keys', () => {
  const { privateKey, pin } = pair();
  const keys = { checks: privateKey, independentReview: pair().privateKey };
  expect(() =>
    createEvaluatorDispatchSigner({ ...keys, checks: checks.privateKey }, policy),
  ).toThrow('must-be-separate');
  expect(() => createEvaluatorDispatchVerifier(review.pin, 'checks', policy)).toThrow(
    'must-be-separate',
  );
  expect(() =>
    createEvaluatorDispatchSigner(
      { ...keys, checks: generateKeyPairSync('x25519').privateKey },
      policy,
    ),
  ).toThrow('key-required');
  expect(() =>
    createEvaluatorDispatchSigner({ checks: privateKey, independentReview: privateKey }, policy),
  ).toThrow('must-be-separate');
  const authorize = createEvaluatorDispatchSigner(keys, policy);
  const verify = createEvaluatorDispatchVerifier(pin, 'checks', policy);
  const input = digest('exact input');
  const time = vi.spyOn(Date, 'now');
  try {
    time.mockReturnValue(100_000);
    const proof = authorize('checks', input);
    expect(verify(input, proof)).toBe(true);
    expect(verify(digest('other input'), proof)).toBe(false);
    expect(verify(input, authorize('independentReview', input))).toBe(false);
    time.mockReturnValue(99_000);
    expect(verify(input, proof)).toBe(false);
    time.mockReturnValue(160_000);
    expect(verify(input, proof)).toBe(false);
  } finally {
    time.mockRestore();
  }
});

it('loads only a private, regular Ed25519 service credential at the fixed name', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dispatch-key-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'autopod-parent-evaluator-checks-dispatch');
  await writeFile(
    path.join(dir, 'autopod-parent-evaluator-review-dispatch'),
    pair().privateKey.export({ format: 'pem', type: 'pkcs8' }),
    { mode: 0o600 },
  );
  await expect(readEvaluatorDispatchKeys(undefined)).rejects.toThrow('key-required');
  const { privateKey } = pair();
  await writeFile(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  await expect(readEvaluatorDispatchKeys(dir)).resolves.toMatchObject({
    checks: { asymmetricKeyType: 'ed25519' },
    independentReview: { asymmetricKeyType: 'ed25519' },
  });
  await chmod(file, 0o644);
  await expect(readEvaluatorDispatchKeys(dir)).rejects.toThrow('key-required');
  await rm(file);
  await symlink('/dev/null', file);
  await expect(readEvaluatorDispatchKeys(dir)).rejects.toThrow('key-required');
});
