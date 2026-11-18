import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ManagedPodRequest } from '@autopod/shared';
import { expect, it, onTestFinished } from 'vitest';
import { requestTimeFixture, resign } from '../test-utils/managed-fixture.js';
import { digest } from './canonical.js';
import { ManagedSourceDelivery } from './source-delivery.js';
import { ManagedGitBroker, managedGit } from './source-git.js';
import { ManagedWorkspaces } from './workspaces.js';

// Vertical spike, no public API: the test acts as the trusted run owner. Managed admission,
// start/replay, candidate custody, workspace preparation, Git and SQLite are real. Only the
// runtime and the run-level adapter (reservation, checkpoint selection, recipe projection)
// are fixtures. Candidate integrity is not an independent review or permission to publish.
async function handoffFixture(maxRequests: number, files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'managed-handoff-'));
  const f = requestTimeFixture(1);
  const installation = 'installation-one'; // both runs share the same installation
  const owner = 'mission-one';
  const mirror = path.join(root, 'enrolled');
  const repository = 'fixture-repo';
  const workspace = (pod: string) => path.join(root, 'attempts', pod, repository);
  onTestFinished(async () => {
    f.close();
    await rm(root, { recursive: true, force: true });
  });
  await managedGit(root, ['init', '-b', 'main', mirror]);
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(mirror, name), content);
  await managedGit(mirror, ['add', '.']);
  await managedGit(mirror, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=f@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'base',
  ]);
  const base = await managedGit(mirror, ['rev-parse', 'HEAD']);
  const refs = await managedGit(mirror, ['show-ref']);
  const service = (baseCommit = base, remoteUrl = mirror) => {
    const git = new ManagedGitBroker([
      {
        repository,
        remote: 'origin',
        remoteUrl,
        base: 'main',
        baseCommit,
        branchNamespace: 'worker/',
        workspace,
      },
    ]);
    const s = f.service();
    return Object.assign(s, {
      source: new ManagedSourceDelivery(s, git, new Map([['fixture', 'test-verifier']])),
    });
  };

  // Synthetic root allowance. This is a reservation, not observed usage.
  f.db.exec(`CREATE TABLE spike_reservations (
      start_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, spec TEXT NOT NULL, requests INTEGER NOT NULL)`);
  const start = (run: string, request: ManagedPodRequest, fault?: string) => {
    const budget = request.effectiveGrant.budget;
    if (!('maxProviderRequests' in budget)) throw new Error('request-budget-required');
    f.db
      .transaction(() => {
        const prior = f.db
          .prepare('SELECT run_id, spec FROM spike_reservations WHERE start_key=?')
          .get(request.startKey) as { run_id: string; spec: string } | undefined;
        if (prior) {
          if (prior.run_id !== run || prior.spec !== request.executionSpecDigest)
            throw new Error('reservation-conflict');
          return;
        }
        const used = f.db
          .prepare('SELECT COALESCE(sum(requests),0) FROM spike_reservations WHERE run_id=?')
          .pluck()
          .get(run) as number;
        if (used + budget.maxProviderRequests > maxRequests)
          throw new Error('run-budget-exhausted');
        f.db
          .prepare('INSERT INTO spike_reservations VALUES (?,?,?,?)')
          .run(request.startKey, run, request.executionSpecDigest, budget.maxProviderRequests);
      })
      .immediate();
    const revision = request.effectiveGrant.scope.repositories[0]?.baseRevision;
    const source = revision && sources.get(revision);
    if (!source) throw new Error('missing-reviewed-source');
    return service(revision, source).start(installation, request, fault);
  };

  // Server-side recipe projection: only the selected immutable revision and attempt vary.
  const recipe = (key: string, revision: string) => {
    const r = structuredClone(f.request);
    r.dispatcherAttemptId = r.effectiveGrant.dispatcherAttemptId = r.startKey = key;
    r.task.kind = 'implementation';
    r.outputs.artifacts.mode = 'optional';
    r.outputs.source = {
      mode: 'commit',
      repository,
      remote: 'origin',
      head: `worker/${key}`,
      base: 'main',
    };
    const profile = r.profileSnapshot;
    profile.scope.repositories = [
      {
        enrollmentId: repository,
        remote: 'origin',
        baseRevision: revision,
        branchNamespace: 'worker/',
        access: 'write',
      },
    ];
    profile.scope.allowedEffects = ['repository.read', 'git.commit', 'artifact.write'];
    const { snapshotDigest: _, ...fields } = profile;
    profile.snapshotDigest = r.effectiveGrant.profileSnapshotDigest = digest(fields);
    r.effectiveGrant.scope = structuredClone(profile.scope);
    f.admission.profiles = new Map([[profile.snapshotDigest, profile]]);
    f.admission.enrollmentCeiling =
      f.admission.identityCeiling =
      f.admission.backendCeiling =
        profile.scope;
    return resign(r);
  };
  const sources = new Map([[base, mirror]]);
  const ensure = f.runtime.ensure.bind(f.runtime);
  f.runtime.ensure = async (id, request, checkpoint, fault) => {
    const revision = request.effectiveGrant.scope.repositories[0]?.baseRevision;
    if (!revision) throw new Error('missing-reviewed-revision');
    const source = sources.get(revision);
    if (!source) throw new Error('missing-reviewed-source');
    await new ManagedWorkspaces(f.db, path.join(root, 'attempts'), [
      { enrollmentId: repository, remote: 'origin', baseRevision: revision, path: source },
    ]).prepare(id, request);
    return ensure(id, request, checkpoint, fault);
  };
  function ownedCandidate(run: string, pod: string, expectedDigest: string) {
    const s = service();
    if (
      !f.db
        .prepare(
          `SELECT 1 FROM spike_reservations r JOIN managed_pods p ON p.managed_start_key=r.start_key AND p.execution_spec_digest=r.spec WHERE r.run_id=? AND p.dispatcher_installation_id=? AND p.pod_id=?`,
        )
        .get(run, installation, pod)
    )
      throw new Error('checkpoint-not-owned');
    const { receipt, bundle } = s.source.candidate(installation, pod);
    if (receipt.candidateDigest !== expectedDigest) throw new Error('checkpoint-mismatch');
    return { receipt, bundle };
  }
  return {
    root,
    f,
    base,
    mirror,
    refs,
    service,
    start,
    recipe,
    sources,
    workspace,
    installation,
    owner,
    ownedCandidate,
  };
}

