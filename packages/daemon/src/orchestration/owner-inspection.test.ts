import { readFile, rm, writeFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { offlineController } from '../test-utils/offline-controller.js';
import { operatorSeedFixture } from '../test-utils/operator-seed-fixture.js';
import {
  composeOperatorEnrollment,
  operatorBasePolicy,
  parseOperatorEnrollment,
} from './operator-enrollment.js';
import { registerOperatorRuns } from './operator-runs.js';

it('commissions a confined v2 inspection only through the bound owner and preserves its single kickoff across restart', async () => {
  const {
    enrollment: signed,
    f,
    operator,
    cli,
    profiles,
    run,
  } = await operatorSeedFixture(
    'registry.example/worker@sha256:' + 'c'.repeat(64),
    true,
    'sandbox',
  );
  const { checks, review, authorities, ...draft } = signed;
  const main = {
    profileName: 'repofit',
    profileId: 'profile-f3ec3b28e6369a8879e2a1da',
    profileRevision: 2,
    aiId: 'ai-2aa5da9e201c0adf52150c71',
    aiRevision: 8,
    accountId: 'anth-pro',
    model: 'claude-sonnet-5-5',
  };
  const raw = {
    ...draft,
    version: 2,
    main,
    expectedRun: run,
    expectedBasePolicy: operatorBasePolicy({ ...draft, main }, profiles, true),
  };
  const e = parseOperatorEnrollment(JSON.stringify(raw));
  if (e?.version !== 2) throw new Error('expected owner task');
  for (const invalid of [
    { ...raw, expectedRun: undefined },
    { ...raw, expectedBasePolicy: undefined },
    { ...raw, checks, review, authorities },
    { ...raw, version: 1 },
    { ...raw, slot: 'accept' },
  ])
    expect(() => parseOperatorEnrollment(JSON.stringify(invalid))).toThrow(
      'invalid-operator-enrollment',
    );
  const offline = offlineController(() => JSON.stringify({ children: [], waitFor: null }));
  const preflight = vi.fn(async () => {}),
    resume = vi.fn(async () => {});
  const deps = {
    db: f.db,
    databasePath: f.db.name,
    profiles,
    cli,
    isolatedArtifacts: true,
    bind: () => offline.provider,
    runtime: {
      config: { db: f.db },
      resume,
      withCheckpoint: async (
        _cp: unknown,
        _mirror: string,
        use: (s: unknown) => Promise<unknown>,
      ) => use({ preflight, db: f.db }),
    } as unknown as NonNullable<Parameters<typeof composeOperatorEnrollment>[1]['runtime']>,
  };
  expect(() => composeOperatorEnrollment(e, { ...deps, isolatedArtifacts: false })).toThrow();
  expect(() =>
    composeOperatorEnrollment({ ...e, budget: { ...e.budget, requests: 19 } }, deps),
  ).toThrow('inspection-run-scope');
  expect(() =>
    composeOperatorEnrollment(e, {
      ...deps,
      profiles: { ...profiles, image: profiles.image.replace(/.$/, 'd') },
    }),
  ).toThrow('inspection-preflight-binding-mismatch');
  expect(() =>
    composeOperatorEnrollment(e, {
      ...deps,
      cli: { ...cli, bindings: [{ ...operator, audience: 'another-api' }] },
    }),
  ).toThrow('inspection-preflight-binding-mismatch');
  const build = () => {
    const config = composeOperatorEnrollment(e, deps);
    const app = Fastify();
    const scheduler = registerOperatorRuns(app, config, {
      validateToken: async (token) => ({
        iss: operator.issuer,
        aud: operator.audience,
        oid: token,
        exp: Date.now() / 1000 + 60,
        iat: 0,
        roles: [],
        name: 'test',
        preferred_username: 'test',
      }),
    });
    const call = (op: string, actor = operator.objectId, payload?: Record<string, unknown>) =>
      app.inject({
        method: op === 'status' ? 'GET' : 'POST',
        url: '/orchestration/runs/inspection/' + op,
        headers: { authorization: 'Bearer ' + actor },
        ...(payload ? { payload } : {}),
      });
    return { app, scheduler, call };
  };
  const bytes = await readFile(e.source.bundlePath);
  await writeFile(e.source.bundlePath, 'changed');
  await expect(composeOperatorEnrollment(e, deps).prepare!()).rejects.toThrow('seed-damaged');
  expect(resume).not.toHaveBeenCalled();
  await writeFile(e.source.bundlePath, bytes);
  let a = build();
  try {
    expect((await a.call('status')).json()).toMatchObject({
      started: false,
      remainingRequests: 18,
      children: [],
    });
    const manifest = f.db
      .prepare('select manifest from orchestration_checkpoint_custody where run_id=?')
      .pluck()
      .get(run) as string;
    expect(JSON.parse(manifest).origin).toBe('owner-inspection/v2');
    expect(JSON.parse(manifest)).not.toHaveProperty('verification');
    expect((await a.call('start', 'other')).statusCode).toBe(401);
    expect((await a.call('start', operator.objectId, { budget: 99 })).statusCode).toBe(400);
    expect(offline.calls()).toBe(0);
    expect(
      (await Promise.all([a.call('start'), a.call('start')])).map((v) => v.statusCode),
    ).toEqual([202, 202]);
    await a.scheduler.settled(run);
    expect(preflight).toHaveBeenCalledTimes(1);
    expect((await a.call('status')).json()).toMatchObject({ started: true, remainingRequests: 17 });
    expect(offline.calls()).toBe(1);
    await a.app.close();
    await rm(e.source.bundlePath);
    await expect(
      composeOperatorEnrollment(
        {
          ...e,
          mission: e.mission + ' changed',
          expectedBasePolicy: operatorBasePolicy(
            { ...e, mission: e.mission + ' changed' },
            profiles,
            true,
          ),
        },
        deps,
      ).prepare!(),
    ).rejects.toThrow('enrollment-changed');
    a = build();
    await a.app.ready();
    await a.scheduler.settled(run);
    expect((await a.call('status')).json()).toMatchObject({ started: true, remainingRequests: 17 });
    expect(offline.calls()).toBe(1);
  } finally {
    await a.app.close();
  }
});
