import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { digest } from '../managed/canonical.js';
import { signalLocalRun } from '../managed/local-run-signals.js';
import { managedGit } from '../managed/source-git.js';
import { buildStartupHarness } from '../test-utils/build-startup-harness.js';
import { resign } from '../test-utils/managed-fixture.js';
import { offlineController } from '../test-utils/offline-controller.js';
import { setupOrchestrationRun as setup } from '../test-utils/orchestration-run-fixture.js';
import { waveProcessRuntime } from '../test-utils/wave-process-runtime.js';

// Real Git, SQLite and child-process restarts: wall-clock limits are deadlock guards,
// not latency assertions. Keep them bounded even on a busy local development machine.
vi.setConfig({ testTimeout: 15_000 });
it.each([
  'notification',
  'startup catch-up',
])('controller commissions six then two from %s without polling', async (mode) => {
  const { f, root, cp, request, host } = await setup(18, 6);
  const runtime = waveProcessRuntime(root);
  Object.assign(f.runtime, runtime.port);
  onTestFinished(async () => {
    await runtime.dispose();
  });
  request.outputs.artifacts.mode = 'required';
  request.outputs.artifacts.requiredPaths = ['report.md'];
  resign(request);
  const seed = () => host().ledger.kickoff(cp, { inspect: request });
  const child = (brief: string) => ({ recipe: 'inspect', brief });
  const { provider, calls } = offlineController((payload) => {
    const ctx = JSON.parse(JSON.parse(payload).messages[0].content);
    if (ctx.phase === 'kickoff') {
      expect(ctx.results).toEqual([]);
      expect(ctx.remainingRequests).toBe(17);
      return JSON.stringify({
        children: Array.from({ length: 6 }, (_, i) => child(`Investigate ${i}`)),
        waitFor: 3,
      });
    }
    expect(ctx.inFlight).toHaveLength(3);
    expect(ctx.availableSlots).toBe(3);
    expect(ctx.results).toHaveLength(3);
    expect(
      ctx.results.every((r: { finding: { text: string } }) =>
        r.finding.text.startsWith('Checks passed'),
      ),
    ).toBe(true);
    return JSON.stringify({
      children: ctx.results
        .slice(0, 2)
        .map((r: { child: string }) => child(`Verify finding from ${r.child}`)),
      waitFor: null,
    });
  });
  const attach = () =>
    host().watchController(
      cp.run,
      {
        mission: 'Verify the returned findings',
        routeId: 'offline',
        recipes: { inspect: '@inspect' },
        findings: 'report.md',
      },
      provider,
    );
  await seed();
  await seed();
  expect(runtime.count()).toBe(0);
  expect(f.db.prepare('SELECT remaining FROM orchestration_request_balances').pluck().get()).toBe(
    18,
  );
  let loop = attach();
  try {
    expect(() => attach()).toThrow('already-attached');
    expect(await loop.settled()).toEqual({ blocked: [] });
    const original = await runtime.live();
    expect(new Set(original.values()).size).toBe(6);
    const ids = [...original.keys()];
    const returns = async (id: string) => {
      await runtime.finish(id);
      const s = f.service();
      await s.enforceExpiry();
      await s.artifactPipeline?.tick();
    };
    for (const id of ids.slice(0, 2)) {
      await returns(id);
      await loop.settled();
      expect(calls()).toBe(1);
    }
    if (mode === 'startup catch-up') await loop.close();
    const third = ids[2];
    if (!third) throw new Error('missing third worker');
    await returns(third);
    if (mode === 'startup catch-up') {
      expect(calls()).toBe(1);
      f.restart();
      loop = attach();
    }
    // Settled is a barrier only; it does not signal a pass.
    expect(await loop.settled()).toEqual({ blocked: [] });
    const live = await runtime.live();
    expect(live.size).toBe(5);
    for (const id of ids.slice(3)) expect(live.get(id)).toBe(original.get(id));
    expect([...live.keys()].filter((id) => !original.has(id))).toHaveLength(2);
    for (let i = 0; i < 10; i++) signalLocalRun(f.db, 'native.example');
    await seed();
    expect(await loop.settled()).toEqual({ blocked: [] });
    expect(calls()).toBe(2);
    expect(runtime.count()).toBe(8);
    expect(f.db.prepare('SELECT remaining FROM orchestration_request_balances').pluck().get()).toBe(
      0,
    );
    expect(f.db.prepare('SELECT accepted_commit FROM orchestration_runs').pluck().get()).toBe(
      cp.commit,
    );
    expect(
      f.db
        .prepare('SELECT count(*) FROM orchestration_result_waits WHERE acknowledged=0')
        .pluck()
        .get(),
    ).toBe(0);
  } finally {
    await loop.close();
  }
}, 30_000);

it('rejects changed kickoff replay and damaged recipe custody without a model or worker charge', async () => {
  const { f, cp, request, host } = await setup(6, 2);
  await host().ledger.kickoff(cp, { inspect: request });
  await expect(host().ledger.kickoff(cp, { changed: request })).rejects.toThrow('kickoff-conflict');
  f.db.prepare("UPDATE orchestration_kickoffs SET recipes_json='{}'").run();
  f.restart();
  const { provider, calls } = offlineController(() => {
    throw new Error('should not call provider');
  });
  const loop = host().watchController(
    cp.run,
    { mission: 'Check', routeId: 'offline', recipes: { inspect: '@inspect' } },
    provider,
  );
  try {
    await expect(loop.settled()).rejects.toThrow('controller-catalog-integrity');
  } finally {
    await loop.close();
  }
  expect(calls()).toBe(0);
  expect(f.launches()).toBe(0);
  expect(f.db.prepare('SELECT remaining FROM orchestration_request_balances').pluck().get()).toBe(
    6,
  );
});

