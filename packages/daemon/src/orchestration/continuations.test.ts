import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { build } from 'esbuild';
import { expect, it, onTestFinished } from 'vitest';
import { digest } from '../managed/canonical.js';
import { ManagedPodService } from '../managed/managed-service.js';
import { managedGit } from '../managed/source-git.js';
import { requestTimeFixture, resign } from '../test-utils/managed-fixture.js';
import { LocalCheckpointHost } from './local-checkpoints.js';

async function setup(workerRequests = 2, maxActive = 1) {
  const f = requestTimeFixture(2);
  const root = await mkdtemp(path.join(tmpdir(), 'native-run-'));
  onTestFinished(async () => {
    f.close();
    await rm(root, { recursive: true, force: true });
  });
  f.db.exec(
    await readFile(
      new URL('../db/migrations/255_orchestration_continuations.sql', import.meta.url),
      'utf8',
    ),
  );
  f.db.exec(
    await readFile(
      new URL('../db/migrations/256_orchestration_checkpoint_custody.sql', import.meta.url),
      'utf8',
    ),
  );
  f.db.exec(
    await readFile(
      new URL('../db/migrations/258_orchestration_waves.sql', import.meta.url),
      'utf8',
    ),
  );
  f.db.exec(
    await readFile(
      new URL('../db/migrations/259_orchestration_controller_turns.sql', import.meta.url),
      'utf8',
    ),
  );
  const source = path.join(root, 'retained');
  const commit = async (message: string) =>
    managedGit(source, [
      '-c',
      'user.email=f@example.invalid',
      '-c',
      'user.name=Fixture',
      'commit',
      '--allow-empty',
      '-m',
      message,
    ]);
  await managedGit(root, ['init', '-b', 'main', source]);
  await commit('base');
  const predecessor = await managedGit(source, ['rev-parse', 'HEAD']);
  await writeFile(path.join(source, 'proof.txt'), 'unpublished checkpoint\n');
  await managedGit(source, ['add', 'proof.txt']);
  await commit('verified');
  const sha = await managedGit(source, ['rev-parse', 'HEAD']);
  const subject = {
    run: 'example',
    predecessor,
    commit: sha,
    tree: await managedGit(source, ['rev-parse', 'HEAD^{tree}']),
    repository: 'fixture-repo',
    policyDigest: digest('fixture-policy'),
  };
  const request = f.request;
  request.outputs.artifacts.mode = 'none';
  const profile = request.profileSnapshot;
  const repo = profile.scope.repositories[0];
  if (!repo) throw new Error('missing fixture repo');
  repo.baseRevision = sha;
  request.effectiveGrant.scope = structuredClone(profile.scope);
  const { snapshotDigest: _, ...fields } = profile;
  profile.snapshotDigest = request.effectiveGrant.profileSnapshotDigest = digest(fields);
  resign(request);
  f.admission.profiles = new Map([[profile.snapshotDigest, profile]]);
  const host = () =>
    new LocalCheckpointHost(
      f.db,
      path.join(root, 'scratch'),
      (_cp, mirror) =>
        new ManagedPodService(
          f.db,
          f.admission,
          {
            ...f.runtime,
            ensure: async (id, spec, checkpoint, fault) => {
              const pin = spec.effectiveGrant.scope.repositories[0]?.baseRevision;
              if (!pin) throw new Error('missing-pin');
              const cwd = path.join(root, id);
              await managedGit(root, ['clone', '--no-local', '--no-checkout', mirror, cwd]);
              await managedGit(cwd, ['checkout', '--detach', pin]);
              expect(await managedGit(cwd, ['rev-parse', 'HEAD'])).toBe(cp.commit);
              expect(await readFile(path.join(cwd, 'proof.txt'), 'utf8')).toBe(
                'unpublished checkpoint\n',
              );
              return f.runtime.ensure(id, spec, checkpoint, fault);
            },
          },
          () => 100,
          true,
        ),
    );
  const ledger = () => host().ledger;
  ledger().open(
    subject.run,
    subject.repository,
    subject.policyDigest,
    predecessor,
    workerRequests,
    maxActive,
  );
  const file = path.join(root, 'retention.bundle');
  await managedGit(source, ['bundle', 'create', file, 'HEAD']);
  const bytes = await readFile(file);
  const verify = async (s: typeof subject, mirror: string) => {
    expect(await managedGit(mirror, ['show', `${s.commit}:proof.txt`])).toBe(
      'unpublished checkpoint',
    );
    return {
      subjectDigest: digest(s),
      checks: { status: 'passed' as const, receiptDigest: digest('fixture-checks') },
      independentReview: { status: 'passed' as const, receiptDigest: digest('fixture-review') },
    };
  };
  const cp = await host().retain(subject, bytes, verify);
  await rm(source, { recursive: true });
  await rm(file);
  return { f, root, cp, request, ledger, host, subject, bytes, verify };
}

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
  let calls = 0;
  const model = 'fixture-controller';
  const client = new Anthropic({
    apiKey: 'fixture-key-not-real',
    fetch: async (_url, init) => {
      calls++;
      return new Response(
        JSON.stringify({
          id: 'message',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: reply(String(init?.body)) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 37, output_tokens: 19 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const tick = () =>
    host().tickController(
      cp.run,
      {
        mission: 'Check the completed work',
        routeId: 'local-test',
        recipes: { inspect: request.startKey },
      },
      { client, model },
    );
  return { f, request, cp, tick, calls: () => calls };
}
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

async function buildStartupHarness() {
  const daemon = path.resolve(import.meta.dirname, '../..');
  await mkdir(path.join(daemon, '.turbo'), { recursive: true });
  const dir = await mkdtemp(path.join(daemon, '.turbo', 'continuation-crash-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const bundle = path.join(dir, 'writer.mjs');
  await build({
    entryPoints: [path.join(daemon, 'src/test-utils/continuation-crash-fixture.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    packages: 'external',
  });
  return bundle;
}

it.skipIf(process.platform === 'win32').each(['accepted', 'allocated', 'lost-handle', 'cancel'])(
  'recovers the committed continuation across SIGKILL: %s',
  async (mode) => {
    const { f, root, cp, request, ledger } = await setup();
    const bundle = await buildStartupHarness();
    const payload = path.join(root, 'request.json');
    await writeFile(payload, JSON.stringify({ cp, request }));
    const writer = spawnSync(process.execPath, [bundle, f.db.name, payload, mode], {
      encoding: 'utf8',
      timeout: 5000,
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
      timeout: 5000,
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

it('cancel after allocation authorization retains uncertainty until a late ref and observed exit', async () => {
  const { f, cp, request, ledger } = await setup();
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
    ledger().cancel(cp.run);
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
  expect(await ledger().recover()).toEqual({ blocked: [] });
  expect(f.launches()).toBe(1);
  expect(
    f.db
      .prepare('SELECT count(*),sum(reserved_requests) FROM orchestration_continuations')
      .raw()
      .get(),
  ).toEqual([1, 2]);
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
