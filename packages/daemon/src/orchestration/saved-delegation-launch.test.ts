import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchRequestSchema, savedLaunchSelectionSchema } from '@autopod/shared';
import { expect, it, vi } from 'vitest';
import { createConfigurationStore } from '../configuration/configuration-store.js';
import { admitLaunch } from '../configuration/launch-admission.js';
import { configurationDigest, resolveLaunch } from '../configuration/launch-resolver.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import { createPodTokenIssuer } from '../crypto/pod-tokens.js';
import { runMigrationsWithBackups } from '../db/migrate.js';
import { digest, sha256 } from '../managed/canonical.js';
import { ManagedPodService } from '../managed/managed-service.js';
import {
  createTestConfiguration,
  insertConfigurationTestPod,
} from '../test-utils/configuration-helpers.js';
import {
  createHistoricalDiskDatabase,
  MIGRATIONS_DIR,
  openTestDiskDatabase,
} from '../test-utils/disk-database.js';
import { resign } from '../test-utils/managed-fixture.js';
import { createTestDb, logger } from '../test-utils/mock-helpers.js';
import { setupOrchestrationRun } from '../test-utils/orchestration-run-fixture.js';
import { OrchestrationContinuations } from './continuations.js';
import { withVerifiedCheckpointMirror } from './local-checkpoints.js';
import { ParentReportResults } from './parent-report-results.js';
import {
  admitSavedDelegationLaunch,
  readSavedDelegationAdmission,
  savedDelegationAttemptRun,
} from './saved-delegation-admission.js';
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
        predecessor: '0'.repeat(40),
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

async function admissionFixture(db = createTestDb()) {
  const f = fixture(db);
  const source = await setupOrchestrationRun();
  const original = f.pins.getMockImplementation()!;
  f.pins.mockImplementation(async (policy, config) => {
    const pins = await original(policy, config);
    const { predecessor, commit, tree } = source.cp;
    return {
      ...pins,
      source: { ...pins.source, predecessor, commit, tree, bundleDigest: sha256(source.bytes) },
    };
  });
  const readSeedBundle = vi.fn(async () => Buffer.from(source.bytes));
  const insertPod = vi.fn(() => {
    const pod = insertConfigurationTestPod(db, randomUUID());
    db.prepare('UPDATE pods SET user_id=? WHERE id=?').run(owner.oid, pod);
    return pod;
  });
  const submit = (raw: unknown) =>
    admitSavedDelegationLaunch({
      request: raw,
      principal: owner,
      db,
      policies: f.policies,
      launch: f.services,
      readVerifiedPins: f.pins,
      scratch: path.join(source.root, 'admissions'),
      readSeedBundle,
      insertPod,
    });
  const reviewed = async (requestId = id) => {
    const request = { ...f.request, requestId };
    const { plan } = await f.preview(request);
    return { ...request, expectedDigest: plan.digest };
  };
  return { ...f, source, readSeedBundle, insertPod, submit, reviewed };
}

it('requires the reviewed digest and atomically retains exactly one admission across concurrent replay and policy edits', async () => {
  const f = await admissionFixture();
  try {
    await expect(f.submit(f.request)).rejects.toMatchObject({
      code: 'DELEGATION_PREVIEW_REQUIRED',
    });
    expect(f.pins).not.toHaveBeenCalled();
    const request = await f.reviewed();
    const [a, b] = await Promise.all([f.submit(request), f.submit(request)]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.podId).toBe(b.podId);
    expect(f.insertPod).toHaveBeenCalledOnce();
    expect(
      f.db
        .prepare('SELECT remaining FROM orchestration_request_balances WHERE id=?')
        .pluck()
        .get(a.plan.runId),
    ).toBe(12);
    expect(f.db.prepare('SELECT count(*) FROM orchestration_kickoffs').pluck().get()).toBe(0);
    expect(readSavedDelegationAdmission(f.db, a.podId, owner)).toEqual({
      plan: a.plan,
      checkpoint: a.checkpoint,
      bundle: f.source.bytes,
    });
    expect(() =>
      readSavedDelegationAdmission(f.db, a.podId, { ...owner, iss: 'another-tenant' }),
    ).toThrow(expect.objectContaining({ code: 'DELEGATION_ADMISSION_NOT_FOUND' }));
    f.policies.revise(owner, f.saved.policyId, 1, { ...seed, name: 'New revision' });
    f.pins.mockClear();
    f.readSeedBundle.mockClear();
    expect(await f.submit(request)).toEqual({ ...a, created: false });
    expect(f.pins).not.toHaveBeenCalled();
    expect(f.readSeedBundle).not.toHaveBeenCalled();
    await expect(f.submit({ ...request, task: 'Different task' })).rejects.toMatchObject({
      code: 'REQUEST_CONFLICT',
    });
  } finally {
    f.db.close();
  }
}, 15_000);

