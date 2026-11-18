import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { expect, it, onTestFinished } from 'vitest';
import { digest } from '../managed/canonical.js';
import { ManagedPodService } from '../managed/managed-service.js';
import { managedGit } from '../managed/source-git.js';
import { requestTimeFixture, resign } from '../test-utils/managed-fixture.js';
import { LocalCheckpointHost } from './local-checkpoints.js';

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
  f.db.exec(
    await readFile(
      new URL('../db/migrations/256_orchestration_checkpoint_custody.sql', import.meta.url),
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
  ledger().open(subject.run, subject.repository, subject.policyDigest, predecessor, 2);
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
