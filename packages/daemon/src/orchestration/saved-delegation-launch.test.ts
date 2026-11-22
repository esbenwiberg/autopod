import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchRequestSchema, savedLaunchSelectionSchema } from '@autopod/shared';
import { expect, it, vi } from 'vitest';
import { admitLaunch } from '../configuration/launch-admission.js';
import { configurationDigest, resolveLaunch } from '../configuration/launch-resolver.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import { runMigrationsWithBackups } from '../db/migrate.js';
import {
  createTestConfiguration,
  insertConfigurationTestPod,
} from '../test-utils/configuration-helpers.js';
import {
  createHistoricalDiskDatabase,
  MIGRATIONS_DIR,
  openTestDiskDatabase,
} from '../test-utils/disk-database.js';
import { createTestDb, logger } from '../test-utils/mock-helpers.js';
import { prepareSavedDelegationLaunch } from './saved-delegation-launch.js';
import {
  createSavedDelegationPolicyStore,
  type DelegationPrincipal,
} from './saved-delegation-policy.js';

const owner = {
  oid: 'owner',
  iss: 'https://entra.example.invalid/tenant/v2.0',
  aud: 'fixture-audience',
  operatorPrincipal: 'delegated-user',
} as const satisfies DelegationPrincipal;
const id = '5e7450e2-99fa-40e8-a064-a0e332f4103b';
const secondId = 'f4ea45d2-847e-4a55-bc69-7f0f4cbe58cf';
const pin = (c: string) => 'sha256:' + c.repeat(64);
const worker = (role: string, file: string) => ({
  role,
  files: [file],
  recipeId: 'implement',
  recipeRevision: 2,
  recipeDigest: pin('c'),
  accountId: 'child',
  modelRequests: 6,
  observedTokenStop: 36_000,
  wallSeconds: 180,
});
const seed = {
  version: 1,
  name: 'Two coding roles',
  repositoryId: 'repo-a',
  repositoryRevision: 1,
  sourceBranch: 'main',
  workers: [worker('count', 'sample/count.txt'), worker('reason', 'sample/reason.txt')],
  maxConcurrentWorkers: 2,
  checksDigest: pin('d'),
  reviewer: { accountId: 'review', tokenBudget: 8000, policyDigest: pin('e') },
};

const recipeBinding = ({
  role,
  recipeId,
  recipeRevision,
  recipeDigest,
  accountId,
}: (typeof seed.workers)[number]) => ({
  role,
  recipeId,
  recipeRevision,
  recipeDigest,
  accountId,
});

function fixture(db = createTestDb()) {
  const { services, store } = createTestConfiguration(db);
  const policies = createSavedDelegationPolicyStore(db);
  const saved = policies.create(owner, seed);
  const request = {
    requestId: id,
    repositoryId: 'repo-a',
    task: 'Keep the change in the two assigned files',
    delegation: { policyId: saved.policyId, revision: saved.revision },
    overrides: {
      ai: {
        reviewer: {
          mode: 'independent',
          route: { providerAccountId: 'review', runtime: 'codex', model: 'review-model' },
        },
      },
      workflow: { output: 'none', reviewerTokenBudget: 8000 },
      execution: { networkPolicy: { enabled: true, mode: 'restricted' } },
    },
  };
  const pins = vi.fn<Parameters<typeof prepareSavedDelegationLaunch>[0]['readVerifiedPins']>(
    async (policy, config) => ({
      source: {
        repositoryDigest: configurationDigest(config.repository?.config),
        ref: 'refs/heads/main',
        commit: '1'.repeat(40),
        tree: '2'.repeat(40),
        bundleDigest: pin('3'),
      },
      workers: [recipeBinding(policy.workers[0]), recipeBinding(policy.workers[1])],
      checksDigest: policy.checksDigest,
      reviewPolicyDigest: policy.reviewer.policyDigest,
      runtimeDigest: pin('4'),
    }),
  );
  const preview = (raw: unknown = request, principal: DelegationPrincipal = owner) =>
    prepareSavedDelegationLaunch({
      request: raw,
      principal,
      policies,
      launch: services,
      readVerifiedPins: pins,
    });
  return { db, services, store, policies, request, saved, pins, preview };
}

