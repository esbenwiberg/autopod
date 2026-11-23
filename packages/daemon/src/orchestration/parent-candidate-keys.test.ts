import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { digest } from '../managed/canonical.js';
import { type GateStatement, verifyGateReceipt } from './combined-attestation.js';
import { parentCandidateChecksDigest } from './parent-candidate-host.js';
import { initializeParentCandidateKeys, openParentCandidateKeys } from './parent-candidate-keys.js';

async function folder() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'ap-owner-keys-')));
  onTestFinished(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

it('creates one local role pair, does not rotate it, and verifies exact role receipts after reopen', async () => {
  const root = await folder();
  const reviewDigest = digest('fixed reviewer');
  await initializeParentCandidateKeys(root);
  const read = () => openParentCandidateKeys(root, parentCandidateChecksDigest, reviewDigest);
  const { pins } = await read();
  expect(pins.checks.publicKey).not.toBe(pins.independentReview.publicKey);
  expect((await lstat(path.join(root, 'parent-candidate-receipts.json'))).mode & 0o777).toBe(0o600);
  await expect(initializeParentCandidateKeys(root)).rejects.toThrow();
  const reopened = await read();
  expect(reopened.pins).toEqual(pins);
  const policy = { ...pins, basePolicyDigest: digest('signed admission') };
  const inputDigest = digest('exact input');
  const statement: GateStatement = {
    role: 'checks',
    identity: pins.checks.identity,
    configurationDigest: pins.checks.configurationDigest,
    status: 'passed',
    inputDigest,
    evidenceDigest: digest('actual deterministic check evidence'),
  };
  const check = reopened.bind(policy, 'checks');
  const review = reopened.bind(policy, 'independentReview');
  await expect(review(statement)).rejects.toThrow('parent-candidate-receipt-refused');
  const receipt = await check(statement);
  expect(verifyGateReceipt(policy, 'checks', inputDigest, receipt).receipt).toEqual(receipt);
  expect(() => verifyGateReceipt(policy, 'checks', digest('different input'), receipt)).toThrow();
  expect(() => verifyGateReceipt(policy, 'independentReview', inputDigest, receipt)).toThrow();
  await expect(check(statement)).rejects.toThrow('parent-candidate-receipt-refused');
  expect(() => reopened.bind({ ...policy, checks: pins.independentReview }, 'checks')).toThrow(
    'parent-candidate-key-pin-mismatch',
  );
});

it('rejects loose mode, links, and tampered key data without showing its contents', async () => {
  const root = await folder();
  const file = path.join(root, 'parent-candidate-receipts.json');
  const read = () => openParentCandidateKeys(root, parentCandidateChecksDigest, digest('review'));
  await initializeParentCandidateKeys(root);
  await chmod(file, 0o644);
  await expect(read()).rejects.toThrow('parent-candidate-key-custody-refused');
  await chmod(file, 0o600);
  const alias = path.join(root, 'alias');
  await link(file, alias);
  await expect(read()).rejects.toThrow('parent-candidate-key-custody-refused');
  await rm(file);
  await symlink(alias, file);
  await expect(read()).rejects.toThrow();
  await expect(initializeParentCandidateKeys(root)).rejects.toThrow();
  await rm(file);
  await writeFile(file, 'untrusted-file-content', { mode: 0o600 });
  await expect(read()).rejects.toThrow(/^parent-candidate-key-custody-refused$/);
  const newRoot = path.join(root, 'other');
  await mkdir(newRoot, { mode: 0o755 });
  await expect(initializeParentCandidateKeys(newRoot)).rejects.toThrow(
    'parent-candidate-key-custody-refused',
  );
});