it('six start, three return, two follow-ups start without waiting for the other three', async () => {
  const { f, cp, request, ledger, host } = await setup(16, 6);
  const child = (n: number, objective: string) => {
    const r = structuredClone(request);
    r.startKey = `child-${n}`;
    r.dispatcherAttemptId = r.effectiveGrant.dispatcherAttemptId = r.startKey;
    r.task.objective = objective;
    return resign(r);
  };
  let l = ledger();
  await l.acceptAndContinue(cp, child(1, 'investigate'));
  for (let i = 2; i <= 6; i++)
    expect(await l.spawnFromAccepted(cp, child(i, 'investigate'))).toBe(`child-${i}`);
  expect(await l.recover()).toEqual({ blocked: [] });
  expect(f.launches()).toBe(6);
  expect(l.waves.available(cp.run)).toBe(0);
  const pod = (i: number) => {
    const row = f.service().lookup('native.example', `child-${i}`);
    if (!row) throw new Error('missing worker');
    return row.pod_id;
  };
  const live = [pod(2), pod(4), pod(6)];
  l.waves.park(cp.run, 'first-three', 0, 3);
  for (const i of [1, 3]) await f.runtime.stop(pod(i));
  const tick = async () => {
    const s = f.service();
    await s.enforceExpiry();
    await s.artifactPipeline?.tick();
  };
  await tick();
  let calls = 0;
  await l.waves.dispatch(cp.run, async () => {
    calls++;
  });
  expect(calls).toBe(0);
  await f.runtime.stop(pod(5));
  await f.service().enforceExpiry();
  // Exit alone is not a result. Wait for the third child's retained output state.
  await l.waves.dispatch(cp.run, async () => {
    calls++;
  });
  expect(calls).toBe(0);
  await tick();
  f.restart();
  l = ledger();
  let cursor = 0;
  const turn = async (wake: import('./run-waves.js').ResultWake) => {
    await ledger().waves.dispatch(cp.run, async () => {
      throw new Error('concurrent controller turn');
    });
    expect(wake.results.map((c) => c.start_key)).toEqual(['child-1', 'child-3', 'child-5']);
    expect(wake.results.every((c) => c.state === 'complete')).toBe(true);
    expect(wake.inFlight).toEqual(['child-2', 'child-4', 'child-6']);
    expect(wake.available).toBe(3);
    for (const n of [7, 8])
      await l.spawnFromAccepted(
        cp,
        child(n, `Follow up on ${wake.results.map((c) => c.pod_id).join(',')}`),
      );
    cursor = wake.cursor;
    calls++;
  };
  await expect(
    l.waves.dispatch(cp.run, async (wake) => {
      await turn(wake);
      throw new Error('lost turn acknowledgement');
    }),
  ).rejects.toThrow('lost turn acknowledgement');
  f.restart();
  l = ledger();
  expect(await host().tick(cp.run, turn)).toEqual({ blocked: [] });
  expect(calls).toBe(2);
  await l.waves.dispatch(cp.run, async () => {
    throw new Error('acknowledged wait redelivered');
  });
  expect(await l.recover()).toEqual({ blocked: [] });
  expect(f.launches()).toBe(8);
  expect(l.waves.available(cp.run)).toBe(1);
  for (const id of [...live, pod(7), pod(8)])
    expect((await f.runtime.observe(id)).state).toBe('running');
  expect(
    f.db
      .prepare('SELECT count(*),sum(reserved_requests) FROM orchestration_continuations')
      .raw()
      .get(),
  ).toEqual([8, 16]);
  expect(f.db.prepare('SELECT accepted_commit FROM orchestration_runs').pluck().get()).toBe(
    cp.commit,
  );
  await expect(l.spawnFromAccepted(cp, child(9, 'unaffordable'))).rejects.toThrow(
    'budget-exhausted',
  );
  await f.runtime.stop(pod(2));
  await tick();
  l.waves.park(cp.run, 'after-restart', cursor, 1);
  let returned: string[] = [];
  await l.waves.dispatch(cp.run, async (w) => {
    returned = w.results.map((c) => c.start_key);
  });
  expect(returned).toEqual(['child-2']);
  l.open('other', cp.repository, cp.policyDigest, cp.commit, 16, 6);
  expect(() => l.waves.park('other', 'foreign-cursor', cursor, 1)).toThrow('invalid-result-cursor');
}, 30_000);

it('queues an affordable child until its run has a free worker slot', async () => {
  const { f, cp, request, ledger } = await setup(4, 1);
  const l = ledger();
  await l.acceptAndContinue(cp, request);
  const next = structuredClone(request);
  next.startKey = next.dispatcherAttemptId = next.effectiveGrant.dispatcherAttemptId = 'second';
  resign(next);
  await l.spawnFromAccepted(cp, next);
  expect(await l.recover()).toEqual({
    blocked: [{ run: cp.run, key: 'second', stage: 'capacity' }],
  });
  expect(f.launches()).toBe(1);
  const first = f.service().lookup('native.example', request.startKey);
  if (!first) throw new Error('missing first');
  // Revoked is an outcome, not a request to retry the first child.
  await f.service().runtime.stop(first.pod_id);
  f.db.prepare('UPDATE managed_pods SET revoked=1 WHERE pod_id=?').run(first.pod_id);
  await f.service().enforceExpiry();
  l.waves.park(cp.run, 'return-on-failure', 0, 1);
  let failed: string[] = [];
  await l.waves.dispatch(cp.run, async (w) => {
    failed = w.results.map((c) => c.state);
  });
  expect(failed).toEqual(['killed']);
  expect(await l.recover()).toEqual({ blocked: [] });
  expect(f.launches()).toBe(2);
});

