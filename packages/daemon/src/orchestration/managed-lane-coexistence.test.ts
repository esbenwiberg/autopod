import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { JwtPayload, Pod } from '@autopod/shared';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { managedPodRoutes } from '../api/routes/managed-pods.js';
import type { PodTokenIssuer } from '../crypto/pod-tokens.js';
import type { AuthModule } from '../interfaces/auth-module.js';
import { canonical, digest } from '../managed/canonical.js';
import { ManagedPodService } from '../managed/managed-service.js';
import { insertConfigurationTestPod } from '../test-utils/configuration-helpers.js';
import {
  createHistoricalDiskDatabase,
  latestMigrationVersion,
  MIGRATIONS_DIR,
  openTestDiskDatabase,
} from '../test-utils/disk-database.js';
import { requestTimeFixture } from '../test-utils/managed-fixture.js';
import { logger } from '../test-utils/mock-helpers.js';
import { LocalCheckpointHost } from './local-checkpoints.js';
import { claimDaemonLifetime } from './local-recovery-claim.js';
import { createManagedLaneOwnership } from './managed-lane-ownership.js';
import { assertOperatorRecovery } from './operator-enrollment.js';
import { type OperatorRunsConfig, operatorRunId, registerOperatorRuns } from './operator-runs.js';
import { combineParentLanes } from './parent-family-lanes.js';
import { ParentManagedLaunch } from './parent-managed-launch.js';
import { delegationOwnerDigest } from './saved-delegation-policy.js';
import { createSavedDelegationRegistry } from './saved-delegation-registry.js';

