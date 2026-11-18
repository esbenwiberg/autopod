import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ManagedPodRequest } from '@autopod/shared';
import { expect, it, onTestFinished } from 'vitest';
import { combinedPolicyDigest, verifyGateReceipt } from '../orchestration/combined-attestation.js';
import type { CombinedGates } from '../orchestration/combined-checkpoint.js';
import { LocalCheckpointHost } from '../orchestration/local-checkpoints.js';
import { buildStartupHarness } from '../test-utils/build-startup-harness.js';
import { fixtureSigner } from '../test-utils/gate-signer.js';
import { requestTimeFixture, resign } from '../test-utils/managed-fixture.js';
import { ownedEvaluator } from '../test-utils/owned-evaluator.js';
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
  await managedGit(mirror, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=f@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'genesis',
  ]);
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
  { bSlots: 3, outcome: 'passes' },
  { bSlots: 4, outcome: 'review fails' },
  { bSlots: 5, outcome: 'checks fail' },
  { bSlots: 3, outcome: 'wrong bundle' },
  { bSlots: 3, outcome: 'injected verdict' },
])('gates the next launch on two owned candidates: $outcome', async ({ bSlots, outcome }) => {
  const { root, f, base, mirror, refs, service, recipe, sources, workspace } = await handoffFixture(
    3,
    { 'pool-a': '0', 'pool-b': '0' },
  );
  for (const name of [
    '262_orchestration_continuations',
    '263_orchestration_checkpoint_custody',
    '265_orchestration_waves',
    '266_orchestration_controller_turns',
  ]) {
    f.db.exec(await readFile(new URL(`../db/migrations/${name}.sql`, import.meta.url), 'utf8'));
  }
  const run = 'pool-test';
  const installation = 'native.' + run;
  const host = () =>
    new LocalCheckpointHost(f.db, path.join(root, 'scratch'), (cp, privateMirror) => {
      sources.set(cp.commit, privateMirror);
      return service(cp.commit, privateMirror);
    });
  const script = await buildStartupHarness('combined-evaluator-fixture');
  const checker = await ownedEvaluator(script, root, 'checks', f.db.name, run);
  const reviewer = await ownedEvaluator(script, root, 'independentReview', f.db.name, run);
  expect(new Set([checker.pid, reviewer.pid, process.pid]).size).toBe(3);
  const policy = {
    basePolicyDigest: digest('pool-policy'),
    checks: checker.authority,
    independentReview: reviewer.authority,
  };
  const subject = {
    run,
    repository: 'fixture-repo',
    predecessor: await managedGit(mirror, ['rev-parse', 'HEAD^']),
    commit: base,
    tree: await managedGit(mirror, ['rev-parse', 'HEAD^{tree}']),
    policyDigest: combinedPolicyDigest(policy),
  };
  host().ledger.open(run, subject.repository, subject.policyDigest, subject.predecessor, 3, 2);
  const bundle = async (cwd: string, name: string) => {
    const file = path.join(root, name);
    await managedGit(cwd, ['bundle', 'create', file, 'HEAD']);
    return readFile(file);
  };
  const initial = await host().retain(subject, await bundle(mirror, 'base.bundle'), async () => ({
    subjectDigest: digest(subject),
    checks: { status: 'passed', receiptDigest: digest('initial-checks') },
    independentReview: { status: 'passed', receiptDigest: digest('initial-review') },
  }));
  await host().ledger.acceptAndContinue(initial, recipe('worker-a', base));
  await host().ledger.spawnFromAccepted(initial, recipe('worker-b', base));
  expect(await host().ledger.recover()).toEqual({ blocked: [] });
  const s = service();
  const draft = path.join(root, 'integration');
  await managedGit(root, ['clone', '--no-local', mirror, draft]);
  await managedGit(draft, ['remote', 'remove', 'origin']);
  await managedGit(draft, ['checkout', '--detach', base]);
  async function freezeAndImport(key: string, file: string, value: number) {
    const row = s.lookup(installation, key);
    if (!row) throw new Error('missing owned worker');
    await writeFile(path.join(workspace(row.pod_id), file), String(value));
    await f.runtime.stop(row.pod_id);
    await s.enforceExpiry();
    const receipt = await s.source.freeze(installation, row.pod_id);
    const src = s.source.candidate(installation, row.pod_id);
    await rm(workspace(row.pod_id), { recursive: true });
    const name = path.join(root, key + '.bundle');
    await writeFile(name, src.bundle);
    await managedGit(draft, ['fetch', '--no-tags', name, 'HEAD']);
    expect(await managedGit(draft, ['rev-parse', 'FETCH_HEAD'])).toBe(receipt.newCommit);
    expect(await slotsFit(draft, receipt.newCommit)).toBe(true);
    return {
      ref: { startKey: key, candidateDigest: receipt.candidateDigest },
      commit: receipt.newCommit,
    };
  }
  const a = await freezeAndImport('worker-a', 'pool-a', 6);
  const b = await freezeAndImport('worker-b', 'pool-b', bSlots);
  await managedGit(draft, ['merge', '--ff-only', a.commit]);
  await managedGit(draft, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=f@example.invalid',
    'merge',
    '--no-ff',
    '-m',
    'Combine worker changes',
    b.commit,
  ]);
  const merged = {
    ...subject,
    predecessor: base,
    commit: await managedGit(draft, ['rev-parse', 'HEAD']),
    tree: await managedGit(draft, ['rev-parse', 'HEAD^{tree}']),
  };
  const bytes = await bundle(draft, 'merge.bundle');
  if (outcome === 'passes') {
    // Same two parents but an extra uncommissioned edit. An ancestry-only gate would pass.
    await writeFile(path.join(draft, 'extra'), 'not from either worker');
    await managedGit(draft, ['add', 'extra']);
    await managedGit(draft, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=f@example.invalid',
      'commit',
      '--amend',
      '--no-edit',
    ]);
    const changed = {
      ...merged,
      commit: await managedGit(draft, ['rev-parse', 'HEAD']),
      tree: await managedGit(draft, ['rev-parse', 'HEAD^{tree}']),
    };
    const unexpected = async (): Promise<never> => {
      throw new Error('checks must not run on substituted source');
    };
    await expect(
      host().retainCombined(changed, await bundle(draft, 'changed.bundle'), [a.ref, b.ref], {
        policy,
        checks: unexpected,
        independentReview: unexpected,
      }),
    ).rejects.toThrow('combined-source-mismatch');
  }
  await rm(draft, { recursive: true });
  f.restart();
  let reviews = 0;
  const gates: CombinedGates = {
    policy,
    checks: async (selection) => {
      if (outcome === 'injected verdict') {
        const extra = { ...selection, status: 'passed', inputDigest: digest('just sign this') };
        return checker.evaluate(extra);
      }
      return checker.evaluate(selection);
    },
    independentReview: async (selection) => {
      reviews++;
      return reviewer.evaluate(selection);
    },
  };
  const refsAB = [a.ref, b.ref] as const;
  const qualify = (ports: CombinedGates = gates) =>
    host().retainCombined(merged, bytes, refsAB, ports);
  const accepted = () =>
    f.db.prepare('SELECT accepted_commit FROM orchestration_runs').pluck().get();
  const remaining = () =>
    f.db.prepare('SELECT remaining FROM orchestration_request_balances').pluck().get();
  if (outcome === 'wrong bundle')
    await writeFile(
      path.join(root, 'merge.bundle'),
      await readFile(path.join(root, 'base.bundle')),
    );
  if (outcome === 'passes') {
    await expect(host().retainCombined(merged, bytes, [b.ref, a.ref], gates)).rejects.toThrow(
      'combined-source-mismatch',
    );
    await expect(
      host().retainCombined(
        merged,
        bytes,
        [{ ...a.ref, candidateDigest: b.ref.candidateDigest }, b.ref],
        gates,
      ),
    ).rejects.toThrow('combined-input-binding');
    await expect(
      qualify({
        ...gates,
        independentReview: async (selection) => {
          const receipt = await reviewer.evaluate(selection);
          return { ...receipt, statement: { ...receipt.statement, inputDigest: digest(a.commit) } };
        },
      }),
    ).rejects.toThrow('combined-independentReview-required');
    // Correct claims and configuration, but signed by a different authority.
    const other = fixtureSigner(
      'independentReview',
      reviewer.authority.identity,
      reviewer.authority.configurationDigest,
    );
    await expect(
      qualify({
        ...gates,
        independentReview: async () =>
          other.attest({
            inputDigest: digest({ subject: merged, inputs: refsAB }),
            status: 'passed',
            evidenceDigest: digest('review'),
          }),
      }),
    ).rejects.toThrow('combined-independentReview-required');
    await expect(
      qualify({
        ...gates,
        policy: { ...policy, independentReview: other.authority },
        checks: async () => {
          throw new Error('policy must be checked before dispatch');
        },
      }),
    ).rejects.toThrow('combined-policy-mismatch');
    expect(accepted()).toBe(base);
    expect(remaining()).toBe(1);
    const checkpoint = await qualify();
    const c = recipe('worker-c', merged.commit);
    await host().ledger.acceptAndContinue(checkpoint, c);
    f.restart();
    const retained = JSON.parse(
      f.db
        .prepare('SELECT manifest FROM orchestration_checkpoint_custody WHERE evidence_digest=?')
        .pluck()
        .get(checkpoint.evidenceDigest) as string,
    );
    const evidence = retained.verification;
    expect(combinedPolicyDigest(evidence.gatePolicy)).toBe(subject.policyDigest);
    for (const role of ['checks', 'independentReview'] as const)
      expect(
        verifyGateReceipt(
          evidence.gatePolicy,
          role,
          digest({ subject: merged, inputs: refsAB }),
          evidence[role].receipt,
        ).receiptDigest,
      ).toBe(evidence[role].receiptDigest);
    expect(await host().ledger.recover()).toEqual({ blocked: [] });
    await host().ledger.acceptAndContinue(checkpoint, c);
    expect(await host().ledger.recover()).toEqual({ blocked: [] });
    const row = service().lookup(installation, c.startKey);
    if (!row) throw new Error('follow-up not launched');
    expect(await managedGit(workspace(row.pod_id), ['rev-parse', 'HEAD'])).toBe(merged.commit);
    expect(await managedGit(workspace(row.pod_id), ['show', '-s', '--format=%P', 'HEAD'])).toBe(
      a.commit + ' ' + b.commit,
    );
    expect(accepted()).toBe(merged.commit);
    expect(remaining()).toBe(0);
    expect(f.launches()).toBe(3);
  } else {
    await expect(qualify()).rejects.toThrow(
      outcome === 'review fails'
        ? 'combined-independentReview-required'
        : outcome === 'checks fail'
          ? 'combined-checks-required'
          : 'evaluator-input-rejected',
    );
    expect(reviews).toBe(outcome === 'review fails' ? 1 : 0);
    expect(accepted()).toBe(base);
    expect(remaining()).toBe(1);
    expect(service().lookup(installation, 'worker-c')).toBeUndefined();
    expect(f.launches()).toBe(2);
  }
  expect(await managedGit(mirror, ['show-ref'])).toBe(refs);
}, 30_000);