it('verifies the bytes and Git tree before insertion and rolls back every admission row on final binding failure', async () => {
  const f = await admissionFixture();
  try {
    const request = await f.reviewed();
    f.readSeedBundle.mockResolvedValueOnce(Buffer.from('different bytes'));
    await expect(f.submit(request)).rejects.toMatchObject({ code: 'DELEGATION_SEED_INVALID' });
    const { plan, config } = await f.preview();
    const wrong = await f.pins(plan.policy, config);
    wrong.source.tree = 'd'.repeat(40);
    f.pins.mockResolvedValueOnce(wrong);
    const changed = await f.reviewed();
    f.pins.mockResolvedValueOnce(wrong);
    await expect(f.submit(changed)).rejects.toThrow('checkpoint-source-mismatch');
    expect(f.insertPod).not.toHaveBeenCalled();
    f.db.exec(`CREATE TRIGGER test_fail_saved_binding BEFORE INSERT ON saved_delegation_admissions
      BEGIN SELECT RAISE(ABORT, 'fixture-binding-failure'); END;`);
    await expect(f.submit(request)).rejects.toThrow('fixture-binding-failure');
    for (const table of [
      'pods',
      'pod_launch_snapshots',
      'orchestration_runs',
      'orchestration_checkpoint_custody',
      'parent_managed_runs',
      'saved_delegation_admissions',
    ])
      expect(f.db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
  } finally {
    f.db.close();
  }
}, 15_000);

it('reopens the exact admission after restart without reading mutable policy or touching the runtime', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ap-saved-admission-restart-'));
  const file = path.join(root, 'state.db');
  let db = createHistoricalDiskDatabase(file, [{ dir: MIGRATIONS_DIR, through: 281 }]);
  try {
    await runMigrationsWithBackups(db, MIGRATIONS_DIR, logger);
    const f = await admissionFixture(db);
    const request = await f.reviewed();
    const admitted = await f.submit(request);
    db.close();
    db = openTestDiskDatabase(file);
    const fail = vi.fn(() => {
      throw new Error('restart must not rerun admission');
    });
    const replay = await admitSavedDelegationLaunch({
      request,
      principal: owner,
      db,
      policies: createSavedDelegationPolicyStore(db),
      launch: { ...f.services, store: createConfigurationStore(db) },
      scratch: root,
      readVerifiedPins: fail,
      readSeedBundle: fail,
      insertPod: fail,
    });
    expect(replay).toEqual({ ...admitted, created: false });
    expect(fail).not.toHaveBeenCalled();
    expect(db.prepare('SELECT count(*) FROM managed_pods').pluck().get()).toBe(0);
    db.prepare('UPDATE orchestration_checkpoint_custody SET bundle=? WHERE run_id=?').run(
      Buffer.from('corrupted fixture'),
      admitted.plan.runId,
    );
    expect(() => readSavedDelegationAdmission(db, admitted.podId, owner)).toThrow(
      expect.objectContaining({ code: 'DELEGATION_ADMISSION_CORRUPT' }),
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

it('isolates two admitted parent attempts, real worker reservations, and result cursors even for the same owner', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ap-saved-delegation-isolation-'));
  const f = await admissionFixture(
    createHistoricalDiskDatabase(path.join(root, 'state.db'), [
      { dir: MIGRATIONS_DIR, through: 282 },
    ]),
  );
  try {
    const a = await f.submit(await f.reviewed());
    const b = await f.submit(await f.reviewed(secondId));
    const secret = path.join(f.source.root, 'pod-key');
    writeFileSync(secret, Buffer.alloc(32, 59), { mode: 0o600, flag: 'wx' });
    const issuer = createPodTokenIssuer(secret);
    const session = (parent: typeof a) => {
      const attempt = randomUUID();
      f.db
        .prepare("UPDATE pods SET status='running',container_id=? WHERE id=?")
        .run(parent.podId, parent.podId);
      f.db
        .prepare(
          'INSERT INTO parent_managed_sessions(attempt,run_id,generation,container_id) VALUES(?,?,1,?)',
        )
        .run(attempt, parent.plan.runId, parent.podId);
      f.db
        .prepare('UPDATE parent_managed_runs SET current_attempt=? WHERE run_id=?')
        .run(attempt, parent.plan.runId);
      const token = issuer.generateAttempt!(parent.podId, attempt);
      return {
        attempt,
        token,
        run: () => savedDelegationAttemptRun(f.db, issuer, parent.podId, token),
      };
    };
    const sessionA = session(a);
    const sessionB = session(b);
    expect(() => savedDelegationAttemptRun(f.db, issuer, b.podId, sessionA.token)).toThrow(
      'parent-session-required',
    );
    const template = structuredClone(f.source.request);
    template.profileSnapshot.scope.repositories[0]!.enrollmentId = a.checkpoint.repository;
    template.effectiveGrant.scope = structuredClone(template.profileSnapshot.scope);
    for (const budget of [template.profileSnapshot.budget, template.effectiveGrant.budget]) {
      if (!('maxProviderRequests' in budget)) throw new Error('fixture budget');
      budget.maxProviderRequests = 6;
    }
    const { snapshotDigest: _, ...body } = template.profileSnapshot;
    template.profileSnapshot.snapshotDigest = template.effectiveGrant.profileSnapshotDigest =
      digest(body);
    resign(template);
    const scope = template.profileSnapshot.scope;
    const service = new ManagedPodService(
      f.db,
      {
        ...f.source.f.admission,
        profiles: new Map([[template.profileSnapshot.snapshotDigest, template.profileSnapshot]]),
        enrollmentCeiling: scope,
        identityCeiling: scope,
        backendCeiling: scope,
      },
      f.source.f.runtime,
      () => 100,
      true,
    );
    const ledger = new OrchestrationContinuations(f.db, async (cp, use) => {
      const parent = [a, b].find((parent) => parent.plan.runId === cp.run);
      if (!parent) throw new Error('fixture-run-mismatch');
      const stored = readSavedDelegationAdmission(f.db, parent.podId, owner);
      expect(cp).toEqual(stored.checkpoint);
      return withVerifiedCheckpointMirror(
        path.join(f.source.root, 'worker-read'),
        cp,
        stored.bundle,
        () => use(service),
      );
    });
    for (const admission of [a, b])
      await ledger.kickoff(admission.checkpoint, { implement: template });
    const balance = (run: string) =>
      f.db
        .prepare('SELECT remaining FROM orchestration_request_balances WHERE id=?')
        .pluck()
        .get(run);
    const reserve = async (parent: typeof a, identity: typeof sessionA, key: string) => {
      const assertScope = () => {
        if (identity.run() !== parent.plan.runId) throw new Error('parent-session-run-mismatch');
      };
      assertScope();
      const request = structuredClone(template);
      request.dispatcherAttemptId = request.effectiveGrant.dispatcherAttemptId = randomUUID();
      request.startKey = key;
      return ledger.spawnWave(parent.checkpoint, [resign(request)], () => {
        assertScope();
        f.db
          .prepare(`INSERT INTO parent_managed_requests(run_id,start_key,request_key,parent_attempt,input_digest)
          VALUES(?,?,?,?,?)`)
          .run(parent.plan.runId, key, key, identity.attempt, digest(key));
      });
    };
    await expect(reserve(b, sessionA, 'attempted-cross-run')).rejects.toThrow(
      'parent-session-run-mismatch',
    );
    expect(balance(b.plan.runId)).toBe(12);
    await reserve(a, sessionA, 'same-child-key');
    await reserve(a, sessionA, 'second-child');
    await expect(reserve(a, sessionA, 'third-child')).rejects.toThrow(
      'continuation-budget-exhausted',
    );
    expect(balance(a.plan.runId)).toBe(0);
    expect(balance(b.plan.runId)).toBe(12);
    await reserve(b, sessionB, 'same-child-key');
    expect(balance(b.plan.runId)).toBe(6);

    expect(await ledger.recover(a.plan.runId)).toEqual({ blocked: [] });
    expect(await ledger.recover(b.plan.runId)).toEqual({ blocked: [] });
    const failed = f.db.prepare(
      "UPDATE managed_pods SET observed_exit=1,state='failed',exit_code=1 WHERE dispatcher_installation_id=?",
    );
    expect(failed.run('native.' + a.plan.runId).changes).toBe(2);
    expect(failed.run('native.' + b.plan.runId).changes).toBe(1);
    const results = new ParentReportResults(f.db);
    const first = await results.results({}, sessionA.run);
    const second = await results.results({}, sessionB.run);
    expect(first.results).toHaveLength(2);
    expect(second.results).toHaveLength(1);
    expect(second.results[0]?.childId).not.toBe(first.results[0]?.childId);
    await expect(results.results({ after: first.nextCursor }, sessionB.run)).rejects.toThrow(
      'parent-result-cursor-refused',
    );
    f.db
      .prepare('UPDATE pods SET lifecycle_generation=lifecycle_generation+1 WHERE id=?')
      .run(a.podId);
    await expect(results.results({}, sessionA.run)).rejects.toThrow('parent-session-stale');
  } finally {
    f.db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);