it('boots Dispatcher, operator and saved parent recovery independently, with the same ownership after reopening SQLite', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ap-managed-lanes-'));
  const file = path.join(root, 'state.db');
  let db = createHistoricalDiskDatabase(file, [
    { dir: MIGRATIONS_DIR, through: latestMigrationVersion() },
  ]);
  const fixture = requestTimeFixture();
  const issuer = 'https://issuer.example.invalid/';
  const audience = 'fixture';
  const operator = { issuer, audience, objectId: 'signed-owner', installationId: 'dispatcher' };
  const principal = {
    iss: issuer,
    aud: audience,
    oid: 'saved-owner',
    operatorPrincipal: 'delegated-user' as const,
  };
  const signedRun = operatorRunId(operator, 'signed');
  const savedRun = 'd'.repeat(64);
  const ordinaryInstallation = 'dispatcher';
  const signedInstallation = `native.${signedRun}`;
  const savedInstallation = `native.${savedRun}`;
  const repository = 'fixture-repo';
  const commit = 'a'.repeat(40);
  const policyDigest = digest('enrolled');
  const evidenceDigest = digest('saved-seed');
  const checkpoint = {
    run: signedRun,
    repository,
    policyDigest,
    predecessor: 'b'.repeat(40),
    commit,
    tree: 'c'.repeat(40),
    evidenceDigest,
  };
  const parent = { requestId: randomUUID(), launchDigest: 'f'.repeat(64) };
  const policy = {
    mission: 'fixture',
    routeId: 'reviewed',
    recipes: {},
    limits: { turns: 1, workers: 1, outputTokens: 512 },
  };
  const slot = {
    slot: 'signed',
    operator,
    checkpoint,
    parent,
    catalog: {},
    policy,
  } satisfies OperatorRunsConfig['slots'][number];
  const signedParent = insertConfigurationTestPod(db, 'signed-parent');
  const savedParent = insertConfigurationTestPod(db, 'saved-parent');
  const auth = {
    validateToken: async (token: string) => {
      if (token !== operator.objectId && token !== principal.oid)
        throw new Error('fixture auth denied');
      return { ...principal, oid: token, exp: Date.now() / 1000 + 1000 } as JwtPayload;
    },
  } as AuthModule;
  const tokens = { verifyAttempt: () => null } as unknown as PodTokenIssuer;
  const diskRows = (stmt: string) => db.prepare(stmt);
  const insertWorker = (pod: string, installation: string) => {
    const r = fixture.request;
    diskRows(`INSERT INTO managed_pods (pod_id,dispatcher_installation_id,dispatcher_attempt_id,managed_start_key,
      execution_spec_digest,profile_snapshot_digest,grant_id,grant_revision,effective_grant_digest,
      request_json,handle_json,state,runtime_ref,created_at,allocation_attempted)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'running',?,100,1)`).run(
      pod,
      installation,
      r.dispatcherAttemptId,
      r.startKey,
      r.executionSpecDigest,
      r.profileSnapshot.snapshotDigest,
      r.effectiveGrant.grantId,
      r.effectiveGrant.revision,
      r.effectiveGrant.digest,
      JSON.stringify(r),
      '{}',
      pod,
    );
  };
  const start = vi.fn(async () => {
    throw new Error('must not start retained workers');
  });
  try {
    for (const run of [signedRun, savedRun]) {
      diskRows(`INSERT INTO orchestration_runs (id,repository,policy_digest,accepted_commit,worker_request_limit,max_active,operator_owned)
      VALUES (?,?,?,?,12,2,1)`).run(run, repository, policyDigest, commit);
    }
    const signedPolicy = canonical({
      parent,
      checkpoint,
      catalog: {},
      operator,
      limits: policy.limits,
    });
    const parents = diskRows(
      'INSERT INTO parent_managed_runs (run_id,pod_id,launch_digest,policy_digest,policy_json) VALUES (?,?,?,?,?)',
    );
    parents.run(signedRun, signedParent, parent.launchDigest, digest(signedPolicy), signedPolicy);
    parents.run(savedRun, savedParent, parent.launchDigest, policyDigest, '{}');
    diskRows(
      'INSERT INTO orchestration_checkpoint_custody (run_id,evidence_digest,manifest,bundle) VALUES (?,?,?,?)',
    ).run(savedRun, evidenceDigest, '{}', Buffer.from('fixture'));
    diskRows(
      'INSERT INTO saved_delegation_admissions (run_id,request_id,owner_digest,plan_digest,seed_evidence_digest) VALUES (?,?,?,?,?)',
    ).run(savedRun, randomUUID(), delegationOwnerDigest(principal), digest('plan'), evidenceDigest);
    expect(() =>
      createManagedLaneOwnership(db, {
        ordinaryInstallations: [ordinaryInstallation],
        signedRun,
        savedOwnerDigest: digest('different-owner'),
        separateSignedRuntime: true,
      }).assertRecovery(),
    ).toThrow('saved-delegation-unconfigured-owner-retained');
    insertWorker('ordinary-worker', ordinaryInstallation);
    insertWorker('signed-worker', signedInstallation);
    insertWorker('saved-worker', savedInstallation);

    for (let boot = 0; boot < 2; boot++) {
      const owners = createManagedLaneOwnership(db, {
        ordinaryInstallations: [ordinaryInstallation],
        signedRun,
        savedOwnerDigest: delegationOwnerDigest(principal),
        separateSignedRuntime: true,
      });
      expect(() => owners.assertRecovery()).not.toThrow();
      expect(() => assertOperatorRecovery(db, signedRun)).toThrow('enrollment-required');
      assertOperatorRecovery(db, signedRun, true);
      const seen = {
        ordinary: new Set<string>(),
        signed: new Set<string>(),
        saved: new Set<string>(),
      };
      const service = (lane: keyof typeof seen, owns: (id: string) => boolean) =>
        new ManagedPodService(
          db,
          fixture.admission,
          {
            ...fixture.runtime,
            ensure: start,
            async observe(ref) {
              seen[lane].add(ref);
              return { state: 'running', consumedTokens: 0 };
            },
          },
          () => 100,
          true,
          [],
          owns,
        );
      const ordinary = service('ordinary', owners.ordinaryRuntime);
      const signedWorker = service('signed', owners.signed);
      const savedWorker = service('saved', owners.saved);
      const lifetimeOwner = claimDaemonLifetime(db);
      const app = Fastify();
      const host = new LocalCheckpointHost(db, root, () => signedWorker);
      const operatorConfig = {
        db,
        host,
        slots: [slot],
        lifetimeOwner,
        watchdog: { service: signedWorker },
        prepare: async () => assertOperatorRecovery(db, signedRun, true),
      };
      const signed = new ParentManagedLaunch(
        operatorConfig,
        tokens,
        (id) => ({ id, userId: operator.objectId }) as Pod,
      );
      const signedIngress = vi.spyOn(signed, 'withIngress');
      const saved = createSavedDelegationRegistry(
        db,
        {
          principal,
          advertise: vi.fn(),
          stopAdvertising: vi.fn(),
          attach: vi.fn(async (podId) => {
            expect(podId).toBe(savedParent);
            return { tick: () => savedWorker.enforceExpiry(), close: async () => {} } as Awaited<
              ReturnType<Parameters<typeof createSavedDelegationRegistry>[1]['attach']>
            >;
          }),
        },
        logger,
        lifetimeOwner,
      );
      const savedIngress = vi.spyOn(saved, 'withIngress');
      const lanes = combineParentLanes(db, signed, saved);
      try {
        app.addHook('preHandler', async (req) => {
          const token = req.headers.authorization?.slice(7);
          if (token) {
            try {
              req.user = await auth.validateToken(token);
            } catch {
              /* unauthorized */
            }
          }
        });
        managedPodRoutes(app, {
          service: ordinary,
          authenticate: async () => ordinaryInstallation,
        });
        registerOperatorRuns(app, operatorConfig, auth);
        lanes.registerFamily(app, auth);
        app.addHook('onReady', () => saved.start());
        app.addHook('onClose', () => saved.close());
        await app.ready();
        const get = (url: string, token: string) =>
          app.inject({ url, headers: { authorization: `Bearer ${token}` } });
        const family = async (id: string, actor: string) =>
          get(`/orchestration/parents/${id}/family`, actor);
        expect((await family(signedParent, operator.objectId)).json()).toMatchObject({
          run: signedRun,
        });
        expect((await family(savedParent, principal.oid)).json()).toMatchObject({ run: savedRun });
        expect((await family(signedParent, principal.oid)).statusCode).toBe(401);
        expect((await family(savedParent, operator.objectId)).statusCode).toBe(404);
        expect(
          (await get(`/orchestration/parents/${savedParent}/review/status`, principal.oid)).json(),
        ).toMatchObject({ status: 'waiting' });
        expect(
          (await get(`/orchestration/parents/${savedParent}/review/status`, operator.objectId))
            .statusCode,
        ).toBe(404);
        expect((await get('/orchestration/runs/signed/status', operator.objectId)).statusCode).toBe(
          200,
        );
        const dispatcher = await get('/managed/pods', operator.objectId);
        expect(dispatcher.statusCode).toBe(200);
        expect(dispatcher.json().pods.map((pod: { podId: string }) => pod.podId)).toEqual([
          'ordinary-worker',
        ]);
        expect(signed.tools(savedParent)).toBeUndefined();
        expect(saved.tools(signedParent)).toBeUndefined();
        await lanes.withIngress(signedParent, 'signed-attempt', async () => {});
        await lanes.withIngress(savedParent, 'saved-attempt', async () => {});
        await lanes.withIngress('ordinary-parent', undefined, async () => {});
        expect(signedIngress).toHaveBeenCalledExactlyOnceWith(
          signedParent,
          'signed-attempt',
          expect.any(Function),
        );
        expect(savedIngress).toHaveBeenCalledExactlyOnceWith(
          savedParent,
          'saved-attempt',
          expect.any(Function),
        );
        await vi.waitFor(
          () => {
            expect([...seen.ordinary]).toEqual(['ordinary-worker']);
            expect([...seen.signed]).toEqual(['signed-worker']);
            expect([...seen.saved]).toEqual(['saved-worker']);
          },
          { timeout: 3500 },
        );
      } finally {
        await app.close();
        expect(lifetimeOwner.owns(db)).toBe(true);
        lifetimeOwner.close();
      }
      expect(diskRows('SELECT count(*) FROM managed_pods').pluck().get()).toBe(3);
      expect(
        diskRows('SELECT remaining FROM orchestration_request_balances ORDER BY id').pluck().all(),
      ).toEqual([12, 12]);
      expect(start).not.toHaveBeenCalled();
      db.close();
      db = openTestDiskDatabase(file);
    }
    const shared = createManagedLaneOwnership(db, {
      ordinaryInstallations: [ordinaryInstallation],
      signedRun,
      savedOwnerDigest: delegationOwnerDigest(principal),
      separateSignedRuntime: false,
    });
    expect(shared.ordinaryRuntime(signedInstallation)).toBe(true);
    expect(shared.ordinaryRuntime(savedInstallation)).toBe(false);
    expect(() =>
      createManagedLaneOwnership(db, {
        ordinaryInstallations: [ordinaryInstallation],
        signedRun: savedRun,
        savedOwnerDigest: delegationOwnerDigest(principal),
        separateSignedRuntime: true,
      }),
    ).toThrow('ownership-overlap');
    insertWorker('unknown-worker', 'native.unknown');
    expect(() => shared.assertRecovery()).toThrow('unrelated-managed-work-retained');
  } finally {
    db.close();
    fixture.close();
    rmSync(root, { force: true, recursive: true });
  }
}, 20_000);