it('keeps saved delegation opt-in out of goals, earlier runs, scheduled templates and signed enrollment', () => {
  const delegation = { policyId: secondId, revision: 1 };
  const task = { repositoryId: 'repo-a', task: 'Task' };
  expect(launchRequestSchema.parse(task).delegation).toBeUndefined();
  const optIn = { ...task, requestId: id, delegation };
  expect(launchRequestSchema.parse(optIn).delegation).toEqual(delegation);
  for (const input of [
    { ...optIn, requestId: undefined },
    { ...optIn, intent: 'goal' },
    { ...optIn, source: { podId: 'prior', digest: 'a'.repeat(64), configuration: 'current' } },
    { emptyWorkspace: true, profileId: 'profile', task: 'Task', requestId: id, delegation },
    { ...optIn, requireParentEnrollment: true, expectedDigest: 'a'.repeat(64) },
    { ...optIn, delegation: { ...delegation, bypass: true } },
  ])
    expect(launchRequestSchema.safeParse(input).success).toBe(false);
  expect(savedLaunchSelectionSchema.safeParse({ repositoryId: 'repo-a', delegation }).success).toBe(
    false,
  );
});

it('isolates immutable policy revisions by exact authenticated person, issuer and audience', () => {
  const f = fixture();
  try {
    for (const stranger of [
      { ...owner, oid: 'other' },
      { ...owner, iss: 'other' },
      { ...owner, aud: 'other' },
    ]) {
      expect(() => f.policies.readCurrent(stranger, f.saved.policyId)).toThrow(
        expect.objectContaining({ code: 'DELEGATION_POLICY_NOT_FOUND' }),
      );
      expect(() => f.policies.revise(stranger, f.saved.policyId, 1, seed)).toThrow();
    }
    for (const unverified of [undefined, 'local-dev'] as const)
      expect(() => f.policies.create({ ...owner, operatorPrincipal: unverified }, seed)).toThrow(
        expect.objectContaining({ code: 'DELEGATION_OWNER_REQUIRED' }),
      );
    const revision = f.policies.revise(owner, f.saved.policyId, 1, { ...seed, name: 'Changed' });
    expect(revision.revision).toBe(2);
    expect(() => f.policies.revise(owner, f.saved.policyId, 1, seed)).toThrow(
      expect.objectContaining({ code: 'DELEGATION_POLICY_CHANGED' }),
    );
    expect(() => f.db.exec('DELETE FROM saved_delegation_policy_revisions')).toThrow(
      'revisions are retained',
    );
    expect(() => f.db.exec('UPDATE saved_delegation_policy_revisions SET revision=9')).toThrow(
      'revisions are immutable',
    );
  } finally {
    f.db.close();
  }
});

it.each([
  { workers: [worker('first', 'Foo'), worker('second', 'foo/bar')] },
  { workers: [worker('first', 'Foo.txt'), worker('second', 'foo.txt')] },
  { workers: [worker('first', '.git/config'), worker('second', 'sample/reason.txt')] },
  { workers: [worker('same', 'foo'), worker('same', 'bar')] },
  { reviewer: { ...seed.reviewer, accountId: 'child' } },
  { sourceBranch: 'main~1' },
  { sourceBranch: 'foo//bar' },
  { sourceBranch: 'refs/a.lock' },
  { maxConcurrentWorkers: 3 },
  { maxConcurrentWorkers: 0 },
  { extraSecret: 'no' },
])('rejects a widened or ambiguous policy: %o', (patch) => {
  const db = createTestDb();
  try {
    const policies = createSavedDelegationPolicyStore(db);
    expect(() => policies.create(owner, { ...seed, ...patch })).toThrow(
      expect.objectContaining({ code: 'DELEGATION_POLICY_INVALID' }),
    );
    expect(db.prepare('SELECT count(*) FROM saved_delegation_policy_revisions').pluck().get()).toBe(
      0,
    );
  } finally {
    db.close();
  }
});

