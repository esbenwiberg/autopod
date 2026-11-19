import { symlink } from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { buildStartupHarness } from '../test-utils/build-startup-harness.js';
import { offlineController } from '../test-utils/offline-controller.js';
import { setupOrchestrationRun } from '../test-utils/orchestration-run-fixture.js';
import { startFixtureProcess } from '../test-utils/owned-fixture-process.js';
import { claimDaemonLifetime } from './local-recovery-claim.js';
import { operatorRunId, registerOperatorRuns } from './operator-runs.js';

const operator = {
  issuer: 'https://issuer.example/',
  audience: 'api://autopod',
  objectId: 'alice',
  installationId: 'team',
};
const bob = { ...operator, objectId: 'bob' };
const auth = {
  validateToken: async (token: string) => ({
    iss: operator.issuer,
    aud: operator.audience,
    oid: token,
    exp: Date.now() / 1000 + 30,
    iat: 0,
    roles: [],
    name: 'operator',
    preferred_username: 'operator',
  }),
};
async function fixture(uncertain = false) {
  const slot = 'inspect',
    run = operatorRunId(operator, slot);
  const { f, cp, request, host, ledger } = await setupOrchestrationRun(6, 2, run);
  const { provider, calls } = offlineController(() => {
    if (uncertain) throw new Error('lost reply');
    return JSON.stringify({
      children: [{ recipe: 'inspect', brief: 'Read synthetic input' }],
      waitFor: 1,
    });
  });
  const base = {
    slot,
    operator,
    checkpoint: cp,
    policy: { mission: 'Synthetic run', routeId: 'offline', recipes: { inspect: '@inspect' } },
    provider,
    catalog: { inspect: request },
  };
  const other = operatorRunId(bob, 'other');
  ledger().open(other, cp.repository, cp.policyDigest, cp.predecessor, 6, 2);
  const build = () => {
    const app = Fastify();
    const scheduler = registerOperatorRuns(
      app,
      {
        db: f.db,
        host: host(),
        slots: [base, { ...base, operator: bob, slot: 'other', checkpoint: { ...cp, run: other } }],
      },
      auth,
    );
    const call = (op: string, token = 'alice', payload?: Record<string, unknown>, name = slot) =>
      app.inject({
        method: op === 'status' ? 'GET' : 'POST',
        url: `/orchestration/runs/${name}/${op}`,
        headers: { authorization: `Bearer ${token}` },
        ...(payload ? { payload } : {}),
      });
    return { app, scheduler, call };
  };
  return { build, run, f, calls };
}
it('binds operator and source to the configured slot; startup restores only a previously started run', async () => {
  const { build, run, f, calls } = await fixture();
  let api = build();
  try {
    expect((await api.call('status')).json()).toMatchObject({
      started: false,
      children: [],
      remainingRequests: 6,
    });
    expect(calls()).toBe(0);
    expect((await api.call('start', 'stranger')).statusCode).toBe(401);
    for (const op of ['start', 'status', 'cancel', 'fence'])
      expect((await api.call(op, 'bob')).statusCode).toBe(404);
    expect((await api.call('start', 'alice', { budget: 60 })).statusCode).toBe(400);
    const results = await Promise.all([api.call('start'), api.call('start')]);
    expect(results.map((r) => r.statusCode)).toEqual([202, 202]);
    await api.scheduler.settled(run);
    const before = (await api.call('status')).json();
    expect(before).toMatchObject({ started: true, remainingRequests: 3 });
    expect(before.children).toHaveLength(1);
    expect(JSON.stringify(before)).not.toMatch(/grant|fixture-key|request_json/);
    expect((await api.call('status', 'bob', undefined, 'other')).json()).toMatchObject({
      started: false,
      remainingRequests: 6,
    });
    await api.app.close();
    f.restart();
    api = build();
    await api.app.ready();
    await api.scheduler.settled(run);
    expect((await api.call('status')).json()).toEqual(before);
    expect(calls()).toBe(1);
    expect((await api.call('cancel')).json()).toEqual({ run, stopRequested: true });
    expect((await api.call('start')).statusCode).toBe(409);
    expect((await api.call('status')).json().children[0].observedExit).toBe(0);
    await f.service().enforceExpiry();
    await f.service().enforceExpiry();
    expect((await api.call('status')).json().children[0]).toMatchObject({
      state: 'killed',
      observedExit: 1,
    });
  } finally {
    await api.app.close();
  }
});
it('refuses startup under another local process, including through a DB alias; SIGKILL releases the owner without starting idle slots', async () => {
  const { build, f, calls } = await fixture();
  const alias = path.join(path.dirname(f.db.name), 'operator-db-alias');
  await symlink(f.db.name, alias);
  const peer = startFixtureProcess(
    await buildStartupHarness('operator-owner-fixture'),
    [alias],
    path.dirname(f.db.name),
  );
  try {
    await peer.message;
    const refused = build();
    try {
      await expect(refused.app.ready()).rejects.toThrow('operator-daemon-owner-active');
    } finally {
      await refused.app.close();
    }
    expect(calls()).toBe(0);
    peer.child.kill('SIGKILL');
    expect(await peer.exit).toEqual({ code: null, signal: 'SIGKILL' });
    peer.assertHealthy();
    const successor = build();
    try {
      expect((await successor.call('status')).json()).toMatchObject({ started: false });
      expect(calls()).toBe(0);
      expect(() => claimDaemonLifetime(f.db)).toThrow('operator-daemon-owner-active');
    } finally {
      await successor.app.close();
    }
  } finally {
    await peer.dispose();
  }
});
it('fences only an observed unknown in the authenticated run, without a retry or refund', async () => {
  const { build, run, calls } = await fixture(true);
  const api = build();
  try {
    expect((await api.call('start')).statusCode).toBe(202);
    await expect(api.scheduler.settled(run)).rejects.toThrow();
    const data = (await api.call('status')).json();
    expect(data.unknown).toHaveLength(1);
    const { key, binding, kind } = data.unknown[0];
    const body = { key, binding, kind, caseRef: 'test-case' };
    expect((await api.call('fence', 'bob', body, 'other')).statusCode).toBe(409);
    expect((await api.call('fence', 'alice', { ...body, actor: 'impostor' })).statusCode).toBe(400);
    const receipt = (await api.call('fence', 'alice', body)).json();
    expect(receipt).toMatchObject({ run_id: run, case_ref: 'test-case', reserved_requests: 1 });
    expect((await api.call('fence', 'alice', body)).json()).toEqual(receipt);
    expect(calls()).toBe(1);
    expect((await api.call('status')).json()).toMatchObject({
      canceled: true,
      remainingRequests: 5,
    });
  } finally {
    await api.app.close();
  }
});
