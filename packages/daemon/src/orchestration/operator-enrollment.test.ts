import { generateKeyPairSync } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { digest } from '../managed/canonical.js';
import {
  PRIVATE_COMMIT_EFFECTS,
  PRIVATE_PARENT_VERIFIER,
} from '../managed/private-commit-policy.js';
import { parseManagedProfileSetConfig } from '../managed/profile-set-config.js';
import { fixtureSigner } from '../test-utils/gate-signer.js';
import { resign } from '../test-utils/managed-fixture.js';
import { offlineController } from '../test-utils/offline-controller.js';
import { operatorSeedFixture } from '../test-utils/operator-seed-fixture.js';
import {
  assertOperatorRecovery,
  composeOperatorEnrollment,
  operatorBasePolicy,
  parseOperatorEnrollment,
} from './operator-enrollment.js';

const image = 'sha256:' + 'a'.repeat(64);

it.each([
  'local',
  'sandbox',
  'sandbox-host',
] as const)('requires two exact signatures for a private %s coding profile and leaves boot idle', async (target) => {
  const isSandbox = target !== 'local';
  const onHost = target === 'sandbox-host';
  const { f, enrollment, profiles, cli, sign } = await operatorSeedFixture(
    isSandbox ? 'registry.example/autopod/worker@' + image : image,
    true,
    isSandbox ? 'sandbox' : 'local',
  );
  const sandbox = {
    resourceScopeDigest: digest('fixture Azure scope'),
    readyDiskImageId: 'pinned-fixture-disk',
    secondPaths: ['other.txt'],
    ...(onHost
      ? { hostQualification: true as const }
      : { authorizeEvaluatorDispatch: true as const }),
  };
  const inspect = structuredClone(
    enrollment.recipes.inspect,
  ) as import('@autopod/shared').ManagedPodRequest;
  const reportProfile = inspect.profileSnapshot;
  const repository = profiles.mirror.enrollmentId;
  reportProfile.scope.repositories[0]!.remote = 'private';
  const pin = (req: typeof inspect) => {
    const { snapshotDigest: _, ...profile } = req.profileSnapshot;
    req.profileSnapshot.snapshotDigest = req.effectiveGrant.profileSnapshotDigest = digest(profile);
    req.effectiveGrant.scope = structuredClone(profile.scope);
    resign(req);
  };
  pin(inspect);
  const implementation = structuredClone(inspect);
  implementation.task.kind = 'implementation';
  implementation.profileSnapshot.profileId = 'private-coding';
  implementation.profileSnapshot.scope.repositories[0]!.access = 'write';
  implementation.profileSnapshot.scope.allowedEffects = [...PRIVATE_COMMIT_EFFECTS];
  implementation.outputs.source = {
    mode: 'commit',
    remote: 'private',
    repository,
    base: 'main',
    head: 'autopod/fixture-private',
  };
  const repo = implementation.profileSnapshot.scope.repositories[0]!;
  if (repo.access !== 'write') throw new Error('fixture scope');
  repo.branchNamespace = 'autopod/';
  implementation.validation.verifierPolicy = PRIVATE_PARENT_VERIFIER;
  pin(implementation);
  const codingProfiles = parseManagedProfileSetConfig(
    JSON.stringify({
      ...profiles,
      mirror: { ...profiles.mirror, remote: 'private' },
      profiles: [
        { ...profiles.profiles[0], profileSnapshot: inspect.profileSnapshot },
        {
          ...profiles.profiles[0],
          profileSnapshot: implementation.profileSnapshot,
          privateCommit: true,
          taskKind: 'implementation',
          sourceMode: 'commit',
        },
      ],
    }),
  )!;
  const parent = {
    requestId: '5ecff8d3-de82-48cb-961a-dc06dc506533',
    launchDigest: 'a'.repeat(64),
    coding: {
      recipe: 'implement',
      paths: ['proof.txt'],
      ...(isSandbox ? { sandbox } : {}),
      ...(!onHost
        ? {
            evaluation: {
              checks: 'https://checks.fixture.example/verify',
              independentReview: 'https://review.fixture.example/verify',
            },
          }
        : {}),
    },
  };
  const input = { ...enrollment, parent, recipes: { inspect, implement: implementation } };
  const authorities = {
    ...enrollment.authorities,
    basePolicyDigest: operatorBasePolicy(input, codingProfiles, true),
  };
  const signed = { ...input, authorities, ...sign(authorities) };
  const service = { db: f.db, ownsInstallation: () => true };
  const resume = vi.fn(async () => {});
  const exportPrivateHead = vi.fn();
  const evaluatorFetch = vi.fn<typeof fetch>();
  const hostPorts = {
    checks: { evaluate: vi.fn(), sign: vi.fn() },
    review: {
      readPod: vi.fn(),
      readLaunch: vi.fn(),
      reviewer: { parentQualification: vi.fn() },
      sign: vi.fn(),
    },
  };
  const deps = {
    db: f.db,
    databasePath: f.db.name,
    profiles: codingProfiles,
    cli,
    isolatedArtifacts: true,
    trustedEvaluatorPins: {
      checks: authorities.checks,
      independentReview: authorities.independentReview,
    },
    evaluatorFetch,
    parentHostGates: onHost ? hostPorts : undefined,
    evaluatorDispatchKeys:
      isSandbox && !onHost
        ? {
            checks: generateKeyPairSync('ed25519').privateKey,
            independentReview: generateKeyPairSync('ed25519').privateKey,
          }
        : undefined,
    bind: () => {
      throw new Error('unexpected controller');
    },
    runtime: {
      config: { db: f.db },
      components: { service },
      resume,
      privateRuntime: { exportPrivateHead },
      sandboxCoding: isSandbox ? sandbox : undefined,
    } as unknown as NonNullable<Parameters<typeof composeOperatorEnrollment>[1]['runtime']>,
  };
  // This fixture uses the real current SQLite migrations for the parent route.
  for (const migration of [
    '271_parent_managed_runs.sql',
    '272_parent_report_dependencies.sql',
    '277_parent_private_candidates.sql',
    '279_parent_qualification_jobs.sql',
    '280_parent_qualification_input_digest.sql',
  ])
    f.db.exec(
      await import('node:fs/promises').then(({ readFile }) =>
        readFile(new URL(`../db/migrations/${migration}`, import.meta.url), 'utf8'),
      ),
    );
  expect(() => composeOperatorEnrollment(input, deps)).toThrow('policy-mismatch');
  expect(() =>
    composeOperatorEnrollment(
      { ...signed, parent: { ...parent, coding: { ...parent.coding, paths: ['other.txt'] } } },
      deps,
    ),
  ).toThrow('policy-mismatch');
  expect(() => composeOperatorEnrollment({ ...signed, parent: undefined }, deps)).toThrow(
    'parent-coding-policy-mismatch',
  );
  if (onHost) {
    expect(() =>
      composeOperatorEnrollment(signed, {
        ...deps,
        parentHostGates: { ...hostPorts, receiptTrust: 'single-owner-local' },
      }),
    ).toThrow('parent-host-receipt-mode-mismatch');
    const localParent = {
      ...parent,
      coding: { ...parent.coding, sandbox: { ...sandbox, singleOwnerReceipts: true as const } },
    };
    expect(operatorBasePolicy({ ...input, parent: localParent }, codingProfiles, true)).not.toBe(
      authorities.basePolicyDigest,
    );
    expect(() =>
      composeOperatorEnrollment(
        { ...signed, parent: localParent },
        {
          ...deps,
          parentHostGates: { ...hostPorts, receiptTrust: 'single-owner-local' },
        },
      ),
    ).toThrow('operator-policy-mismatch');
    expect(() =>
      composeOperatorEnrollment(signed, {
        ...deps,
        evaluatorDispatchKeys: {
          checks: generateKeyPairSync('ed25519').privateKey,
          independentReview: generateKeyPairSync('ed25519').privateKey,
        },
      }),
    ).toThrow('parent-host-qualification-remote-dispatch-refused');
    expect(() =>
      composeOperatorEnrollment(signed, { ...deps, parentHostGates: undefined }),
    ).toThrow('parent-host-qualification-binding-required');
    expect(() =>
      composeOperatorEnrollment(
        {
          ...signed,
          parent: {
            ...parent,
            coding: {
              ...parent.coding,
              evaluation: {
                checks: 'https://checks.fixture.example/verify',
                independentReview: 'https://review.fixture.example/verify',
              },
            },
          },
        },
        deps,
      ),
    ).toThrow('parent-coding-policy-mismatch');
    expect(() =>
      composeOperatorEnrollment(signed, {
        ...deps,
        parentHostGates: {
          ...hostPorts,
          review: { ...hostPorts.review, sign: hostPorts.checks.sign },
        },
      }),
    ).toThrow('parent-host-evaluator-ports-required');
  } else {
    expect(() =>
      composeOperatorEnrollment(signed, { ...deps, parentHostGates: hostPorts }),
    ).toThrow('parent-host-qualification-binding-required');
  }
  if (isSandbox && !onHost) {
    expect(() =>
      composeOperatorEnrollment(signed, { ...deps, evaluatorDispatchKeys: undefined }),
    ).toThrow('parent-evaluator-dispatch-key-required');
    expect(() => composeOperatorEnrollment(signed, { ...deps, evaluatorFetch: undefined })).toThrow(
      'parent-evaluator-tls-credentials-required',
    );
    expect(() =>
      composeOperatorEnrollment(signed, { ...deps, trustedEvaluatorPins: undefined }),
    ).toThrow('independently-provisioned-public-policy-required');
    expect(() =>
      composeOperatorEnrollment(signed, {
        ...deps,
        trustedEvaluatorPins: {
          ...deps.trustedEvaluatorPins,
          checks: { ...authorities.checks, configurationDigest: digest('other policy') },
        },
      }),
    ).toThrow('independently-provisioned-public-policy-required');
    expect(() =>
      composeOperatorEnrollment(signed, {
        ...deps,
        runtime: { ...deps.runtime, sandboxCoding: { ...sandbox, readyDiskImageId: 'wrong' } },
      }),
    ).toThrow('parent-sandbox-coding-runtime-mismatch');
    expect(() =>
      composeOperatorEnrollment(
        {
          ...signed,
          parent: { ...parent, coding: { ...parent.coding, sandbox: undefined } },
        },
        deps,
      ),
    ).toThrow('parent-coding-policy-mismatch');
    expect(() =>
      composeOperatorEnrollment(
        {
          ...signed,
          parent: { ...parent, coding: { ...parent.coding, evaluation: undefined } },
        },
        deps,
      ),
    ).toThrow('parent-coding-policy-mismatch');
    expect(() =>
      composeOperatorEnrollment(
        {
          ...signed,
          parent: {
            ...parent,
            coding: { ...parent.coding, sandbox: { ...sandbox, secondPaths: ['PROOF.txt/child'] } },
          },
        },
        deps,
      ),
    ).toThrow('parent-coding-policy-mismatch');
  }
  const ready = composeOperatorEnrollment(signed, deps);
  await ready.prepare?.();
  ready.qualification?.recover();
  await ready.qualification?.tick();
  expect(ready.qualification).toBeDefined();
  expect(evaluatorFetch).not.toHaveBeenCalled();
  expect(hostPorts.checks.evaluate).not.toHaveBeenCalled();
  expect(hostPorts.review.reviewer.parentQualification).not.toHaveBeenCalled();
  expect(resume).toHaveBeenCalledTimes(1);
  expect(exportPrivateHead).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT count(*) FROM orchestration_continuations').pluck().get()).toBe(0);
});

