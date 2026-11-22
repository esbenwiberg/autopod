import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { digest } from '../managed/canonical.js';
import { fixtureSigner } from '../test-utils/gate-signer.js';
import type { parseOperatorEnrollment } from './operator-enrollment.js';
import {
  evaluateParentCandidate,
  parentCandidateChecksDigest,
  parentCandidateSeed,
  prepareParentCandidate,
  requireParentCandidateNetworkHeadroom,
} from './parent-candidate-host.js';
import { initializeParentCandidateKeys, openParentCandidateKeys } from './parent-candidate-keys.js';

async function directory() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ap-candidate-')));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

it.each([0, 1])('requires capacity for parent and reviewer: %s subnet(s)', async (free) => {
  await expect(requireParentCandidateNetworkHeadroom(async () => free)).rejects.toMatchObject({
    code: 'PARENT_NETWORK_CAPACITY',
  });
});

it('refuses unknown capacity and accepts two verified subnets', async () => {
  await expect(requireParentCandidateNetworkHeadroom(async () => null)).rejects.toMatchObject({
    code: 'PARENT_NETWORK_CAPACITY_UNKNOWN',
  });
  await expect(
    requireParentCandidateNetworkHeadroom(async () => {
      throw new Error('Docker unavailable');
    }),
  ).rejects.toMatchObject({ code: 'PARENT_NETWORK_CAPACITY_UNKNOWN' });
  await expect(requireParentCandidateNetworkHeadroom(async () => 2)).resolves.toBeUndefined();
});