it('serves a paid queued worker even if the later controller reply is permanently lost', async () => {
  const { f, cp, request, host } = await setup(6, 1);
  const owner = host();
  await owner.ledger.kickoff(cp, { inspect: request });
  const { provider, calls } = offlineController((payload) => {
    if (JSON.parse(JSON.parse(payload).messages[0].content).phase !== 'kickoff')
      throw new Error('lost');
    return JSON.stringify({
      children: ['one', 'two'].map((brief) => ({ recipe: 'inspect', brief })),
      waitFor: 1,
    });
  });
  const config = { mission: 'check', routeId: 'offline', recipes: { inspect: '@inspect' } };
  await owner.tickController(cp.run, config, provider);
  expect(f.launches()).toBe(1);
  const id = String(f.db.prepare('SELECT pod_id FROM managed_pods').pluck().get());
  await f.service().runtime.stop(id);
  f.db.prepare('UPDATE managed_pods SET revoked=1 WHERE pod_id=?').run(id);
  await f.service().enforceExpiry();
  await expect(owner.tickController(cp.run, config, provider)).rejects.toThrow();
  expect(f.launches()).toBe(2);
  f.restart();
  await expect(host().tickController(cp.run, config, provider)).rejects.toThrow(
    'controller-request-uncertain',
  );
  expect(calls()).toBe(2);
  expect(f.launches()).toBe(2);
});
async function controllerFixture(limit: number, reply: (payload: string) => string) {
  const { f, request, cp, host, ledger } = await setup(limit, 6);
  const l = ledger();
  await l.acceptAndContinue(cp, request);
  expect(await l.recover()).toEqual({ blocked: [] });
  const first = f.service().lookup('native.example', request.startKey);
  if (!first) throw new Error('missing first worker');
  await f.runtime.stop(first.pod_id);
  await f.service().enforceExpiry();
  await f.service().artifactPipeline?.tick();
  l.waves.park(cp.run, 'plan-next', 0, 1);
  const { provider, calls } = offlineController(reply);
  const tick = () =>
    host().tickController(
      cp.run,
      {
        mission: 'Check the completed work',
        routeId: 'local-test',
        recipes: { inspect: request.startKey },
      },
      provider,
    );
  return { f, request, cp, host, tick, calls, provider };
}
it('a rolled-back partial wave does not wake its own controller watcher', async () => {
  const { f, request, cp, host, provider, calls } = await controllerFixture(6, () =>
    JSON.stringify({
      children: [
        { recipe: 'inspect', brief: 'one' },
        { recipe: 'inspect', brief: 'two' },
      ],
      waitFor: null,
    }),
  );
  const owner = host();
  const pass = owner.tickController.bind(owner);
  let passes = 0;
  vi.spyOn(owner, 'tickController').mockImplementation((...args) => {
    if (++passes > 1) throw new Error('unexpected second pass');
    return pass(...args);
  });
  const loop = owner.watchController(
    cp.run,
    {
      mission: 'Check the completed work',
      routeId: 'local-test',
      recipes: { inspect: request.startKey },
    },
    provider,
  );
  try {
    await expect(loop.settled()).rejects.toThrow('continuation-budget-exhausted');
    expect(passes).toBe(1);
    expect(calls()).toBe(1);
    expect(f.db.prepare('SELECT count(*) FROM orchestration_continuations').pluck().get()).toBe(1);
  } finally {
    await loop.close();
  }
});
it.skipIf(process.platform === 'win32').each(['mid-wave', 'before-ack'])(
  'recovers a SIGKILLed scheduler while three original worker PIDs stay live: %s',
  async (boundary) => {
    const { f, root, request, cp, ledger, host } = await setup(17, 6);
    const processes = waveProcessRuntime(root);
    Object.assign(f.runtime, processes.port);
    onTestFinished(async () => {
      await processes.dispose();
    });
    const l = ledger();
    for (let i = 0; i < 6; i++) {
      const r = structuredClone(request);
      r.dispatcherAttemptId = r.effectiveGrant.dispatcherAttemptId = r.startKey = `worker-${i}`;
      r.outputs.artifacts.mode = 'required';
      r.outputs.artifacts.requiredPaths = ['report.md'];
      if (i === 0) await l.acceptAndContinue(cp, resign(r));
      else await l.spawnFromAccepted(cp, resign(r));
    }
    expect(await l.recover()).toEqual({ blocked: [] });
    l.waves.park(cp.run, 'read-three', 0, 3);
    const firstWave = await processes.live();
    expect(new Set(firstWave.values()).size).toBe(6);
    const returned: string[] = [];
    for (const i of [0, 1, 2]) {
      const id = f.service().lookup('native.example', `worker-${i}`)?.pod_id;
      if (!id) throw new Error('missing worker');
      await processes.finish(id); // Worker writes its own report, then exits normally.
      returned.push(id);
      await f.service().enforceExpiry();
      await f.service().artifactPipeline?.tick();
      if (returned.length < 3)
        await l.waves.dispatch(cp.run, async () => {
          throw new Error('woke too soon');
        });
    }
    expect(
      f.db.prepare("SELECT count(*) FROM artifact_exports WHERE status='committed'").pluck().get(),
    ).toBe(3);
    const { provider, calls } = offlineController(() => {
      throw new Error('owner must not plan');
    });
    const tick = () =>
      host().tickController(
        cp.run,
        {
          findings: 'report.md',
          mission: 'Investigate reported issues',
          routeId: 'offline',
          recipes: { inspect: 'worker-0' },
        },
        provider,
      );
    const [pod] = returned;
    if (!pod) throw new Error('missing returned worker');
    const bundle = f.db
      .prepare('SELECT bundle_bytes FROM artifact_exports WHERE pod_id=?')
      .pluck()
      .get(pod) as Buffer;
    const replace = (bytes: Buffer) =>
      f.db.prepare('UPDATE artifact_exports SET bundle_bytes=? WHERE pod_id=?').run(bytes, pod);
    replace(Buffer.from('damaged'));
    await expect(tick()).rejects.toThrow('artifact-integrity-failure');
    expect(calls()).toBe(0);
    expect(f.db.prepare('SELECT remaining FROM orchestration_request_balances').pluck().get()).toBe(
      5,
    );
    replace(bundle);
    // The result cursor is not an artifact capability: swapping in a sibling's real
    // export must not disclose that sibling's bytes, even in the same installation.
    const [original, sibling] = f.db
      .prepare('SELECT artifact_id FROM orchestration_child_outcomes ORDER BY sequence')
      .pluck()
      .all() as string[];
    if (!original || !sibling) throw new Error('missing artifact fixture');
    const swap = (id: string) =>
      f.db
        .prepare('UPDATE orchestration_child_outcomes SET artifact_id=? WHERE pod_id=?')
        .run(id, pod);
    swap(sibling);
    await expect(tick()).rejects.toThrow('controller-artifact-binding');
    expect(calls()).toBe(0);
    swap(original);
    const scheduler = await buildStartupHarness('wave-scheduler-fixture');
    await writeFile(path.join(root, 'profile.json'), JSON.stringify(request.profileSnapshot));
    const env = { HOME: root, TMPDIR: root, LANG: 'C' };
    const writer = spawnSync(process.execPath, [scheduler, f.db.name, root, boundary], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(writer.error).toBeUndefined();
    expect(writer.signal, writer.stderr).toBe('SIGKILL');
    f.restart();
    const waits = () =>
      f.db
        .prepare('SELECT acknowledged FROM orchestration_result_waits ORDER BY rowid')
        .pluck()
        .all();
    const waveCommitted = boundary === 'before-ack';
    expect(waits()).toEqual(waveCommitted ? [0, 0] : [0]);
    expect(f.db.prepare('SELECT remaining FROM orchestration_request_balances').pluck().get()).toBe(
      waveCommitted ? 0 : 4,
    );
    expect(f.db.prepare('SELECT status FROM orchestration_controller_turns').pluck().all()).toEqual(
      ['decided'],
    );
    expect(
      f.db
        .prepare('SELECT count(*) FROM orchestration_continuations WHERE pod_id IS NULL')
        .pluck()
        .get(),
    ).toBe(waveCommitted ? 2 : 0);
    expect(await processes.live()).toEqual(
      new Map([...firstWave].filter(([id]) => !returned.includes(id))),
    );
    replace(Buffer.from('damaged after decision'));

    // Only the worker owner survives. A new scheduler reads its decisions and launch
    // specs from SQLite. Its IPC channel can ask the owner to start only an admitted ID.
    const reader = fork(scheduler, [f.db.name, root, 'recover'], {
      cwd: root,
      env,
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      timeout: 15_000,
      killSignal: 'SIGKILL',
    });
    const closed = once(reader, 'close');
    let diagnostic = '';
    reader.stderr?.on('data', (chunk) => {
      diagnostic = (diagnostic + chunk).slice(-4096);
    });
    try {
      expect(reader.pid).not.toBe(writer.pid);
      for (let i = 0; i < 2; i++) {
        const [id] = await Promise.race([
          once(reader, 'message'),
          closed.then(() => {
            throw new Error('scheduler closed before launch: ' + diagnostic);
          }),
        ]);
        if (typeof id !== 'string') throw new Error('invalid fixture allocation');
        const row = f.service().row('native.example', id);
        const spec = JSON.parse(row.request_json);
        expect(spec.startKey).toMatch(/^turn-/);
        await processes.port.ensure(id, spec, () => {});
        reader.send(id);
      }
      expect(await closed, diagnostic).toEqual([0, null]);
    } finally {
      if (reader.exitCode === null && reader.signalCode === null) reader.kill('SIGKILL');
      await closed;
    }
    expect(waits()).toEqual([1, 0]);
    const requests = (await readFile(path.join(root, 'provider-calls.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    expect(requests).toHaveLength(1);
    const call = JSON.parse(requests[0] ?? '');
    expect(call.pid).toBe(writer.pid);
    expect(call.payload).not.toMatch(/sibling contents|hidden-tail|�/);
    const ctx = JSON.parse(JSON.parse(call.payload).messages[0].content);
    expect(ctx.inFlightCount).toBe(3);
    expect(ctx.results).toHaveLength(3);
    for (const r of ctx.results) {
      expect(r.finding.status).toBe('excerpt');
      expect(r.finding.truncated).toBe(true);
      expect(Buffer.byteLength(r.finding.text)).toBeLessThanOrEqual(2048);
    }
    expect(processes.count()).toBe(8);
    const active = await processes.live();
    expect(new Set(active.values()).size).toBe(5);
    for (const [id, pid] of firstWave)
      expect(active.get(id)).toBe(returned.includes(id) ? undefined : pid);
    expect([...active.keys()].filter((id) => !firstWave.has(id))).toHaveLength(2);
    expect(ledger().waves.available(cp.run)).toBe(1);
    expect(
      f.db
        .prepare(
          "SELECT json_extract(request_json,'$.task.objective') FROM orchestration_continuations WHERE start_key LIKE 'turn-%' ORDER BY rowid",
        )
        .pluck()
        .all(),
    ).toEqual(
      ['CLI retries', 'cache expiry'].map(
        (issue) => `${request.task.objective}\n\nFollow-up task:\nInvestigate ${issue}`,
      ),
    );
    expect(f.db.prepare('SELECT accepted_commit FROM orchestration_runs').pluck().get()).toBe(
      cp.commit,
    );
    f.restart();
    expect(await tick()).toEqual({ blocked: [] });
    expect(await processes.live()).toEqual(active);
    expect(processes.count()).toBe(8);
    expect(calls()).toBe(0);

    // Cancel fences new work immediately, but does not fabricate exit evidence.
    ledger().cancel(cp.run);
    expect(await processes.live()).toEqual(active);
    const unseen = () =>
      f.db.prepare('SELECT count(*) FROM managed_pods WHERE observed_exit=0').pluck().get();
    await f.service().enforceExpiry();
    expect((await processes.live()).size).toBe(0);
    expect(unseen()).toBe(5);
    await f.service().enforceExpiry();
    expect(unseen()).toBe(0);
    expect(
      f.db.prepare("SELECT count(*) FROM managed_pods WHERE state='killed'").pluck().get(),
    ).toBe(5);
    expect(f.db.prepare('SELECT remaining FROM orchestration_request_balances').pluck().get()).toBe(
      0,
    );
  },
  30_000,
);

it('replays a recorded controller decision without a second SDK request or duplicate workers', async () => {
  const { f, tick, calls, request } = await controllerFixture(7, (payload) => {
    expect(payload).not.toContain('effectiveGrant');
    expect(payload).not.toContain('profileSnapshot');
    expect(JSON.parse(payload)).not.toHaveProperty('tools');
    expect(payload).toContain('complete');
    return JSON.stringify({
      children: [
        { recipe: 'inspect', brief: 'Check CLI' },
        { recipe: 'inspect', brief: 'Check daemon' },
      ],
      waitFor: 1,
    });
  });
  f.db.exec(
    `CREATE TEMP TRIGGER lose_ack BEFORE UPDATE OF acknowledged ON orchestration_result_waits BEGIN SELECT RAISE(ABORT,'lost-ack'); END`,
  );
  await expect(tick()).rejects.toThrow('lost-ack');
  expect(calls()).toBe(1);
  // TEMP trigger is lost on reopen; intents, controller receipt and next wait survive.
  f.restart();
  expect(await tick()).toEqual({ blocked: [] });
  expect(calls()).toBe(1);
  expect(f.launches()).toBe(3);
  const rows = f.db
    .prepare(
      'SELECT request_json FROM orchestration_continuations WHERE start_key!=? ORDER BY rowid',
    )
    .pluck()
    .all(request.startKey) as string[];
  expect(rows.map((r) => JSON.parse(r).task.objective)).toEqual(
    ['Check CLI', 'Check daemon'].map(
      (brief) => request.task.objective + '\n\nFollow-up task:\n' + brief,
    ),
  );
  for (const raw of rows) {
    const worker = JSON.parse(raw);
    expect(worker.effectiveGrant.scope).toEqual(request.effectiveGrant.scope);
    expect(worker.route).toEqual(request.route);
    expect(worker.startKey).toMatch(/^turn-/);
  }
  expect(f.db.prepare('SELECT remaining FROM orchestration_request_balances').pluck().get()).toBe(
    0,
  );
  expect(
    f.db
      .prepare('SELECT status,input_tokens,output_tokens FROM orchestration_controller_turns')
      .raw()
      .all(),
  ).toEqual([['decided', 37, 19]]);
  expect(
    f.db
      .prepare('SELECT acknowledged FROM orchestration_result_waits ORDER BY rowid')
      .pluck()
      .all(),
  ).toEqual([1, 0]);
});
it.each([
  'unknown recipe',
  'raw grant',
  'uncertain call',
  'over budget',
])('blocks %s without partially admitting a wave or recalling the model', async (mode) => {
  const { f, tick, calls } = await controllerFixture(6, () => {
    if (mode === 'uncertain call') throw new Error('transport unavailable');
    return JSON.stringify({
      children: [
        { recipe: 'inspect', brief: 'one' },
        {
          recipe: mode === 'unknown recipe' ? 'admin' : 'inspect',
          brief: 'two',
          ...(mode === 'raw grant' ? { effectiveGrant: {} } : {}),
        },
      ],
      waitFor: null,
    });
  });
  await expect(tick()).rejects.toThrow();
  f.restart();
  const error =
    mode === 'uncertain call'
      ? 'controller-request-uncertain'
      : mode === 'over budget'
        ? 'budget-exhausted'
        : 'controller-decision-invalid';
  await expect(tick()).rejects.toThrow(error);
  expect(calls()).toBe(1);
  expect(f.launches()).toBe(1);
  expect(f.db.prepare('SELECT count(*) FROM orchestration_continuations').pluck().get()).toBe(1);
  expect(f.db.prepare('SELECT remaining FROM orchestration_request_balances').pluck().get()).toBe(
    3,
  );
});

it.skipIf(process.platform === 'win32').each(['accepted', 'allocated', 'lost-handle', 'cancel'])(
  'recovers the committed continuation across SIGKILL: %s',
  async (mode) => {
    const { f, root, cp, request, ledger } = await setup();
    const bundle = await buildStartupHarness();
    const payload = path.join(root, 'request.json');
    await writeFile(payload, JSON.stringify({ cp, request }));
    const writer = spawnSync(process.execPath, [bundle, f.db.name, payload, mode], {
      encoding: 'utf8',
      timeout: 12_000,
    });
    expect(writer.error).toBeUndefined();
    expect(writer.signal, writer.stderr).toBe('SIGKILL');
    f.restart();
    expect(f.db.prepare('SELECT accepted_commit FROM orchestration_runs').pluck().get()).toBe(
      cp.commit,
    );
    const old = f.db.prepare('SELECT pod_id FROM managed_pods').pluck().get();
    if (mode === 'allocated' || mode === 'lost-handle') expect(old).toEqual(expect.any(String));
    else expect(old).toBeUndefined();
    const l = ledger();
    if (mode === 'cancel') l.cancel(cp.run);
    await l.acceptAndContinue(cp, request); // same receipt, even after cancellation
    // A fresh local host gets the reviewed profile only; its worker spec and source must
    // come from SQLite. Remove even orphan scratch mirrors left by the killed process.
    await rm(path.join(root, 'scratch'), { recursive: true, force: true });
    await writeFile(
      payload,
      JSON.stringify({ request: { profileSnapshot: request.profileSnapshot } }),
    );
    const reader = spawnSync(process.execPath, [bundle, f.db.name, payload, 'startup'], {
      encoding: 'utf8',
      timeout: 12_000,
    });
    expect(reader.error).toBeUndefined();
    expect(reader.status, reader.stderr).toBe(0);
    expect(JSON.parse(reader.stdout)).toEqual({ blocked: [] });
    expect(await l.recover()).toEqual({ blocked: [] });
    expect(
      f.db
        .prepare('SELECT count(*),sum(reserved_requests) FROM orchestration_continuations')
        .raw()
        .get(),
    ).toEqual([1, 2]);
    // No additional launch in the final in-process pass. In lost-handle mode a second
    // launch in the reader would also fail because C's existing clone is nonempty.
    expect(f.launches()).toBe(0);
    if (mode === 'cancel')
      expect(f.db.prepare('SELECT count(*) FROM managed_pods').pluck().get()).toBe(0);
    else {
      const pod = f.db.prepare('SELECT pod_id FROM orchestration_continuations').pluck().get();
      expect(pod).toEqual(old ?? expect.any(String));
      expect(await managedGit(path.join(root, String(pod)), ['rev-parse', 'HEAD'])).toBe(cp.commit);
      expect(await readFile(path.join(root, String(pod), 'proof.txt'), 'utf8')).toBe(
        'unpublished checkpoint\n',
      );
      expect(f.db.prepare('SELECT pod_id FROM managed_pods').pluck().all()).toEqual([pod]);
    }
  },
);

it.each([
  'bundle',
  'manifest',
  'missing',
])('keeps the accepted checkpoint and reservation when %s custody is damaged', async (damage) => {
  const { f, cp, request, ledger } = await setup();
  await ledger().acceptAndContinue(cp, request);
  const saved = f.db.prepare('SELECT * FROM orchestration_checkpoint_custody').get() as {
    run_id: string;
    evidence_digest: string;
    manifest: string;
    bundle: Buffer;
  };
  if (damage === 'missing') f.db.exec('DELETE FROM orchestration_checkpoint_custody');
  else if (damage === 'manifest')
    f.db.exec(`UPDATE orchestration_checkpoint_custody SET manifest='{}'`);
  else
    f.db
      .prepare('UPDATE orchestration_checkpoint_custody SET bundle=?')
      .run(Buffer.from('damaged'));
  f.restart();
  expect(await ledger().recover()).toEqual({
    blocked: [{ run: cp.run, key: request.startKey, stage: 'source' }],
  });
  expect(f.launches()).toBe(0);
  expect(f.db.prepare('SELECT accepted_commit FROM orchestration_runs').pluck().get()).toBe(
    cp.commit,
  );
  expect(
    f.db
      .prepare('SELECT count(*),sum(reserved_requests) FROM orchestration_continuations')
      .raw()
      .get(),
  ).toEqual([1, 2]);
  // Restoring the same bytes and host record permits replay, not a substituted source.
  f.db
    .prepare(
      'INSERT OR REPLACE INTO orchestration_checkpoint_custody VALUES (@run_id,@evidence_digest,@manifest,@bundle)',
    )
    .run(saved);
  expect(await ledger().recover()).toEqual({ blocked: [] });
  expect(f.launches()).toBe(1);
});

it('rejects the wrong source, scope or review before accepting anything', async () => {
  const { f, cp, subject, bytes, host, verify, request, ledger } = await setup();
  await expect(host().retain({ ...subject, tree: subject.commit }, bytes, verify)).rejects.toThrow(
    'source-mismatch',
  );
  await expect(host().retain({ ...subject, repository: 'other' }, bytes, verify)).rejects.toThrow(
    'run-mismatch',
  );
  await expect(
    host().retain(subject, bytes, async (s, dir) => ({
      ...(await verify(s, dir)),
      independentReview: { status: 'failed', receiptDigest: digest('review') },
    })),
  ).rejects.toThrow('verification-required');
  await expect(
    ledger().acceptAndContinue({ ...cp, evidenceDigest: digest('unretained') }, request),
  ).rejects.toThrow('custody-missing');
  expect(f.db.prepare('SELECT accepted_commit FROM orchestration_runs').pluck().get()).toBe(
    cp.predecessor,
  );
  expect(f.db.prepare('SELECT count(*) FROM orchestration_continuations').pluck().get()).toBe(0);
});

it('another local recovery process defers while the first launch is unconfirmed', async () => {
  const { f, cp, request, ledger, root } = await setup();
  const bundle = await buildStartupHarness();
  const payload = path.join(root, 'profile.json');
  await writeFile(
    payload,
    JSON.stringify({ request: { profileSnapshot: request.profileSnapshot } }),
  );
  await ledger().acceptAndContinue(cp, request);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const ensure = f.runtime.ensure.bind(f.runtime);
  f.runtime.ensure = async (...args) => {
    entered.resolve();
    await resume.promise;
    return ensure(...args);
  };
  const first = ledger().recover();
  try {
    await Promise.race([
      entered.promise,
      first.then(() => {
        throw new Error('first recovery never reached allocation');
      }),
    ]);
    const second = spawnSync(process.execPath, [bundle, f.db.name, payload, 'startup'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(second.error).toBeUndefined();
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual({
      blocked: [{ run: cp.run, key: request.startKey, stage: 'claim' }],
    });
  } finally {
    resume.resolve();
    await first;
  }
  expect(await first).toEqual({ blocked: [] });
  expect(await ledger().recover()).toEqual({ blocked: [] });
  expect(f.launches()).toBe(1);
  expect(
    f.db
      .prepare(
        'SELECT count(*),sum(reserved_requests),count(pod_id) FROM orchestration_continuations',
      )
      .raw()
      .get(),
  ).toEqual([1, 2, 1]);
  expect(f.db.prepare('SELECT count(*) FROM managed_pods').pluck().get()).toBe(1);
});

it('operator fence after allocation authorization retains uncertainty until a late ref and observed exit', async () => {
  const { f, cp, request, ledger, host } = await setup();
  await ledger().acceptAndContinue(cp, request);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const ensure = f.runtime.ensure.bind(f.runtime);
  f.runtime.ensure = async (id, spec) => {
    // External effect happened, but neither checkpoint callback nor reply reached SQLite.
    const result = await ensure(id, spec, () => {});
    entered.resolve();
    await resume.promise;
    return result;
  };
  const stops: string[] = [];
  let stopped = false;
  f.runtime.stop = async (ref) => {
    stops.push(ref);
  }; // acknowledgement is not an exit observation
  f.runtime.observe = async () => ({ state: stopped ? 'stopped' : 'unknown', consumedTokens: 0 });
  const row = () => f.service().lookup('native.example', request.startKey);
  const first = ledger().recover();
  try {
    await Promise.race([
      entered.promise,
      first.then(() => {
        throw new Error('allocation never started');
      }),
    ]);
    const [unknown] = host().interventions.inspect(cp.run).unknown;
    if (!unknown) throw new Error('missing allocation');
    host().interventions.fence(unknown, 'operator-one', 'case-42');
    await f.service().enforceExpiry();
    expect(row()).toMatchObject({
      revoked: 1,
      stop_requested: 1,
      observed_exit: 0,
      runtime_ref: null,
      allocation_attempted: 1,
    });
    expect(await ledger().recover()).toEqual({ blocked: [] });
    expect(stops).toEqual([]);
  } finally {
    resume.resolve();
    await first;
  }
  expect(await first).toEqual({
    blocked: [{ run: cp.run, key: request.startKey, stage: 'launch' }],
  });
  f.restart();
  const id = row()?.pod_id;
  expect(id).toEqual(expect.any(String));
  expect(stops).toEqual([id]);
  expect(row()).toMatchObject({ runtime_ref: id, observed_exit: 0 });
  await f.service().enforceExpiry();
  expect(row()?.observed_exit).toBe(0);
  expect(stops).toEqual([id, id]);
  stopped = true;
  await f.service().enforceExpiry();
  expect(row()).toMatchObject({ state: 'killed', observed_exit: 1 });
  const history = host().interventions.inspect(cp.run);
  expect(history.unknown).toEqual([]);
  expect(history.fences).toHaveLength(1);
  const [receipt] = history.fences;
  if (!receipt) throw new Error('missing historical fence');
  expect(host().interventions.fence(receipt, 'operator-one', 'case-42')).toEqual(receipt);
  expect(await ledger().recover()).toEqual({ blocked: [] });
  expect(f.launches()).toBe(1);
  expect(
    f.db
      .prepare('SELECT count(*),sum(reserved_requests) FROM orchestration_continuations')
      .raw()
      .get(),
  ).toEqual([1, 2]);
});

it('never retries a lost allocation without identity, before or after operator intervention', async () => {
  const { f, cp, request, ledger, host } = await setup();
  await ledger().acceptAndContinue(cp, request);
  let attempts = 0;
  const ensure = f.runtime.ensure.bind(f.runtime);
  f.runtime.ensure = async (id, spec) => {
    attempts++;
    await ensure(id, spec, () => {});
    throw new Error('lost allocation identity');
  };
  expect((await ledger().recover()).blocked[0]?.stage).toBe('launch');
  f.restart();
  expect((await ledger().recover()).blocked[0]?.stage).toBe('allocation-unknown');
  const [target] = host().interventions.inspect(cp.run).unknown;
  if (!target) throw new Error('missing allocation');
  expect(target).toMatchObject({ kind: 'allocation', key: request.startKey, reserved_requests: 2 });
  expect(host().interventions.inspect('another-run').unknown).toEqual([]);
  expect(() =>
    host().interventions.fence({ ...target, binding: digest('stale') }, 'operator-one', 'case-42'),
  ).toThrow('outcome-not-unknown');
  expect(f.db.prepare('SELECT canceled FROM orchestration_runs').pluck().get()).toBe(0);
  host().interventions.fence(target, 'operator-one', 'case-42');
  f.restart();
  await f.service().enforceExpiry();
  expect(await ledger().recover()).toEqual({ blocked: [] });
  expect(attempts).toBe(1);
  expect(f.service().lookup('native.example', request.startKey)).toMatchObject({
    runtime_ref: null,
    observed_exit: 0,
    stop_requested: 1,
  });
  expect(host().interventions.inspect(cp.run).unknown).toEqual([target]);
  expect(f.db.prepare('SELECT remaining FROM orchestration_request_balances').pluck().get()).toBe(
    0,
  );
});

it('atomically records and replays an operator fence for a lost controller reply', async () => {
  const { f, cp, host, tick, calls } = await controllerFixture(6, () => {
    throw new Error('no provider reply');
  });
  await expect(tick()).rejects.toThrow();
  const [target] = host().interventions.inspect(cp.run).unknown;
  if (!target) throw new Error('missing turn');
  expect(target).toMatchObject({
    kind: 'controller',
    key: 'plan-next',
    reserved_requests: 1,
    pod_id: null,
  });
  const fence = () => host().interventions.fence(target, 'operator-two', 'case-17');
  f.db.exec(
    "CREATE TEMP TRIGGER fail_fence BEFORE UPDATE OF canceled ON orchestration_runs BEGIN SELECT RAISE(ABORT,'injected-fence'); END",
  );
  expect(fence).toThrow('injected-fence');
  expect(host().interventions.inspect(cp.run)).toEqual({ unknown: [target], fences: [] });
  expect(f.db.prepare('SELECT canceled FROM orchestration_runs').pluck().get()).toBe(0);
  f.restart();
  const receipt = fence();
  f.restart();
  expect(fence()).toEqual(receipt);
  expect(() => host().interventions.fence(target, 'operator-two', 'other-case')).toThrow(
    'unknown-fence-conflict',
  );
  expect(host().interventions.inspect(cp.run)).toEqual({ unknown: [target], fences: [receipt] });
  await expect(tick()).rejects.toThrow('controller-policy-inactive');
  expect(calls()).toBe(1);
  expect(f.launches()).toBe(1);
  expect(f.db.prepare('SELECT remaining FROM orchestration_request_balances').pluck().get()).toBe(
    3,
  );
});

it('retains a late controller reply as evidence but does not dispatch its proposed child after a fence', async () => {
  const { f, host, cp, tick, calls } = await controllerFixture(6, () => {
    const [pending] = host().interventions.inspect(cp.run).unknown;
    if (!pending) throw new Error('missing turn');
    host().interventions.fence(pending, 'operator', 'case-late');
    return JSON.stringify({
      children: [{ recipe: 'inspect', brief: 'late follow-up' }],
      waitFor: null,
    });
  });
  await expect(tick()).rejects.toThrow('controller-policy-inactive');
  f.restart();
  expect(host().interventions.inspect(cp.run).unknown).toEqual([]);
  expect(host().interventions.inspect(cp.run).fences).toHaveLength(1);
  expect(f.db.prepare('SELECT status FROM orchestration_controller_turns').pluck().get()).toBe(
    'decided',
  );
  expect(f.db.prepare('SELECT count(*) FROM orchestration_continuations').pluck().get()).toBe(1);
  expect(f.db.prepare('SELECT remaining FROM orchestration_request_balances').pluck().get()).toBe(
    3,
  );
  await expect(tick()).rejects.toThrow('controller-policy-inactive');
  expect(calls()).toBe(1);
  expect(f.launches()).toBe(1);
});

it('records killed rather than validating when cancellation commits during exit observation', async () => {
  const { f, cp, request, ledger } = await setup();
  const l = ledger();
  await l.acceptAndContinue(cp, request);
  expect(await l.recover()).toEqual({ blocked: [] });
  f.runtime.observe = async () => {
    l.cancel(cp.run);
    return { state: 'stopped', consumedTokens: 2 };
  };
  await f.service().enforceExpiry();
  expect(f.service().lookup('native.example', request.startKey)).toMatchObject({
    observed_exit: 1,
    revoked: 1,
    state: 'killed',
  });
});

it('fences cancellation during managed preflight before allocating or reserving a pod', async () => {
  const { f, cp, request, ledger } = await setup();
  const l = ledger();
  await l.acceptAndContinue(cp, request);
  f.runtime.preflight = async () => {
    l.cancel(cp.run);
  };
  expect((await l.recover()).blocked).toHaveLength(1);
  expect(f.launches()).toBe(0);
  expect(f.db.prepare('SELECT count(*) FROM managed_pods').pluck().get()).toBe(0);
  expect(await l.recover()).toEqual({ blocked: [] });
});

it('rejects insufficient budget and conflicting replay without advancing or double charging', async () => {
  const { f, cp, request, ledger } = await setup();
  const l = ledger();
  f.db.prepare('UPDATE orchestration_runs SET worker_request_limit=1').run();
  await expect(l.acceptAndContinue(cp, request)).rejects.toThrow('budget-exhausted');
  expect(f.db.prepare('SELECT accepted_commit FROM orchestration_runs').pluck().get()).toBe(
    cp.predecessor,
  );
  expect(f.db.prepare('SELECT count(*) FROM orchestration_continuations').pluck().get()).toBe(0);
  f.db.prepare('UPDATE orchestration_runs SET worker_request_limit=2').run();
  await l.acceptAndContinue(cp, request);
  const other = structuredClone(request);
  other.task.objective = 'different';
  resign(other);
  await expect(l.acceptAndContinue(cp, other)).rejects.toThrow('key-conflict');
  expect(
    f.db
      .prepare('SELECT count(*),sum(reserved_requests) FROM orchestration_continuations')
      .raw()
      .get(),
  ).toEqual([1, 2]);
});