it('persists policy revisions on the additive upgrade from schema 280', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ap-delegation-policy-'));
  let db = createHistoricalDiskDatabase(path.join(root, 'release.db'), [
    { dir: MIGRATIONS_DIR, through: 280 },
  ]);
  try {
    await runMigrationsWithBackups(db, MIGRATIONS_DIR, logger);
    const initial = createSavedDelegationPolicyStore(db).create(owner, seed);
    db.close();
    db = openTestDiskDatabase(path.join(root, 'release.db'));
    expect(createSavedDelegationPolicyStore(db).readCurrent(owner, initial.policyId)).toEqual(
      initial,
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('freezes the reviewed Task, policy, source, runtime and reviewer without any admission write', async () => {
  const f = fixture();
  try {
    const before = f.db.serialize();
    const prepared = await f.preview();
    expect(prepared.plan).toMatchObject({
      requestId: id,
      launchDigest: prepared.config.digest,
      policyId: f.saved.policyId,
      revision: 1,
      workerModelRequests: 12,
      policy: { workers: seed.workers, reviewer: seed.reviewer },
      pins: { source: { commit: '1'.repeat(40), tree: '2'.repeat(40) }, runtimeDigest: pin('4') },
    });
    expect((await f.preview({ ...f.request, expectedDigest: prepared.plan.digest })).plan).toEqual(
      prepared.plan,
    );
    expect((await f.preview({ ...f.request, requestId: secondId })).plan.runId).not.toBe(
      prepared.plan.runId,
    );
    expect(f.db.serialize().equals(before)).toBe(true);
    prepared.plan.policy.workers[0].modelRequests++;
    expect(() => prepared.assertCurrent()).toThrow(
      expect.objectContaining({ code: 'DELEGATION_PREVIEW_CHANGED' }),
    );
  } finally {
    f.db.close();
  }
});

it('does not resolve another person’s policy and gives the same UUID distinct run identities per owner', async () => {
  const f = fixture();
  try {
    const other = { ...owner, oid: 'second-person' };
    await expect(f.preview(f.request, other)).rejects.toMatchObject({
      code: 'DELEGATION_POLICY_NOT_FOUND',
    });
    expect(f.pins).not.toHaveBeenCalled();
    const personal = f.policies.create(other, seed);
    const second = await f.preview(
      {
        ...f.request,
        delegation: { policyId: personal.policyId, revision: personal.revision },
      },
      other,
    );
    expect(second.plan.requestId).toBe(id);
    expect(second.plan.runId).not.toBe((await f.preview()).plan.runId);
  } finally {
    f.db.close();
  }
});

it('rejects policy drift during an asynchronous preview and rechecks before binding', async () => {
  const f = fixture();
  try {
    const old = await f.preview();
    const verified = await f.pins(old.plan.policy, old.config);
    f.pins.mockImplementationOnce(async () => {
      f.policies.revise(owner, f.saved.policyId, 1, { ...seed, name: 'Revised' });
      return verified;
    });
    await expect(f.preview()).rejects.toMatchObject({ code: 'DELEGATION_POLICY_CHANGED' });
    expect(() => old.assertCurrent()).toThrow(
      expect.objectContaining({ code: 'DELEGATION_POLICY_CHANGED' }),
    );
    expect(f.db.prepare('SELECT count(*) FROM pods').pluck().get()).toBe(0);
  } finally {
    f.db.close();
  }
});

it('rejects moving source, substituted trusted pins and an unapproved repo or reviewer', async () => {
  const f = fixture();
  try {
    const first = await f.preview();
    const observed = await f.pins(first.plan.policy, first.config);
    f.pins.mockResolvedValueOnce({
      ...observed,
      source: { ...observed.source, commit: '9'.repeat(40) },
    });
    await expect(
      f.preview({ ...f.request, expectedDigest: first.plan.digest }),
    ).rejects.toMatchObject({ code: 'DELEGATION_PREVIEW_CHANGED' });
    f.pins.mockResolvedValueOnce({ ...observed, reviewPolicyDigest: pin('5') });
    await expect(f.preview()).rejects.toMatchObject({ code: 'DELEGATION_PINS_MISMATCH' });
    await expect(f.preview({ ...f.request, repositoryId: 'repo-b' })).rejects.toMatchObject({
      code: 'DELEGATION_REPOSITORY_MISMATCH',
    });
    await expect(
      f.preview({
        ...f.request,
        overrides: {
          ...f.request.overrides,
          workflow: { output: 'none', reviewerTokenBudget: 9000 },
        },
      }),
    ).rejects.toMatchObject({ code: 'DELEGATION_REVIEWER_MISMATCH' });
    await expect(f.preview({ ...f.request, work: { startBranch: 'other' } })).rejects.toMatchObject(
      { code: 'DELEGATION_TASK_REFUSED' },
    );
  } finally {
    f.db.close();
  }
});

it('cannot run as an ordinary Task even if the delegated option has a valid preview', async () => {
  const f = fixture();
  try {
    const { plan } = await f.preview();
    const request = { ...f.request, expectedDigest: plan.digest };
    const snapshots = createLaunchSnapshotRepository(f.db, f.store);
    const createPod = vi.fn(() => insertConfigurationTestPod(f.db, 'ordinary'));
    const authorize = vi.fn();
    await expect(resolveLaunch(request, f.services, owner.oid)).rejects.toMatchObject({
      code: 'SAVED_DELEGATION_UNAVAILABLE',
    });
    await expect(
      admitLaunch({
        request,
        actorId: owner.oid,
        services: f.services,
        snapshots,
        createPod,
        authorize,
      }),
    ).rejects.toMatchObject({ code: 'SAVED_DELEGATION_UNAVAILABLE' });
    expect(createPod).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT count(*) FROM pod_launch_snapshots').pluck().get()).toBe(0);
    const normal = await admitLaunch({
      request: { repositoryId: 'repo-a', task: 'Nondelegated' },
      actorId: owner.oid,
      services: f.services,
      snapshots,
      createPod,
    });
    expect(normal.created).toBe(true);
  } finally {
    f.db.close();
  }
});