it('checks the exact frozen fictional tree and vetoes wrong bytes, modes and extra paths', async () => {
  const mirror = await directory();
  const git = (args: string[], input?: string, env?: NodeJS.ProcessEnv) =>
    execFileSync('git', args, {
      cwd: mirror,
      input,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    }).trim();
  git(['init', '-q', '--object-format=sha1']);
  const count = path.join(mirror, 'sample/count.txt'),
    reason = path.join(mirror, 'sample/reason.txt');
  await mkdir(path.dirname(count));
  await writeFile(count, '12\n');
  git(['add', '.']);
  const tree = git(['write-tree']);
  const commit = (name: string, date: string, message: string, refs: string[]) =>
    git(['-c', 'commit.gpgsign=false', 'commit-tree', tree, ...refs], message + '\n', {
      GIT_AUTHOR_NAME: name,
      GIT_COMMITTER_NAME: name,
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
  const root = commit(
    'Autopod Transport Fixture',
    '@1767225600 +0000',
    'Synthetic bounded transport fixture',
    [],
  );
  const base = commit(
    'Synthetic Fixture',
    '@1795271040 +0000',
    'Freeze synthetic parent Task input',
    ['-p', root],
  );
  expect(base).toBe(parentCandidateSeed.commit);
  await writeFile(count, '24\n');
  await writeFile(reason, '24 is twice 12\n');
  const run = async () => {
    const tree = git(['write-tree']);
    const commit = git([
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit-tree',
      tree,
      '-p',
      base,
      '-m',
      'Synthetic change',
    ]);
    return evaluateParentCandidate({ mirror, commit, tree, predecessor: base });
  };
  git(['add', '.']);
  expect((await run()).status).toBe('passed');
  git(['update-index', '--chmod=+x', 'sample/reason.txt']);
  expect((await run()).status).toBe('failed');
  git(['update-index', '--chmod=-x', 'sample/reason.txt']);
  await writeFile(count, '25\n');
  git(['add', '.']);
  expect((await run()).status).toBe('failed');
  await writeFile(count, '24\n');
  await writeFile(path.join(mirror, 'extra.txt'), 'extra');
  git(['add', '.']);
  expect((await run()).status).toBe('failed');
});

it('refuses accidental stock boot, shared custody, unpinned source and missing socket trust', async () => {
  const root = await directory();
  const home = path.join(root, 'home');
  const db = path.join(root, 'autopod.db');
  await mkdir(home, { mode: 0o700 });
  const checks = fixtureSigner('checks', 'checks', parentCandidateChecksDigest);
  const independentReview = fixtureSigner('independentReview', 'review', digest('review'));
  const policy = { checks: checks.authority, independentReview: independentReview.authority };
  const envelope = {
    version: 1,
    parent: {
      coding: {
        paths: ['sample/count.txt'],
        sandbox: {
          hostQualification: true,
          secondPaths: ['sample/reason.txt'],
        },
      },
    },
    source: { ...parentCandidateSeed },
    budget: { active: 2, workers: 2 },
    authorities: policy,
  } as unknown as ReturnType<typeof parseOperatorEnrollment>;
  const pinFile = path.join(home, 'pins.json');
  await writeFile(pinFile, JSON.stringify(policy), { mode: 0o600 });
  const env = {
    HOST: '127.0.0.1',
    HOME: home,
    DB_PATH: db,
    DATA_DIR: path.join(root, 'data'),
    AUTOPOD_WORKTREE_DIR: path.join(root, 'worktrees'),
    AUTOPOD_PARENT_CANDIDATE_DIR: root,
    AUTOPOD_OPERATOR_PROFILE_SET: '{}',
    AUTOPOD_OPERATOR_SANDBOX_TARGET: '{}',
    AUTOPOD_EVALUATOR_PUBLIC_POLICY: pinFile,
  };
  await expect(prepareParentCandidate(false, env, undefined)).resolves.toBeUndefined();
  await expect(prepareParentCandidate(false, env, envelope)).rejects.toThrow('entrypoint-required');
  await expect(prepareParentCandidate(true, { ...env, HOST: '0.0.0.0' }, envelope)).rejects.toThrow(
    'boundary-required',
  );
  await expect(
    prepareParentCandidate(true, { ...env, AUTOPOD_MANAGED_PROFILE_SET: '{}' }, envelope),
  ).rejects.toThrow('boundary-required');
  await symlink(pinFile, db);
  await expect(prepareParentCandidate(true, env, envelope)).rejects.toThrow('database-refused');
  await rm(db);
  await expect(
    prepareParentCandidate(true, env, {
      ...envelope!,
      source: { ...envelope!.source, commit: 'abc' },
    }),
  ).rejects.toThrow('source-refused');
  await expect(
    prepareParentCandidate(true, { ...env, AUTOPOD_EVALUATOR_PUBLIC_POLICY: undefined }, envelope),
  ).rejects.toThrow('independently-provisioned-public-policy-required');
  await expect(prepareParentCandidate(true, env, envelope)).rejects.toThrow(
    'receipt-sockets-required',
  );
  await expect(
    prepareParentCandidate(true, { ...env, __CF_USER_TEXT_ENCODING: '0x1F5:0:0' }, envelope),
  ).rejects.toThrow(
    process.platform === 'darwin' ? 'receipt-sockets-required' : 'boundary-required',
  );
  await expect(
    prepareParentCandidate(
      true,
      {
        ...env,
        AUTOPOD_PARENT_RECEIPT_SOCKETS: JSON.stringify({
          checks: { uid: 10, socket: '/tmp/checks.sock' },
          independentReview: { uid: 10, socket: '/tmp/review.sock' },
        }),
      },
      envelope,
    ),
  ).rejects.toThrow('receipt-separation-required');

  const id = '5ecff8d3-de82-48cb-961a-dc06dc506533';
  const launchDigest = 'a'.repeat(64);
  const owner = {
    ...envelope!,
    parent: {
      ...envelope!.parent!,
      requestId: id,
      launchDigest,
      coding: {
        ...envelope!.parent!.coding!,
        sandbox: {
          ...envelope!.parent!.coding!.sandbox!,
          singleOwnerReceipts: true as const,
        },
      },
    },
  };
  const clean = { ...env, AUTOPOD_EVALUATOR_PUBLIC_POLICY: undefined };
  await expect(prepareParentCandidate(true, env, owner)).rejects.toThrow('receipt-mode-conflict');
  await expect(prepareParentCandidate(true, clean, owner)).rejects.toThrow();
  await expect(
    prepareParentCandidate(true, { ...clean, AZURE_CONFIG_DIR: home }, owner),
  ).rejects.toThrow('parent-candidate-azure-cli-refused');
  await expect(
    prepareParentCandidate(
      true,
      { ...clean, AZURE_CONFIG_DIR: home, AZURE_TOKEN_CREDENTIALS: 'ManagedIdentityCredential' },
      owner,
    ),
  ).rejects.toThrow('parent-candidate-azure-cli-refused');
  await initializeParentCandidateKeys(root);
  await expect(prepareParentCandidate(true, clean, owner)).rejects.toThrow('key-pin-mismatch');
  const { pins } = await openParentCandidateKeys(
    root,
    parentCandidateChecksDigest,
    policy.independentReview.configurationDigest,
  );
  const boot = await prepareParentCandidate(
    true,
    { ...clean, AZURE_CONFIG_DIR: home, AZURE_TOKEN_CREDENTIALS: 'AzureCliCredential' },
    {
      ...owner,
      authorities: { ...pins, basePolicyDigest: digest('base policy') },
    },
  );
  expect(boot?.receiptTrust).toBe('single-owner-local');
  expect(boot?.pins).toEqual(pins);
  expect(() => boot?.requireLaunch({ requestId: id, expectedDigest: launchDigest })).toThrow();
  expect(() =>
    boot?.requireLaunch({
      requestId: id,
      expectedDigest: launchDigest,
      requireParentEnrollment: true,
    }),
  ).not.toThrow();
});
