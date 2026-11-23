import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ManagedPodRequest } from '@autopod/shared';
import Database from 'better-sqlite3';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createConfigurationStore } from '../configuration/configuration-store.js';
import type { rehearseConfigurationConversion } from '../configuration/conversion-rehearsal.js';
import { configurationCutoverReadiness } from '../configuration/cutover-readiness.js';
import { admitLaunch } from '../configuration/launch-admission.js';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import { loadOrCreateKey } from '../crypto/credentials-cipher.js';
import { runMigrations } from '../db/migrate.js';
import { digest, sha256 } from '../managed/canonical.js';
import {
  PRIVATE_COMMIT_EFFECTS,
  PRIVATE_PARENT_VERIFIER,
} from '../managed/private-commit-policy.js';
import { createProviderAccountStore } from '../provider-accounts/index.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { openTestDiskDatabase } from '../test-utils/disk-database.js';
import { resign } from '../test-utils/managed-fixture.js';
import { insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { checkInspectionDraft, signingPacket } from './enrollment-packet.js';
import {
  parentCandidateReviewDigest,
  parentCandidateSeed,
  prepareParentCandidate,
} from './parent-candidate-host.js';

const dist = fileURLToPath(new URL('../../dist/', import.meta.url));
const preload = fileURLToPath(new URL('./parent-candidate-idle-preload.mjs', import.meta.url));
const exec = promisify(execFile);
const owner = 'candidate-fixture-owner';
const image = `example.invalid/fixture@sha256:${'1'.repeat(64)}`;

// Exact bytes of the version-2 HEAD bundle for the two fictional commits built
// in parent-candidate-host.test.ts. Pin the pack bytes too, independently of the
// installed Git/zlib version. The packet and boot both verify the real Git objects.
const seed = Buffer.from(
  'IyB2MiBnaXQgYnVuZGxlCjQ0MzM1MTNhYmRhMjhkODk0YzZlYjUwYmMxOTBlODNmNTg2NTYxZmMgSEVBRAoKUEFDSwAAAAIA' +
    'AAAFnRB4nKWPTQrCMBBG9znF7AXJpE2mARFXXkAvMCZTDNof6lTU01tQvIDf6m2+B08nEfA1Sw45p5OPiL4OjjlXmDHXRGSb' +
    'NjiqMnsz8iS9QowNRZtY2BMiuSRIloKVGKRp2sqTc4TMhmc9DxMcnr2eRUuCfXnoPAls2g/s5MHdeJV16e98LXkLSNEvZ1tb' +
    'WNllJg1dV1TlT43ZL6UvgdtP8o058u0CpR9nNW+DsVU+ng54nK3MQQrCMBBA0X1OMXtBkrRJFER04wX0AtPOlAbapMSJ1Nsr' +
    'KJ7Av/qrJ4UZXItMnqjv3N4Y13qLSI0hQ20IQe8Gb0ND6BRWGXOBc5W8ZIJbwXRfchG4xFVqYTgMnznxivMy8TamB06RjmCC' +
    'D9Y6rzVs9DvV53mOIvwnTl2fSUaW2EOXayImkJ/3ZdQLVFpPSaECeJwzMQACheLE3IKcVIbZLSt/WNybXG8m07cv4Msu9/mf' +
    'HN4CANWYDyClAnicMzQwMDMxUUjOL80r0SupKGHw4NAv+tB+ri5/efQcx+sWtevOulQDAO4lDs8zeJwzNOICAAEEAG4xPxM1' +
    'zFflNwQBzkCbBd/R190sfQ==',
  'base64',
);

async function packaged(entry: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return (
    await exec(process.execPath, ['--import', preload, path.join(dist, entry), ...args], {
      cwd,
      env,
      timeout: 15_000,
    })
  ).stdout;
}

async function idleBoot(
  root: string,
  env: NodeJS.ProcessEnv,
  inspect: (url: string) => Promise<void>,
) {
  const child = spawn(
    process.execPath,
    ['--import', preload, path.join(dist, 'index.js'), '--parent-candidate'],
    {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const closed = once(child, 'close');
  let output = '';
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-64 * 1024);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  try {
    // Fastify reports the bound address, including the OS-selected ephemeral port.
    await vi.waitFor(
      () => expect(output).toMatch(/Server listening at http:\/\/127\.0\.0\.1:\d+/),
      { timeout: 10_000 },
    );
    expect(output).toContain('"receiptTrust":"single-owner-local"');
    const url = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (!url) throw new Error('Missing idle fixture listener');
    await inspect(url);
    expect(child.exitCode).toBeNull();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
    try {
      expect(await closed, output).toEqual([0, null]);
    } finally {
      clearTimeout(kill);
    }
  }
}

async function privateCutover(root: string, env: NodeJS.ProcessEnv, database: string, key: string) {
  const db = openTestDiskDatabase(database);
  try {
    runMigrations(db, path.join(dist, 'db/migrations'), logger);
    insertTestProfile(db);
    db.prepare(`UPDATE profiles SET repo_url='https://github.com/fictional/fixture',
      test_command='npm test',provider_failover=NULL WHERE name='test-profile'`).run();
  } finally {
    db.close();
  }
  loadOrCreateKey(key);
  const bindings = path.join(root, 'bindings.json');
  await writeFile(
    bindings,
    JSON.stringify({
      accountByProfile: { 'test-profile': 'account' },
      accountFailover: { account: null },
    }),
    { mode: 0o600 },
  );
  const original = await readFile(database);
  const preview = JSON.parse(
    await packaged(
      'configuration/conversion-cli.js',
      [
        '--source',
        database,
        '--output-directory',
        root,
        '--secrets-key',
        key,
        '--owner',
        owner,
        '--bindings',
        bindings,
      ],
      root,
      env,
    ),
  ) as Awaited<ReturnType<typeof rehearseConfigurationConversion>>;
  expect(preview.preview.blocked).toBe(false);
  expect(preview.receipt).toBeNull();
  expect(await readFile(database)).toEqual(original);
  const applied = JSON.parse(
    await packaged(
      'configuration/cutover-cli.js',
      [
        '--operation',
        'apply-reviewed',
        '--database',
        database,
        '--secrets-key',
        key,
        '--source-identity',
        preview.sourceIdentity,
        '--source-fingerprint',
        preview.sourceFingerprint,
        '--conversion-digest',
        preview.preview.digest,
        '--owner',
        owner,
        '--bindings',
        bindings,
      ],
      root,
      env,
    ),
  );
  expect(applied).toMatchObject({ applied: true, receipt: { admissionEnabled: false } });
}

async function managedSelection(root: string) {
  const examples = await readFile(
    new URL('../../../../specs/managed-pod/v1/examples.json', import.meta.url),
    'utf8',
  );
  const { ManagedPodRequest: request } = JSON.parse(examples) as {
    ManagedPodRequest: ManagedPodRequest;
  };
  const repository = 'fictional-count';
  const profile = request.profileSnapshot;
  profile.route.executionTarget = 'sandbox';
  request.route = { ...profile.route };
  request.task = {
    ...request.task,
    kind: 'implementation',
    objective: 'Edit the fictional count sample',
  };
  profile.scope.allowedEffects = [...PRIVATE_COMMIT_EFFECTS];
  profile.scope.repositories = [
    {
      enrollmentId: repository,
      remote: 'private',
      access: 'write',
      branchNamespace: 'autopod/',
      baseRevision: parentCandidateSeed.commit,
    },
  ];
  profile.budget = {
    mode: 'request-time',
    maxProviderRequests: 1,
    maxObservedTokens: 10_000,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    maxDurationSeconds: 480,
  };
  const { snapshotDigest: _, ...fields } = profile;
  profile.snapshotDigest = digest(fields);
  Object.assign(request.effectiveGrant, {
    route: { ...request.route },
    profileSnapshotDigest: profile.snapshotDigest,
    scope: structuredClone(profile.scope),
    budget: { ...profile.budget },
  });
  request.validation.verifierPolicy = PRIVATE_PARENT_VERIFIER;
  request.outputs.source = {
    mode: 'commit',
    remote: 'private',
    repository,
    base: 'main',
    head: 'autopod/fixture',
  };
  request.outputs.artifacts.requiredPaths = request.outputs.artifacts.include = ['report.md'];
  request.outputs.artifacts.limits = { maxFiles: 1, maxFileBytes: 16384, maxTotalBytes: 16384 };
  resign(request);
  const profiles = {
    mode: 'reviewed-profile-set-v1',
    installationId: 'fixture-installation',
    profiles: [
      {
        profileSnapshot: profile,
        taskKind: 'implementation',
        artifactPath: 'report.md',
        inputNames: [],
        sourceMode: 'commit',
        privateCommit: true,
      },
    ],
    mirror: {
      enrollmentId: repository,
      remote: 'private',
      baseRevision: parentCandidateSeed.commit,
      path: path.join(root, 'unmounted-mirror'),
    },
    image,
  };
  const cli = {
    bindings: [
      {
        issuer: 'https://fixture.example.invalid/',
        audience: 'fixture-api',
        objectId: owner,
        installationId: profiles.installationId,
      },
    ],
    artifactDirectory: path.join(root, 'managed', 'cli-artifacts'),
  };
  return { request, profiles, cli };
}

// Opt in after building dist; ordinary source-only daemon test runs do not require a release.
it.skipIf(process.env.AUTOPOD_TEST_PACKAGED_PARENT_CANDIDATE !== '1')(
  'boots the signed fictional candidate without starting work and fences a lost qualification send on restart',
  async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'parent-candidate-idle-')));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    const home = path.join(root, 'home');
    const tmp = path.join(root, 'tmp');
    const database = path.join(root, 'autopod.db');
    await mkdir(home, { mode: 0o700 });
    await mkdir(tmp, { mode: 0o700 });
    await mkdir(path.join(home, '.autopod'), { mode: 0o700 });
    const env = { HOME: home, TMPDIR: tmp, PATH: '/usr/bin:/bin', NODE_ENV: 'production' };
    const keyPath = path.join(home, '.autopod', 'secrets.key');
    await privateCutover(root, env, database, keyPath);
    const { request, profiles, cli } = await managedSelection(root);

    const launchRequest = {
      intent: 'task' as const,
      emptyWorkspace: true as const,
      task: 'Set the fictional count to 24 and explain why.',
      profileId: 'profile',
      requestId: '5ecff8d3-de82-48cb-961a-dc06dc506533',
      overrides: {
        workflow: { output: 'none' as const, validationPhases: [] },
        ai: {
          reviewer: {
            mode: 'independent' as const,
            route: {
              providerAccountId: 'fixture-review',
              runtime: 'claude' as const,
              model: 'claude-sonnet-4-6',
            },
          },
        },
      },
    };
    const configDb = openTestDiskDatabase(database);
    const { selection, services } = await (async () => {
      try {
        expect(configurationCutoverReadiness(configDb, true)).toMatchObject({ ready: true });
        // The sandbox profile requires a local auth record even when idle.
        // This string is inert, not an account credential or provider proof.
        createProviderAccountStore(configDb, loadOrCreateKey(keyPath)).create({
          id: request.route.providerAccountId,
          name: 'Fictional idle fixture',
          provider: 'openai',
          credentials: {
            provider: 'openai',
            authMode: 'chatgpt',
            authJson: JSON.stringify({
              auth_mode: 'chatgpt',
              tokens: { access_token: 'not-a-credential', account_id: 'fictional' },
            }),
          },
        });
        const { services } = createTestConfiguration(configDb);
        // Resolve with the production resolver, fixture-only account/image ports.
        return { selection: await resolveLaunch(launchRequest, services, owner), services };
      } finally {
        configDb.close();
      }
    })();
    const reviewDigest = parentCandidateReviewDigest(selection.ai.reviewer, image);
    await writeFile(
      path.join(home, '.autopod', 'configuration-host.json'),
      JSON.stringify({ reviewerImages: { local: image } }),
      { mode: 0o600 },
    );

    const target = {
      subscriptionId: '5ea82d48-6f53-401b-b607-69c6d0a12531',
      location: 'fictional',
      resourceGroup: 'fixture-rg',
      sandboxGroup: 'fixture-group',
    };
    const bundlePath = path.join(root, 'seed.bundle');
    await writeFile(bundlePath, seed, { mode: 0o600 });
    expect(sha256(seed)).toBe(parentCandidateSeed.bundleDigest);
    const main = selection.ai.main;
    const draft = {
      version: 1,
      slot: 'fixture-parent',
      objectId: owner,
      mission: launchRequest.task,
      main: {
        profileName: 'Development',
        profileId: selection.profileId,
        profileRevision: 1,
        aiId: 'ai',
        aiRevision: 1,
        model: main.model,
        accountId: main.providerAccountId,
      },
      budget: { requests: 2, active: 2, workers: 2, turns: 2 },
      recipes: { implement: request },
      source: { ...parentCandidateSeed, bundlePath },
      parent: {
        requestId: launchRequest.requestId,
        launchDigest: selection.digest,
        coding: {
          recipe: 'implement',
          paths: ['sample/count.txt'],
          sandbox: {
            hostQualification: true,
            singleOwnerReceipts: true,
            secondPaths: ['sample/reason.txt'],
            resourceScopeDigest: digest(
              JSON.stringify([
                `https://management.${target.location}.azuredevcompute.io`,
                target.subscriptionId,
                target.resourceGroup,
                target.sandboxGroup,
              ]),
            ),
            readyDiskImageId: 'fictional-disk',
          },
        },
      },
    };
    const profileRaw = JSON.stringify(profiles);
    const cliRaw = JSON.stringify(cli);
    const checked = await checkInspectionDraft(draft, profileRaw, cliRaw, seed);
    const pins = JSON.parse(
      await packaged(
        'orchestration/parent-candidate-keys-cli.js',
        ['init', root, reviewDigest],
        root,
        env,
      ),
    );
    await Promise.all([
      writeFile(path.join(root, 'profiles.json'), profileRaw, { mode: 0o600 }),
      writeFile(path.join(root, 'cli.json'), cliRaw, { mode: 0o600 }),
    ]);
    const draftFile = path.join(root, 'draft.json');
    const packet = signingPacket(checked, pins);
    const candidateKeys = (args: string[]) =>
      packaged('orchestration/parent-candidate-keys-cli.js', args, root, env);
    const enroll = () => candidateKeys(['enroll', root, reviewDigest, packet.inputDigest]);
    for (const rejected of [
      { ...draft, source: { ...draft.source, bundlePath: path.join(root, 'other.bundle') } },
      { ...draft, budget: { ...draft.budget, active: 1 } },
      { ...draft, mission: 'Valid but not reviewed for this exact enrollment.' },
      {
        ...draft,
        parent: {
          ...draft.parent,
          coding: {
            ...draft.parent.coding,
            sandbox: { ...draft.parent.coding.sandbox, singleOwnerReceipts: undefined },
          },
        },
      },
    ]) {
      await writeFile(draftFile, JSON.stringify(rejected), { mode: 0o600 });
      await expect(enroll()).rejects.toThrow('parent-candidate-keys-refused');
    }
    await writeFile(draftFile, JSON.stringify(draft), { mode: 0o600 });
    const preview = JSON.parse(await candidateKeys(['preview', root, reviewDigest]));
    expect(preview).toEqual(packet);
    expect(preview).not.toHaveProperty('checks');
    await expect(candidateKeys(['enroll', root, reviewDigest])).rejects.toThrow(
      'parent-candidate-keys-refused',
    );
    const enrollment = JSON.parse(await enroll());
    expect(enrollment.authorities).toEqual(packet.authorities);
    expect(enrollment.checks.statement.inputDigest).toBe(packet.inputDigest);
    expect(enrollment.review.statement.inputDigest).toBe(packet.inputDigest);
    const bootEnv = {
      ...env,
      HOST: '127.0.0.1',
      PORT: '0',
      DB_PATH: database,
      DATA_DIR: path.join(root, 'data'),
      AUTOPOD_WORKTREE_DIR: path.join(root, 'worktrees'),
      AUTOPOD_PARENT_CANDIDATE_DIR: root,
      AUTOPOD_OPERATOR_ENROLLMENT: JSON.stringify(enrollment),
      AUTOPOD_OPERATOR_PROFILE_SET: profileRaw,
      AUTOPOD_OPERATOR_SANDBOX_TARGET: JSON.stringify(target),
      AUTOPOD_MANAGED_CLI: cliRaw,
      ENTRA_TENANT_ID: 'e28d7647-2b13-46f5-a27b-82683436159e',
      ENTRA_CLIENT_ID: 'fictional-client',
    };
    const keyFile = path.join(root, 'parent-candidate-receipts.json');
    const hidden = `${keyFile}.withheld`;
    const beforeMissingTrust = await readFile(database);
    await rename(keyFile, hidden);
    try {
      await expect(packaged('index.js', ['--parent-candidate'], root, bootEnv)).rejects.toThrow(
        /ENOENT.*parent-candidate-receipts\.json/,
      );
    } finally {
      await rename(hidden, keyFile);
    }
    expect(await readFile(database)).toEqual(beforeMissingTrust);
    const candidate = await prepareParentCandidate(true, bootEnv, enrollment);
    if (!candidate) throw new Error('Expected candidate');
    const signedRequest = {
      ...launchRequest,
      expectedDigest: selection.digest,
      requireParentEnrollment: true,
    };
    expect(() => candidate.requireLaunch(signedRequest)).not.toThrow();
    const admitDb = new Database(database, { readonly: true });
    try {
      const store = createConfigurationStore(admitDb);
      const authorize = vi.fn();
      const createPod = vi.fn();
      const resolveEnvironment = vi.fn(() => {
        throw new Error('Another launch must be refused before resolution');
      });
      await expect(
        admitLaunch({
          request: { ...signedRequest, requestId: 'e24e1b10-a2f2-424f-ba9a-994a396c3292' },
          actorId: owner,
          services: { ...services, store, resolveEnvironment },
          snapshots: createLaunchSnapshotRepository(admitDb, store),
          assertRequest: candidate.requireLaunch,
          authorize,
          createPod,
        }),
      ).rejects.toMatchObject({
        code: 'PARENT_ENROLLMENT_REQUIRED',
        message: 'Only the enrolled candidate Task is allowed',
      });
      expect(authorize).not.toHaveBeenCalled();
      expect(resolveEnvironment).not.toHaveBeenCalled();
      expect(createPod).not.toHaveBeenCalled();
    } finally {
      admitDb.close();
    }
    const neverReview = () => {
      throw new Error('Idle rehearsal cannot review');
    };
    const review = {
      readPod: neverReview,
      readLaunch: neverReview,
      reviewer: { parentQualification: neverReview },
    };
    const { assertLaunch } = candidate.bind(image, review);
    expect(() => assertLaunch(selection)).not.toThrow();
    expect(() =>
      candidate
        .bind(`example.invalid/other@sha256:${'2'.repeat(64)}`, review)
        .assertLaunch(selection),
    ).toThrow('Candidate launch or review route differs');
    const changedDraft = { ...draft, parent: { ...draft.parent, launchDigest: 'f'.repeat(64) } };
    const changedPacket = signingPacket(
      await checkInspectionDraft(changedDraft, profileRaw, cliRaw, seed),
      pins,
    );
    // Even updating the public policy metadata cannot reuse the old signatures.
    await expect(
      packaged('index.js', ['--parent-candidate'], root, {
        ...bootEnv,
        AUTOPOD_OPERATOR_ENROLLMENT: JSON.stringify({
          ...enrollment,
          parent: changedDraft.parent,
          authorities: changedPacket.authorities,
        }),
      }),
    ).rejects.toThrow('combined-checks-required');

    const assertIdle = async (url: string) => {
      const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      expect(health.status).toBe(200);
      await health.text();
      const status = await fetch(`${url}/orchestration/runs/${draft.slot}/status`, {
        signal: AbortSignal.timeout(2000),
      });
      expect(status.status).toBe(401);
      await status.text();
      const db = new Database(database, { readonly: true });
      try {
        for (const table of [
          'pods',
          'managed_pods',
          'managed_sandbox_allocations',
          'orchestration_continuations',
          'orchestration_kickoffs',
          'orchestration_controller_turns',
        ])
          expect(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get(), table).toBe(0);
        expect(
          db
            .prepare('SELECT bundle FROM orchestration_checkpoint_custody WHERE run_id=?')
            .pluck()
            .all(checked.run),
        ).toEqual([seed]);
        expect(
          db
            .prepare('SELECT remaining FROM orchestration_request_balances WHERE id=?')
            .pluck()
            .get(checked.run),
        ).toBe(draft.budget.requests);
      } finally {
        db.close();
      }
    };
    await idleBoot(root, bootEnv, assertIdle);

    // Model a lost send by inserting ONLY its durable recovery facts. Never
    // commission a parent, fabricate child outputs, build a candidate, or send.
    const lostDigest = digest('fictional interrupted send');
    const lostSelection = '[]';
    const db = openTestDiskDatabase(database);
    try {
      db.prepare(`INSERT INTO parent_managed_runs (run_id,pod_id,launch_digest,policy_digest,policy_json)
      SELECT id,'fictional-stopped-parent',?,policy_digest,? FROM orchestration_runs WHERE id=?`).run(
        selection.digest,
        JSON.stringify(draft.parent),
        checked.run,
      );
      db.prepare(`INSERT INTO parent_qualification_jobs (run_id,selection_json,status,input_digest)
      VALUES (?,?,'checks',?)`).run(checked.run, lostSelection, lostDigest);
    } finally {
      db.close();
    }
    await rm(bundlePath); // recovery reads the pinned seed from custody, not the submission path
    await idleBoot(root, bootEnv, async (url) => {
      // Wait past the first qualification tick, not just the listener barrier.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await assertIdle(url);
      const reopened = new Database(database, { readonly: true });
      try {
        expect(
          reopened
            .prepare(
              'SELECT status,input_digest,selection_json,evidence_digest FROM parent_qualification_jobs WHERE run_id=?',
            )
            .get(checked.run),
        ).toEqual({
          status: 'unknown',
          input_digest: lostDigest,
          selection_json: lostSelection,
          evidence_digest: null,
        });
      } finally {
        reopened.close();
      }
      expect(
        JSON.parse(
          await packaged(
            'orchestration/parent-candidate-keys-cli.js',
            ['pins', root, reviewDigest],
            root,
            env,
          ),
        ),
      ).toEqual(pins);
    });
  },
  45_000,
);