it('provisions only a countersigned, confined seed and rejects rotation against an existing run before reattaching channels', async () => {
  const { f, enrollment: e, profiles, cli, sign, run } = await operatorSeedFixture(image);
  const resume = vi.fn(async () => {}),
    provider = offlineController(() => {
      throw new Error('unexpected-call');
    });
  const runtime = {
    config: { db: f.db },
    resume,
    withCheckpoint() {
      throw new Error('unexpected-executor');
    },
  } as unknown as NonNullable<Parameters<typeof composeOperatorEnrollment>[1]['runtime']>;
  const deps = {
    db: f.db,
    databasePath: f.db.name,
    profiles,
    cli,
    runtime,
    bind: () => provider.provider,
  };
  expect(() => composeOperatorEnrollment(e, { ...deps, isolatedArtifacts: true })).toThrow(
    'policy-mismatch',
  );
  const compose = (envelope = e) => composeOperatorEnrollment(envelope, deps);
  expect(parseOperatorEnrollment(undefined)).toBeUndefined();
  expect(() => parseOperatorEnrollment('{"enabled":true}')).toThrow('invalid-operator-enrollment');
  expect(() => compose({ ...e, budget: { ...e.budget, requests: 999 } })).toThrow(
    'policy-mismatch',
  );
  expect(() => compose({ ...e, review: e.checks })).toThrow('independentReview-required');
  // A pair of valid receipts for the wrong Git tree still cannot pin a broken envelope.
  const wrongTree = '1'.repeat(40);
  const invalidSeed = {
    ...e,
    source: { ...e.source, tree: wrongTree },
    ...sign(e.authorities, undefined, wrongTree),
  };
  await expect(compose(invalidSeed).prepare!()).rejects.toThrow('checkpoint-source-mismatch');
  expect(f.db.prepare('SELECT 1 FROM orchestration_runs WHERE id=?').get(run)).toBeUndefined();
  const seeded = compose();
  await seeded.prepare!();
  expect(resume).toHaveBeenCalledTimes(1);
  expect(provider.calls()).toBe(0);
  const cp = seeded.slots[0]!.checkpoint;
  expect(
    f.db
      .prepare('SELECT count(*) FROM orchestration_checkpoint_custody WHERE run_id=?')
      .pluck()
      .get(run),
  ).toBe(1);
  await rm(e.source.bundlePath);
  await compose().prepare!();
  const next = fixtureSigner('independentReview', 'reviewer-v2', digest('config-v2'));
  const authorities = { ...e.authorities, independentReview: next.authority };
  expect(() => compose({ ...e, authorities })).toThrow('checks-required');
  await expect(
    compose({ ...e, authorities, ...sign(authorities, next) }).prepare!(),
  ).rejects.toThrow('enrollment-changed');
  expect(resume).toHaveBeenCalledTimes(2);
  f.db
    .prepare('UPDATE orchestration_checkpoint_custody SET bundle=? WHERE run_id=?')
    .run(Buffer.from('damaged'), run);
  await expect(compose().prepare!()).rejects.toThrow('custody-damaged');
  f.db
    .prepare(
      'INSERT INTO orchestration_kickoffs(run_id,seed_digest,checkpoint_json,recipes_json) VALUES(?,?,?,?)',
    )
    .run(run, digest(0), JSON.stringify(cp), '{}');
  f.db.prepare('DELETE FROM orchestration_checkpoint_custody WHERE run_id=?').run(run);
  expect(() => assertOperatorRecovery(f.db, null)).toThrow('enrollment-required');
  expect(() => assertOperatorRecovery(f.db, run)).not.toThrow();
  seeded.host.ledger.cancel(run);
  expect(() => assertOperatorRecovery(f.db, null)).not.toThrow();
  expect(provider.calls()).toBe(0);
  const other = 'x'.repeat(64);
  seeded.host.ledger.open(other, cp.repository, cp.policyDigest, cp.commit, 4);
  f.db
    .prepare(
      'INSERT INTO orchestration_kickoffs(run_id,seed_digest,checkpoint_json,recipes_json) VALUES(?,?,?,?)',
    )
    .run(other, digest(1), JSON.stringify(cp), '{}');
  expect(() => assertOperatorRecovery(f.db, null)).not.toThrow();
});
it('requires countersignatures for the future parent selection and never binds a host model for a parent slot', async () => {
  const { f, enrollment, profiles, cli, sign } = await operatorSeedFixture(image);
  const parent = {
    requestId: '5ecff8d3-de82-48cb-961a-dc06dc506533',
    launchDigest: 'a'.repeat(64),
  };
  const input = { ...enrollment, parent };
  const bind = vi.fn(() => {
    throw new Error('host-controller-must-not-run');
  });
  const deps = {
    db: f.db,
    databasePath: f.db.name,
    profiles,
    cli,
    bind,
    runtime: { config: { db: f.db }, resume: vi.fn() } as unknown as NonNullable<
      Parameters<typeof composeOperatorEnrollment>[1]['runtime']
    >,
  };
  expect(() => composeOperatorEnrollment(input, deps)).toThrow('policy-mismatch');
  const authorities = {
    ...enrollment.authorities,
    basePolicyDigest: operatorBasePolicy(input, profiles),
  };
  const parsed = parseOperatorEnrollment(
    JSON.stringify({ ...input, authorities, ...sign(authorities) }),
  );
  if (!parsed) throw new Error('missing enrollment');
  const enrolled = composeOperatorEnrollment(parsed, deps);
  await enrolled.prepare!();
  expect(enrolled.slots[0]?.parent).toEqual(parent);
  expect(enrolled.slots[0]?.provider).toBeUndefined();
  expect(bind).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT count(*) FROM orchestration_continuations').pluck().get()).toBe(0);
  const legacy = Object.fromEntries(
    Object.entries(input).filter(([key]) => !['authorities', 'checks', 'review'].includes(key)),
  );
  expect(() =>
    parseOperatorEnrollment(
      JSON.stringify({
        ...legacy,
        version: 2,
        slot: 'inspection-99',
        expectedRun: 'a'.repeat(64),
        expectedBasePolicy: digest('fixture'),
      }),
    ),
  ).toThrow('invalid-operator-enrollment');
});
it('requires a separately enrolled, signed sandbox target and never starts a fresh run during preparation', async () => {
  const { f, profiles, enrollment, cli } = await operatorSeedFixture(
    'registry.example/worker@sha256:' + 'b'.repeat(64),
    true,
    'sandbox',
  );
  const resume = vi.fn(),
    bind = vi.fn(
      () =>
        offlineController(() => {
          throw new Error('unexpected-call');
        }).provider,
    );
  const deps = {
    db: f.db,
    databasePath: f.db.name,
    profiles,
    cli,
    bind,
    runtime: { config: { db: f.db }, resume } as unknown as NonNullable<
      Parameters<typeof composeOperatorEnrollment>[1]['runtime']
    >,
  };
  expect(() => composeOperatorEnrollment(enrollment, deps)).toThrow();
  const run = composeOperatorEnrollment(enrollment, { ...deps, isolatedArtifacts: true });
  await run.prepare!();
  expect(resume).toHaveBeenCalledTimes(1);
  expect(f.db.prepare('select count(*) from orchestration_kickoffs').pluck().get()).toBe(0);
  expect(f.db.prepare('select count(*) from managed_sandbox_allocations').pluck().get()).toBe(0);
});
it('rejects the wrong seed file before opening a run or resuming any runtime', async () => {
  const { f, enrollment, profiles, cli, run } = await operatorSeedFixture(image);
  await writeFile(enrollment.source.bundlePath, 'wrong bytes');
  const resume = vi.fn();
  const runtime = { config: { db: f.db }, resume } as unknown as NonNullable<
    Parameters<typeof composeOperatorEnrollment>[1]['runtime']
  >;
  const c = composeOperatorEnrollment(enrollment, {
    db: f.db,
    databasePath: f.db.name,
    profiles,
    cli,
    runtime,
    bind: () =>
      offlineController(() => {
        throw new Error();
      }).provider,
  });
  await expect(c.prepare!()).rejects.toThrow('seed-damaged');
  expect(f.db.prepare('SELECT 1 FROM orchestration_runs WHERE id=?').get(run)).toBeUndefined();
  expect(resume).not.toHaveBeenCalled();
});
