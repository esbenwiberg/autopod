import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { expect, it, onTestFinished } from 'vitest';
import { digest } from '../managed/canonical.js';
import { managedGit } from '../managed/source-git.js';
import { requestTimeFixture, resign } from '../test-utils/managed-fixture.js';
import { OrchestrationContinuations } from './continuations.js';

async function setup() {
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
  await commit('verified');
  const sha = await managedGit(source, ['rev-parse', 'HEAD']);
  const cp = {
    run: 'example',
    predecessor,
    commit: sha,
    tree: await managedGit(source, ['rev-parse', 'HEAD^{tree}']),
    repository: 'fixture-repo',
    evidenceDigest: digest('fixture-verification'),
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
  const service = () => f.service();
  const ledger = () =>
    new OrchestrationContinuations(f.db, async (checkpoint) => {
      expect(checkpoint).toEqual(cp);
      return service();
    });
  ledger().open(cp.run, cp.repository, cp.policyDigest, predecessor, 2);
  const ensure = f.runtime.ensure.bind(f.runtime);
  f.runtime.ensure = async (id, spec, checkpoint, fault) => {
    const pin = spec.effectiveGrant.scope.repositories[0]?.baseRevision;
    if (!pin) throw new Error('missing-pin');
    const cwd = path.join(root, id);
    await managedGit(root, ['clone', '--no-local', '--no-checkout', source, cwd]);
    await managedGit(cwd, ['checkout', '--detach', pin]);
    expect(await managedGit(cwd, ['rev-parse', 'HEAD'])).toBe(cp.commit);
    return ensure(id, spec, checkpoint, fault);
  };
  return { f, root, cp, request, ledger };
}

it.skipIf(process.platform === 'win32').each(['accepted', 'allocated', 'lost-handle', 'cancel'])(
  'recovers the committed continuation across SIGKILL: %s',
  async (mode) => {
    const { f, root, cp, request, ledger } = await setup();
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
    expect(await l.recover()).toEqual({ blocked: [] });
    expect(await l.recover()).toEqual({ blocked: [] });
    expect(
      f.db
        .prepare('SELECT count(*),sum(reserved_requests) FROM orchestration_continuations')
        .raw()
        .get(),
    ).toEqual([1, 2]);
    // After losing the handle, the child already started C. Recovery must only observe it.
    expect(f.launches()).toBe(mode === 'cancel' || mode === 'lost-handle' ? 0 : 1);
    if (mode === 'lost-handle')
      expect(await managedGit(path.join(root, String(old)), ['rev-parse', 'HEAD'])).toBe(cp.commit);
    if (mode === 'cancel')
      expect(f.db.prepare('SELECT count(*) FROM managed_pods').pluck().get()).toBe(0);
    else {
      const pod = f.db.prepare('SELECT pod_id FROM orchestration_continuations').pluck().get();
      expect(pod).toEqual(old ?? expect.any(String));
      expect(f.db.prepare('SELECT pod_id FROM managed_pods').pluck().all()).toEqual([pod]);
    }
  },
);

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
  await expect(l.acceptAndContinue(cp, request)).rejects.toThrow('not-admissible');
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