it('replays A once and starts B from its run-owned unpublished checkpoint', async () => {
  const {
    root,
    f,
    base,
    mirror,
    refs,
    service,
    start,
    recipe,
    sources,
    workspace,
    installation,
    owner,
    ownedCandidate,
  } = await handoffFixture(2);
  const a = recipe('worker-a', base);
  await expect(start(owner, a, 'before-response')).rejects.toThrow('injected-before-response');
  f.restart(); // closes and reopens the on-disk database; starts use fresh service instances
  const original = await service().reconcileStart(installation, a);
  const replay = await start(owner, a);
  expect(replay).toEqual(original);
  expect(f.launches()).toBe(1);
  expect(
    f.db.prepare('SELECT count(*), sum(requests) FROM spike_reservations').raw().get(),
  ).toEqual([1, 1]);

  await writeFile(path.join(workspace(replay.podId), 'handoff.txt'), 'from A\n');
  await f.runtime.stop(replay.podId);
  const s = service();
  await s.enforceExpiry();
  const candidate = await s.source.freeze(installation, replay.podId);
  expect(candidate.newCommit).not.toBe(base);
  expect(candidate.newCommit).toBe(
    await managedGit(workspace(replay.podId), ['rev-parse', 'HEAD']),
  );
  await rm(workspace(replay.podId), { recursive: true });
  f.restart(); // B must use the retained bundle, not A's checkout or an in-memory receipt

  const fromCheckpoint = async (run: string, pod: string, expectedDigest: string) => {
    const { receipt, bundle } = ownedCandidate(run, pod, expectedDigest);
    const bundlePath = path.join(root, 'checkpoint.bundle');
    await writeFile(bundlePath, bundle, { flag: 'wx', mode: 0o600 });
    const checkpointRepo = path.join(root, 'checkpoint.git');
    await managedGit(root, ['init', '--bare', checkpointRepo]);
    await managedGit(checkpointRepo, ['fetch', '--no-tags', bundlePath, 'HEAD:refs/heads/main']);
    expect(await managedGit(checkpointRepo, ['rev-parse', 'refs/heads/main'])).toBe(
      receipt.newCommit,
    );
    sources.set(receipt.newCommit, checkpointRepo);
    return start(run, recipe('worker-b', receipt.newCommit));
  };
  await expect(
    fromCheckpoint('mission-two', replay.podId, candidate.candidateDigest),
  ).rejects.toThrow('checkpoint-not-owned');
  expect(f.launches()).toBe(1);
  const b = await fromCheckpoint(owner, replay.podId, candidate.candidateDigest);
  expect(f.launches()).toBe(2);
  expect(b.podId).not.toBe(replay.podId);
  expect(await managedGit(workspace(b.podId), ['rev-parse', 'HEAD'])).toBe(candidate.newCommit);
  expect(await readFile(path.join(workspace(b.podId), 'handoff.txt'), 'utf8')).toBe('from A\n');
  expect(await managedGit(workspace(b.podId), ['remote'])).toBe('');
  expect(await managedGit(mirror, ['show-ref'])).toBe(refs);
});

// A fixture-owned validation rule, evaluated on committed blobs, not the worker's report or
// mutable checkout. Each worker controls one pool; together they may allocate at most ten slots.
async function slotsFit(repo: string, sha: string) {
  const slots = await Promise.all(
    ['pool-a', 'pool-b'].map(async (name) => {
      const value = await managedGit(repo, ['show', `${sha}:${name}`]);
      if (!/^\d+$/.test(value)) throw new Error('invalid-slot-count');
      return Number(value);
    }),
  );
  return slots.reduce((sum, value) => sum + value, 0) <= 10;
}

it.each([
  { outcome: 'accepts', bSlots: 4, passes: true },
  { outcome: 'rejects', bSlots: 5, passes: false },
])('$outcome a clean merge of two individually valid worker changes', async ({
  bSlots,
  passes,
}) => {
  const {
    root,
    f,
    base,
    mirror,
    refs,
    service,
    start,
    recipe,
    sources,
    workspace,
    installation,
    owner,
    ownedCandidate,
  } = await handoffFixture(3, { 'pool-a': '0', 'pool-b': '0' });
  const [a, b] = await Promise.all([
    start(owner, recipe('worker-a', base)),
    start(owner, recipe('worker-b', base)),
  ]);
  expect(a.podId).not.toBe(b.podId);
  const workers = [a, b];
  for (const { podId } of workers)
    expect(await managedGit(workspace(podId), ['rev-parse', 'HEAD'])).toBe(base);
  await Promise.all([
    writeFile(path.join(workspace(a.podId), 'pool-a'), '6'),
    writeFile(path.join(workspace(b.podId), 'pool-b'), String(bSlots)),
  ]);
  await Promise.all(workers.map(({ podId }) => f.runtime.stop(podId)));
  const s = service();
  await s.enforceExpiry();

  // In this private clone main is the accepted checkpoint; all merge work happens on a
  // detached HEAD. Updating main is the acceptance step, not a side effect of merging.
  const draft = path.join(root, 'integration');
  await managedGit(root, ['clone', '--no-local', mirror, draft]);
  await managedGit(draft, ['remote', 'remove', 'origin']);
  await managedGit(draft, ['checkout', '--detach', base]);
  const importWorker = async (id: string) => {
    const candidate = await s.source.freeze(installation, id);
    const { receipt, bundle } = ownedCandidate(owner, id, candidate.candidateDigest);
    const bundlePath = path.join(root, `${id}.bundle`);
    await writeFile(bundlePath, bundle, { flag: 'wx', mode: 0o600 });
    await managedGit(draft, ['fetch', '--no-tags', bundlePath, 'HEAD']);
    expect(await managedGit(draft, ['rev-parse', 'FETCH_HEAD'])).toBe(receipt.newCommit);
    expect(await managedGit(draft, ['rev-parse', `${receipt.newCommit}^`])).toBe(base);
    expect(await slotsFit(draft, receipt.newCommit)).toBe(true);
    return receipt.newCommit;
  };
  const first = await importWorker(a.podId);
  const second = await importWorker(b.podId);
  await managedGit(draft, ['merge', '--ff-only', first]);
  await managedGit(draft, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=f@example.invalid',
    'merge',
    '--no-ff',
    '-m',
    'Combine worker changes',
    second,
  ]);
  const merged = await managedGit(draft, ['rev-parse', 'HEAD']);
  expect(await managedGit(draft, ['show', '-s', '--format=%P', merged])).toBe(`${first} ${second}`);
  const accepted = () => managedGit(draft, ['rev-parse', 'refs/heads/main']);
  expect(await accepted()).toBe(base);
  const advanceAndStart = async () => {
    if (!(await slotsFit(draft, merged))) return null;
    await managedGit(draft, ['update-ref', 'refs/heads/main', merged, base]);
    sources.set(merged, draft);
    return start(owner, recipe('worker-c', merged));
  };
  const c = await advanceAndStart();
  if (passes) {
    expect(await accepted()).toBe(merged);
    if (!c) throw new Error('missing-next-worker');
    const cwd = workspace(c.podId);
    expect(await managedGit(cwd, ['rev-parse', 'HEAD'])).toBe(merged);
    for (const sha of [first, second])
      await managedGit(cwd, ['merge-base', '--is-ancestor', sha, 'HEAD']);
    expect(f.launches()).toBe(3);
  } else {
    expect(c).toBeNull();
    expect(await accepted()).toBe(base);
    expect(f.launches()).toBe(2);
    expect(s.lookup(installation, 'worker-c')).toBeUndefined();
  }
  expect(await managedGit(mirror, ['show-ref'])).toBe(refs);
});
